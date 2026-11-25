import test from "node:test";
import assert from "node:assert/strict";

import { SessionRegistry } from "../src/main/session-registry.ts";
import { SlotPool, type SlotRuntime } from "../src/main/slot-pool.ts";

/** 修改 4 · M0：身份、准入、抢占、回收。不 spawn 真 pi。 */

class FakeSlot implements SlotRuntime {
  readonly id: string;
  readonly workspace: string;
  sessionFile: string | null;
  isRunning = false;
  busy = false;
  ready = false;
  lastActiveAt: number;
  disposed = false;
  startCount = 0;

  constructor(id: string, workspace: string, sessionFile: string | null, now: number) {
    this.id = id;
    this.workspace = workspace;
    this.sessionFile = sessionFile;
    this.lastActiveAt = now;
  }

  start(): void {
    this.startCount += 1;
    this.isRunning = true;
  }
  stop(): void {
    this.isRunning = false;
    this.ready = false;
  }
  dispose(): void {
    this.disposed = true;
    this.isRunning = false;
  }
  setSessionFile(file: string | null): void {
    this.sessionFile = file;
  }
  async waitReady(): Promise<void> {
    if (!this.isRunning) throw new Error("not started");
    this.ready = true;
  }
}

function make(opts: { max?: number; workspaces?: string[] } = {}) {
  const registry = new SessionRegistry();
  const clock = { at: 1_000 };
  const created: FakeSlot[] = [];
  const dequeued: Array<{ slotId: string; file: string }> = [];
  const pool = new SlotPool({
    registry,
    maxSlots: opts.max ?? 2,
    now: () => clock.at,
    createSlot: ({ id, workspace, sessionFile }) => {
      const slot = new FakeSlot(id, workspace, sessionFile, clock.at);
      created.push(slot);
      return slot;
    },
    onDequeued: (slotId, file) => dequeued.push({ slotId, file }),
  });
  return { pool, registry, clock, created, dequeued };
}

const WS = "D:/proj";
const file = (n: string) => `${WS}/.omcp/science/sessions/s${n}.jsonl`;

test("第一个会话新建槽并激活；第二个会话另起一槽而不是抢占", async () => {
  const { pool, registry } = make({ max: 2 });

  const a = await pool.open(file(1), WS);
  assert.equal(a.kind, "created");
  assert.equal(pool.list().length, 1);
  assert.equal(pool.active?.sessionFile, file(1));
  assert.equal(registry.get(file(1))?.state, "idle");

  const b = await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(b.kind, "created");
  assert.equal(pool.list().length, 2);
  assert.equal(pool.active?.sessionFile, file(2));
  // 第一个槽仍在跑，没被停
  assert.equal(pool.list().filter((s) => s.running).length, 2);
});

