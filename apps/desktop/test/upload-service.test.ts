import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyUpload,
  copyWithProgress,
  filtersFor,
  readImageBase64,
  safeFileName,
  uniqueDestination,
} from "../src/main/upload-service.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("safeFileName：空白与保留字符变下划线，保留扩展名", () => {
  assert.equal(safeFileName("my data.csv"), "my_data.csv");
  assert.equal(safeFileName('a/b\\c:d.csv'), "a_b_c_d.csv");
  assert.equal(safeFileName("  ..  "), "file");
  assert.equal(safeFileName("报告 2026.xlsx"), "报告_2026.xlsx");
});

test("filtersFor：图片与数据带扩展名，文件接受全部", () => {
  assert.ok(filtersFor("image")[0]!.extensions.includes("png"));
  assert.ok(filtersFor("data")[0]!.extensions.includes("csv"));
  assert.deepEqual(filtersFor("file")[0]!.extensions, ["*"]);
});

test("classifyUpload：工作区内给相对路径，工作区外不给", async () => {
  const root = tempDir("omcp-up-root-");
  const outside = tempDir("omcp-up-out-");
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "a.csv"), "x\n1\n");
    writeFileSync(join(outside, "b.csv"), "y\n2\n");

    const inside = await classifyUpload(join(root, "data", "a.csv"), root);
    assert.equal(inside.insideWorkspace, true);
    assert.equal(inside.relative, "data/a.csv");
    assert.equal(inside.size, 4);

    const external = await classifyUpload(join(outside, "b.csv"), root);
    assert.equal(external.insideWorkspace, false);
    assert.equal(external.relative, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("uniqueDestination：重名追加 -1，不覆盖", () => {
  const dir = tempDir("omcp-up-dest-");
  try {
    writeFileSync(join(dir, "a.csv"), "1");
    assert.equal(uniqueDestination(dir, "a.csv"), join(dir, "a-1.csv"));
    writeFileSync(join(dir, "a-1.csv"), "2");
    assert.equal(uniqueDestination(dir, "a.csv"), join(dir, "a-2.csv"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copyWithProgress：复制内容并上报进度", async () => {
  const dir = tempDir("omcp-up-copy-");
  try {
    const src = join(dir, "src.bin");
    const dest = join(dir, "dest.bin");
    const payload = Buffer.alloc(256 * 1024, 7);
    writeFileSync(src, payload);
    let last = 0;
    await copyWithProgress(src, dest, payload.length, {
      onProgress: (copied) => {
        last = copied;
      },
    });
    assert.deepEqual(readFileSync(dest), payload);
    assert.equal(last, payload.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readImageBase64：mime 正确，超过上限拒绝", async () => {
  const dir = tempDir("omcp-up-img-");
  try {
    const p = join(dir, "a.png");
    writeFileSync(p, Buffer.from([137, 80, 78, 71]));
    const r = await readImageBase64(p, 1024);
    assert.equal(r.mimeType, "image/png");
    assert.ok(r.data.length > 0);
    await assert.rejects(() => readImageBase64(p, 2), /图片超过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
