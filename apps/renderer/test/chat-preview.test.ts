import test from "node:test";
import assert from "node:assert/strict";

import { pickMessages } from "../src/chat-preview.ts";

/**
 * 修改 5 · S5b：打开会话时先画哪一份。
 *
 * 这里的错误代价是"串台"——A 的快照画在 B 上，用户会以为那几句话是 B 说的。
 * 所以两条边界（预览属于别的文件 / 预览为空）都得钉住。
 */

const A = "D:\\ws\\.omcp\\sessions\\a.jsonl";
const B = "D:\\ws\\.omcp\\sessions\\b.jsonl";
const bucket = [{ id: "b-1" }];

test("预览属于当前文件 → 画预览（历史先到）", () => {
  const preview = { file: A, items: [{ id: "a-1" }, { id: "a-2" }] };
  assert.deepEqual(pickMessages(preview, A, bucket), preview.items);
});

test("预览属于别的文件（用户已经切走）→ 画本槽的桶，不串台", () => {
  const preview = { file: A, items: [{ id: "a-1" }] };
  assert.deepEqual(pickMessages(preview, B, bucket), bucket);
});

test("没有预览 → 画桶", () => {
  assert.deepEqual(pickMessages(null, A, bucket), bucket);
});

test("没有当前文件（新建会话未落盘）→ 画桶", () => {
  const preview = { file: A, items: [{ id: "a-1" }] };
  assert.deepEqual(pickMessages(preview, null, bucket), bucket);
});

test("预览是空数组 → 回落到桶（不能因为空快照把已有内容盖成空白）", () => {
  const preview = { file: A, items: [] };
  assert.deepEqual(pickMessages(preview, A, bucket), bucket);
});
