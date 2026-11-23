import test from "node:test";
import assert from "node:assert/strict";

import type { PiEvent } from "@oh-my-coding-pi/shared";
import { SessionRuntime } from "../src/main/session-runtime.ts";

/** P0：容器只负责“装”，不改变单会话行为；锁住 token/env/工作区与事件泵。 */

function make(over: Partial<ConstructorParameters<typeof SessionRuntime>[0]> = {}) {
  const events: PiEvent[] = [];
  const ids: string[] = [];
  const runtime = new SessionRuntime({
    id: "r1",
    provider: "p",
    model: "m",
    emit: (event, runtimeId) => {
      events.push(event);
      ids.push(runtimeId);
    },
    pumpEnabled: true,
    ...over,
  });
  return { runtime, events, ids };
}

test("构造：id / provider / model / token", () => {
  const { runtime } = make();
  assert.equal(runtime.id, "r1");
  assert.equal(runtime.supervisor.getProvider(), "p");
  assert.equal(runtime.supervisor.getModel(), "m");
  assert.match(runtime.token, /^[0-9a-f]{48}$/);
  runtime.dispose();
});

test("env：合并、删除、批量", () => {
  const { runtime } = make({ env: { A: "1" } });
  assert.equal(runtime.environment().A, "1");
  runtime.setEnv("B", "2");
  assert.deepEqual(runtime.environment(), { A: "1", B: "2" });
  runtime.setEnv("A", "");
  assert.equal(runtime.environment().A, undefined);

  runtime.setEnvs({ C: "3", D: undefined });
  assert.equal(runtime.environment().C, "3");
  assert.equal(runtime.environment().D, undefined);

  runtime.resetEnv();
  assert.deepEqual(runtime.environment(), {});
  runtime.dispose();
});

test("工作区与会话：setter 落到 supervisor", () => {
  const { runtime } = make();
  runtime.setWorkspace("C:/ws");
  assert.equal(runtime.workspace, "C:/ws");
  assert.equal(runtime.supervisor.getCwd(), "C:/ws");

  runtime.setSessionFile("C:/ws/.omcp/sessions/a.jsonl");
  assert.equal(runtime.sessionFile, "C:/ws/.omcp/sessions/a.jsonl");
  runtime.setSessionDir("C:/ws/.omcp/sessions");
  runtime.setModel("p2", "m2");
  assert.equal(runtime.supervisor.getProvider(), "p2");
  assert.equal(runtime.supervisor.getModel(), "m2");
  runtime.dispose();
});

test("事件泵：dispose 前把缓冲的文本冲出来", () => {
  const { runtime, events, ids } = make();
  runtime.pump.push({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
  } as PiEvent);
  runtime.pump.dispose();
  assert.equal(events.length, 1);
  const event = events[0] as Extract<PiEvent, { type: "message_update" }>;
  assert.equal(event.assistantMessageEvent.type, "text_delta");
  assert.equal(event.assistantMessageEvent.delta, "hi");
  assert.deepEqual(ids, ["r1"]);
  runtime.dispose();
});
