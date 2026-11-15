import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import type {
  FileEntry,
  FileListResult,
  FileReadResult,
  FileStatResult,
} from "@oh-my-coding-pi/shared";

/** 这些目录不列：版本库、依赖、oh my coding pi 自己的元数据 */
const SKIP_DIRS = new Set([".git", "node_modules", ".omcp"]);

/** 单目录条数上限。一万级目录不该把整个渲染进程拖住。 */
const MAX_ENTRIES = 1000;

/** 文本 / 图片预览上限 */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 只认能安全用 <img> 显示的位图。SVG 按文本处理，不当图片渲染。 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

type Resolved = { abs: string; rel: string } | { error: string };

function isWin(): boolean {
  return process.platform === "win32";
}

/** Windows 路径大小写不敏感，比较前统一小写 */
function insideRoot(root: string, target: string): boolean {
  const r = isWin() ? root.toLowerCase() : root;
  const t = isWin() ? target.toLowerCase() : target;
  if (r === t) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * 把工作区相对路径解析成绝对路径。
 * 规则：只收相对路径；拒绝 `..`；realpath 之后必须仍在工作区内（符号链接也算）。
 */
export function resolveInside(root: string, relPath: string): Resolved {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { error: "工作区不存在" };
  }
  const raw = String(relPath ?? "").replace(/\\/g, "/").trim();
  if (raw.includes("\0")) return { error: "路径非法" };
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("//")) {
    return { error: "只接受工作区内相对路径" };
  }
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return { error: "路径不能越出工作区" };

  const abs = join(rootReal, ...parts);
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    return { error: "路径不存在" };
  }
  if (!insideRoot(rootReal, realAbs)) return { error: "路径越出工作区" };
  return { abs: realAbs, rel: relative(rootReal, realAbs).split(sep).join("/") };
}

function toTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** 只列一层，不递归。 */
export function listWorkspaceDir(root: string, relPath: string): FileListResult {
  const target = resolveInside(root, relPath);
  if ("error" in target) return { path: "", entries: [], truncated: false, error: target.error };

  let isDir = false;
  try {
    isDir = statSync(target.abs).isDirectory();
  } catch {
    return { path: target.rel, entries: [], truncated: false, error: "读不到这个路径" };
  }
  if (!isDir) return { path: target.rel, entries: [], truncated: false, error: "不是目录" };

  let names: Dirent[];
  try {
    names = readdirSync(target.abs, { withFileTypes: true });
  } catch {
    return { path: target.rel, entries: [], truncated: false, error: "没有权限读取" };
  }

  const entries: FileEntry[] = [];
  let truncated = false;
  for (const dirent of names) {
    if (SKIP_DIRS.has(dirent.name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const childRel = target.rel ? `${target.rel}/${dirent.name}` : dirent.name;
    const symlink = dirent.isSymbolicLink();
    let type: "file" | "dir" = dirent.isDirectory() ? "dir" : "file";
    let size: number | undefined;
    let mtime: string | undefined;
    try {
      const st = statSync(join(target.abs, dirent.name));
      type = st.isDirectory() ? "dir" : "file";
      if (type === "file") size = st.size;
      mtime = toTime(st.mtimeMs);
    } catch {
      // 悬空符号链接等：仍然列名字，但拿不到大小
    }
    entries.push({ name: dirent.name, path: childRel, type, symlink, size, mtime });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh", { numeric: true, sensitivity: "base" });
  });

  return { path: target.rel, entries, truncated };
}

export function statWorkspacePath(root: string, relPath: string): FileStatResult {
  const target = resolveInside(root, relPath);
  if ("error" in target) {
    return { path: "", name: "", type: "file", size: 0, mtime: "", error: target.error };
  }
  try {
    const st = statSync(target.abs);
    const isDir = st.isDirectory();
    const name = target.rel ? target.rel.split("/").pop() || target.rel : ".";
    return {
      path: target.rel,
      name,
      type: isDir ? "dir" : "file",
      size: isDir ? 0 : st.size,
      mtime: toTime(st.mtimeMs),
    };
  } catch {
    return { path: target.rel, name: "", type: "file", size: 0, mtime: "", error: "读不到这个路径" };
  }
}

/** 前 8 KB 里有 NUL 就当二进制，不猜编码 */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

/**
 * 只读预览。先看大小再看内容：
 * 文本 2 MB、图片 8 MB 以上直接拒绝，绝不整份读进渲染进程。
 */
export function readWorkspaceFile(root: string, relPath: string): FileReadResult {
  const target = resolveInside(root, relPath);
  if ("error" in target) {
    return { path: "", kind: "binary", size: 0, error: target.error };
  }

  let size = 0;
  let isDir = false;
  try {
    const st = statSync(target.abs);
    isDir = st.isDirectory();
    size = st.size;
  } catch {
    return { path: target.rel, kind: "binary", size: 0, error: "读不到这个路径" };
  }
  if (isDir) return { path: target.rel, kind: "binary", size: 0, error: "这是目录" };

  const ext = extname(target.rel).toLowerCase();
  const imageMime = IMAGE_MIME[ext];

  if (imageMime) {
    if (size > IMAGE_MAX_BYTES) {
      return {
        path: target.rel,
        kind: "too-large",
        size,
        error: `图片 ${size.toLocaleString("en-US")} 字节，超过 8 MB 上限`,
      };
    }
    try {
      const buf = readFileSync(target.abs);
      return {
        path: target.rel,
        kind: "image",
        size,
        mime: imageMime,
        dataUrl: `data:${imageMime};base64,${buf.toString("base64")}`,
      };
    } catch {
      return { path: target.rel, kind: "binary", size, error: "读不到这个文件" };
    }
  }

  if (size > TEXT_MAX_BYTES) {
    return {
      path: target.rel,
      kind: "too-large",
      size,
      error: `文件 ${size.toLocaleString("en-US")} 字节，超过 2 MB 文本上限`,
    };
  }

  let buf: Buffer;
  try {
    buf = readFileSync(target.abs);
  } catch {
    return { path: target.rel, kind: "binary", size, error: "读不到这个文件" };
  }
  if (looksBinary(buf)) {
    return { path: target.rel, kind: "binary", size, error: "二进制文件，本版本不预览" };
  }
  return { path: target.rel, kind: "text", size, text: buf.toString("utf8") };
}
