import test from "node:test";
import assert from "node:assert/strict";

import { STICK_THRESHOLD, isNearBottom, unreadAfter } from "../src/scroll-stick.ts";

/** 修改四：贴底判定与"离开底部后的新消息计数"。 */

test("正好在底部 → 贴底", () => {
  assert.equal(isNearBottom(900, 1000, 100), true); // 1000-100-900 = 0
});

test("阈值内（24px）仍算贴底，多出 1px 就不算", () => {
  assert.equal(isNearBottom(876, 1000, 100), true); // 剩 24
  assert.equal(isNearBottom(875, 1000, 100), false); // 剩 25
});

test("内容比视口矮（不能滚动）→ 算贴底", () => {
  assert.equal(isNearBottom(0, 300, 500), true);
});

test("滚到顶部读历史 → 不贴底（这时才该出按钮）", () => {
  assert.equal(isNearBottom(0, 5000, 700), false);
});

test("拿不到尺寸（NaN/未挂载）→ 当作贴底，别误报按钮", () => {
  assert.equal(isNearBottom(Number.NaN, 100, 100), true);
  assert.equal(isNearBottom(0, Number.NaN, 100), true);
});

test("自定义阈值", () => {
  assert.equal(isNearBottom(860, 1000, 100, 50), true); // 剩 40 ≤ 50
  assert.equal(isNearBottom(860, 1000, 100, 10), false);
});

test("计数：在底部永远 0", () => {
  assert.equal(unreadAfter(0, 3, true), 0);
  assert.equal(unreadAfter(5, 3, true), 0);
});

test("计数：离开底部后累加，负数入参不倒退", () => {
  assert.equal(unreadAfter(0, 1, false), 1);
  assert.equal(unreadAfter(2, 3, false), 5);
  assert.equal(unreadAfter(4, -2, false), 4);
  assert.equal(unreadAfter(-3, 1, false), 1);
});

test("阈值常量是 24（一点点没到底不该频繁闪按钮）", () => {
  assert.equal(STICK_THRESHOLD, 24);
});
