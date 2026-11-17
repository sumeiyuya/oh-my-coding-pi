import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type AuditDecision = "allow" | "deny" | "timeout";

export interface AuditEntry {
  ts: string;
  toolName: string;
  ruleId: string;
  decision: AuditDecision;
  /** once / session / always / deny / timeout / policy */
  scope?: string;
  summary: string;
  sessionId?: string;
  source?: string;
  /**
   * 执行结果（自测报告 P4）：只记「放行」不记「结果」，日志就复盘不了哪一步失败。
   * 放行不等于成功：ok=false 才是真失败；status=error 表示内核跑完了但代码报错。
   */
  outcome?: {
    ok: boolean;
    durationMs: number;
    status?: string;
    errorClass?: string;
    kernelPid?: number;
  };
}

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_FILES = 3;
const SUMMARY_MAX = 200;

export function sanitize(text: string): string {
  return String(text ?? "")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[redacted]")
    .replace(/\b(sk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)["'\s:=]+)[^\s"',;}]{4,}/gi, "$1[redacted]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"]+/g, "%USERPROFILE%")
    .replace(/[A-Za-z]:\/Users\/[^/\s"]+/g, "%USERPROFILE%");
}

export function clampSummary(text: string): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= SUMMARY_MAX ? s : s.slice(0, SUMMARY_MAX) + "…";
}

/**
 * 审计日志：`<ws>/.omcp/logs/audit.jsonl`。
 * 10MB × 3 轮转；写入失败不抛错（审计不能拖垮主流程），由调用方决定是否提示。
 */
export class AuditLog {
  private readonly getFile: () => string | null;

  constructor(getFile: () => string | null) {
    this.getFile = getFile;
  }

  private rotate(file: string): void {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        if (existsSync(from)) renameSync(from, to);
      } catch {
        // ignore
      }
    }
  }

  write(entry: AuditEntry): boolean {
    const file = this.getFile();
    if (!file) return false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      this.rotate(file);
      const record: AuditEntry = {
        ...entry,
        summary: clampSummary(sanitize(entry.summary)),
      };
      appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /** 倒序返回最近记录（最多 limit 条） */
  read(limit = 500): AuditEntry[] {
    return this.readAll(limit, true);
  }

  /** 筛选 + 分页；用于权限页（10 万行也不至于一次全塞给渲染进程） */
  query(options: { limit?: number; offset?: number; tool?: string; decision?: string; q?: string } = {}): {
    total: number;
    items: AuditEntry[];
  } {
    let items = this.readAll(200_000, false);
    if (options.tool) items = items.filter((e) => e.toolName === options.tool);
    if (options.decision) items = items.filter((e) => e.decision === options.decision);
    if (options.q) {
      const q = options.q.toLowerCase();
      items = items.filter(
        (e) =>
          e.summary.toLowerCase().includes(q) ||
          e.ruleId.toLowerCase().includes(q) ||
          e.toolName.toLowerCase().includes(q),
      );
    }
    const total = items.length;
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const offset = Math.max(0, options.offset ?? 0);
    return { total, items: items.slice(offset, offset + limit) };
  }

  private readAll(limit: number, takeTail: boolean): AuditEntry[] {
    const file = this.getFile();
    if (!file || !existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      const slice = takeTail ? lines.slice(-limit) : lines;
      const out: AuditEntry[] = [];
      for (const line of slice) {
        try {
          out.push(JSON.parse(line) as AuditEntry);
        } catch {
          // 跳过坏行
        }
      }
      return out.reverse();
    } catch {
      return [];
    }
  }
}
