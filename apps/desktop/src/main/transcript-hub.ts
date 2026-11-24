/**
 * 转录中枢（修改 4 · M1）。
 *
 * 这块是「切走不停、切回即得、刷新不丢」的那一半：会话的转写不再只活在
 * 渲染进程的内存里，主进程按**会话**维护一份，带 `revision`。
 *
 * 三条纪律（照 DAWN 的做法）：
 *
 *  1. **后台会话照样归约**，只是不往界面推——所以切走半小时回来，历史是连续的；
 *  2. **快照 + 版本号**：订阅时给一次全量 `{items, revision}`，之后按事件续；
 *     客户端发现自己的版本对不上就整段重取，**不猜、不拼**；
 *  3. **订阅门**：只有订阅了的会话才推（省 IPC），但归约与未读计数照常进行。
 *
 * 这里不做 IO：不读盘、不写盘。重启后是空的，由界面用
 * `messagesFromAgent()`（渲染端）或 `get_messages` 重新种进来。
 */
import type { ChatItem, PiEvent } from "@oh-my-coding-pi/shared";
import { appendSystem, appendUserTurn, applyPiEvent } from "@oh-my-coding-pi/shared";

export interface TranscriptEntry {
  key: string;
  revision: number;
  items: ChatItem[];
  unread: number;
  /** 这份转写里最后一轮的成败，界面用来画"这一轮失败了" */
  failed: boolean;
  updatedAt: number;
}

export interface TranscriptSnapshot {
  key: string;
  revision: number;
  items: ChatItem[];
  unread: number;
  /** 中枢里还没有这段的转写（重启后第一次打开）：调用方自己去重建 */
  cold: boolean;
}

export interface TranscriptHubOptions {
  now?: () => number;
  /** 每个会话最多留多少条；超了从头丢（转写可以从盘重建，内存不该无限涨） */
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 2000;

export class TranscriptHub {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly now: () => number;
  private readonly maxItems: number;
  private readonly listeners = new Set<(key: string, revision: number) => void>();

  constructor(opts: TranscriptHubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxItems = Math.max(50, opts.maxItems ?? DEFAULT_MAX_ITEMS);
  }

  /** 这段转写有没有（不创建） */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  private ensure(key: string): TranscriptEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, revision: 0, items: [], unread: 0, failed: false, updatedAt: this.now() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * 重建之后种进来（重启、或界面自己拉了 get_messages）。
   * **不算增量**：revision +1，让还在等增量的客户端重新取快照。
   */
  seed(key: string, items: ChatItem[], revision = 0): TranscriptEntry {
    const entry = this.ensure(key);
    entry.items = items.slice(-this.maxItems);
    entry.revision = Math.max(entry.revision, revision) + 1;
    entry.updatedAt = this.now();
    this.notify(key);
    return entry;
  }

  /** 一条 pi 事件：归约 + revision +1 */
  ingest(key: string, ev: PiEvent): TranscriptEntry {
    const entry = this.ensure(key);
    const next = applyPiEvent(entry.items, ev, { now: this.now });
    if (next !== entry.items) {
      entry.items = next.slice(-this.maxItems);
      entry.revision += 1;
      entry.updatedAt = this.now();
      if (ev.type === "message_end" && ev.message.role === "assistant") {
        entry.unread += 1;
      }
      this.notify(key);
    }
    return entry;
  }

  /** 用户发的那一句（事件流里没有） */
  userTurn(key: string, text: string, attachments?: { id: string; data: string; mimeType: string }[]): void {
    const entry = this.ensure(key);
    entry.items = appendUserTurn(entry.items, text, {
      now: this.now,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }).slice(-this.maxItems);
    entry.revision += 1;
    entry.updatedAt = this.now();
    this.notify(key);
  }

  system(key: string, text: string): void {
    const entry = this.ensure(key);
    entry.items = appendSystem(entry.items, text, { now: this.now }).slice(-this.maxItems);
    entry.revision += 1;
    entry.updatedAt = this.now();
    this.notify(key);
  }

  markFailed(key: string, failed = true): void {
    const entry = this.ensure(key);
    if (entry.failed === failed) return;
    entry.failed = failed;
    entry.revision += 1;
    this.notify(key);
  }

  snapshot(key: string): TranscriptSnapshot {
    const entry = this.entries.get(key);
    if (!entry) {
      return { key, revision: 0, items: [], unread: 0, cold: true };
    }
    return {
      key,
      revision: entry.revision,
      items: [...entry.items],
      unread: entry.unread,
      cold: entry.items.length === 0,
    };
  }

  /** 只给标量，界面刷新徽标用（不搬 items） */
  summary(key: string): { revision: number; unread: number; failed: boolean } {
    const entry = this.entries.get(key);
    return entry
      ? { revision: entry.revision, unread: entry.unread, failed: entry.failed }
      : { revision: 0, unread: 0, failed: false };
  }

  clearUnread(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.unread === 0) return;
    entry.unread = 0;
    this.notify(key);
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** 订阅：key 或其 revision 变了就喊一声。返回退订函数。 */
  onUpdate(listener: (key: string, revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(key: string): void {
    const revision = this.entries.get(key)?.revision ?? 0;
    for (const listener of [...this.listeners]) {
      try {
        listener(key, revision);
      } catch {
        // 一个听众出错不该影响别的
      }
    }
  }
}
