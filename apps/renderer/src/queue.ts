/**
 * 待发队列的纯逻辑（修改 2）。
 *
 * 队列本身以 pi 的 queue_update 为准，这里只做三件不需要副作用的事：
 * 展平、撤回后从转写里去掉对应气泡、把某一条改成立刻转向。
 */

export interface QueueSnapshot {
  steering: string[];
  followUp: string[];
}

export const EMPTY_QUEUE: QueueSnapshot = { steering: [], followUp: [] };

/** steering 在前：pi 会先投递转向，再投递排队 */
export function flattenQueue(q: QueueSnapshot): string[] {
  return [...q.steering, ...q.followUp];
}

export type ChatItem = { kind: string; text?: string };

/**
 * 取回后把“排队时就已经显示出来的”用户气泡撤掉。
 * 从尾部按文本匹配，避免误删更早的同一句话。
 */
export function removeQueuedMessages<T extends ChatItem>(messages: T[], texts: string[]): T[] {
  const next = [...messages];
  for (const text of texts) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].kind === "user" && next[i].text === text) {
        next.splice(i, 1);
        break;
      }
    }
  }
  return next;
}

/**
 * 把某一条改成立刻转向：其余按原顺序继续排队。
 * 返回投递计划，由调用方按顺序发。
 */
export function planRedirect(
  queue: QueueSnapshot,
  index: number,
): { steer: string; followUp: string[] } | null {
  const all = flattenQueue(queue);
  const target = all[index];
  if (!target) return null;
  return { steer: target, followUp: all.filter((_, i) => i !== index) };
}

/** 取回文本回填输入框：原顺序在前，已有草稿在后 */
export function joinTakeBack(texts: string[], existing: string): string {
  const body = texts.filter((t) => t.trim()).join("\n\n");
  if (!body) return existing;
  if (!existing.trim()) return body;
  return `${body}\n\n${existing}`;
}
