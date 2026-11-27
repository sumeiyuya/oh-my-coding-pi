/**
 * 预算账本（修改 4 · M2 抽出）。
 *
 * 两条口径（ADR-014 / ADR-017）：
 *  - **会话账按文件分**：每个会话各自累计自己的花费；
 *  - **日账按增量累加**：`dailySpent` 只加"这次比上次多出来的那部分"，
 *    否则同一笔钱会在每次刷新时被反复计入。
 *
 * 这里只放纯函数：读盘、写盘、告警都由调用方做，便于单测
 * （尤其是"两个会话同时跑，钱记到谁头上"这种问题）。
 */
import type { BudgetStatus } from "@oh-my-coding-pi/shared";

export interface BudgetLimits {
  sessionLimit: number;
  dailyLimit: number;
  alertRatio: number;
}

export interface LedgerState {
  dailyDate: string;
  dailySpent: number;
  /** 会话文件 → 该会话已花费（美元） */
  sessionCosts: Record<string, number>;
}

/** 账面上的状态：日账按"如果这一笔算进去"的口径投影 */
export function budgetStatusOf(input: {
  cost: number;
  sessionFile: string | null;
  ledger: LedgerState;
  limits: BudgetLimits;
}): BudgetStatus {
  const previous = input.sessionFile ? input.ledger.sessionCosts[input.sessionFile] ?? 0 : 0;
  const projectedDaily = input.ledger.dailySpent + Math.max(0, input.cost - previous);
  return {
    sessionUsd: input.cost,
    dailyUsd: projectedDaily,
    sessionLimit: input.limits.sessionLimit,
    dailyLimit: input.limits.dailyLimit,
    alertRatio: input.limits.alertRatio,
  };
}

/**
 * 记一笔：把 `cost` 与上次记录的差额加进日账，并更新该会话的花费。
 *
 * 返回新的账本（不就地改传入的对象，调用方决定什么时候落盘）。
 * `cost` 比上次**小**时（换会话、pi 重启后重新计数）按 0 增，不倒退。
 */
export function applyCost(input: {
  cost: number;
  sessionFile: string | null;
  ledger: LedgerState;
  today: string;
}): { ledger: LedgerState; delta: number; rollover: boolean } {
  const rollover = Boolean(input.ledger.dailyDate) && input.ledger.dailyDate !== input.today;
  const base = rollover || !input.ledger.dailyDate
    ? { dailyDate: input.today, dailySpent: 0, sessionCosts: input.ledger.sessionCosts }
    : input.ledger;

  if (!input.sessionFile) {
    return { ledger: { ...base }, delta: 0, rollover };
  }

  const previous = base.sessionCosts[input.sessionFile] ?? 0;
  const delta = Math.max(0, input.cost - previous);
  return {
    ledger: {
      dailyDate: base.dailyDate,
      dailySpent: base.dailySpent + delta,
      sessionCosts: { ...base.sessionCosts, [input.sessionFile]: input.cost },
    },
    delta,
    rollover,
  };
}

/**
 * 「任一上限超过比例」的通用判断。
 *
 * 修改 5 · D1 起，日账的提醒改成按档位（80% / 100%）在 `maybeReportDailyBudget`
 * 里单独处理——因为后台会话也在烧钱，日账提醒不该按会话各响一遍。
 * 这个函数保留给需要"任一超线"判断的调用方与单测。
 */
export function shouldAlert(
  status: BudgetStatus,
  limits: BudgetLimits,
): boolean {
  return (
    status.sessionUsd >= limits.sessionLimit * limits.alertRatio ||
    status.dailyUsd >= limits.dailyLimit * limits.alertRatio
  );
}
