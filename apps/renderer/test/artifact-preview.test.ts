import test from "node:test";
import assert from "node:assert/strict";

import { extOf, pickPreviewKind } from "../src/artifact-preview.ts";

/** 产物预览选渲染器（修改 1）：只判断，不读文件。 */

test("扩展名提取", () => {
  assert.equal(extOf("figures/pcoa.PNG"), "png");
  assert.equal(extOf("results/a.b.csv"), "csv");
  assert.equal(extOf("README"), "");
});

test("Markdown 走渲染器", () => {
  assert.equal(pickPreviewKind("reports/x.md", "text"), "markdown");
  assert.equal(pickPreviewKind("reports/x.MDX", "text"), "markdown");
});

test("CSV/TSV 走表格", () => {
  assert.equal(pickPreviewKind("results/a.csv", "text"), "table");
  assert.equal(pickPreviewKind("results/a.tsv", "text"), "table");
});

test("图片与普通文本", () => {
  assert.equal(pickPreviewKind("figures/a.png", "image"), "image");
  assert.equal(pickPreviewKind("analysis/x.py", "text"), "text");
});

test("二进制 / 过大不预览", () => {
  assert.equal(pickPreviewKind("data/x.bin", "binary"), "none");
  assert.equal(pickPreviewKind("data/x.parquet", "too-large"), "none");
});
