import test from "node:test";
import assert from "node:assert/strict";

import { preflightModel } from "../src/main/model-preflight.ts";

/**
 * 发送前预检（PR1）：三类失败必须分得开，且每一类都给得出下一步。
 * 预检不联网、不读密钥值——只判断「有没有」与「地址/模型对不对」。
 */

const catalog = {
  baseUrl: "https://api.deepseek.com",
  api: "openai-completions",
  requiresBaseUrl: false,
  models: [{ id: "deepseek-flash" }],
};

test("缺凭据：先拦，给 add_key", () => {
  const r = preflightModel({
    provider: "deepseek",
    modelId: "deepseek-flash",
    config: null,
    catalog,
    hasCredential: false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_credential");
  assert.equal(r.fix, "add_key");
});

test("有凭据 + 目录默认地址 + 目录里有该模型：放行", () => {
  const r = preflightModel({
    provider: "deepseek",
    modelId: "deepseek-flash",
    config: null,
    catalog,
    hasCredential: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.baseUrl, "https://api.deepseek.com");
});

test("需要自填地址的服务商（azure 类）没填地址：bad_url + 去确认", () => {
  const r = preflightModel({
    provider: "azure",
    modelId: "gpt-4o",
    config: null,
    catalog: { baseUrl: "", requiresBaseUrl: true, models: [{ id: "gpt-4o" }] },
    hasCredential: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_url");
  assert.equal(r.fix, "confirm_connection");
});

test("地址不是 http(s)：bad_url", () => {
  const r = preflightModel({
    provider: "custom",
    modelId: "m1",
    config: { baseUrl: "ftp://x", models: [{ id: "m1" }] },
    catalog: null,
    hasCredential: true,
  });
  assert.equal(r.reason, "bad_url");
});

test("模型在配置与目录里都没有：model_not_found + 去换模型", () => {
  const r = preflightModel({
    provider: "deepseek",
    modelId: "deepseek-nonexistent",
    config: { baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-flash" }] },
    catalog,
    hasCredential: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "model_not_found");
  assert.equal(r.fix, "choose_model");
});

test("自定义 provider 只在自己的配置里列出模型：认配置", () => {
  const r = preflightModel({
    provider: "my-gateway",
    modelId: "qwen3",
    config: { baseUrl: "https://gw.example.com/v1", models: [{ id: "qwen3" }] },
    catalog: null,
    hasCredential: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.baseUrl, "https://gw.example.com/v1");
});

test("两边都不认识这个 provider：unknown_provider", () => {
  const r = preflightModel({
    provider: "not-a-provider",
    modelId: "x",
    config: null,
    catalog: null,
    hasCredential: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_provider");
});

test("配置地址优先于目录默认地址", () => {
  const r = preflightModel({
    provider: "deepseek",
    modelId: "deepseek-flash",
    config: { baseUrl: "https://proxy.example.com/v1", models: [{ id: "deepseek-flash" }] },
    catalog,
    hasCredential: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.baseUrl, "https://proxy.example.com/v1");
});
