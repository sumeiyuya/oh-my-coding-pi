/** 页签是“快速切换”，不是多开。这里只做数组与上限，不碰会话。 */

export const TABS_KEY = "omcp.sessionTabs";
export const TABS_MAX = 8;

/** 从 localStorage 读出来的东西一律当脏数据：非字符串、空串、重复都丢掉。 */
export function sanitizeTabs(raw: unknown, max = TABS_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const file = item.trim();
    if (!file || out.includes(file)) continue;
    out.push(file);
  }
  return out.slice(-max);
}

/** 已经开着的返回原数组，方便调用方判断“没变化”。超过上限丢最早的，保证新开的在列表里。 */
export function pushTab(tabs: string[], file: string, max = TABS_MAX): string[] {
  if (!file || tabs.includes(file)) return tabs;
  const next = [...tabs, file];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 只保留当前工作区真实存在的会话；当前会话不在列表里就补上。 */
export function pruneTabs(
  tabs: string[],
  valid: Set<string>,
  current: string | null,
  max = TABS_MAX,
): string[] {
  let next = tabs.filter((f) => valid.has(f));
  if (current && valid.has(current) && !next.includes(current)) next = [...next, current];
  if (next.length > max) next = next.slice(next.length - max);
  const same = next.length === tabs.length && next.every((f, i) => f === tabs[i]);
  return same ? tabs : next;
}
