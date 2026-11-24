import test from "node:test";
import assert from "node:assert/strict";

import { applyPiEvent, appendSystem, appendUserTurn, type ChatItem } from "../src/transcript.ts";
import type { PiEvent } from "../src/protocol.ts";

/** 修改 4 · M1：实时增量只留一份归约（主进程与渲染端共用）。 */

let n = 0;
const opts = { now: () => 1_000, nextId: () => `x${++n}` };

const assistantStart = { type: "message_start", message: { role: "assistant", content: [] } } as unknown as PiEvent;
const delta = (text: string) =>
  ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  }) as unknown as PiEvent;
const end = (text: string) =>
  ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) as unknown as PiEvent;
const toolStart = (id: string, name: string) =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: { a: 1 } }) as unknown as PiEvent;
const toolEnd = (id: string, text: string, isError = false) =>
  ({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "bash",
    isError,
    result: { content: [{ type: "text", text }] },
  }) as unknown as PiEvent;

test("流式文本：start + 两段 delta → 一条 assistant，文本拼齐", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, assistantStart, opts);
  items = applyPiEvent(items, delta("你"), opts);
  items = applyPiEvent(items, delta("好"), opts);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "assistant");
  assert.equal((items[0] as { text: string }).text, "你好");
});

test("message_end 用最终文本覆盖（含工具调用之后的收尾）", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, assistantStart, opts);
  items = applyPiEvent(items, delta("半句"), opts);
  items = applyPiEvent(items, end("完整的一句话"), opts);
  assert.equal((items[0] as { text: string }).text, "完整的一句话");
  assert.equal(items.length, 1, "不该多出一条");
});

test("没有 message_start 的 delta 也能接住（乱序/补发）", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, delta("直接开说"), opts);
  assert.equal(items.length, 1);
  assert.equal((items[0] as { text: string }).text, "直接开说");
});

test("工具：start 追加、end 就地补结果并打完成", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, toolStart("t1", "bash"), opts);
  assert.deepEqual(
    { kind: items[0]!.kind, done: (items[0] as { done: boolean }).done },
    { kind: "tool", done: false },
  );
  items = applyPiEvent(items, toolEnd("t1", "ok"), opts);
  const tool = items[0] as { done: boolean; result?: string; endedAt?: number };
  assert.equal(tool.done, true);
  assert.equal(tool.result, "ok");
  assert.equal(tool.endedAt, 1_000);
});

test("失败的工具带 isError，但仍然算完成", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, toolStart("t1", "bash"), opts);
  items = applyPiEvent(items, toolEnd("t1", "boom", true), opts);
  const tool = items[0] as { done: boolean; isError?: boolean };
  assert.equal(tool.done, true);
  assert.equal(tool.isError, true);
});

test("找不到对应 tool 的 end 事件被忽略（不改列表）", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, toolStart("t1", "bash"), opts);
  const before = items;
  items = applyPiEvent(items, toolEnd("nope", "x"), opts);
  assert.equal(items, before, "返回同一个引用");
});

test("工具之后的 assistant 文本不会粘到前一条上", () => {
  let items: ChatItem[] = [];
  items = applyPiEvent(items, assistantStart, opts);
  items = applyPiEvent(items, end("先说话"), opts);
  items = applyPiEvent(items, toolStart("t1", "bash"), opts);
  items = applyPiEvent(items, toolEnd("t1", "ok"), opts);
  items = applyPiEvent(items, assistantStart, opts);
  items = applyPiEvent(items, delta("再说话"), opts);
  assert.equal(items.length, 3);
  assert.equal((items[2] as { text: string }).text, "再说话", "新的一条，不是拼到上面那条");
  assert.equal((items[0] as { text: string }).text, "先说话", "前一条没被动过");
});

test("用户轮次与系统提示各自成条", () => {
  let items: ChatItem[] = [];
  items = appendUserTurn(items, "跑一下", opts);
  items = appendSystem(items, "内核已回收", opts);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, "user");
  assert.equal(items[1]!.kind, "system");
});

test("不认识的事件原样返回（引用不变，便于上层判断有没有变）", () => {
  const items: ChatItem[] = [{ kind: "assistant", id: "a", text: "x" }];
  const same = applyPiEvent(items, { type: "agent_start" } as PiEvent, opts);
  assert.equal(same, items);
});
