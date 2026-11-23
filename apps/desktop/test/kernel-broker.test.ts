import test from "node:test";
import assert from "node:assert/strict";

import { KernelBroker } from "../src/main/kernel-broker.ts";
import type { KernelService } from "../src/main/kernel-service.ts";

/** P1b2b：runtime token 路由到对应内核；legacy 全局 token 仍可用。 */

const calls: string[] = [];

function fake(name: string): KernelService {
  return {
    isReady: true,
    pid: 1,
    async execute(code: string, onEvent: (ev: unknown) => void) {
      calls.push(`${name}:${code}`);
      onEvent({ ev: "result", status: "ok" });
    },
    async variables() {
      return [];
    },
    async interrupt() {},
    async ensureStarted() {},
  } as unknown as KernelService;
}

test("runtime token → runtime 的内核；全局 token → default；错误 token 401", async (t) => {
  const defaultPython = fake("default-py");
  const runtimePython = fake("runtime-py");
  const broker = new KernelBroker(
    { python: defaultPython, r: fake("default-r") },
    undefined,
    undefined,
    undefined,
    (token) =>
      token === "runtime-token"
        ? { runtimeId: "r1", services: { python: runtimePython, r: fake("runtime-r") } }
        : undefined,
  );
  await broker.start();
  t.after(() => broker.stop());

  const run = async (token: string) => {
    const response = await fetch(`${broker.url}/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "1+1", lang: "python" }),
    });
    return { status: response.status, body: await response.text() };
  };

  const runtime = await run("runtime-token");
  assert.equal(runtime.status, 200);
  assert.match(runtime.body, /"ev":"result"/);
  assert.deepEqual(calls.at(-1), "runtime-py:1+1");

  const legacy = await run(broker.token);
  assert.equal(legacy.status, 200);
  assert.deepEqual(calls.at(-1), "default-py:1+1");

  const unauthorized = await run("wrong-token");
  assert.equal(unauthorized.status, 401);
});
