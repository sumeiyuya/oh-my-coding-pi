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
