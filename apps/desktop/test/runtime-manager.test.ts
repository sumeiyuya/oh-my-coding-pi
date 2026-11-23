import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeManager } from "../src/main/runtime-manager.ts";

/** P1a：注册/激活/关闭；不 start、不 stop 其他 runtime。 */

function make() {
  const manager = new RuntimeManager();
  const base = { emit: () => {}, pumpEnabled: false };
  const a = manager.create({ id: "a", provider: "p", model: "m", ...base });
  const b = manager.create({ id: "b", provider: "p", model: "m", ...base });
  return { manager, a, b };
}

test("第一个 runtime 自动激活；list 标出 active", () => {
  const { manager, a } = make();
  assert.equal(manager.active?.id, "a");
  assert.equal(manager.services.resolve(a.token)?.runtimeId, "a");
  assert.deepEqual(manager.list().map((x) => [x.id, x.active]), [
    ["a", true],
    ["b", false],
  ]);
  manager.updateSession("a", "s1");
  assert.equal(manager.services.resolve(a.token)?.session, "s1");
  manager.closeAll();
});

test("activate 只切 active，不碰其他 runtime", () => {
  const { manager, b } = make();
  manager.activate("b");
  assert.equal(manager.active?.id, "b");
  assert.equal(manager.get("a")?.id, "a");
  assert.equal(b.id, "b");
  manager.closeAll();
});

test("关闭 active 后顺延到下一个；全关后 active=null", () => {
  const { manager, b } = make();
  manager.activate("b");
  const token = b.token;
  manager.close("b");
  assert.equal(manager.active?.id, "a");
  assert.equal(manager.services.resolve(token), undefined);
  manager.close("a");
  assert.equal(manager.active, null);
  assert.deepEqual(manager.list(), []);
});

test("重复 id 拒绝；close 不存在的 id 不抛", () => {
  const { manager } = make();
  assert.throws(() => manager.create({ id: "a", emit: () => {}, pumpEnabled: false }), /已存在/);
  assert.doesNotThrow(() => manager.close("missing"));
  manager.closeAll();
});

test("创建时注入 runtime id/token 环境变量", () => {
  const { manager, a } = make();
  const env = a.environment();
  assert.equal(env.OMCP_RUNTIME_ID, "a");
  assert.equal(env.OMCP_RUNTIME_TOKEN, a.token);
  manager.closeAll();
});

test("maxRuntimes 上限拒绝第三个 runtime", () => {
  const manager = new RuntimeManager({ maxRuntimes: 2 });
  const base = { emit: () => {}, pumpEnabled: false };
  manager.create({ id: "a", ...base });
  manager.create({ id: "b", ...base });
  assert.throws(() => manager.create({ id: "c", ...base }), /上限/);
  manager.closeAll();
});

test("setMaxRuntimes 动态调整上限", () => {
  const manager = new RuntimeManager({ maxRuntimes: 2 });
  const base = { emit: () => {}, pumpEnabled: false };
  manager.create({ id: "a", ...base });
  manager.create({ id: "b", ...base });
  assert.throws(() => manager.create({ id: "c", ...base }), /上限/);
  manager.setMaxRuntimes(3);
  manager.create({ id: "c", ...base });
  assert.equal(manager.list().length, 3);
  manager.closeAll();
});
