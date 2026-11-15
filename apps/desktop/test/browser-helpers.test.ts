import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EVAL_BYTES,
  downloadFileName,
  evalResultText,
  resolveInWorkspace,
  sanitizeEvalValue,
} from "../src/main/browser-service.ts";

const ROOT = process.cwd();

test("工作区内路径放行", () => {
  assert.equal(resolveInWorkspace("a.csv", ROOT), `${ROOT}\\a.csv`.replace(/\//g, "\\"));
});

test("出工作区被拒（../ 与绝对路径）", () => {
  assert.throws(() => resolveInWorkspace("../x.csv", ROOT), /工作区之外/);
  assert.throws(() => resolveInWorkspace("C:/Windows/win.ini", ROOT), /工作区之外/);
});

test("下载文件名：URL 尾段 / 指定名 / 空尾段兜底", () => {
  assert.equal(downloadFileName("https://x.test/a.csv"), "a.csv");
  assert.equal(downloadFileName("https://x.test/a.csv?token=1"), "a.csv");
  assert.equal(downloadFileName("https://x.test/"), "下载文件");
  assert.equal(downloadFileName("https://x.test/", "data/out.csv"), "data/out.csv");
});

test("非法保存名被拒", () => {
  assert.throws(() => downloadFileName("https://x.test/a", ".."), /不合法/);
  assert.throws(() => downloadFileName("https://x.test/a", "a<b>.txt"), /不合法/);
});

test("净化：深度、循环、函数、Date", () => {
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 8; i++) {
    const next: Record<string, unknown> = {};
    cur.next = next;
    cur = next;
  }
  const out = sanitizeEvalValue(deep) as Record<string, unknown>;
  assert.ok(JSON.stringify(out).includes("深度截断"));

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.ok(JSON.stringify(sanitizeEvalValue(cyclic)).includes("循环引用"));

  assert.equal(sanitizeEvalValue(() => 1), "[Function]");
  assert.equal(sanitizeEvalValue(new Date(0)), "1970-01-01T00:00:00.000Z");
});

test("净化：数组与字符串长度受限", () => {
  const big = Array.from({ length: 500 }, (_, i) => i);
  const arr = sanitizeEvalValue(big) as number[];
  assert.equal(arr.length, 100);
  const long = "x".repeat(5000);
  assert.ok(String(sanitizeEvalValue(long)).length <= 2001);
});

test("eval 返回值超过 64 KB 直接报错，不截断", () => {
  const huge = { rows: Array.from({ length: 100 }, () => "y".repeat(700)) };
  assert.throws(() => evalResultText(huge), /64 KB/);
  assert.equal(MAX_EVAL_BYTES, 64 * 1024);
});
