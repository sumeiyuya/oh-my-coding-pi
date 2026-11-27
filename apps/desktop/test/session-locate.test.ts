import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { sessionsDirOf, workspaceOfSession } from "../src/main/session-locate.ts";

/**
 * 修改 5 · C1：会话必须能找到自己的工作区。
 *
 * 这一层的错误代价很高——找错工作区，文件树、策略、内核全会指向错的目录；
 * 找不到则退化成「别的工作区的会话根本打不开」。所以这里逐条钉死。
 */

const A = "D:\\desktop\\coding\\lab-a";
const B = "D:\\desktop\\coding\\lab-b";

const fileIn = (root: string, name = "2026-11-25T10-00-00Z_x.jsonl"): string =>
  join(root, ".omcp", "sessions", name);

test("sessionsDirOf：<工作区>/.omcp/sessions，尾部斜杠不算两层", () => {
  assert.equal(sessionsDirOf("D:\\ws").toLowerCase(), "d:\\ws\\.omcp\\sessions");
  assert.equal(sessionsDirOf("D:\\ws\\").toLowerCase(), "d:\\ws\\.omcp\\sessions");
  assert.equal(sessionsDirOf("D:\\ws\\\\").toLowerCase(), "d:\\ws\\.omcp\\sessions");
});

test("会话在 A 的目录下 → 返回 A（原样大小写）", () => {
  assert.equal(workspaceOfSession(fileIn(A), [A, B]), A);
});

test("会话在 B 的目录下 → 返回 B，不是列表里的第一个", () => {
  assert.equal(workspaceOfSession(fileIn(B), [A, B]), B);
});

test("Windows 大小写不敏感：文件路径小写也认", () => {
  assert.equal(workspaceOfSession(fileIn(A).toLowerCase(), [A, B]), A);
});

test("没登记过的目录 → null（不猜）", () => {
  const stranger = "E:\\somewhere\\else";
  assert.equal(workspaceOfSession(fileIn(stranger), [A, B]), null);
});

test("只有文件名、没有目录 → null", () => {
  assert.equal(workspaceOfSession("2026-11-25T10-00-00Z_x.jsonl", [A, B]), null);
});

test("老布局 <工作区>/sessions（还没迁移）→ null，由调用方回落当前视图", () => {
  assert.equal(workspaceOfSession(join(A, "sessions", "x.jsonl"), [A, B]), null);
});

test("空文件 / 空名单 → null", () => {
  assert.equal(workspaceOfSession(null, [A, B]), null);
  assert.equal(workspaceOfSession("", [A, B]), null);
  assert.equal(workspaceOfSession(fileIn(A), []), null);
});

test("名单里有空串也不误判（已知工作区可能带脏值）", () => {
  assert.equal(workspaceOfSession(fileIn(A), ["", A]), A);
});

test("兄弟目录前缀不混淆：lab-a2 不是 lab-a", () => {
  const A2 = "D:\\desktop\\coding\\lab-a2";
  assert.equal(workspaceOfSession(fileIn(A2), [A]), null);
});
