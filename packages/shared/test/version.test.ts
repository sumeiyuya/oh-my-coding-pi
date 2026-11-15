import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isNewerVersion, parseVersion } from "../src/version.ts";

test("解析版本号：v 前缀与预发布", () => {
  assert.deepEqual(parseVersion("v0.4.0"), { major: 0, minor: 4, patch: 0, prerelease: null });
  assert.deepEqual(parseVersion("1.2.3-beta.1"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: "beta.1",
  });
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("abc"), null);
});

test("比较：数值优先", () => {
  assert.equal(compareVersions("0.4.0", "0.3.0"), 1);
  assert.equal(compareVersions("0.3.0", "0.4.0"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v0.4.0", "0.4.0"), 0);
});

test("预发布低于正式版", () => {
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
});

test("isNewerVersion", () => {
  assert.equal(isNewerVersion("0.4.0", "0.5.0"), true);
  assert.equal(isNewerVersion("0.4.0", "0.4.0"), false);
  assert.equal(isNewerVersion("0.4.0", "0.3.9"), false);
});
