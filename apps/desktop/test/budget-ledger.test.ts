import test from "node:test";
import assert from "node:assert/strict";

import { applyCost, budgetStatusOf, shouldAlert } from "../src/main/budget-ledger.ts";

/** 修改 4 · M2：钱要记到**花它的那个会话**头上，日账只加增量（ADR-017）。 */

const limits = { sessionLimit: 1, dailyLimit: 5, alertRatio: 0.8 };

function emptyLedger(today = "2026-11-24") {
  return { dailyDate: today, dailySpent: 0, sessionCosts: {} };
}

test("会话账按文件分：A 的花费不影响 B 的会话额度", () => {
  const ledger = { ...emptyLedger(), sessionCosts: { "D:/p/a.jsonl": 0.9 } };
  const a = budgetStatusOf({ cost: 0.9, sessionFile: "D:/p/a.jsonl", ledger, limits });
  const b = budgetStatusOf({ cost: 0.1, sessionFile: "D:/p/b.jsonl", ledger, limits });
  assert.equal(a.sessionUsd, 0.9);
  assert.equal(b.sessionUsd, 0.1, "B 的会话花费是它自己的，不是 A 的");
});

test("日账只加增量：同一笔钱刷新两次不会算两遍", () => {
  const first = applyCost({ cost: 0.30, sessionFile: "D:/p/a.jsonl", ledger: emptyLedger(), today: "2026-11-24" });
  assert.equal(first.ledger.dailySpent, 0.3);
  assert.equal(first.delta, 0.3);

  const second = applyCost({
    cost: 0.30,
    sessionFile: "D:/p/a.jsonl",
    ledger: first.ledger,
    today: "2026-11-24",
  });
  assert.equal(second.ledger.dailySpent, 0.3, "没有新花费就不该再加");
  assert.equal(second.delta, 0);

  const third = applyCost({
    cost: 0.50,
    sessionFile: "D:/p/a.jsonl",
    ledger: second.ledger,
    today: "2026-11-24",
  });
  assert.equal(third.ledger.dailySpent.toFixed(6), "0.500000");
  assert.equal(third.delta.toFixed(6), "0.200000", "只加多出来的 0.2");
});

test("两个会话交替记账，日账是两人之和、会话账各归各", () => {
  let ledger = emptyLedger();
  ledger = applyCost({ cost: 0.10, sessionFile: "D:/p/a.jsonl", ledger, today: "2026-11-24" }).ledger;
  ledger = applyCost({ cost: 0.20, sessionFile: "D:/p/b.jsonl", ledger, today: "2026-11-24" }).ledger;
  ledger = applyCost({ cost: 0.40, sessionFile: "D:/p/a.jsonl", ledger, today: "2026-11-24" }).ledger;

  assert.equal(ledger.sessionCosts["D:/p/a.jsonl"], 0.4);
  assert.equal(ledger.sessionCosts["D:/p/b.jsonl"], 0.2);
  assert.equal(Number(ledger.dailySpent.toFixed(6)), 0.6);
});

test("费用倒退（重启后重新计数）不加钱", () => {
  const ledger = { ...emptyLedger(), sessionCosts: { "D:/p/a.jsonl": 0.8 }, dailySpent: 0.8 };
  const next = applyCost({ cost: 0.1, sessionFile: "D:/p/a.jsonl", ledger, today: "2026-11-24" });
  assert.equal(next.delta, 0);
  assert.equal(next.ledger.dailySpent, 0.8);
});

test("跨天：日账清零、会话账保留", () => {
  const ledger = { dailyDate: "2026-11-23", dailySpent: 4.2, sessionCosts: { "D:/p/a.jsonl": 0.5 } };
  const next = applyCost({ cost: 0.6, sessionFile: "D:/p/a.jsonl", ledger, today: "2026-11-24" });
  assert.equal(next.rollover, true);
  assert.equal(next.ledger.dailyDate, "2026-11-24");
  assert.equal(next.ledger.dailySpent.toFixed(6), "0.100000", "只算今天新花的 0.1");
  assert.equal(next.ledger.sessionCosts["D:/p/a.jsonl"], 0.6);
});

test("没有会话文件时不记会话账（不编一个键出来）", () => {
  const next = applyCost({ cost: 0.3, sessionFile: null, ledger: emptyLedger(), today: "2026-11-24" });
  assert.equal(next.delta, 0);
  assert.deepEqual(next.ledger.sessionCosts, {});
  assert.equal(next.ledger.dailySpent, 0);
});

test("告警阈值按会话与日账分别判", () => {
  const sessionHot = budgetStatusOf({ cost: 0.85, sessionFile: "D:/p/a.jsonl", ledger: emptyLedger(), limits });
  assert.equal(shouldAlert(sessionHot, limits), true);
  const bothCold = budgetStatusOf({ cost: 0.1, sessionFile: "D:/p/a.jsonl", ledger: emptyLedger(), limits });
  assert.equal(shouldAlert(bothCold, limits), false);
});
