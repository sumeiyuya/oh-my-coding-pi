/**
 * 用量扫描（修改 4 · U1）。
 *
 * 只读会话 jsonl，不跑内核、不改文件：
 *   <workspace>/.omcp/sessions/*.jsonl
 *
 * 计数口径（照 DAWN）：
 *   - 用掉的 token = input + output，**不含 cacheRead**（各家含义不一致，合并会重复计）
 *   - 有 token 但没有 model 的记入 unattributed
 *   - assistant 消息但完全没有 usage 的记入 silentTurns
 *
 * 缓存按 (路径, mtime, size) 增量：没变的文件不重读。
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

export interface UsageRecord {
  /** 本机时区的 YYYY-MM-DD */
  date: string;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  /** 这条记录对应一个 assistant 回合（用于 byModel.runs） */
  turn: boolean;
}

export interface FileScan {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
  silentTurns: number;
}

export interface ScanCache {
  version: 1;
  files: Record<string, FileScan>;
}

export interface ScanResult {
  records: UsageRecord[];
  silentTurns: number;
  files: number;
  reused: number;
  parsed: number;
}

export function emptyCache(): ScanCache {
  return { version: 1, files: {} };
}

/** 本机时区的日期；不用 toISOString（那是 UTC，会把跨零点的用量记错天） */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 解析一个会话文件；坏行跳过，不影响其它行 */
export function scanSessionText(text: string): { records: UsageRecord[]; silentTurns: number } {
  const records: UsageRecord[] = [];
  let silentTurns = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry.type;
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const date = localDate(ts);

    if (type === "message") {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg || msg.role !== "assistant") continue;
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (!usage) {
        silentTurns++;
        continue;
      }
      const input = num(usage.input);
      const output = num(usage.output);
      const cacheRead = num(usage.cacheRead);
      if (input + output + cacheRead === 0) {
        silentTurns++;
        continue;
      }
      records.push({
        date,
        ...(typeof msg.provider === "string" ? { provider: msg.provider } : {}),
        ...(typeof msg.model === "string" ? { model: msg.model } : {}),
        input,
        output,
        cacheRead,
        turn: true,
      });
      continue;
    }

    // pi 的独立 usage 条目（cache_warm 等）与带 usage 的 compaction 也计入总量
    if (type === "usage" || type === "compaction") {
      const usage = entry.usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      records.push({
        date,
        ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        turn: false,
      });
    }
  }
  return { records, silentTurns };
}

/**
 * 扫描目录。`cache` 会被就地更新（调用方负责落盘）。
 * `readFile` 可注入，便于单测。
 */
export function scanSessions(
  files: string[],
  cache: ScanCache,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ScanResult {
  const records: UsageRecord[] = [];
  let silentTurns = 0;
  let reused = 0;
  let parsed = 0;
  const next: Record<string, FileScan> = {};

  for (const file of files) {
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(file);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      continue;
    }
    const hit = cache.files[file];
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      next[file] = hit;
      records.push(...hit.records);
      silentTurns += hit.silentTurns;
      reused++;
      continue;
    }
    let text: string;
    try {
      text = readFile(file);
    } catch {
      continue;
    }
    const scanned = scanSessionText(text);
    next[file] = { ...st, records: scanned.records, silentTurns: scanned.silentTurns };
    records.push(...scanned.records);
    silentTurns += scanned.silentTurns;
    parsed++;
  }

  // 只保留本次见到的文件，删掉的会话不会永久占缓存
  cache.files = next;
  return { records, silentTurns, files: files.length, reused, parsed };
}

export function sessionFileKey(file: string): string {
  return basename(file);
}
