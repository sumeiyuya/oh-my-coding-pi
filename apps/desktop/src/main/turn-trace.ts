/**
 * 回合级时序记录（方案二 PR1）。
 *
 * 目的：把“发送后没动静”拆成可测的几段——预算、pi 预检/压缩、首 token、工具、回合末刷新。
 * 纪律：
 *  - 只记时间、长度、工具名、结果码；不记 prompt 正文、工具输出、文件路径、密钥。
 *  - 写盘失败不影响主流程；目录不存在就跳过。
 *  - 文件按 5 MB 轮转，最多保留一份旧文件（perf.1.jsonl）。
 *  - 事件仍然实时发给 renderer（用于状态展示），与是否写盘无关。
 */
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type TurnPhase =
  | "accepted"
  | "preparing"
  | "started"
  | "first_token"
  | "tool_start"
  | "tool_end"
  | "settled"
  | "failed";

export interface TurnPhaseDetail {
  tool?: string;
  ok?: boolean;
  reason?: string;
  /** 工具/阶段自带的毫秒数（例如内核冷启动） */
  ms?: number;
}

export interface TurnPhaseEvent {
  turnId: string;
  phase: TurnPhase;
  /** 墙钟时间，仅用于展示 */
  at: number;
  /** 相对 accepted 的毫秒数 */
  elapsedMs: number;
  detail?: TurnPhaseDetail;
}

export interface TurnSpan {
  phase: TurnPhase;
  at: number;
  elapsedMs: number;
  detail?: TurnPhaseDetail;
}

export interface TurnRecord {
  v: 1;
  turnId: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  outcome: string;
  totalMs: number;
  meta: Record<string, number | string>;
  notes: Record<string, number | string>;
  spans: TurnSpan[];
}

export interface TurnTraceOptions {
  /** 返回 JSONL 目标路径；返回 null 表示当前不写盘（例如还没打开工作区） */
  file: () => string | null;
  /** 单文件上限，默认 5 MB */
  maxBytes?: number;
  /** 环境变量或设置关闭写盘；事件仍会发出 */
  enabled?: boolean;
  /** 事件出口（通常是 IPC send）；抛错会被吞掉 */
  onPhase?: (event: TurnPhaseEvent) => void;
}

interface ActiveTurn {
  id: string;
  kind: string;
  startedAt: number;
  t0: number;
  meta: Record<string, number | string>;
  notes: Record<string, number | string>;
  spans: TurnSpan[];
  seen: Set<TurnPhase>;
}

let seq = 0;

function newTurnId(): string {
  seq = (seq + 1) % 1_000_000;
  return `t${Date.now().toString(36)}-${seq.toString(36)}`;
}

export class TurnTrace {
  private active: ActiveTurn | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly enabled: boolean;
  private readonly file: () => string | null;
  private onPhase: ((event: TurnPhaseEvent) => void) | undefined;

  constructor(opts: TurnTraceOptions) {
    this.file = opts.file;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.enabled = opts.enabled ?? true;
    this.onPhase = opts.onPhase;
  }

  setPhaseSink(fn: (event: TurnPhaseEvent) => void): void {
    this.onPhase = fn;
  }

  get activeId(): string | null {
    return this.active?.id ?? null;
  }

  /** 开一个回合。若已有进行中的回合，返回 null（调用方应把它当作排队/追加处理）。 */
  begin(kind: string, meta: Record<string, number | string> = {}): string | null {
    if (this.active) return null;
    const id = newTurnId();
    const now = Date.now();
    this.active = {
      id,
      kind,
      startedAt: now,
      t0: performance.now(),
      meta: { ...meta },
      notes: {},
      spans: [],
      seen: new Set(),
    };
    void this.rotateIfNeeded();
    this.emit("accepted");
    return id;
  }

  phase(phase: TurnPhase, detail?: TurnPhaseDetail): void {
    if (!this.active) return;
    // started / first_token / settled 只记第一次，避免重试或多轮工具把它刷掉
    if ((phase === "started" || phase === "first_token" || phase === "settled") && this.active.seen.has(phase)) {
      return;
    }
    this.emit(phase, detail);
  }

  note(key: string, value: number | string): void {
    if (!this.active) return;
    this.active.notes[key] = typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
  }

  /** 每个 pi 事件记一次，用于验证 IPC 合并效果 */
  countIpc(): void {
    if (!this.active) return;
    const cur = Number(this.active.notes.ipcEvents ?? 0);
    this.active.notes.ipcEvents = cur + 1;
  }

  /** 实际发往 renderer 的事件数（合并后），与 ipcEvents 对比 */
  countIpcSent(): void {
    if (!this.active) return;
    const cur = Number(this.active.notes.ipcSent ?? 0);
    this.active.notes.ipcSent = cur + 1;
  }

  fail(reason: string): void {
    if (!this.active) return;
    this.emit("failed", { reason });
    this.finish("failed");
  }

  settle(): void {
    if (!this.active) return;
    this.emit("settled");
    this.finish("ok");
  }

  /** 立即结束（例如 pi 退出、用户中止）；不重复发 settled */
  abort(reason: string): void {
    if (!this.active) return;
    this.emit("failed", { reason });
    this.finish("aborted");
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  private emit(phase: TurnPhase, detail?: TurnPhaseDetail): void {
    const a = this.active;
    if (!a) return;
    const elapsedMs = Math.round(performance.now() - a.t0);
    const span: TurnSpan = {
      phase,
      at: Date.now(),
      elapsedMs,
      ...(detail ? { detail } : {}),
    };
    a.spans.push(span);
    a.seen.add(phase);
    if (this.onPhase) {
      try {
        this.onPhase({ turnId: a.id, phase, at: span.at, elapsedMs, ...(detail ? { detail } : {}) });
      } catch {
        // 展示层的问题不能影响主流程
      }
    }
  }

  private finish(outcome: string): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (!this.enabled) return;
    const target = this.file();
    if (!target) return;
    const record: TurnRecord = {
      v: 1,
      turnId: a.id,
      kind: a.kind,
      startedAt: new Date(a.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      outcome,
      totalMs: Math.round(performance.now() - a.t0),
      meta: a.meta,
      notes: a.notes,
      spans: a.spans,
    };
    const line = JSON.stringify(record) + "\n";
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(target), { recursive: true });
        await appendFile(target, line, "utf8");
      })
      .catch(() => {
        // 写不进去只影响诊断，不影响对话
      });
  }

  private async rotateIfNeeded(): Promise<void> {
    if (!this.enabled) return;
    const target = this.file();
    if (!target) return;
    try {
      const info = await stat(target);
      if (info.size < this.maxBytes) return;
      await rename(target, target.replace(/\.jsonl$/, ".1.jsonl"));
    } catch {
      // 文件还不存在 / 被占用：忽略
    }
  }
}
