/**
 * 切换耗时埋点（修改 5 · S5）。
 *
 * 目的只有一个：让「切工作区/切会话到底慢在哪」有数字可查，而不是靠感觉。
 * 每次切换写一行 JSON 到 `logs/timings.jsonl`：
 *
 *     {"t":"2026-11-25T10:00:00.000Z","label":"session-open","ms":312,
 *      "marks":[{"phase":"resolve-workspace","ms":1}, ...],"meta":{"kind":"activated"}}
 *
 * 纪律：
 *  - **只记时间与离散标签**（槽种类、槽数量、是否冷启），不记路径、不记对话内容。
 *  - 写失败绝不影响主流程（埋点不能成为新的故障点）。
 *  - 文件超过 4 MB 轮转成 `.1`，只留一代——这是诊断数据，不是账本。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface SwitchMark {
  phase: string;
  /** 相对开始时刻的毫秒数 */
  ms: number;
  meta?: Record<string, unknown>;
}

export interface SwitchTrace {
  label: string;
  id: string;
  startedAt: number;
  marks: SwitchMark[];
}

const MAX_BYTES = 4 * 1024 * 1024;

export class SwitchTiming {
  private seq = 0;

  constructor(
    private readonly fileOf: () => string,
    private readonly enabled = true,
  ) {}

  begin(label: string, meta?: Record<string, unknown>): SwitchTrace {
    this.seq += 1;
    const trace: SwitchTrace = {
      label,
      id: `${Date.now().toString(36)}-${this.seq}`,
      startedAt: performance.now(),
      marks: [],
    };
    if (meta) this.mark(trace, "begin", meta);
    return trace;
  }

  mark(trace: SwitchTrace, phase: string, meta?: Record<string, unknown>): void {
    trace.marks.push({
      phase,
      ms: Math.round((performance.now() - trace.startedAt) * 10) / 10,
      ...(meta ? { meta } : {}),
    });
  }

  /** 收尾：写一行汇总。调用方不必 await——写盘是同步的，但失败了也只是丢一条诊断。 */
  end(trace: SwitchTrace, meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const total = Math.round((performance.now() - trace.startedAt) * 10) / 10;
    const entry = {
      t: new Date().toISOString(),
      label: trace.label,
      id: trace.id,
      ms: total,
      marks: trace.marks,
      ...(meta ? { meta } : {}),
    };
    // console 留一条：开发时不用翻文件
    console.log(`[switch] ${trace.label} ${total}ms ${trace.marks.map((m) => `${m.phase}:${m.ms}`).join(" ")}`);
    try {
      const file = this.fileOf();
      if (!file) return;
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // 埋点失败不影响任何功能
    }
  }
}
