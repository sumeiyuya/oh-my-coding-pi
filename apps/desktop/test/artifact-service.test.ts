import test from "node:test";
import assert from "node:assert/strict";

import { ArtifactService } from "../src/main/artifact-service.ts";

/** P1b2c1：runtime token → 该 runtime 的 workspace；legacy 全局 token 仍可用。 */

test("runtime token 与 legacy token 都能记录；错误 token 401", async (t) => {
  const appended: Array<Record<string, unknown>> = [];
  const ledger = {
    append: (entry: Record<string, unknown>) => appended.push(entry),
    list: () => ({ files: [] }),
  };
  const service = new ArtifactService(
    ledger as never,
    () => "C:/default",
    () => "session-default",
    (token) =>
      token === "runtime-token"
        ? { runtimeId: "r1", workspace: "C:/runtime" }
        : undefined,
  );
  await service.start();
  t.after(() => service.stop());

  const post = async (token: string, body: unknown) => {
    const response = await fetch(`${service.url}/tool-result`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const runtime = await post("runtime-token", {
    toolName: "write",
    toolCallId: "c1",
    input: { path: "figures/a.png" },
  });
  assert.equal(runtime.status, 200);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0]?.paths, ["figures/a.png"]);
  assert.equal(appended[0]?.session, "session-default");

  const legacy = await post(service.token, {
    toolName: "write",
    toolCallId: "c2",
    input: { path: "figures/b.png" },
  });
  assert.equal(legacy.status, 200);
  assert.deepEqual(appended[1]?.paths, ["figures/b.png"]);

  const bad = await post("wrong-token", {
    toolName: "write",
    toolCallId: "c3",
    input: { path: "x" },
  });
  assert.equal(bad.status, 401);
});
