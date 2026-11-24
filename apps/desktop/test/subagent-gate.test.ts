import test from "node:test";
import assert from "node:assert/strict";

import { SubagentGate } from "../src/main/subagent-gate.ts";

/** 修改 4 · M4：全局子任务名额（2 槽 × 4 子任务不能变成 8 个请求）。 */

test("有号立刻给，用满之后排队", async () => {
  const gate = new SubagentGate({ capacity: 2 });
  assert.equal(await gate.acquire({ key: "a" }), true);
  assert.equal(await gate.acquire({ key: "a" }), true);
  assert.equal(gate.snapshot().inUse, 2);

  let thirdSettled = false;
  const third = gate.acquire({ key: "b" }).then((ok) => {
    thirdSettled = true;
    return ok;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(thirdSettled, false, "第三个应当还在等");
  assert.equal(gate.snapshot().waiting, 1);

  gate.release("a");
  assert.equal(await third, true);
  assert.equal(gate.snapshot().inUse, 2);
});

test("队首优先：先等的人先拿到", async () => {
  const gate = new SubagentGate({ capacity: 1 });
  await gate.acquire({ key: "holder" });
  const order: string[] = [];
  const first = gate.acquire({ key: "one" }).then((ok) => ok && order.push("one"));
  const second = gate.acquire({ key: "two" }).then((ok) => ok && order.push("two"));
  gate.release("holder");
  await first;
  gate.release("one");
  await second;
  assert.deepEqual(order, ["one", "two"]);
});

test("超时就明确拒绝，不悄悄超额", async () => {
  const gate = new SubagentGate({ capacity: 1 });
  await gate.acquire({ key: "holder" });
  const ok = await gate.acquire({ key: "late", timeoutMs: 1_000 });
  assert.equal(ok, false);
  assert.equal(gate.snapshot().waiting, 0);
  assert.equal(gate.snapshot().inUse, 1, "被拒的请求不占名额");
});

test("releaseAll 兜底：一个会话崩了，它的号全还回来", async () => {
  const gate = new SubagentGate({ capacity: 2 });
  await gate.acquire({ key: "slot-1" });
  await gate.acquire({ key: "slot-1" });
  assert.equal(gate.releaseAll("slot-1"), 2);
  assert.equal(gate.snapshot().inUse, 0);
  assert.deepEqual(gate.snapshot().holders, []);
});

test("多还一次不会把占用变成负数", () => {
  const gate = new SubagentGate({ capacity: 2 });
  gate.release("nothing");
  assert.equal(gate.snapshot().inUse, 0);
});

test("dispose 把还在等的都拒掉", async () => {
  const gate = new SubagentGate({ capacity: 1 });
  await gate.acquire({ key: "holder" });
  const pending = gate.acquire({ key: "waiting" });
  gate.dispose();
  await assert.rejects(() => pending, /已关闭/);
});

/* 真实的 HTTP 入口：扩展进程就是这么领名额的 */
import { startSubagentGateServer } from "../src/main/subagent-gate.ts";

test("闸口：领满之后第 N+1 个拿到 429，还号后能再领", async (t) => {
  const gate = new SubagentGate({ capacity: 1 });
  const server = await startSubagentGateServer(gate);
  t.after(() => server.close());

  const call = async (path: string, key: string, timeoutMs = 800) => {
    const response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ key, timeoutMs }),
    });
    return { status: response.status, body: await response.text() };
  };

  const first = await call("/subagent/lease", "slot-1");
  assert.equal(first.status, 200);
  assert.match(first.body, /"overflow"/.test(first.body) ? /overflow/ : /"inUse":1/);

  const second = await call("/subagent/lease", "slot-2");
  assert.equal(second.status, 429, "第二个应当被挡住");
  assert.match(second.body, /名额已满/);

  await call("/subagent/release", "slot-1");
  const third = await call("/subagent/lease", "slot-2");
  assert.equal(third.status, 200);
});

test("闸口：没有 token 一律 401", async (t) => {
  const gate = new SubagentGate({ capacity: 1 });
  const server = await startSubagentGateServer(gate);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/subagent/lease`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "x" }),
  });
  assert.equal(response.status, 401);
});