test("同一会话再打开是激活，不新建也不重复 start", async () => {
  const { pool, created } = make({ max: 2 });
  await pool.open(file(1), WS);
  await pool.open(file(2), WS);
  const again = await pool.open(file(1), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(again.kind, "activated");
  assert.equal(created.length, 2);
  assert.equal(created[0].startCount, 1);
});

test("满员时停掉最久未用的空闲槽腾额度，槽对象保留（会话挂起）", async () => {
  const { pool, clock, created, registry } = make({ max: 2 });
  await pool.open(file(1), WS);
  clock.at += 1_000;
  await pool.open(file(2), WS);

  clock.at += 1_000;
  const third = await pool.open(file(3), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(third.kind, "preempted");
  if (third.kind !== "preempted") return;
  assert.equal(third.suspended, created[0].id);
  // 第一个槽被停（不是被销毁），会话变成挂起
  assert.equal(created[0].isRunning, false);
  assert.equal(created[0].disposed, false);
  assert.equal(registry.get(file(1))?.state, "suspended");
  assert.equal(pool.runningCount(), 2);
  assert.equal(pool.list().length, 3);
});

test("已挂起的槽优先被复用：换绑而不是新建进程", async () => {
  const { pool, clock, created } = make({ max: 2 });
  const a = await pool.open(file(1), WS);
  clock.at += 1_000;
  await pool.open(file(2), WS);
  // 停掉槽 a（模拟空闲回收），它变成可复用的挂起槽
  assert.equal(pool.stopSlot(a.slotId), true);
  const slotA = created.find((s) => s.id === a.slotId);
  assert.ok(slotA);
  clock.at += 1_000;

  const third = await pool.open(file(3), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(third.kind, "resumed");
  if (third.kind !== "resumed") return;
  assert.equal(third.slotId, a.slotId);
  assert.equal(created.length, 2, "不该新建第三个槽对象");
  assert.equal(slotA.isRunning, true);
  assert.equal(slotA.sessionFile, file(3));
});

test("忙碌且可见的槽不被抢占：第三个会话进队，槽空出后按位次放行", async () => {
  const { pool, clock, created, dequeued } = make({ max: 2 });
  const a = await pool.open(file(1), WS);
  await pool.open(file(2), WS);
  const slotA = created.find((s) => s.id === a.slotId);
  assert.ok(slotA);
  // A 在跑（不可抢），B 是当前可见（也不抢）
  slotA.busy = true;

  const third = await pool.open(file(3), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(third.kind, "queued");
  if (third.kind !== "queued") return;
  assert.equal(third.position, 1);
  assert.equal(pool.queueLength(), 1);

  // A 跑完了 → 它变成可抢 → 队首被放行（会抢掉 A）
  slotA.busy = false;
  clock.at += 100;
  pool.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(pool.queueLength(), 0);
  assert.deepEqual(dequeued.map((d) => d.file), [file(3)]);
  assert.equal(pool.list().some((s) => s.sessionFile === file(3)), true);
});

test("等审批的槽不可停（isBlocked），解除后才能腾额度", async () => {
  const registry = new SessionRegistry();
  const clock = { at: 1_000 };
  const created: FakeSlot[] = [];
  const blocked = new Set<string>();
  const pool = new SlotPool({
    registry,
    maxSlots: 2,
    now: () => clock.at,
    isBlocked: (slotId) => blocked.has(slotId),
    createSlot: ({ id, workspace, sessionFile }) => {
      const slot = new FakeSlot(id, workspace, sessionFile, clock.at);
      created.push(slot);
      return slot;
    },
  });

  const a = await pool.open(file(1), WS);
  clock.at += 1_000;
  const b = await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });

  blocked.add(a.slotId);
  blocked.add(b.slotId);

  const third = await pool.open(file(3), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(third.kind, "queued");

  blocked.delete(a.slotId);
  pool.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pool.queueLength(), 0);
  assert.equal(created[0].isRunning, false, "解除阻塞后被停掉腾额度");
  assert.equal(created[0].disposed, false);
});

test("跨工作区不共用槽：同一条会话在别的工作区会新开槽", async () => {
  const { pool } = make({ max: 2 });
  await pool.open(file(1), WS);
  const other = "D:/other";
  const outcome = await pool.open(other + "/.omcp/science/sessions/x.jsonl", other, {
    visibleSlotId: pool.activeSlotId,
  });
  assert.equal(outcome.kind, "created");
  assert.equal(pool.list().length, 2);
  assert.deepEqual(
    pool.list().map((s) => s.workspace).sort(),
    [WS, other].sort(),
  );
});

test("关闭槽会解绑会话（变 suspended），会话不消失", async () => {
  const { pool, registry } = make({ max: 2 });
  const a = await pool.open(file(1), WS);
  pool.closeSlot(a.slotId);
  assert.equal(pool.list().length, 0);
  const record = registry.get(file(1));
  assert.ok(record);
  assert.equal(record.slotId, null);
  assert.equal(record.state, "suspended");
});

test("空闲回收只停 pi、不删槽；切回时重新 start", async () => {
  const { pool, clock, created } = make({ max: 2 });
  const a = await pool.open(file(1), WS);
  await pool.open(file(2), WS);
  clock.at += 60_000 * 31;

  const touched = pool.reapIdle(30 * 60_000);
  assert.deepEqual(touched, [a.slotId]);
  assert.equal(pool.list().length, 2);
  const slotA = created.find((s) => s.id === a.slotId);
  assert.ok(slotA);
  assert.equal(slotA.isRunning, false);

  const back = await pool.open(file(1), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(back.kind, "activated");
  assert.equal(slotA.isRunning, true);
  assert.equal(slotA.startCount, 2);
});

test("重名会话排队不会重复入队", async () => {
  const { pool, created } = make({ max: 1 });
  const a = await pool.open(file(1), WS);
  const slotA = created.find((s) => s.id === a.slotId);
  assert.ok(slotA);
  slotA.busy = true;

  const first = await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });
  const second = await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(first.kind, "queued");
  assert.equal(second.kind, "queued");
  assert.equal(pool.queueLength(), 1);
});

test("被钉住的槽（默认槽）只挂起不销毁", async () => {
  const registry = new SessionRegistry();
  const clock = { at: 1_000 };
  const created: FakeSlot[] = [];
  const pool = new SlotPool({
    registry,
    maxSlots: 2,
    now: () => clock.at,
    pinnedSlots: ["default"],
    createSlot: ({ id, workspace, sessionFile }) => {
      const slot = new FakeSlot(id, workspace, sessionFile, clock.at);
      created.push(slot);
      return slot;
    },
  });
  const pinned = new FakeSlot("default", WS, file(1), clock.at);
  pool.adopt(pinned);
  registry.upsert({ file: file(1), workspace: WS });
  registry.bind(file(1), "default");

  pool.closeSlot("default");
  assert.equal(pool.list().length, 1, "槽还在");
  assert.equal(pinned.disposed, false, "没有销毁");
  assert.equal(pinned.isRunning, false, "只是停了");
  assert.equal(registry.get(file(1))?.slotId, null);
});

test("排队位次：按入队顺序，重复请求不占两个位", async () => {
  const { pool, created } = make({ max: 1 });
  const a = await pool.open(file(1), WS);
  const slotA = created.find((s) => s.id === a.slotId);
  assert.ok(slotA);
  slotA.busy = true;

  await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });
  await pool.open(file(3), WS, { visibleSlotId: pool.activeSlotId });
  await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });

  assert.deepEqual(pool.queuePositions(), [
    { file: file(2), position: 1 },
    { file: file(3), position: 2 },
  ]);
});

