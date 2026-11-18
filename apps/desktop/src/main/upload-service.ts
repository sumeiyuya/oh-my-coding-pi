/**
 * 上传服务（修改1）：原生对话框选中的文件，按“工作区内引用 / 工作区外复制”落位。
 *
 * 纪律：
 *  - 只处理用户显式选择的普通文件；不扫描目录、不后台读取。
 *  - 复制目标固定在 `<工作区>/.omcp/uploads/<日期>/`，不覆盖已有文件。
 *  - 文件/数据不设应用层限额；复制前检查磁盘空间，流式复制并上报进度。
 *  - 图片只读 base64，单张上限由调用方（共享常量）决定。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { readFile, realpath, stat, statfs } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

export interface UploadFilters {
  name: string;
  extensions: string[];
}

export interface ClassifiedUpload {
  path: string;
  name: string;
  size: number;
  insideWorkspace: boolean;
  /** 工作区相对路径（/ 分隔）；不在工作区内时缺省 */
  relative?: string;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const DATA_EXTS = [
  "csv", "tsv", "txt", "xlsx", "xls", "json", "parquet", "rds", "rdata",
  "feather", "arrow", "sav", "dta", "sqlite", "db",
];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function filtersFor(kind: "file" | "image" | "data"): UploadFilters[] {
  if (kind === "image") return [{ name: "图片", extensions: IMAGE_EXTS }];
  if (kind === "data") {
    return [
      { name: "数据文件", extensions: DATA_EXTS },
      { name: "所有文件", extensions: ["*"] },
    ];
  }
  return [{ name: "所有文件", extensions: ["*"] }];
}

export function mimeFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.includes(extname(path).slice(1).toLowerCase());
}

/** 安全文件名：去掉路径分隔符/空白/控制字符，保留扩展名，避免 @ 解析失败 */
export function safeFileName(name: string): string {
  let base = String(name ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "");
  if (!base) base = "file";
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length) || "file";
  const shortStem = stem.length > 100 ? stem.slice(0, 100) : stem;
  const shortExt = ext.length > 20 ? ext.slice(0, 20) : ext;
  return shortStem + shortExt;
}

export async function classifyUpload(absPath: string, workspaceRoot: string): Promise<ClassifiedUpload> {
  const real = await realpath(absPath);
  const info = await stat(real);
  if (!info.isFile()) throw new Error("不是普通文件");
  const rootReal = await realpath(workspaceRoot);
  const rel = relative(rootReal, real);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return {
    path: real,
    name: basename(real),
    size: info.size,
    insideWorkspace: inside,
    ...(inside ? { relative: rel.split(sep).join("/") } : {}),
  };
}

/** 目标重名时追加 -1、-2，不覆盖 */
export function uniqueDestination(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "file";
  let candidate = join(dir, name);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${i++}${ext}`);
  }
  return candidate;
}

/** 复制前检查剩余空间；statfs 不可用时跳过检查 */
export async function checkDiskSpace(dir: string, bytes: number): Promise<void> {
  try {
    const info = await statfs(dir);
    const free = Number(info.bavail) * Number(info.bsize);
    const margin = 64 * 1024 * 1024;
    if (Number.isFinite(free) && free < bytes + margin) {
      throw new Error(
        `磁盘空间不足：需要约 ${formatBytes(bytes)}，剩余 ${formatBytes(free)}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("磁盘空间不足")) throw err;
    // statfs 在个别平台/网络盘不可用：跳过检查，让复制自己报错
  }
}

export interface CopyOptions {
  onProgress?: (copiedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/** 流式复制到临时文件，成功后 rename；失败/取消清理临时文件 */
export async function copyWithProgress(
  src: string,
  dest: string,
  totalBytes: number,
  opts: CopyOptions = {},
): Promise<void> {
  const temp = `${dest}.part-${process.pid}-${Date.now()}`;
  const rs = createReadStream(src);
  const ws = createWriteStream(temp, { flags: "wx" });
  let copied = 0;
  let lastEmit = 0;
  let writeError: Error | null = null;
  ws.on("error", (err) => {
    writeError = err instanceof Error ? err : new Error(String(err));
  });
  try {
    for await (const chunk of rs) {
      if (opts.signal?.aborted) throw new Error("已取消");
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!ws.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          ws.once("drain", resolve);
          ws.once("error", reject);
        });
      }
      if (writeError) throw writeError;
      copied += buf.length;
      const now = Date.now();
      if (opts.onProgress && (now - lastEmit > 100 || copied === totalBytes)) {
        lastEmit = now;
        opts.onProgress(copied, totalBytes);
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.end(() => (writeError ? reject(writeError) : resolve()));
    });
    if (writeError) throw writeError;
    if (opts.signal?.aborted) throw new Error("已取消");
    renameSync(temp, dest);
    if (opts.onProgress && copied !== totalBytes) opts.onProgress(copied, totalBytes);
  } catch (err) {
    try {
      ws.destroy();
    } catch {
      // ignore
    }
    try {
      unlinkSync(temp);
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function readImageBase64(path: string, maxBytes: number): Promise<{ data: string; mimeType: string }> {
  const info = await stat(path);
  if (info.size > maxBytes) {
    throw new Error(`图片超过 ${formatBytes(maxBytes)}`);
  }
  const buf = await readFile(path);
  return { data: buf.toString("base64"), mimeType: mimeFor(path) };
}

export function uploadDateDir(root: string): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const dir = join(root, ".omcp", "uploads", `${y}-${m}-${day}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
