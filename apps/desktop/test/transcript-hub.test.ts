import test from "node:test";
import assert from "node:assert/strict";

import { TranscriptHub } from "../src/main/transcript-hub.ts";
import type { ChatItem, PiEvent } from "@oh-my-coding-pi/shared";

/** 修改 4 · M1：转录中枢 —— 后台照记、快照带版本、未读可清。 */

const delta = (text: string) =>
  ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  }) as unknown as PiEvent;
const start = { type: "message_start", message: { role: "assistant", content: [] } } as unknown as PiEvent;
const end = (text: string) =>
  ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) as unknown as PiEvent;

test("没见过的会话：快照是 cold，让调用方去重建", () => {
  const hub = new TranscriptHub();
  const shot = hub.snapshot("session:a");
  assert.equal(shot.cold, true);
  assert.deepEqual(shot.items, []);
  assert.equal(shot.revision, 0);
});

test("归约 + 版本号：每条改变内容的事件 revision +1", () => {
  const hub = new TranscriptHub({ now: () => 1 });
  hub.ingest("session:a", start);
  const afterStart = hub.snapshot("session:a").revision;
  hub.ingest("session:a", delta("你"));
  hub.ingest("session:a", delta("好"));
  const shot = hub.snapshot("session:a");
  assert.equal(shot.revision, afterStart + 2);
  assert.equal((shot.items[0] as { text: string }).text, "你好");
  assert.equal(shot.cold, false);
});

test("不改变内容的事件不涨版本（避免界面无谓重绘）", () => {
  const hub = new TranscriptHub();
  hub.ingest("session:a", start);
  const before = hub.snapshot("session:a").revision;
  hub.ingest("session:a", { type: "agent_start" } as PiEvent);
  assert.equal(hub.snapshot("session:a").revision, before);
});

test("后台会话照样归约：不订阅也一直记", () => {
  const hub = new TranscriptHub();
  hub.ingest("session:b", start);
  hub.ingest("session:b", end("后台跑完了"));
  const shot = hub.snapshot("session:b");
  assert.equal(shot.items.length, 1);
  assert.equal((shot.items[0] as { text: string }).text, "后台跑完了");
});

test("未读：assistant 一轮收尾 +1，clearUnread 归零", () => {
  const hub = new TranscriptHub();
  hub.ingest("session:a", start);
  hub.ingest("session:a", end("甲"));
  hub.ingest("session:a", start);
  hub.ingest("session:a", end("乙"));
  assert.equal(hub.snapshot("session:a").unread, 2);
  hub.clearUnread("session:a");
  assert.equal(hub.snapshot("session:a").unread, 0);
});

test("用户轮次与系统提示都算内容，并各自涨版本", () => {
  const hub = new TranscriptHub();
  hub.userTurn("session:a", "跑一下");
  hub.system("session:a", "内核已回收");
  const shot = hub.snapshot("session:a");
  assert.equal(shot.items.length, 2);
  assert.equal(shot.revision, 2);
  assert.equal(shot.items[0]!.kind, "user");
  assert.equal(shot.items[1]!.kind, "system");
});

test("seed：重建后覆盖条目，并把版本抬高（等增量的客户端会重取）", () => {
  const hub = new TranscriptHub();
  hub.ingest("session:a", start);
  const before = hub.snapshot("session:a").revision;

  const rebuilt: ChatItem[] = [
    { kind: "user", id: "u1", text: "以前说的", at: 1 },
    { kind: "assistant", id: "a1", text: "以前答的" },
  ];
  hub.seed("session:a", rebuilt);
  const shot = hub.snapshot("session:a");
  assert.equal(shot.items.length, 2);
  assert.ok(shot.revision > before);
});

test("订阅：每次内容变化喊一声，退订后不再喊", () => {
  const hub = new TranscriptHub();
  const seen: Array<[string, number]> = [];
  const off = hub.onUpdate((key, revision) => seen.push([key, revision]));
  hub.ingest("session:a", start);
  hub.ingest("session:b", start);
  assert.deepEqual(seen.map(([k]) => k), ["session:a", "session:b"]);
  off();
  hub.ingest("session:a", delta("x"));
  assert.equal(seen.length, 2);
});

test("条目数有上限：超了从头丢，内存不无限涨", () => {
  const hub = new TranscriptHub({ maxItems: 50 });
  for (let i = 0; i < 120; i += 1) hub.userTurn("session:a", `第 ${i} 句`);
  const shot = hub.snapshot("session:a");
  assert.equal(shot.items.length, 50);
  assert.equal((shot.items.at(-1) as { text: string }).text, "第 119 句");
});

test("summary 只给标量：界面刷新徽标不必搬 items", () => {
  const hub = new TranscriptHub();
  hub.ingest("session:a", start);
  hub.ingest("session:a", end("x"));
  assert.deepEqual(hub.summary("session:a"), { revision: 2, unread: 1, failed: false });
  assert.deepEqual(hub.summary("session:none"), { revision: 0, unread: 0, failed: false });
});
