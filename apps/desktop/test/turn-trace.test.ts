import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TurnTrace } from "../src/main/turn-trace.ts";

function withFile() {
  const dir = mkdtempSync(join(tmpdir(), "omcp-trace-"));
  return { dir, file: join(dir, "perf.jsonl") };
}

test("记录阶段顺序与耗时，不写正文", async () => {
  const { dir, file } = withFile();
  const phases: string[] = [];
  const trace = new TurnTrace({ file: () => file, onPhase: (e) => phases.push(e.phase) });
  const id = trace.begin("prompt", { textLen: 12 });
  assert.ok(id);
  trace.note("budgetMs", 1.5);
  trace.phase("preparing");
  trace.phase("started");
  trace.phase("first_token");
  trace.phase("first_token"); // 只记第一次
  trace.phase("tool_start", { tool: "bash" });
  trace.phase("tool_end", { tool: "bash", ok: true });
  trace.countIpc();
  trace.countIpc();
  trace.settle();
  await trace.flush();

  assert.deepEqual(phases, [
    "accepted",
    "preparing",
    "started",
    "first_token",
    "tool_start",
    "tool_end",
    "settled",
  ]);

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.v, 1);
  assert.equal(rec.turnId, id);
  assert.equal(rec.kind, "prompt");
  assert.equal(rec.outcome, "ok");
  assert.equal(rec.meta.textLen, 12);
  assert.equal(rec.notes.budgetMs, 1.5);
  assert.equal(rec.notes.ipcEvents, 2);
  assert.equal(rec.spans.filter((s: { phase: string }) => s.phase === "first_token").length, 1);
  assert.ok(rec.totalMs >= 0);
  // 不允许把 prompt 正文写进诊断文件
  assert.equal(JSON.stringify(rec).includes("secret prompt"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("失败会收尾，后续阶段不再记录", async () => {
  const { dir, file } = withFile();
  const trace = new TurnTrace({ file: () => file });
  const id = trace.begin("prompt");
  trace.fail("budget");
  assert.equal(trace.activeId, null);
  trace.phase("started"); // 无 active，不应抛错也不应写
  await trace.flush();
  const rec = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(rec.turnId, id);
  assert.equal(rec.outcome, "failed");
  assert.equal(rec.spans.at(-1).phase, "failed");
  assert.equal(rec.spans.at(-1).detail.reason, "budget");
  rmSync(dir, { recursive: true, force: true });
});

test("已有回合时 begin 返回 null，不覆盖进行中的记录", async () => {
  const { dir, file } = withFile();
  const trace = new TurnTrace({ file: () => file });
  const first = trace.begin("prompt");
  assert.ok(first);
  const second = trace.begin("prompt");
  assert.equal(second, null);
  trace.settle();
  await trace.flush();
  const rec = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(rec.turnId, first);
  rmSync(dir, { recursive: true, force: true });
});

test("关闭写盘时仍发阶段事件", async () => {
  const { dir, file } = withFile();
  const phases: string[] = [];
  const trace = new TurnTrace({ file: () => file, enabled: false, onPhase: (e) => phases.push(e.phase) });
  trace.begin("prompt");
  trace.phase("started");
  trace.settle();
  await trace.flush();
  assert.deepEqual(phases, ["accepted", "started", "settled"]);
  assert.throws(() => readFileSync(file, "utf8"));
  rmSync(dir, { recursive: true, force: true });
});
