/**
 * 会话区滚动：什么时候该"贴底"（修改四）。
 *
 * 旧行为是**无条件贴底**——`shownMessages` 一变就 `scrollTop = scrollHeight`。
 * 于是流式回复期间视图一直在被拽回底部，用户根本读不了上面的历史；
 * 有了「回到底部」按钮也没用，因为点了之后下一批增量又把人拽走。
 *
 * 规则改成：**只有本来就在底部（距离 ≤ 阈值）才跟随**。
 * 判定写成纯函数，边界（内容比视口还矮、刚好卡在阈值、NaN）都能单测。
 */

/** 距离底部多少像素以内算"在底部" */
export const STICK_THRESHOLD = 24;

/**
 * @param scrollTop   当前滚动位置
 * @param scrollHeight 内容总高
 * @param clientHeight 视口高
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = STICK_THRESHOLD,
): boolean {
  if (![scrollTop, scrollHeight, clientHeight].every((n) => Number.isFinite(n))) return true;
  // 内容比视口矮时 remaining 为负，仍算"在底部"
  return scrollHeight - clientHeight - scrollTop <= Math.max(0, threshold);
}

/**
 * 离开底部后累计"又来了多少条"。
 *
 * 回到 `atBottom` 立刻清零——按钮上的数字是"你没看的"，不是历史总数。
 */
export function unreadAfter(previous: number, added: number, atBottom: boolean): number {
  if (atBottom) return 0;
  const base = Math.max(0, previous);
  const delta = Math.max(0, added);
  return base + delta;
}
