import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelManager } from "../src/main/kernel-manager.ts";

/** P1b2a：一对内核按 runtimeId 懒创建；dispose 只影响这一个。 */

test("同一个 runtime 拿到同一对；不同 runtime 不同", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-km-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new KernelManager(join(dir, "sidecar.py"), dir, join(dir, "specs"));
  const a1 = manager.get("a");
  const a2 = manager.get("a");
  const b = manager.get("b");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(a1.python, a2.python);
  assert.equal(a1.r, a2.r);
  manager.disposeAll();
});

test("dispose 一个 runtime 后重新创建是新的一对", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-km-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new KernelManager(join(dir, "sidecar.py"), dir, join(dir, "specs"));
  const before = manager.get("a");
  manager.dispose("a");
  const after = manager.get("a");
  assert.notEqual(before, after);
  assert.notEqual(before.python, after.python);
  manager.disposeAll();
});

/**
 * 修改 4 · M2：键改成会话。
 * 这两条就是那次数据串台的回归测试——同一个槽换会话必须拿到**不同**的内核对。
 */
import { kernelKeyFor } from "../src/main/kernel-manager.ts";

function mk(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "omcp-km-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new KernelManager(join(dir, "sidecar.py"), dir, join(dir, "specs"));
}

test("同一个槽换会话：内核键跟着会话变，不复用上一个会话的变量", (t) => {
  const manager = mk(t);
  const keyA = kernelKeyFor("D:/p/.omcp/science/sessions/a.jsonl", "slot-1");
  const keyB = kernelKeyFor("D:/p/.omcp/science/sessions/b.jsonl", "slot-1");
  assert.notEqual(keyA, keyB);

  const a = manager.get(keyA, "D:/p");
  const b = manager.get(keyB, "D:/p");
  assert.notEqual(a.python, b.python, "会话 B 不能拿到会话 A 的 Python 内核");
  assert.notEqual(a.r, b.r);
  manager.disposeAll();
});

test("同一个会话在两个槽里打开：仍是同一对内核", (t) => {
  const manager = mk(t);
  const file = "D:/p/.omcp/science/sessions/a.jsonl";
  const viaSlot1 = manager.get(kernelKeyFor(file, "slot-1"), "D:/p");
  const viaSlot2 = manager.get(kernelKeyFor(file, "slot-2"), "D:/p");
  assert.equal(viaSlot1.python, viaSlot2.python, "变量跟会话走，不跟槽走");
  assert.equal(manager.list().length, 1);
  manager.disposeAll();
});

test("还没有会话文件时按槽兜底", (t) => {
  const manager = mk(t);
  const key = kernelKeyFor(null, "slot-7");
  assert.equal(key, "runtime:slot-7");
  manager.disposeAll();
});

test("空闲回收：超时的会话内核被关掉并忘掉，未超时的留着", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-km-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let at = 0;
  const manager = new KernelManager(join(dir, "sidecar.py"), dir, join(dir, "specs"), {
    now: () => at,
  });
  manager.get("session:a", "D:/p"); // t=0
  at = 9 * 60_000;
  manager.get("session:b", "D:/p"); // t=9min
  at = 10 * 60_000 + 1_000; // t=10min01s

  const reaped = manager.reapIdle(10 * 60_000);
  assert.deepEqual(reaped.map((r) => r.key), ["session:a"]);
  assert.deepEqual(manager.list().map((e) => e.key), ["session:b"]);
  manager.disposeAll();
});
