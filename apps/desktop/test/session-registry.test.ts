import test from "node:test";
import assert from "node:assert/strict";

import { SessionRegistry, crashOutcome, sessionKey } from "../src/main/session-registry.ts";

/** 修改 4 · M0：会话键规范化 + 绑定关系。 */

const BACKSLASH = "\\";

test("Windows 键不区分大小写，但保留原始路径给界面", () => {
  const registry = new SessionRegistry({ now: () => 1 });
  const record = registry.upsert({ file: "D:/Proj/S1.jsonl", workspace: "D:/Proj" });
  assert.equal(record.file, "D:/Proj/S1.jsonl");
  assert.equal(record.key, sessionKey("D:/Proj/S1.jsonl", "win32"));
  assert.equal(registry.get("d:/proj/s1.jsonl")?.key, record.key);
});

test("反斜杠路径与正斜杠路径指向同一条会话", () => {
  const registry = new SessionRegistry({ now: () => 1 });
  const winPath = ["D:", "proj", "s1.jsonl"].join(BACKSLASH);
  registry.upsert({ file: winPath, workspace: "D:/proj" });
  assert.ok(registry.get("D:/proj/s1.jsonl"), "同一个会话应当用两种写法都查得到");
  assert.equal(registry.get("D:/proj/s1.jsonl")?.file, winPath);
});

test("一槽同一时刻只绑一个会话：换绑会解绑旧的", () => {
  const registry = new SessionRegistry({ now: () => 1 });
  registry.upsert({ file: "D:/p/a.jsonl", workspace: "D:/p" });
  registry.upsert({ file: "D:/p/b.jsonl", workspace: "D:/p" });
  registry.bind("D:/p/a.jsonl", "slot-1");
  registry.bind("D:/p/b.jsonl", "slot-1");
  const a = registry.get("D:/p/a.jsonl");
  assert.ok(a);
  assert.equal(a.slotId, null);
  assert.equal(a.state, "suspended");
  assert.equal(registry.sessionOfSlot("slot-1")?.file, "D:/p/b.jsonl");
});

test("按工作区筛选，最近活动的排前面", () => {
  let at = 100;
  const registry = new SessionRegistry({ now: () => at });
  registry.upsert({ file: "D:/p/a.jsonl", workspace: "D:/p" });
  at = 200;
  registry.upsert({ file: "D:/p/b.jsonl", workspace: "D:/p" });
  at = 300;
  registry.upsert({ file: "D:/q/c.jsonl", workspace: "D:/q" });

  assert.deepEqual(registry.list("D:/p").map((r) => r.file), ["D:/p/b.jsonl", "D:/p/a.jsonl"]);
  assert.equal(registry.list("D:/q").length, 1);
});

test("未读与清空；解绑后状态是 suspended", () => {
  const registry = new SessionRegistry({ now: () => 1 });
  registry.upsert({ file: "D:/p/a.jsonl", workspace: "D:/p" });
  registry.bind("D:/p/a.jsonl", "slot-1");
  assert.equal(registry.bumpUnread("D:/p/a.jsonl"), 1);
  assert.equal(registry.bumpUnread("D:/p/a.jsonl"), 2);
  registry.clearUnread("D:/p/a.jsonl");
  assert.equal(registry.get("D:/p/a.jsonl")?.unread, 0);

  registry.unbind("slot-1");
  assert.equal(registry.get("D:/p/a.jsonl")?.slotId, null);
  assert.equal(registry.get("D:/p/a.jsonl")?.state, "suspended");
});

test("崩溃标注：有回合在飞 → interrupted，空闲 → idle，且两句话不一样", () => {
  const busy = crashOutcome(true);
  const idle = crashOutcome(false);
  assert.equal(busy.state, "interrupted");
  assert.equal(idle.state, "idle");
  assert.match(busy.note, /中断/);
  assert.match(idle.note, /自动重启/);
  assert.notEqual(busy.note, idle.note);
});
