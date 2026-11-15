import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, probePlan } from "../src/main/model-probe.ts";

test("normalizeBaseUrl：去尾斜杠、去掉误填的端点", () => {
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(
    normalizeBaseUrl("https://api.deepseek.com/v1/chat/completions"),
    "https://api.deepseek.com/v1",
  );
  assert.equal(normalizeBaseUrl("https://x.ai/responses"), "https://x.ai");
});

test("已带版本段：只试 /models", () => {
  const plan = probePlan("https://api.openai.com/v1", "openai-responses");
  assert.deepEqual(plan.urls, ["https://api.openai.com/v1/models"]);
  assert.equal(plan.headers.authorization, "Bearer __KEY__");
});

test("没有版本段：先原样，再补 /v1", () => {
  const plan = probePlan("https://api.deepseek.com", "openai-completions");
  assert.deepEqual(plan.urls, [
    "https://api.deepseek.com/models",
    "https://api.deepseek.com/v1/models",
  ]);
});

test("openrouter 的 /api 前缀：候选包含 /api/v1/models", () => {
  const plan = probePlan("https://openrouter.ai/api", "openai-completions");
  assert.deepEqual(plan.urls, [
    "https://openrouter.ai/api/models",
    "https://openrouter.ai/api/v1/models",
  ]);
});

test("anthropic：/v1/models 且用 x-api-key + anthropic-version", () => {
  const plan = probePlan("https://api.anthropic.com", "anthropic-messages");
  assert.deepEqual(plan.urls, ["https://api.anthropic.com/v1/models"]);
  assert.equal(plan.headers["x-api-key"], "__KEY__");
  assert.equal(plan.headers["anthropic-version"], "2023-06-01");
  assert.equal(plan.headers.authorization, undefined);
});

test("google：key 走 query", () => {
  const plan = probePlan("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai");
  assert.deepEqual(plan.urls, ["https://generativelanguage.googleapis.com/v1beta/models"]);
  assert.equal(plan.keyInQuery, true);
});

test("azure / bedrock：明确说不适用，不冒充 404", () => {
  assert.match(probePlan("https://x.openai.azure.com", "azure-openai-responses").unsupported ?? "", /部署名/);
  assert.match(probePlan("https://bedrock-runtime.us-east-1.amazonaws.com", "bedrock-converse-stream").unsupported ?? "", /区域/);
});
