import test from "node:test";
import assert from "node:assert/strict";

import { credentialEnvNames, hasEnvCredential, providerEnvKey } from "../src/main/model-env.ts";
import { providerEnvKey as registryProviderEnvKey } from "../src/main/model-registry.ts";

/** 内置 provider 必须按 pi 官方变量名注入，否则「密钥存了、pi 却说没有」。 */

test("内置 provider：官方名在前，OMCP_KEY 兜底", () => {
  assert.deepEqual(credentialEnvNames("deepseek", ["DEEPSEEK_API_KEY"]), [
    "DEEPSEEK_API_KEY",
    "OMCP_KEY_DEEPSEEK",
  ]);
});

test("多个官方名（anthropic）都保留，并去重", () => {
  const names = credentialEnvNames("anthropic", [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OMCP_KEY_ANTHROPIC",
  ]);
  assert.deepEqual(names, [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OMCP_KEY_ANTHROPIC",
  ]);
});

test("没有官方名（自定义 / 环境凭据型）：只有 OMCP_KEY_<ID>", () => {
  assert.deepEqual(credentialEnvNames("my-gateway", undefined), ["OMCP_KEY_MY_GATEWAY"]);
  assert.deepEqual(credentialEnvNames("amazon-bedrock", []), ["OMCP_KEY_AMAZON_BEDROCK"]);
});

test("provider id 里的符号转下划线", () => {
  assert.deepEqual(credentialEnvNames("some.provider-1", undefined), ["OMCP_KEY_SOME_PROVIDER_1"]);
});

test("hasEnvCredential：任一官方名存在即算有", () => {
  const env = { DEEPSEEK_API_KEY: "sk-x" } as Record<string, string | undefined>;
  assert.equal(hasEnvCredential("deepseek", ["DEEPSEEK_API_KEY"], env), true);
  assert.equal(hasEnvCredential("deepseek", ["DEEPSEEK_API_KEY"], {}), false);
  assert.equal(hasEnvCredential("deepseek", ["DEEPSEEK_API_KEY"], { OMCP_KEY_DEEPSEEK: "x" }), true);
});

test("两处 providerEnvKey 实现必须一致（防止哪天改了一边）", () => {
  for (const id of ["deepseek", "some.provider-1", "a_b", "UPPER"]) {
    assert.equal(providerEnvKey(id), registryProviderEnvKey(id));
  }
});
