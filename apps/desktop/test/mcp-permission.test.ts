import test from "node:test";
import assert from "node:assert/strict";

import permissionExt from "../../../packages/permission-ext/src/index.ts";

/**
 * 审批门的验收（P1/P2）：
 *
 * - policy 对未列出的 mcp__* 返回 ask → permission-ext 弹选择；
 * - 点拒绝 → { block: true }，pi 不执行；
 * - MCP 只读判定来自 pi.getAllTools() 的 annotations.readOnlyHint，
 *   随 /decide 请求带给主进程（只对 mcp__ 前缀查）。
 */

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface ToolInfo {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

function setup(decision: Record<string, unknown>, choice?: string, tools: ToolInfo[] = []) {
  const handlers = new Map<string, Handler>();
  const bodies: Array<Record<string, unknown>> = [];
  permissionExt({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    getAllTools: () => tools,
  } as never);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    bodies.push(body);
    return new Response(JSON.stringify({ decision }), { status: 200 });
  }) as typeof fetch;

  const prevUrl = process.env.OMCP_POLICY_URL;
  const prevToken = process.env.OMCP_POLICY_TOKEN;
  process.env.OMCP_POLICY_URL = "http://127.0.0.1:1";
  process.env.OMCP_POLICY_TOKEN = "test-token";

  const ctx = {
    ui: {
      select: async () => choice,
    },
  };

  return {
    toolCall: (event: { toolName: string; input: Record<string, unknown> }) =>
      handlers.get("tool_call")!(event, ctx) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.OMCP_POLICY_URL;
      else process.env.OMCP_POLICY_URL = prevUrl;
      if (prevToken === undefined) delete process.env.OMCP_POLICY_TOKEN;
      else process.env.OMCP_POLICY_TOKEN = prevToken;
    },
  };
}

const ask = {
  action: "ask",
  ruleId: "tool:unlisted:mcp__filesystem",
  summary: "mcp__filesystem__read_file",
  reason: "工具 mcp__filesystem__read_file 不在 tools.allow 白名单内。",
};

test("ask + 拒绝 → block，模型拿到明确原因", async () => {
  const ctx = setup(ask, "拒绝");
  try {
    const result = await ctx.toolCall({
      toolName: "mcp__filesystem__read_file",
      input: { path: "package.json" },
    });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /拒绝/);
    assert.match(result?.reason ?? "", /tool:unlisted/);
  } finally {
    ctx.restore();
  }
});

test("ask + 仅本次 → 放行（不 block）", async () => {
  const ctx = setup(ask, "仅本次");
  try {
    const result = await ctx.toolCall({
      toolName: "mcp__filesystem__read_file",
      input: { path: "package.json" },
    });
    assert.equal(result, undefined);
  } finally {
    ctx.restore();
  }
});

test("deny → 直接 block，不弹选择", async () => {
  const ctx = setup(
    {
      action: "deny",
      ruleId: "tool:deny",
      summary: "mcp__danger__drop",
      reason: "工具在 tools.deny 里",
    },
    "仅本次",
  );
  try {
    const result = await ctx.toolCall({ toolName: "mcp__danger__drop", input: {} });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /tool:deny/);
  } finally {
    ctx.restore();
  }
});

test("allow → 不 block", async () => {
  const ctx = setup(
    { action: "allow", ruleId: "default", summary: "x", reason: "未命中限制" },
    undefined,
  );
  try {
    const result = await ctx.toolCall({ toolName: "mcp__filesystem__read_file", input: {} });
    assert.equal(result, undefined);
  } finally {
    ctx.restore();
  }
});

test("只读 MCP 工具：readOnlyHint 随请求透传给主进程", async () => {
  const ctx = setup(
    { action: "allow", ruleId: "mcp:readonly", summary: "x", reason: "只读" },
    undefined,
    [{ name: "mcp__filesystem__read_file", annotations: { readOnlyHint: true } }],
  );
  try {
    await ctx.toolCall({ toolName: "mcp__filesystem__read_file", input: {} });
    assert.equal(ctx.bodies[0]?.readOnly, true);
  } finally {
    ctx.restore();
  }
});

test("非只读 MCP 工具：不带 readOnly", async () => {
  const ctx = setup(
    { action: "ask", ruleId: "tool:unlisted:mcp__filesystem", summary: "x", reason: "问一句" },
    "拒绝",
    [{ name: "mcp__filesystem__write_file", annotations: { readOnlyHint: false } }],
  );
  try {
    await ctx.toolCall({ toolName: "mcp__filesystem__write_file", input: {} });
    assert.equal(ctx.bodies[0]?.readOnly, undefined);
  } finally {
    ctx.restore();
  }
});

test("非 mcp 工具不能靠 annotations 自称只读（不查询、不透传）", async () => {
  const ctx = setup(
    { action: "allow", ruleId: "default", summary: "x", reason: "放行" },
    undefined,
    [{ name: "custom_tool", annotations: { readOnlyHint: true } }],
  );
  try {
    await ctx.toolCall({ toolName: "custom_tool", input: {} });
    assert.equal(ctx.bodies[0]?.readOnly, undefined);
  } finally {
    ctx.restore();
  }
});
