import test from "node:test";
import assert from "node:assert/strict";

import { describeModelError } from "../src/model-error.ts";

/** 错误归一（PR4）：先把 pi 的原文分类，再给下一步；认不出来就 unknown。 */

const kinds = (text: string) => describeModelError(text)?.kind;

test("缺凭据：No API key found → no_credential，并指向补密钥入口", () => {
  const info = describeModelError(
    "No API key found for deepseek.\n\nUse /login to log into a provider via OAuth or API key.",
  );
  assert.equal(info?.kind, "no_credential");
  assert.match(String(info?.hint), /缺密钥|模型注册表/);
});

test("401 / 403 → auth（不是网络错误）", () => {
  assert.equal(kinds('401: {"message":"Invalid API key"}'), "auth");
  assert.equal(kinds("403 Forbidden: permission denied"), "auth");
});

test("429 → quota（并保留限流语义）", () => {
  const info = describeModelError('429: {"message":"Rate limit reached, resets in 3h 15m"}');
  assert.equal(info?.kind, "quota");
  assert.match(String(info?.hint), /恢复/);
});

test("模型不存在 → missing", () => {
  assert.equal(kinds("404 model not found: deepseek-xxx"), "missing");
});

test("地址/证书问题 → url", () => {
  assert.equal(kinds("connect ECONNREFUSED 127.0.0.1:8080"), "url");
  assert.equal(kinds("getaddrinfo ENOTFOUND api.example.com"), "url");
});

test("超时 / 断链 → network", () => {
  assert.equal(kinds("fetch failed: socket hang up"), "network");
  assert.equal(kinds("request timed out"), "network");
});

test("认不出来：unknown，但保留原文片段", () => {
  const info = describeModelError("something totally unexpected happened");
  assert.equal(info?.kind, "unknown");
  assert.match(String(info?.detail), /unexpected/);
});

test("空输入返回 null", () => {
  assert.equal(describeModelError(""), null);
  assert.equal(describeModelError(null), null);
});
