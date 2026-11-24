/**
 * 聊天条目的**实时归约**（修改 4 · M1）。
 *
 * 转写有两份来源：
 *  - 落盘的会话消息 → `messagesFromAgent()`（重建，主进程/渲染端都能用）；
 *  - 正在跑的 pi 事件流 → 这里（增量）。
 *
 * 此前增量这一份在渲染端写了两遍：前台一条 switch、后台 `applyBackgroundEvent`
 * 一条。两份的覆盖范围不同（后台那份没有工具卡片之外的 system/notice），
 * 于是一个会话切到后台再切回来，看到的东西会和一直盯着它不一样。
 * 现在只留一份，主进程的转录中枢与渲染端都用它。
 *
 * 纯函数、无 IO，便于单测。
 */
import type { PiEvent } from "./protocol.ts";

export type ChatImage = { id: string; data: string; mimeType: string };

export type ChatItem =
  | {
      kind: "user";
      id: string;
      text: string;
      at: number;
      failed?: boolean;
      attachments?: ChatImage[];
      textOnly?: boolean;
    }
  | { kind: "assistant"; id: string; text: string; at?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      done: boolean;
      result?: string;
      startedAt?: number;
      endedAt?: number;
      isError?: boolean;
      interrupted?: boolean;
    }
  | { kind: "system"; id: string; text: string; at: number };

export interface ApplyOptions {
  /** 注入时钟便于测试 */
  now?: () => number;
  /** 同上：id 生成器 */
  nextId?: () => string;
}

let seq = 0;
function defaultNextId(): string {
  seq = (seq + 1) % 1_000_000;
  return `c${Date.now().toString(36)}-${seq.toString(36)}`;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => {
      return Boolean(c) && typeof c === "object" && (c as { type?: unknown }).type === "text";
    })
    .map((c) => c.text)
    .join("");
}

/** 末尾那条 assistant 的下标；没有就 -1（工具与 system 之后不算"末尾"） */
function lastAssistantIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant") return i;
    if (item.kind === "user" || item.kind === "system") return -1;
  }
  return -1;
}

/**
 * 把一条 pi 事件并进条目列表，返回**新数组**（不改入参）。
 *
 * 只认「对话本身」的事件；审批、方案卡、队列这些由界面自己的状态管，
 * ——它们不是会话内容，写进转写会让重建与实时两条路对不上。
 */
export function applyPiEvent(items: ChatItem[], ev: PiEvent, opts: ApplyOptions = {}): ChatItem[] {
  const now = opts.now ?? Date.now;
  const nextId = opts.nextId ?? defaultNextId;

  switch (ev.type) {
    case "message_start": {
      if (ev.message.role !== "assistant") return items;
      return [...items, { kind: "assistant", id: nextId(), text: "", at: now() }];
    }
    case "message_update": {
      const inner = ev.assistantMessageEvent;
      if (!inner || inner.type !== "text_delta") return items;
      const delta = inner.delta ?? "";
      if (!delta) return items;
      const index = lastAssistantIndex(items);
      if (index < 0) {
        return [...items, { kind: "assistant", id: nextId(), text: delta, at: now() }];
      }
      const next = [...items];
      const current = next[index] as Extract<ChatItem, { kind: "assistant" }>;
      next[index] = { ...current, text: current.text + delta };
      return next;
    }
    case "message_end": {
      if (ev.message.role !== "assistant") return items;
      const text = textOfContent(ev.message.content);
      const index = lastAssistantIndex(items);
      if (index < 0) {
        return text ? [...items, { kind: "assistant", id: nextId(), text, at: now() }] : items;
      }
      if (!text) return items;
      const next = [...items];
      next[index] = { ...(next[index] as Extract<ChatItem, { kind: "assistant" }>), text };
      return next;
    }
    case "tool_execution_start": {
      return [
        ...items,
        {
          kind: "tool",
          id: ev.toolCallId,
          name: ev.toolName,
          args: JSON.stringify(ev.args ?? {}),
          done: false,
          startedAt: now(),
        },
      ];
    }
    case "tool_execution_end": {
      const index = items.findIndex((item) => item.kind === "tool" && item.id === ev.toolCallId);
      if (index < 0) return items;
      const next = [...items];
      const tool = next[index] as Extract<ChatItem, { kind: "tool" }>;
      next[index] = {
        ...tool,
        done: true,
        endedAt: now(),
        ...(ev.isError ? { isError: true } : {}),
        result: textOfContent(ev.result?.content),
      };
      return next;
    }
    default:
      return items;
  }
}

/** 用户自己发的那一句（事件流里没有，由主进程在收下 prompt 时补） */
export function appendUserTurn(
  items: ChatItem[],
  text: string,
  opts: ApplyOptions & { attachments?: ChatImage[]; textOnly?: boolean } = {},
): ChatItem[] {
  const now = opts.now ?? Date.now;
  const nextId = opts.nextId ?? defaultNextId;
  return [
    ...items,
    {
      kind: "user",
      id: nextId(),
      text,
      at: now(),
      ...(opts.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments }
        : {}),
      ...(opts.textOnly ? { textOnly: true } : {}),
    },
  ];
}

/** 系统提示（断线、内核回收这类）：属于转写的一部分，切走再回来还看得见 */
export function appendSystem(
  items: ChatItem[],
  text: string,
  opts: ApplyOptions = {},
): ChatItem[] {
  const now = opts.now ?? Date.now;
  const nextId = opts.nextId ?? defaultNextId;
  return [...items, { kind: "system", id: nextId(), text, at: now() }];
}
