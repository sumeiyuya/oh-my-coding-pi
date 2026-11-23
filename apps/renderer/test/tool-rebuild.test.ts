import test from "node:test";
import assert from "node:assert/strict";

import { messagesFromAgent } from "../src/tool-rebuild.ts";

/**
 * 工具行重建（修改 4）。
 *
 * 锁住：工具调用是转写的一部分——刷新 / 切会话 / 下一段对话都不能把它洗掉。
 */

const run = (content: unknown, role = "assistant", extra: Record<string, unknown> = {}) =>
  ({ role, content, ...extra }) as never;

test("工具调用重建为 kind=tool，并回填结果", () => {
  const out = messagesFromAgent([
    run("先看目录", "user"),
    run([{ type: "text", text: "我来跑一下" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
    run("total 0", "toolResult", { toolCallId: "c1", toolName: "bash" }),
  ]);
  assert.deepEqual(out.map((m) => m.kind), ["user", "assistant", "tool"]);
  const tool = out[2] as Extract<(typeof out)[number], { kind: "tool" }>;
  assert.equal(tool.id, "c1");
  assert.equal(tool.name, "bash");
  assert.equal(tool.done, true);
  assert.equal(tool.result, "total 0");
  assert.ok(tool.args.includes("ls"));
});

test("只有调用没有结果：done=false，且不编造输出", () => {
  const out = messagesFromAgent([run([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }])]);
  const tool = out[0] as Extract<(typeof out)[number], { kind: "tool" }>;
  assert.equal(tool.done, false);
  assert.equal(tool.result, undefined);
});

test("多个工具保持顺序，结果按 id 配对", () => {
  const out = messagesFromAgent([
    run([
      { type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
      { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } },
    ]),
    run("A", "toolResult", { toolCallId: "a" }),
    run("B", "toolResult", { toolCallId: "b" }),
  ]);
  assert.deepEqual(out.map((m) => (m.kind === "tool" ? m.id : m.kind)), ["a", "b"]);
  assert.deepEqual(out.map((m) => (m.kind === "tool" ? m.result : "")), ["A", "B"]);
});

test("失败结果透传 isError", () => {
  const out = messagesFromAgent([
    run([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
    run("boom", "toolResult", { toolCallId: "c1", isError: true }),
  ]);
  assert.equal((out[0] as { isError?: boolean }).isError, true);
});

test("工具前后的文本分成两段，不并成一句", () => {
  const out = messagesFromAgent([
    run([
      { type: "text", text: "先说一句" },
      { type: "toolCall", id: "c1", name: "bash", arguments: {} },
      { type: "text", text: "跑完了" },
    ]),
  ]);
  assert.deepEqual(out.map((m) => m.kind), ["assistant", "tool", "assistant"]);
  assert.equal((out[0] as { text: string }).text, "先说一句");
  assert.equal((out[2] as { text: string }).text, "跑完了");
});

test("纯 toolResult 的 user 消息不会变成气泡", () => {
  const out = messagesFromAgent([
    run([{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok" }] }], "user"),
  ]);
  assert.equal(out.length, 0);
});

test("user 消息保留图片块，文字照常保留", () => {
  const out = messagesFromAgent([
    run(
      [
        { type: "text", text: "看图" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
      ],
      "user",
    ),
  ]);
  assert.equal(out.length, 1);
  const msg = out[0] as Extract<(typeof out)[number], { kind: "user" }>;
  assert.equal(msg.text, "看图");
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments?.[0]?.mimeType, "image/png");
  assert.equal(msg.attachments?.[0]?.data, "YWJj");
});

test("只有图片没有文字的 user 消息也保留", () => {
  const out = messagesFromAgent([
    run([{ type: "image", data: "eA==", mimeType: "image/jpeg" }], "user"),
  ]);
  assert.equal(out.length, 1);
  assert.equal((out[0] as { text?: string }).text, "");
  assert.equal((out[0] as { attachments?: unknown[] }).attachments?.length, 1);
});
