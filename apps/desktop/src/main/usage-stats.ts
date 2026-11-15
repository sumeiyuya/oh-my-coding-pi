/**
 * 用量聚合（修改 4 · U2）。纯函数，输入扫描记录，输出与 DAWN 同形的结构。
 *
 * 口径写死在这里，也写在界面上：
 *   total = input + output（不含 cacheRead）
 *   unattributed = 有 token 但不知道是哪个模型
 *   silentTurns = 有回合但一条 usage 都没有
 */
import type { UsageRecord } from "./usage-scan";

export interface UsageData {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  daily: { date: string; tokens: number }[];
  byModel: { model: string; tokens: number; runs: number }[];
  peak?: { date: string; tokens: number };
  activeDays: number;
  streak: { current: number; longest: number };
  unattributed: { runs: number; tokens: number };
  silentTurns: number;
}

/** 两个日期相差几天（按本地日期字符串算，避免夏令时/时区误差） */
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const t1 = Date.UTC(ay, am - 1, ad);
  const t2 = Date.UTC(by, bm - 1, bd);
  return Math.round((t1 - t2) / 86_400_000);
}

export function aggregateUsage(records: UsageRecord[], silentTurns: number): UsageData {
  const day = new Map<string, number>();
  const models = new Map<string, { tokens: number; runs: number }>();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let unattributedRuns = 0;
  let unattributedTokens = 0;

  for (const r of records) {
    // 口径：不含 cacheRead
    const tokens = r.input + r.output;
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;

    if (tokens > 0) day.set(r.date, (day.get(r.date) ?? 0) + tokens);

    if (r.model) {
      const key = r.provider ? `${r.provider}/${r.model}` : r.model;
      const cur = models.get(key) ?? { tokens: 0, runs: 0 };
      cur.tokens += tokens;
      if (r.turn) cur.runs++;
      models.set(key, cur);
    } else if (tokens > 0) {
      unattributedTokens += tokens;
      if (r.turn) unattributedRuns++;
    }
  }

  const daily = [...day.entries()]
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const peak = daily.reduce<{ date: string; tokens: number } | undefined>(
    (best, d) => (!best || d.tokens > best.tokens ? d : best),
    undefined,
  );

  // 连续天数：从“最近有量的一天”往回数；今天没量不算断（当天还没开始用）
  const dates = daily.map((d) => d.date);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i > 0 && dayDiff(dates[i]!, dates[i - 1]!) === 1) run++;
    else run = 1;
    longest = Math.max(longest, run);
  }
  let current = 0;
  if (dates.length > 0) {
    const last = dates[dates.length - 1]!;
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    const gap = dayDiff(todayStr, last);
    if (gap <= 1) {
      current = 1;
      for (let i = dates.length - 1; i > 0; i--) {
        if (dayDiff(dates[i]!, dates[i - 1]!) === 1) current++;
        else break;
      }
    }
  }

  return {
    total: input + output,
    input,
    output,
    cacheRead,
    daily,
    byModel: [...models.entries()]
      .map(([model, v]) => ({ model, tokens: v.tokens, runs: v.runs }))
      .sort((a, b) => b.tokens - a.tokens),
    ...(peak ? { peak } : {}),
    activeDays: daily.length,
    streak: { current, longest },
    unattributed: { runs: unattributedRuns, tokens: unattributedTokens },
    silentTurns,
  };
}
