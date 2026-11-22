import test from "node:test";
import assert from "node:assert/strict";

import { approvalScopeHint } from "../src/approval-hint.ts";

/**
 * 审批文案：服务器级授权必须说清「会放行整台服务器」，
 * 否则用户会以为只是允许当前这一个工具。
 */

test("MCP 服务器级授权：点明会放行整台服务器（含写工具）", () => {
  const hint = approvalScopeHint("tool:unlisted:mcp__filesystem");
  assert.ok(hint);
  assert.match(hint, /服务器级/);
  assert.match(hint, /filesystem/);
  assert.match(hint, /写工具/);
  assert.match(hint, /仅本次/);
});

test("服务器的连字符/下划线原样显示", () => {
  const hint = approvalScopeHint("tool:unlisted:mcp__my-server_2");
  assert.ok(hint);
  assert.match(hint, /my-server_2/);
});

test("普通未列出工具不显示服务器级提示", () => {
  assert.equal(approvalScopeHint("tool:unlisted"), null);
});

test("只读放行、deny、路径规则都不显示", () => {
  assert.equal(approvalScopeHint("mcp:readonly"), null);
  assert.equal(approvalScopeHint("tool:deny"), null);
  assert.equal(approvalScopeHint("path:allowWrite"), null);
});
