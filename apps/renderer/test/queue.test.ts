import test from "node:test";
import assert from "node:assert/strict";

import { flattenQueue, joinTakeBack, planRedirect, removeQueuedMessages } from "../src/queue.ts";

/** 待发队列的纯逻辑（修改 2）。 */

test("展平：转向在前", () => {
  assert.deepEqual(flattenQueue({ steering: ["s"], followUp: ["a", "b"] }), ["s", "a", "b"]);
});

test("取回：从尾部按文本撤气泡，不误删更早的同句", () => {
  const msgs = [
    { kind: "user", text: "同一句" },
    { kind: "assistant", text: "回答" },
    { kind: "user", text: "同一句" },
  ];
  const out = removeQueuedMessages(msgs, ["同一句"]);
  assert.equal(out.length, 2);
  assert.equal(out[2 - 1].kind, "assistant");
});

test("调整方向：目标立即转向，其余按原顺序排队", () => {
  const plan = planRedirect({ steering: [], followUp: ["A", "B", "C"] }, 1);
  assert.deepEqual(plan, { steer: "B", followUp: ["A", "C"] });
  assert.equal(planRedirect({ steering: [], followUp: [] }, 0), null);
  assert.equal(planRedirect({ steering: [], followUp: ["A"] }, 5), null);
});

test("取回回填：队列在前、草稿在后", () => {
  assert.equal(joinTakeBack(["A", "B"], "草稿"), "A\n\nB\n\n草稿");
  assert.equal(joinTakeBack([], "草稿"), "草稿");
});
