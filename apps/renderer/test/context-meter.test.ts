import test from "node:test";
import assert from "node:assert/strict";
import { readMeter } from "../src/context-meter.ts";
import type { SessionStats } from "@oh-my-coding-pi/shared";

function stats(usage?: SessionStats["contextUsage"]): SessionStats {
  return {
    sessionId: "s",
    sessionFile: "f",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...(usage ? { contextUsage: usage } : {}),
  };
}

test("没有 stats：显示 —，不编数", () => {
  const r = readMeter(null);
  assert.equal(r.value, "—");
  assert.equal(r.detail.length > 0, true);
});

test("没有 contextUsage：显示 —", () => {
  assert.equal(readMeter(stats()).value, "—");
});

test("首轮之前（tokens=null 且非压缩）：显示 —", () => {
  const r = readMeter(stats({ tokens: null, contextWindow: 200000, percent: null }));
  assert.equal(r.value, "—");
  assert.match(r.detail[0]!, /第一次回复/);
});

test("刚压缩过：显示「已压缩」", () => {
  const r = readMeter(stats({ tokens: null, contextWindow: 200000, percent: null, afterCompaction: true }));
  assert.equal(r.value, "已压缩");
});

test("正常读数：百分比 + 已用/上限", () => {
  const r = readMeter(
    stats({ tokens: 100000, contextWindow: 200000, percent: 50, usedTokens: 100000, compactAt: 183616 }),
  );
  assert.equal(r.value, "50%");
  assert.match(r.detail[0]!, /100k \/ 200k/);
});

test("接近压缩线（≥85%）：warn", () => {
  const r = readMeter(
    stats({
      tokens: 160000,
      contextWindow: 200000,
      percent: 80,
      usedTokens: 160000,
      compactAt: 183616,
    }),
  );
  assert.equal(r.tone, "warn");
  assert.match(r.detail.join(" "), /快满了/);
});

test("过压缩线：over", () => {
  const r = readMeter(
    stats({
      tokens: 190000,
      contextWindow: 200000,
      percent: 95,
      usedTokens: 190000,
      compactAt: 183616,
    }),
  );
  assert.equal(r.tone, "over");
  assert.match(r.detail.join(" "), /下一次回复之前会先压缩/);
});

test("估算值加「约」", () => {
  const r = readMeter(
    stats({ tokens: 5000, contextWindow: 200000, percent: 2.5, usedTokens: 5000, estimated: true }),
  );
  assert.match(r.value, /^约 /);
});

test("没有上限：只显示 token 数，不给百分比", () => {
  const r = readMeter(stats({ tokens: 5000, contextWindow: 0, percent: null, usedTokens: 5000 }));
  assert.equal(r.value, "5k");
  assert.match(r.detail.join(" "), /没报上限/);
});

test("压缩线说明里写明是按默认推算", () => {
  const r = readMeter(
    stats({ tokens: 1000, contextWindow: 200000, percent: 1, usedTokens: 1000, compactAt: 183616 }),
  );
  assert.match(r.detail.join(" "), /按默认值推算/);
});