test("换工作区时丢掉旧队列，不会把旧工作区的会话放进来", async () => {
  const { pool, created } = make({ max: 1 });
  const a = await pool.open(file(1), WS);
  const slotA = created.find((s) => s.id === a.slotId);
  assert.ok(slotA);
  slotA.busy = true;
  await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });
  assert.equal(pool.queueLength(), 1);

  assert.deepEqual(pool.dropQueue(), [file(2)]);
  assert.equal(pool.queueLength(), 0);
  assert.deepEqual(pool.queuePositions(), []);
});

test("启动中的槽不会被抢占（B4）", async () => {
  const registry = new SessionRegistry();
  const clock = { at: 1_000 };
  const created: FakeSlot[] = [];
  let releaseFirst: (() => void) | null = null;
  const pool = new SlotPool({
    registry,
    maxSlots: 2,
    now: () => clock.at,
    createSlot: ({ id, workspace, sessionFile }) => {
      const slot = new FakeSlot(id, workspace, sessionFile, clock.at);
      // 第一个槽卡在"启动中"
      if (created.length === 0) {
        slot.start = () => {
          slot.isRunning = true;
        };
        slot.waitReady = () =>
          new Promise<void>((resolve) => {
            releaseFirst = () => {
              slot.ready = true;
              resolve();
            };
          });
      }
      created.push(slot);
      return slot;
    },
  });

  const opening = pool.open(file(1), WS); // 卡在 waitReady
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pool.list()[0]?.state, "starting");

  clock.at += 1_000;
  await pool.open(file(2), WS, { visibleSlotId: pool.activeSlotId });
  const third = await pool.open(file(3), WS, { visibleSlotId: pool.activeSlotId });

  assert.equal(third.kind, "queued", "两个槽都不该被抢：一个在启动、一个是可见的");
  releaseFirst?.();
  await opening;
  assert.equal(pool.list().filter((s) => s.running).length, 2);
});
