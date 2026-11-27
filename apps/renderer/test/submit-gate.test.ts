import test from "node:test";
import assert from "node:assert/strict";

import { phaseFor, sendBlockReason } from "../src/submit-gate.ts";

/**
 * 修改 5 · 修复「别的会话在跑，这里发不出去」。
 *
 * 核心不变式：**阶段按 runtime 记账**。后台会话流式输出时，
 * 当前会话的发送门必须是开的——这正是之前那个 bug。
 */

const base = {
  text: "搜索 github 上涨星最高的开源项目",
  phase: "idle" as const,
  busy: false,
  slotReady: true,
  queued: false,
  opening: false,
};

test("别的 runtime 在流式输出，不影响这一段的阶段", () => {
  const phases = { "slot-1": "streaming" as const };
  assert.equal(phaseFor(phases, "slot-1"), "streaming");
  assert.equal(phaseFor(phases, "default"), "idle");
  // 这一段是 default（空闲）→ 可以发
  assert.equal(sendBlockReason({ ...base, phase: phaseFor(phases, "default") }), null);
});

test("没有记录的 runtime 一律视为 idle（不是 undefined）", () => {
  assert.equal(phaseFor({}, "slot-9"), "idle");
});

test("这一段自己在飞 → 拦住，并说清是 in-flight 而不是 busy", () => {
  assert.equal(sendBlockReason({ ...base, phase: "streaming" }), "in-flight");
  assert.equal(sendBlockReason({ ...base, phase: "submitting" }), "in-flight");
});

test("排队中优先于打开中（两者的提示不一样）", () => {
  assert.equal(sendBlockReason({ ...base, slotReady: false, queued: true, opening: true }), "queued");
});

test("正在打开：先拦住，别把话发给上一个会话", () => {
  assert.equal(sendBlockReason({ ...base, slotReady: false, opening: true }), "opening");
});

test("槽没就绪（还在启动）→ not-ready", () => {
  assert.equal(sendBlockReason({ ...base, slotReady: false }), "not-ready");
});

test("这一段正在跑一轮 → busy（界面改成「排队 / 追加」两个按钮）", () => {
  assert.equal(sendBlockReason({ ...base, busy: true }), "busy");
});

test("空输入不提示任何原因（不发就是不发）", () => {
  assert.equal(sendBlockReason({ ...base, text: "   " }), "empty");
});
