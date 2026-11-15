import test from "node:test";
import assert from "node:assert/strict";

import { SerialQueue } from "../src/main/serial-queue.ts";

/** 内核执行的串行队列（P2-01）：不并发、不卡死、超限要说清楚。 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("按提交顺序执行，不交叉", async () => {
  const q = new SerialQueue(4);
  const log: string[] = [];
  const a = q.run(async () => {
    log.push("a-start");
    await tick();
    log.push("a-end");
  });
  const b = q.run(async () => {
    log.push("b-start");
    await tick();
    log.push("b-end");
  });
  await Promise.all([a, b]);
  assert.deepEqual(log, ["a-start", "a-end", "b-start", "b-end"]);
});

test("第二次提交在前一次结束前不会开始", async () => {
  const q = new SerialQueue(4);
  const gate = deferred<void>();
  let secondStarted = false;
  const first = q.run(() => gate.promise);
  const second = q.run(async () => {
    secondStarted = true;
  });
  await tick();
  assert.equal(secondStarted, false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});

test("超上限直接拒，并说明已有几段在等", async () => {
  const q = new SerialQueue(2);
  const gate = deferred<void>();
  const running = q.run(() => gate.promise);
  const queued = q.run(async () => undefined);
  await assert.rejects(q.run(async () => undefined), /KernelBusy：已有 2 段代码/);
  gate.resolve();
  await Promise.all([running, queued]);
});

test("一次失败不会卡住后面的队列", async () => {
  const q = new SerialQueue(4);
  const results: string[] = [];
  const bad = q.run(async () => {
    throw new Error("boom");
  });
  const good = q.run(async () => {
    results.push("after-boom");
  });
  await assert.rejects(bad, /boom/);
  await good;
  assert.deepEqual(results, ["after-boom"]);
  assert.equal(q.size, 0, "全部结束后队列计数应归零");
});

test("结束后计数归零，可继续复用", async () => {
  const q = new SerialQueue(1);
  await q.run(async () => undefined);
  assert.equal(q.size, 0);
  await q.run(async () => undefined);
  assert.equal(q.size, 0);
});
