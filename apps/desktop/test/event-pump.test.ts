import test from "node:test";
import assert from "node:assert/strict";

import { EventPump } from "../src/main/event-pump.ts";
import type { PiEvent } from "@oh-my-coding-pi/shared";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function text(delta: string, contentIndex = 0): PiEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex, delta },
  };
}

function toolEnd(): PiEvent {
  return {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [] },
    isError: false,
  };
}

test("同一 contentIndex 的文本增量合并成一帧", async () => {
  const out: PiEvent[] = [];
  const pump = new EventPump({ emit: (e) => out.push(e), windowMs: 5 });
  pump.push(text("你"));
  pump.push(text("好"));
  assert.equal(out.length, 0, "窗口内不应立即发出");
  await tick();
  assert.equal(out.length, 1);
  const ev = out[0] as Extract<PiEvent, { type: "message_update" }>;
  assert.equal(ev.assistantMessageEvent.type, "text_delta");
  assert.equal((ev.assistantMessageEvent as { delta: string }).delta, "你好");
});

test("非增量事件先 flush，顺序不倒", async () => {
  const out: PiEvent[] = [];
  const pump = new EventPump({ emit: (e) => out.push(e), windowMs: 50 });
  pump.push(text("a"));
  pump.push(toolEnd());
  assert.equal(out.length, 2);
  assert.equal(out[0]!.type, "message_update");
  assert.equal(out[1]!.type, "tool_execution_end");
});

test("超过字节上限立即 flush", () => {
  const out: PiEvent[] = [];
  const pump = new EventPump({ emit: (e) => out.push(e), windowMs: 50, maxBytes: 8 });
  pump.push(text("12345"));
  pump.push(text("67890"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, "message_update");
});

test("关闭合并时逐条转发", () => {
  const out: PiEvent[] = [];
  const pump = new EventPump({ emit: (e) => out.push(e), enabled: false });
  pump.push(text("a"));
  pump.push(text("b"));
  assert.equal(out.length, 2);
});

test("text 与 thinking 分开合并，dispose 会冲掉尾巴", () => {
  const out: PiEvent[] = [];
  const pump = new EventPump({ emit: (e) => out.push(e), windowMs: 50 });
  pump.push(text("t1"));
  pump.push({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "k1" },
  });
  pump.dispose();
  assert.equal(out.length, 2);
  const kinds = out.map((e) => (e as Extract<PiEvent, { type: "message_update" }>).assistantMessageEvent.type);
  assert.deepEqual(kinds, ["text_delta", "thinking_delta"]);
});

test("usage 随合并帧带上", () => {
  const out: PiEvent[] = [];
  const pump = new EventPump({ emit: (e) => out.push(e), windowMs: 5 });
  pump.push({
    type: "message_update",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
  } as PiEvent);
  pump.dispose();
  const ev = out[0] as Extract<PiEvent, { type: "message_update" }>;
  assert.equal(ev.usage?.totalTokens, 3);
});
