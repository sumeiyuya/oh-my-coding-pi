import test from "node:test";
import assert from "node:assert/strict";

import { PolicyService } from "../src/main/policy-service.ts";

/** P1b2c2：policy service 接受 runtime token；legacy 全局 token 仍可用。 */

test("runtime token / legacy token 都能决策；错误 token 401", async (t) => {
  const service = new PolicyService({
    getWorkspaceRoot: () => "C:/default",
    getSessionKey: () => "session-default",
    grants: { has: () => false } as never,
    audit: () => {},
    resolveRuntime: (token) =>
      token === "runtime-token"
        ? { runtimeId: "r1", workspace: "C:/runtime" }
        : undefined,
  });
  await service.start();
  t.after(() => service.stop());

  const decide = async (token: string) => {
    const response = await fetch(`${service.url}/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "mcp__filesystem__read_file",
        input: { path: "a" },
        readOnly: true,
      }),
    });
    return {
      status: response.status,
      data: (await response.json()) as { decision?: { action?: string; ruleId?: string } },
    };
  };

  const runtime = await decide("runtime-token");
  assert.equal(runtime.status, 200);
  assert.equal(runtime.data.decision?.action, "allow");
  assert.equal(runtime.data.decision?.ruleId, "mcp:readonly");

  const legacy = await decide(service.token);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.decision?.action, "allow");

  const bad = await decide("wrong-token");
  assert.equal(bad.status, 401);
});
