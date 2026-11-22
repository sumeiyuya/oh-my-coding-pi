import test from "node:test";
import assert from "node:assert/strict";

import { PolicyService } from "../src/main/policy-service.ts";

/**
 * P2：只读 MCP 工具贯通方案期门与只读模式。
 *
 * readOnly 只对 mcp__ 前缀生效；其它工具不能靠自称只读绕过。
 * 写工具仍按原规则：方案期 plan:readonly、只读模式 mode:readonly。
 */

function service(gate: { enabled: boolean; approved: boolean } = { enabled: false, approved: false }) {
  return new PolicyService({
    getWorkspaceRoot: () => "C:/workspace",
    getSessionKey: () => "session",
    grants: { has: () => false } as never,
    audit: () => {},
    getPlanGate: () => gate,
  });
}

test("方案期：只读 MCP 工具放行", () => {
  const svc = service({ enabled: true, approved: false });
  const d = svc.decide("mcp__filesystem__read_file", {}, { readOnly: true });
  assert.equal(d.action, "allow");
  assert.equal(d.ruleId, "mcp:readonly");
});

test("方案期：写 MCP 工具仍然拒绝", () => {
  const svc = service({ enabled: true, approved: false });
  const d = svc.decide("mcp__filesystem__write_file", {}, {});
  assert.equal(d.action, "deny");
  assert.equal(d.ruleId, "plan:readonly");
});

test("方案期：非 mcp 工具不能靠 readOnly 绕过", () => {
  const svc = service({ enabled: true, approved: false });
  const d = svc.decide("custom_tool", {}, { readOnly: true });
  assert.equal(d.action, "deny");
  assert.equal(d.ruleId, "plan:readonly");
});

test("只读模式：只读 MCP 放行，写 MCP 拒绝", () => {
  const svc = service();
  svc.setMode("readonly");
  assert.equal(
    svc.decide("mcp__filesystem__read_file", {}, { readOnly: true }).action,
    "allow",
  );
  const d = svc.decide("mcp__filesystem__write_file", {}, {});
  assert.equal(d.action, "deny");
  assert.equal(d.ruleId, "mode:readonly");
});

test("普通模式：只读 MCP 不弹审批，写 MCP 走服务器级 ask", () => {
  const svc = service();
  assert.equal(
    svc.decide("mcp__filesystem__read_file", {}, { readOnly: true }).action,
    "allow",
  );
  const d = svc.decide("mcp__filesystem__write_file", {}, {});
  assert.equal(d.action, "ask");
  assert.equal(d.ruleId, "tool:unlisted:mcp__filesystem");
});
