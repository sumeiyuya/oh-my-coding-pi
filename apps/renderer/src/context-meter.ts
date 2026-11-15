import type { SessionStats } from "@oh-my-coding-pi/shared";

/**
 * 上下文读数（C2 的纯函数部分，单测直接打）。
 *
 * 三条「不许」：不拿字节凑 token（没数就写「—」）；不给外部 agent 估数（本版只有 native）；
 * 不轮询（取数时机在组件里：换会话 / 一轮结束 / 打开弹层）。
 */

export type MeterTone = "normal" | "warn" | "over" | "dim";

export interface MeterReading {
  tone: MeterTone;
  /** 按钮上显示的那一截 */
  value: string;
  /** 弹层里的说明行 */
  detail: string[];
  canCompact: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function readMeter(stats: SessionStats | null, error?: string): MeterReading {
  if (error) return { tone: "dim", value: "—", detail: [`没取到：${error}`], canCompact: false };
  const usage = stats?.contextUsage;
  if (!usage) return { tone: "dim", value: "—", detail: ["还没有可用的上下文数据"], canCompact: false };

  const limit = usage.contextWindow;
  const line = usage.compactAt;
  const lineNote =
    line !== undefined
      ? [`可用 token 低于 ${formatTokens(limit - line)}（pi 默认 reserveTokens）时自动压缩；压缩线按默认值推算`]
      : [];

  if (usage.afterCompaction) {
    return {
      tone: "normal",
      value: "已压缩",
      detail: ["刚压缩过，等下一次回复才知道现在用了多少", ...lineNote],
      canCompact: true,
    };
  }

  const used = usage.usedTokens ?? usage.tokens;
  if (used === null || used === undefined) {
    return {
      tone: "normal",
      value: "—",
      detail: ["第一次回复之后才知道——系统提示词与工具说明也占地方，只数对话会少算", ...lineNote],
      canCompact: true,
    };
  }

  if (!limit) {
    return {
      tone: "normal",
      value: formatTokens(used),
      detail: [`已用 ${formatTokens(used)} tokens`, "这个模型没报上限，算不出比例，也不会自动压缩"],
      canCompact: true,
    };
  }

  const ratio = (used / limit) * 100;
  const percent = ratio < 1 ? "<1%" : `${Math.round(ratio)}%`;
  const over = line !== undefined && used >= line;
  const warn = line !== undefined && !over && used >= line * 0.85;
  const tone: MeterTone = over ? "over" : warn ? "warn" : "normal";
  return {
    tone,
    value: usage.estimated ? `约 ${percent}` : percent,
    detail: [
      `${formatTokens(used)} / ${formatTokens(limit)} tokens`,
      ...(usage.estimated ? ["其中有一截是估的"] : []),
      ...(over ? ["已过自动压缩线：下一次回复之前会先压缩"] : warn ? ["快满了"] : []),
      ...lineNote,
    ],
    canCompact: true,
  };
}

