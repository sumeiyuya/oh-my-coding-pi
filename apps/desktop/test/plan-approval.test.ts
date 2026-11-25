import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizePlanText, planDigest, verifyPlanFile } from "../src/main/plan-approval.ts";

/**
 * 方案批准的“内容绑定”（P1-01）：
 * 目标是“批准的是这份内容”，而不是“这个路径”。
 * 只规范化 BOM 与换行——多一步宽松归一化，就多一个改了却仍匹配的漏洞。
 */

test("换行符不同不算改内容", () => {
  const lf = "# 方案\n第二行\n";
  const crlf = "# 方案\r\n第二行\r\n";
  assert.equal(normalizePlanText(crlf), lf);
  assert.equal(planDigest(crlf), planDigest(lf));
});

test("BOM 不算改内容", () => {
  const plain = "# 方案\n";
  assert.equal(planDigest("\uFEFF" + plain), planDigest(plain));
});

test("改一个字就不同", () => {
  assert.notEqual(planDigest("# 方案 A\n"), planDigest("# 方案 B\n"));
});

test("空白差异会被算作修改（不做过度归一化）", () => {
  assert.notEqual(planDigest("a\nb\n"), planDigest("a\n b\n"));
  assert.notEqual(planDigest("a\n"), planDigest("a\n\n"));
});

test("摘要固定为 64 位十六进制", () => {
  assert.match(planDigest("x"), /^[0-9a-f]{64}$/);
});

test("verifyPlanFile：内容一致 → ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-plan-"));
  try {
    const file = join(dir, "plan.md");
    writeFileSync(file, "# 方案\r\n步骤\r\n", "utf8");
    const digest = planDigest("# 方案\n步骤\n");
    assert.deepEqual(verifyPlanFile(file, digest), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPlanFile：批准后改了内容 → 失效", () => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-plan-"));
  try {
    const file = join(dir, "plan.md");
    writeFileSync(file, "# 方案\n原始\n", "utf8");
    const digest = planDigest("# 方案\n原始\n");
    writeFileSync(file, "# 方案\n改过了\n", "utf8");
    const res = verifyPlanFile(file, digest);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /被修改/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPlanFile：文件被删 → 失效且说明原因", () => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-plan-"));
  try {
    const file = join(dir, "plan.md");
    writeFileSync(file, "# 方案\n", "utf8");
    const digest = planDigest("# 方案\n");
    unlinkSync(file);
    const res = verifyPlanFile(file, digest);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /已被删除/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPlanFile：没有摘要 → 失效（fail-closed）", () => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-plan-"));
  try {
    const file = join(dir, "plan.md");
    writeFileSync(file, "# 方案\n", "utf8");
    const res = verifyPlanFile(file, "");
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /没有记录内容摘要/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 修改 4 · M2：方案期按会话记。
 * A 批准了方案，B 仍然是只读——这条以前是错的（单对象 planGate）。
 */
import { PlanGateBook } from "../src/main/plan-approval.ts";

test("方案期按会话独立：A 批准不影响 B", () => {
  const book = new PlanGateBook();
  book.setEnabled("session:a", true);
  book.setEnabled("session:b", true);
  book.approve("session:a", "plans/x.md", "digest-a");

  assert.equal(book.status("session:a").approved, true);
  assert.equal(book.status("session:b").approved, false, "B 不该因为 A 批准而放行");
  assert.equal(book.status("session:b").enabled, true);
});

test("关掉方案期会清掉批准；再打开也不是已批准", () => {
  const book = new PlanGateBook();
  book.setEnabled("session:a", true);
  book.approve("session:a", "plans/x.md", "d");
  book.setEnabled("session:a", false);
  assert.deepEqual(book.status("session:a"), {
    enabled: false,
    approved: false,
    planPath: null,
    digest: null,
  });
  book.setEnabled("session:a", true);
  assert.equal(book.status("session:a").approved, false);
});

test("内容漂移只撤销那一个会话的批准", () => {
  const book = new PlanGateBook();
  book.setEnabled("session:a", true);
  book.setEnabled("session:b", true);
  book.approve("session:a", "plans/x.md", "digest-a");
  book.approve("session:b", "plans/x.md", "digest-b");

  const result = book.revalidate("session:a", () => ({ ok: false, reason: "改过" }), (rel) => rel);
  assert.equal(result.ok, false);
  assert.equal(book.status("session:a").approved, false);
  assert.equal(book.status("session:b").approved, true, "B 的批准不该被 A 的漂移带走");
});

test("没批准时 revalidate 直接放行（不读盘）", () => {
  const book = new PlanGateBook();
  book.setEnabled("session:a", true);
  let touched = false;
  const result = book.revalidate(
    "session:a",
    () => {
      touched = true;
      return { ok: true };
    },
    (rel) => rel,
  );
  assert.equal(result.ok, true);
  assert.equal(touched, false);
});
