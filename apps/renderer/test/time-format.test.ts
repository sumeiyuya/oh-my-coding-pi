import test from "node:test";
import assert from "node:assert/strict";

import { formatElapsed } from "../src/time-format.ts";

/** 修改 5 · D1：标签上的运行时长。边界比正例更容易写错，所以只钉边界。 */

test("一分钟以内也给秒（0:07，而不是 0:00）", () => {
  assert.equal(formatElapsed(7000), "0:07");
  assert.equal(formatElapsed(999), "0:00");
});

test("分秒进位", () => {
  assert.equal(formatElapsed(61_000), "1:01");
  assert.equal(formatElapsed(59 * 60_000 + 59_000), "59:59");
});

test("超过一小时用 h:mm:ss", () => {
  assert.equal(formatElapsed(3600_000), "1:00:00");
  assert.equal(formatElapsed(3600_000 + 61_000), "1:01:01");
});

test("负数与零一律 0:00（时钟回退不显示负号）", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(-5000), "0:00");
});
