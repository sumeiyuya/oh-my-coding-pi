/**
 * 工具调用的分组与汇总（S1/S2）。
 *
 * 借自 DAWN 的 `tool-group.ts`，三条纪律原样保留：
 * 1. **≥2 条相邻**才算一组；隔着任何别的东西就断开；
 * 2. 组的 key 用**第一条**的 id——流式追加时组还会变长，key 稳定才不会把
 *    用户刚点开的展开状态冲掉；
 * 3. **总时长缺一段就不给**——少算一截的总数看起来很确定，而它是错的。
 */

export interface ToolItem {
  id: string;
  name: string;
  /** 原始入参（JSON 字符串，来自 tool_execution_start） */
  args: string;
  done: boolean;
  result?: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  /** 被用户停下（停止 / 调整方向）：不算失败 */
  interrupted?: boolean;
}

/** 时长：毫秒 → 人话；≥60s 用分，其余保留一位小数 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} 秒`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

/** 安全解析入参；解析不出来就返回空对象，绝不抛 */
export function parseToolArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export type ToolLanguage = "python" | "r";

/**
 * run_code 的语言：参数里 language=r 才是 R；没有该字段按工具默认 Python；
 * 参数被截断/不是合法 JSON 时返回 null（不猜，也不显示徽标）。
 */
export function toolLanguage(item: Pick<ToolItem, "name" | "args">): ToolLanguage | null {
  if (item.name !== "run_code") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.args);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const input = parsed as Record<string, unknown>;
  const value = typeof input.language === "string" ? input.language.trim().toLowerCase() : "python";
  return value === "r" ? "r" : "python";
}

/** 一行摘要：优先命令，其次路径，最后退回工具名 */
export function toolCommandLine(item: Pick<ToolItem, "name" | "args">): string {
  const input = parseToolArgs(item.args);
  const candidates = [input.command, input.cmd, input.script, input.path, input.file, input.query];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // 没有已知字段：取第一个非空字符串值，总比什么都不显示好
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return item.name;
}

/**
 * 运行中时组头显示的可执行名。
 *
 * 比 DAWN 多走一步：它取**第一段**可执行，`cd x && pnpm build` 会显示 "cd"（没信息量）。
 * 这里取**最后一段**（按 `&&` / `||` / `;` / `|` 切），于是显示 "pnpm build" 里的 "pnpm"。
 */
export function runningLabel(item: ToolItem): string {
  const command = toolCommandLine(item);
  const last = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
  const match = /(?:^|\s)(?:[^\s/]+\/)?([^\s]+)/.exec(last);
  return match?.[1] || item.name;
}

export interface ToolSummary {
  count: number;
  allCommands: boolean;
  failures: number;
  running: ToolItem | undefined;
  /** 各条耗时之和；有任何一条缺起止时刻就是 undefined */
  totalMs: number | undefined;
}

export function summarizeTools(tools: readonly ToolItem[]): ToolSummary {
  let failures = 0;
  let running: ToolItem | undefined;
  let total: number | undefined = 0;
  for (const t of tools) {
    if (t.isError && !t.interrupted) failures += 1;
    if (!t.done) running = t;
    if (total !== undefined) {
      total =
        t.startedAt !== undefined && t.endedAt !== undefined
          ? total + Math.max(0, t.endedAt - t.startedAt)
          : undefined;
    }
  }
  return {
    count: tools.length,
    allCommands: tools.every((t) => t.name === "bash"),
    failures,
    running,
    totalMs: running ? undefined : total,
  };
}

const KIND: Record<string, "read" | "write" | "command"> = {
  read: "read",
  read_file: "read",
  write: "write",
  edit: "write",
  bash: "command",
};

export interface PhrasePart {
  kind: "read" | "write" | "command" | "tool";
  count: number;
  name?: string;
}

/** 计数短语，按出现顺序；组头再拼成一句 */
export function groupPhrase(tools: readonly ToolItem[]): PhrasePart[] {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const kind = KIND[t.name] ?? `tool:${t.name}`;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) =>
    kind.startsWith("tool:")
      ? { kind: "tool" as const, name: kind.slice(5), count }
      : { kind: kind as "read" | "write" | "command", count },
  );
}

/** 组头那一句（不含时长与失败数，那两块由组件单独渲染） */
export function groupSentence(tools: readonly ToolItem[]): string {
  const parts = groupPhrase(tools).map((p) => {
    if (p.kind === "command") return `跑了 ${p.count} 条命令`;
    if (p.kind === "read") return `读了 ${p.count} 个文件`;
    if (p.kind === "write") return `写了 ${p.count} 个文件`;
    return `调用了 ${p.count} 次 ${p.name}`;
  });
  return parts.join("、");
}

export type Block<T> =
  | { kind: "item"; item: T; index: number }
  | { kind: "group"; key: string; items: T[]; index: number };

/**
 * 把相邻的工具项折成组（≥2 条）；其它项原样保留。
 * `isTool` 判断是不是工具项，`keyOf` 取唯一 id（用第一条的 id 当组 key）。
 */
export function groupAdjacent<T>(
  items: readonly T[],
  isTool: (item: T) => boolean,
  keyOf: (item: T) => string,
): Array<Block<T>> {
  const out: Array<Block<T>> = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (isTool(item)) {
      let j = i;
      while (j < items.length && isTool(items[j]!)) j += 1;
      if (j - i >= 2) {
        const run = items.slice(i, j);
        out.push({ kind: "group", key: `group:${keyOf(run[0]!)}`, items: run, index: i });
        i = j;
        continue;
      }
    }
    out.push({ kind: "item", item, index: i });
    i += 1;
  }
  return out;
}

/** 输出折叠：保留前 N 行，并如实报出被藏了多少行 */
export function foldOutput(result: string | undefined, expanded: boolean, headLines = 8): { text: string; hidden: number } | undefined {
  if (result === undefined) return undefined;
  const lines = result.split("\n");
  const hidden = Math.max(0, lines.length - headLines);
  if (expanded || hidden === 0) return { text: result, hidden };
  return { text: lines.slice(0, headLines).join("\n"), hidden };
}
