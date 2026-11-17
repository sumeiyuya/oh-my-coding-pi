/**
 * 事件合并泵（方案二 PR2）。
 *
 * 背景：pi 的 `text_delta` 是逐 token 的，主进程此前对每个事件都 `webContents.send`，
 * 一次长回复会产生上千次结构化克隆与 renderer 事件循环唤醒。这里把同一
 * `contentIndex` 的文本增量按时间窗合并，非增量事件前强制 flush，保证顺序。
 *
 * 纪律：
 *  - 只合并 `text_delta` / `thinking_delta`；工具结果、错误、权限请求一律原样直发。
 *  - 非增量事件到达时先 flush，再发它自己——顺序不能倒。
 *  - 单帧有字节与条数上限，超了立即 flush，避免一帧塞进整段长文。
 *  - `OMCP_EVENT_PUMP=0` 时退化为逐条转发，便于 A/B 与故障排查。
 */
import type { AssistantMessageEvent, PiEvent, Usage } from "@oh-my-coding-pi/shared";

export interface EventPumpOptions {
  emit: (ev: PiEvent) => void;
  /** 合并窗口，默认 16 ms */
  windowMs?: number;
  /** 单帧文本字节上限，默认 8 KB */
  maxBytes?: number;
  /** 单帧增量条数上限，默认 64 */
  maxEvents?: number;
  /** 关闭合并，逐条转发 */
  enabled?: boolean;
  /** 测试注入 */
  now?: () => number;
}

interface PendingDelta {
  kind: "text_delta" | "thinking_delta";
  contentIndex: number;
  delta: string;
  bytes: number;
  count: number;
  /** 最近一次 message_update 自带的 usage，flush 时带上 */
  usage?: Usage;
}

function isDelta(ev: PiEvent): ev is Extract<PiEvent, { type: "message_update" }> & {
  assistantMessageEvent: Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>;
} {
  if (ev.type !== "message_update") return false;
  const t = ev.assistantMessageEvent?.type;
  return t === "text_delta" || t === "thinking_delta";
}

export class EventPump {
  private readonly emitFn: (ev: PiEvent) => void;
  private readonly windowMs: number;
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private pending = new Map<string, PendingDelta>();
  private timer: NodeJS.Timeout | null = null;
  private bytes = 0;
  private count = 0;

  constructor(opts: EventPumpOptions) {
    this.emitFn = opts.emit;
    this.windowMs = opts.windowMs ?? 16;
    this.maxBytes = opts.maxBytes ?? 8 * 1024;
    this.maxEvents = opts.maxEvents ?? 64;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
  }

  push(ev: PiEvent): void {
    if (!this.enabled) {
      this.emitFn(ev);
      return;
    }
    if (isDelta(ev)) {
      const e = ev.assistantMessageEvent;
      const key = `${e.type}:${e.contentIndex}`;
      const cur = this.pending.get(key);
      if (cur) {
        cur.delta += e.delta;
        cur.bytes += Buffer.byteLength(e.delta, "utf8");
        cur.count += 1;
        if (ev.usage !== undefined) cur.usage = ev.usage;
      } else {
        this.pending.set(key, {
          kind: e.type,
          contentIndex: e.contentIndex,
          delta: e.delta,
          bytes: Buffer.byteLength(e.delta, "utf8"),
          count: 1,
          ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
        });
      }
      this.bytes += Buffer.byteLength(e.delta, "utf8");
      this.count += 1;
      if (this.bytes >= this.maxBytes || this.count >= this.maxEvents) {
        this.flush();
        return;
      }
      this.schedule();
      return;
    }
    // 任何非增量事件都必须排在已缓冲的文本之后
    this.flush();
    this.emitFn(ev);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const items = [...this.pending.values()];
    this.pending.clear();
    this.bytes = 0;
    this.count = 0;
    for (const item of items) {
      this.emitFn({
        type: "message_update",
        ...(item.usage !== undefined ? { usage: item.usage } : {}),
        assistantMessageEvent: {
          type: item.kind,
          contentIndex: item.contentIndex,
          delta: item.delta,
        },
      } as PiEvent);
    }
  }

  /** 退出/重启前调用，避免最后一段文本留在缓冲里 */
  dispose(): void {
    this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs);
    // 不阻止进程退出
    this.timer.unref?.();
  }
}
