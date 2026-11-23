import test from "node:test";
import assert from "node:assert/strict";

import { ServiceHub } from "../src/main/service-hub.ts";

/** P1b1：token → runtimeId 的反查表；不接服务，只锁语义。 */

test("register / resolve / list", () => {
  const hub = new ServiceHub();
  hub.register({ id: "a", token: "ta", workspace: "C:/a", sessionFile: "s1" });
  hub.register({ id: "b", token: "tb", workspace: "C:/b" });
  assert.deepEqual(hub.resolve("ta"), { runtimeId: "a", workspace: "C:/a", session: "s1" });
  hub.updateSession("ta", "s2");
  assert.equal(hub.resolve("ta")?.session, "s2");
  assert.equal(hub.resolve("nope"), undefined);
  assert.equal(hub.list().length, 2);
});

test("unregister 后查不到", () => {
  const hub = new ServiceHub();
  hub.register({ id: "a", token: "ta", workspace: "C:/a" });
  hub.unregister("ta");
  assert.equal(hub.resolve("ta"), undefined);
  assert.deepEqual(hub.list(), []);
});

test("重复 token 拒绝", () => {
  const hub = new ServiceHub();
  hub.register({ id: "a", token: "same", workspace: "C:/a" });
  assert.throws(
    () => hub.register({ id: "b", token: "same", workspace: "C:/b" }),
    /重复/,
  );
});
