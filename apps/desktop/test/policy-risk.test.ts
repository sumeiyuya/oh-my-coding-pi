import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyService } from "../src/main/policy-service.ts";

const WS = mkdtempSync(join(tmpdir(), "sci-policy-"));
mkdirSync(join(WS, "data", "raw"), { recursive: true });
mkdirSync(join(WS, "analysis"), { recursive: true });
writeFileSync(join(WS, "data", "raw", "demo.csv"), "a,b\n1,2\n");

function service(): PolicyService {
  return new PolicyService({
    getWorkspaceRoot: () => WS,
    getSessionKey: () => "sess-1",
    grants: { has: () => false } as never,
    audit: () => undefined,
  });
}

const svc = service();

test("三档对「删工作区文件」：deny / ask / allow", () => {
  const input = { command: "rm -f data/demo.csv" };
  svc.setMode("deny-risky");
  assert.equal(svc.decide("bash", input).action, "deny");
  svc.setMode("ask-risky");
  assert.equal(svc.decide("bash", input).action, "ask");
  svc.setMode("allow-all");
  assert.equal(svc.decide("bash", input).action, "allow");
});

test("硬拒在任何档都拒（sudo）", () => {
  for (const mode of ["deny-risky", "ask-risky", "allow-all"] as const) {
    svc.setMode(mode);
    const d = svc.decide("bash", { command: "sudo rm -rf /" });
    assert.equal(d.action, "deny", mode);
    assert.match(d.reason, /提权|任何档/);
  }
});

test("写 data/raw：三档分别 deny / ask / allow", () => {
  const input = { path: join(WS, "data", "raw", "demo.csv") };
  svc.setMode("deny-risky");
  assert.equal(svc.decide("write", input).action, "deny");
  svc.setMode("ask-risky");
  assert.equal(svc.decide("write", input).action, "ask");
  svc.setMode("allow-all");
  assert.equal(svc.decide("write", input).action, "allow");
});

test("「不可问」在请求批准档也拒", () => {
  svc.setMode("ask-risky");
  const d = svc.decide("bash", { command: "rm -rf ./out-*" });
  assert.equal(d.action, "deny");
});

test("旧档 readonly 保持原行为（风险层不接管）", () => {
  svc.setMode("readonly");
  assert.equal(svc.decide("write", { path: join(WS, "analysis", "a.csv") }).action, "deny");
  // 但硬拒仍然生效
  assert.equal(svc.decide("bash", { command: "sudo ls" }).action, "deny");
});

test("旧档 allow 保持原行为", () => {
  svc.setMode("allow");
  assert.equal(svc.decide("write", { path: join(WS, "analysis", "a.csv") }).action, "allow");
});

test("改档立即生效（不需要重建服务）", () => {
  svc.setMode("allow-all");
  assert.equal(svc.decide("bash", { command: "rm -f data/old.csv" }).action, "allow");
  svc.setMode("deny-risky");
  assert.equal(svc.decide("bash", { command: "rm -f data/old.csv" }).action, "deny");
});

test("方案期门优先级最高：未批准时 allow-all 也拒写", () => {
  const gate = { enabled: true, approved: false };
  const svc2 = new PolicyService({
    getWorkspaceRoot: () => WS,
    getSessionKey: () => "sess-2",
    grants: { has: () => false } as never,
    audit: () => undefined,
    getPlanGate: () => gate,
  });
  svc2.setMode("allow-all");
  assert.equal(svc2.decide("write", { path: join(WS, "analysis", "a.csv") }).action, "deny");
  // 只读工具仍放行
  assert.equal(svc2.decide("read", { path: join(WS, "analysis", "a.csv") }).action, "allow");
  // 批准后按档位办
  gate.approved = true;
  assert.equal(svc2.decide("write", { path: join(WS, "analysis", "a.csv") }).action, "allow");
});

test.after(() => {
  rmSync(WS, { recursive: true, force: true });
});
