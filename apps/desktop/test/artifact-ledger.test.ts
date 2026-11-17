import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactLedger,
  classify,
  normalizeInside,
  pathsFromToolResult,
} from "../src/main/artifact-ledger.ts";

/**
 * 产物账本（B1/B6）。
 *
 * 锁三件事：
 * 1. 路径守卫：工作区外的路径一个都不许进列表；
 * 2. 归属口径：write/edit 精确，bash/run_code 记 unknown（不猜）；
 * 3. 失效可见：账本里有、盘上没了 → exists=false，但条目不能消失。
 */

/** 每个用例一个独立工作区：账本落在 .omcp/artifacts.jsonl，共用会串味 */
function fresh(): { root: string; ledger: ArtifactLedger } {
  const root = mkdtempSync(join(tmpdir(), "omcp-art-"));
  return { root, ledger: new ArtifactLedger(() => root) };
}

test("类型按扩展名归类", () => {
  assert.equal(classify("figures/a.png"), "image");
  assert.equal(classify("analysis/x.py"), "code");
  assert.equal(classify("results/t.csv"), "data");
  assert.equal(classify("README.md"), "markdown");
  assert.equal(classify("notes.log"), "text");
  assert.equal(classify("model.bin"), "other");
});

test("路径守卫：工作区内通过，越界一律拒绝", () => {
  const { root } = fresh();
  assert.equal(normalizeInside(root, "figures/a.png"), "figures/a.png");
  assert.equal(normalizeInside(root, join(root, "results", "b.csv")), "results/b.csv");
  assert.equal(normalizeInside(root, "../outside.txt"), null);
  assert.equal(normalizeInside(root, "C:/Windows/notepad.exe"), null);
});

test("write/edit 精确落路径；bash 与自定义工具记 unknown", () => {
  const { root } = fresh();
  const w = pathsFromToolResult(root, "write", { path: "figures/a.png" });
  assert.deepEqual(w, { paths: ["figures/a.png"], unknown: false });

  const e = pathsFromToolResult(root, "edit", { path: "analysis/x.py" });
  assert.deepEqual(e, { paths: ["analysis/x.py"], unknown: false });

  const b = pathsFromToolResult(root, "bash", { command: "python x.py" });
  assert.equal(b.unknown, true);
  assert.deepEqual(b.paths, []);

  const r = pathsFromToolResult(root, "run_code", { code: "plt.savefig('a.png')" });
  assert.equal(r.unknown, true);
});

test("越界路径的 write 记为 unknown，而不是记成外部文件", () => {
  const { root } = fresh();
  const out = pathsFromToolResult(root, "write", { path: "../evil.txt" });
  assert.deepEqual(out.paths, []);
  assert.equal(out.unknown, true);
});

test("列表：账本命中 + 目录补充 + 去重 + 失效可见", () => {
  const { root, ledger } = fresh();
  mkdirSync(join(root, "figures"), { recursive: true });
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "figures", "a.png"), "x");
  writeFileSync(join(root, "results", "t.csv"), "a,b\n");

  const now = new Date().toISOString();
  ledger.append({ ts: now, session: "s1", tool: "write", toolCallId: "c1", paths: ["figures/a.png"], unknown: false });
  ledger.append({ ts: now, session: "s1", tool: "bash", toolCallId: "c2", paths: [], unknown: true });
  ledger.append({ ts: now, session: "s1", tool: "write", toolCallId: "c3", paths: ["results/gone.csv"], unknown: false });

  const res = ledger.list({ session: "s1" });
  const byPath = new Map(res.artifacts.map((a) => [a.path, a]));

  assert.equal(res.unknownRuns, 1, "bash 那次要计进 unknown");
  assert.equal(byPath.get("figures/a.png")?.origin, "run", "账本命中优先，保留归属");
  assert.equal(byPath.get("figures/a.png")?.exists, true);
  assert.equal(byPath.get("results/gone.csv")?.exists, false, "盘上没了仍要列出");
  assert.equal(byPath.get("results/t.csv")?.origin, "observed", "脚本写的靠目录扫描补上");
  assert.equal(res.observed, 1);
});

test("会话隔离：别的会话的账本不进当前列表", () => {
  const { root, ledger } = fresh();
  mkdirSync(join(root, "figures"), { recursive: true });
  writeFileSync(join(root, "figures", "a.png"), "x");
  ledger.append({
    ts: new Date().toISOString(),
    session: "other",
    tool: "write",
    toolCallId: "z1",
    paths: ["figures/a.png"],
    unknown: false,
  });
  const res = ledger.list({ session: "s1" });
  assert.equal(res.artifacts[0]?.origin, "observed");
  assert.equal(res.unknownRuns, 0);
});

test("没有工作区时给错误，而不是空列表", () => {
  const l = new ArtifactLedger(() => null);
  const res = l.list({ session: "s1" });
  assert.match(res.error ?? "", /没有打开工作区/);
});
