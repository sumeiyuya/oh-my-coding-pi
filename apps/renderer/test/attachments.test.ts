import test from "node:test";
import assert from "node:assert/strict";

import { bytesOfBase64, mergeImages } from "../src/attachments.ts";

/**
 * 修改一：贴图不能丢。两条历史 bug 都钉在这里：
 *  ① 两次粘贴挨得近 → 后一次覆盖前一次（所以合并必须基于"最新列表"）；
 *  ② 超限静默丢 → 现在要给 reject 理由。
 */

const limits = { maxCount: 4, maxBytes: 4 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 };
const img = (id: string, size = 1024): { id: string; data: string; mimeType: string; size: number } => ({
  id,
  data: `base64-${id}`,
  mimeType: "image/png",
  size,
});

test("空列表 + 一张 → 一张", () => {
  const { list, rejected } = mergeImages([], [img("a")], limits);
  assert.equal(list.length, 1);
  assert.equal(rejected.length, 0);
});

test("连贴两次（第二次基于最新列表）→ 两张都在", () => {
  const first = mergeImages([], [img("a")], limits).list;
  const second = mergeImages(first, [img("b")], limits);
  assert.deepEqual(second.list.map((x) => x.id), ["a", "b"]);
});

test("同一张图重复粘贴 → 去重，只留一份", () => {
  const first = mergeImages([], [img("a")], limits).list;
  const again = mergeImages(first, [img("a")], limits);
  assert.equal(again.list.length, 1);
  assert.match(again.rejected[0]?.reason ?? "", /重复/);
});

test("超过 4 张：前 4 张保留，第 5 张给理由", () => {
  const four = mergeImages([], [img("a"), img("b"), img("c"), img("d")], limits);
  assert.equal(four.list.length, 4);
  const fifth = mergeImages(four.list, [img("e")], limits);
  assert.equal(fifth.list.length, 4);
  assert.match(fifth.rejected[0]?.reason ?? "", /最多 4 张/);
});

test("单张超 4 MB 直接拒，不占名额", () => {
  const big = mergeImages([], [img("big", 5 * 1024 * 1024)], limits);
  assert.equal(big.list.length, 0);
  assert.match(big.rejected[0]?.reason ?? "", /单张超过/);
});

test("合计超 12 MB：再多一点就进不来，前面的保留", () => {
  const mb = 1024 * 1024;
  const full = mergeImages([], [img("a", 4 * mb), img("b", 4 * mb), img("c", 4 * mb)], limits);
  assert.equal(full.list.length, 3, "4+4+4 正好 12 MB，应当允许");
  const over = mergeImages(full.list, [img("d", 2)], limits);
  assert.equal(over.list.length, 3);
  assert.match(over.rejected[0]?.reason ?? "", /合计超过/);
});

test("正好卡在合计上限 → 允许（边界取等号）", () => {
  const mb = 1024 * 1024;
  const first = mergeImages([], [img("a", 4 * mb), img("b", 4 * mb)], limits);
  const exact = mergeImages(first.list, [img("c", 4 * mb)], limits);
  assert.equal(exact.list.length, 3);
  assert.equal(exact.rejected.length, 0);
});

test("size 没给时按 base64 长度估算（picker 那条路可能只有 data）", () => {
  const data = "x".repeat(4000); // ≈ 3000 字节
  assert.equal(bytesOfBase64(data), 3000);
  const { list } = mergeImages([], [{ id: "x", data, mimeType: "image/png" }], limits);
  assert.equal(list.length, 1);
});
