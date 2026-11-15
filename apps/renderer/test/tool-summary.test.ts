import test from "node:test";
import assert from "node:assert/strict";

import {
  foldOutput,
  formatDuration,
  groupAdjacent,
  groupPhrase,
  groupSentence,
  parseToolArgs,
  runningLabel,
  summarizeTools,
  toolCommandLine,
  type ToolItem,
} from "../src/tool-summary.ts";

/** 工具折叠的纯逻辑（S1/S2）：时长、汇总、分组、折叠输出。 */

const tool = (over: Partial<ToolItem> = {}): ToolItem => ({
  id: `t${Math.random().toString(36).slice(2, 7)}`,
  name: "bash",
  args: JSON.stringify({ command: "ls" }),
  done: true,
  startedAt: 1000,
  endedAt: 1400,
  ...over,
});

test("formatDuration：毫秒 / 秒 / 分", () => {
  assert.equal(formatDuration(900), "900 毫秒");
  assert.equal(formatDuration(1400), "1.4 秒");
  assert.equal(formatDuration(2000), "2 秒");
  assert.equal(formatDuration(77_000), "1 分 17 秒");
  assert.equal(formatDuration(60_000), "1 分");
});

test("parseToolArgs：坏 JSON 返回空对象，不抛", () => {
  assert.deepEqual(parseToolArgs("{ not json"), {});
  assert.deepEqual(parseToolArgs("[1,2]"), {});
  assert.deepEqual(parseToolArgs('{"command":"ls"}'), { command: "ls" });
});

test("toolCommandLine：命令 > 路径 > 第一个字符串 > 工具名", () => {
  assert.equal(toolCommandLine({ name: "bash", args: '{"command":"pnpm build"}' }), "pnpm build");
  assert.equal(toolCommandLine({ name: "read", args: '{"path":"a.ts"}' }), "a.ts");
  assert.equal(toolCommandLine({ name: "x", args: '{"foo":"bar"}' }), "bar");
  assert.equal(toolCommandLine({ name: "x", args: "{" }), "x");
});

test("runningLabel：取可执行名", () => {
  assert.equal(runningLabel(tool({ name: "bash", args: '{"command":"cd /tmp && pnpm build 2>&1"}' })), "pnpm");
});

test("汇总：失败只数 isError 且未中断的", () => {
  const s = summarizeTools([
    tool({ isError: true }),
    tool({ isError: true, interrupted: true }),
    tool(),
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.failures, 1);
});

test("汇总：任一缺起止时刻就不给总时长", () => {
  const ok = summarizeTools([tool(), tool()]);
  assert.equal(ok.totalMs, 800);

  const missing = summarizeTools([tool(), tool({ endedAt: undefined })]);
  assert.equal(missing.totalMs, undefined);
});

test("汇总：有在跑的条目时不算总时长，并报出它", () => {
  const running = tool({ id: "run", done: false, endedAt: undefined });
  const s = summarizeTools([tool(), running]);
  assert.equal(s.running?.id, "run");
  assert.equal(s.totalMs, undefined);
});

test("汇总：全是 bash 才算「全是命令」", () => {
  assert.equal(summarizeTools([tool(), tool()]).allCommands, true);
  assert.equal(summarizeTools([tool(), tool({ name: "read" })]).allCommands, false);
});

test("短语：命令/读/写/其它工具分别计数，按出现顺序", () => {
  const parts = groupPhrase([
    tool(),
    tool(),
    tool({ name: "read" }),
    tool({ name: "edit" }),
    tool({ name: "browser_open" }),
  ]);
  assert.deepEqual(parts.map((p) => p.kind), ["command", "read", "write", "tool"]);
  assert.equal(groupSentence([
    tool(), tool(), tool({ name: "read" }), tool({ name: "edit" }), tool({ name: "browser_open" }),
  ]), "跑了 2 条命令、读了 1 个文件、写了 1 个文件、调用了 1 次 browser_open");
});

test("分组：≥2 条相邻成组，单条不成组", () => {
  const items = [tool({ id: "a" }), tool({ id: "b" })];
  const blocks = groupAdjacent(items, () => true, (x) => x.id);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, "group");

  const single = groupAdjacent([tool({ id: "a" })], () => true, (x) => x.id);
  assert.equal(single[0]!.kind, "item");
});

test("分组：隔着别的消息就断开", () => {
  type Row = { kind: string; id?: string };
  const rows: Row[] = [
    { kind: "tool", id: "a" },
    { kind: "assistant", id: "x" },
    { kind: "tool", id: "b" },
    { kind: "tool", id: "c" },
  ];
  const blocks = groupAdjacent(rows, (r) => r.kind === "tool", (r) => r.id ?? "?");
  assert.deepEqual(blocks.map((b) => b.kind), ["item", "item", "group"]);
});

test("分组：组 key 用第一条的 id（流式追加不换 key）", () => {
  const a = tool({ id: "first" });
  const b = tool({ id: "second" });
  const one = groupAdjacent([a, b], () => true, (x) => x.id);
  const two = groupAdjacent([a, b, tool({ id: "third" })], () => true, (x) => x.id);
  assert.equal((one[0] as { key: string }).key, "group:first");
  assert.equal((two[0] as { key: string }).key, "group:first");
});

test("输出折叠：保留前 8 行并报剩余行数", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const folded = foldOutput(text, false);
  assert.equal(folded?.text.split("\n").length, 8);
  assert.equal(folded?.hidden, 12);

  const full = foldOutput(text, true);
  assert.equal(full?.text.split("\n").length, 20);
  assert.equal(full?.hidden, 12);

  assert.equal(foldOutput(undefined, false), undefined);
});
