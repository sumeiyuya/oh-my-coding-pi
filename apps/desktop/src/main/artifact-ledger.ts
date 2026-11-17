import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ArtifactItem, ArtifactKind, ArtifactListResult } from "@oh-my-coding-pi/shared";

/**
 * 产物账本（参考 DAWN 的 listArtifacts 语义）。
 *
 * 三条纪律，来自 DAWN 的产物 spec：
 * 1. 账本记「某次工具调用产出了哪些文件」；写文件类工具能精确知道，bash / run_code 不知道。
 * 2. **不知道就说不知道**：缺路径的调用记为 unknown，界面显示「另有 N 次运行产出未知」，
 *    不许把「不知道」画成「没有」。
 * 3. 约定目录（figures/、results/）另外扫一遍，补上脚本写出来的、账本看不见的文件。
 */

export type { ArtifactItem, ArtifactKind, ArtifactListResult };

export interface LedgerEntry {
  ts: string;
  session: string;
  tool: string;
  toolCallId: string;
  /** 工作区相对路径（统一 / 分隔） */
  paths: string[];
  /** 这次调用的产出无法枚举（bash / run_code / 自定义工具） */
  unknown: boolean;
}

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".py": "code", ".r": "code", ".rmd": "code", ".qmd": "code", ".js": "code", ".mjs": "code",
  ".ts": "code", ".tsx": "code", ".sh": "code", ".ps1": "code", ".sql": "code", ".ipynb": "code",
  ".md": "markdown", ".txt": "text", ".log": "text", ".csv": "data", ".tsv": "data",
  ".json": "data", ".xlsx": "data", ".parquet": "data", ".rds": "data",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".svg": "image", ".pdf": "image", ".tif": "image",
};

export function classify(path: string): ArtifactKind {
  return KIND_BY_EXT[extname(path).toLowerCase()] ?? "other";
}

/** 把工具入参里的路径整理成工作区相对路径；越界一律丢弃（路径守卫的第一道） */
export function normalizeInside(root: string, raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const abs = isAbsolute(raw) ? normalize(raw) : resolve(root, raw);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * 从一次工具调用推出产出文件。
 *
 * 只认「写文件」这一类工具的入参；其余（bash / run_code / 自定义）一律 unknown。
 * 这是刻意的：猜一个路径比承认不知道更糟。
 */
export function pathsFromToolResult(
  root: string,
  tool: string,
  input: Record<string, unknown> | undefined,
): { paths: string[]; unknown: boolean } {
  const t = String(tool || "").toLowerCase();
  const raw = input ? (input.path ?? input.file_path ?? input.file) : undefined;
  const writes = t === "write" || t === "edit" || t.endsWith("_write") || t.endsWith("_edit");
  if (writes && typeof raw === "string") {
    const rel = normalizeInside(root, raw);
    if (rel) return { paths: [rel], unknown: false };
  }
  return { paths: [], unknown: true };
}

export class ArtifactLedger {
  private readonly root: () => string | null;
  private readonly maxBytes: number;

  /** 账本落到工作区的 .omcp/artifacts.jsonl；没有工作区就不记 */
  constructor(root: () => string | null, maxBytes = 2 * 1024 * 1024) {
    this.root = root;
    this.maxBytes = maxBytes;
  }

  private file(): string | null {
    const root = this.root();
    return root ? join(root, ".omcp", "artifacts.jsonl") : null;
  }

  append(entry: LedgerEntry): void {
    const file = this.file();
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > this.maxBytes) {
          // 简单轮转：留最近一份，不实现多代
          appendFileSync(file + ".old", "", "utf8");
        }
      } catch {
        // 文件还不存在
      }
      appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // 记账失败不能影响工具结果
    }
  }

  read(session: string): LedgerEntry[] {
    const file = this.file();
    if (!file || !existsSync(file)) return [];
    const out: LedgerEntry[] = [];
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LedgerEntry;
          if (e && e.session === session && Array.isArray(e.paths)) out.push(e);
        } catch {
          // 坏行跳过
        }
      }
    } catch {
      return [];
    }
    return out;
  }

  /** 扫约定目录；只认文件，深度与条数都有上限，避免大工作区把面板拖死 */
  scanObserved(dirs: string[], maxFiles = 400, maxDepth = 5): ArtifactItem[] {
    const root = this.root();
    if (!root) return [];
    const out: ArtifactItem[] = [];
    const walk = (abs: string, rel: string, depth: number) => {
      if (out.length >= maxFiles || depth > maxDepth) return;
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxFiles) return;
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const childAbs = join(abs, e.name);
        const childRel = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) {
          walk(childAbs, childRel, depth + 1);
        } else if (e.isFile()) {
          let size: number | null = null;
          let mtime: string | null = null;
          try {
            const st = statSync(childAbs);
            size = st.size;
            mtime = st.mtime.toISOString();
          } catch {
            // 读不到就留空
          }
          out.push({
            path: childRel,
            name: e.name,
            dir: rel,
            kind: classify(childRel),
            size,
            mtime,
            exists: true,
            origin: "observed",
          });
        }
      }
    };
    for (const d of dirs) {
      const abs = join(root, d);
      if (existsSync(abs)) walk(abs, d, 0);
    }
    return out;
  }

  list(options: { session: string; dirs?: string[] }): ArtifactListResult {
    const root = this.root();
    const scannedAt = new Date().toISOString();
    if (!root) {
      return { artifacts: [], unknownRuns: 0, observed: 0, scannedAt, error: "没有打开工作区" };
    }
    const entries = this.read(options.session);
    const byPath = new Map<string, ArtifactItem>();
    let unknownRuns = 0;
    for (const e of entries) {
      if (e.unknown) unknownRuns += 1;
      for (const p of e.paths) {
        const prev = byPath.get(p);
        if (prev && String(prev.ts) > String(e.ts)) continue;
        const abs = join(root, p);
        let exists = false;
        let size: number | null = null;
        let mtime: string | null = null;
        try {
          const st = statSync(abs);
          exists = st.isFile();
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          exists = false;
        }
        byPath.set(p, {
          path: p,
          name: p.split("/").pop() ?? p,
          dir: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
          kind: classify(p),
          size,
          mtime,
          exists,
          origin: "run",
          tool: e.tool,
          ts: e.ts,
        });
      }
    }
    let observed = 0;
    for (const item of this.scanObserved(options.dirs ?? ["figures", "results"])) {
      if (byPath.has(item.path)) continue; // 账本已经记过，保留归属
      byPath.set(item.path, item);
      observed += 1;
    }
    const artifacts = [...byPath.values()].sort((a, b) => {
      if (a.exists !== b.exists) return a.exists ? -1 : 1;
      return String(b.mtime ?? b.ts ?? "").localeCompare(String(a.mtime ?? a.ts ?? ""));
    });
    return { artifacts, unknownRuns, observed, scannedAt };
  }
}
