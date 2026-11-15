import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPiProviders,
  mergeModelsJson,
  previewPiProvider,
  validateRegistry,
  type ModelRegistry,
} from "../src/main/model-registry.ts";

/**
 * models.json 派生（PR3）：
 * - 没有密钥的 provider 不写进去（pi 会当它是可用的，然后报错）；
 * - 模型元数据从目录继承，避免把收图模型声明成纯文本（或反过来）；
 * - 用户自己写进 models.json 的条目不能被我们覆盖；
 * - 预览片段里只有 $ENV 引用，没有真实密钥。
 */

function registry(): ModelRegistry {
  return validateRegistry({
    version: 1,
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        models: [{ id: "deepseek-flash" }],
      },
    },
  }).registry;
}

const catalogMeta = (providerId: string, modelId: string) =>
  providerId === "deepseek" && modelId === "deepseek-flash"
    ? {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        input: ["text" as const, "image" as const],
        contextWindow: 128000,
        maxTokens: 8192,
      }
    : undefined;

test("没有密钥：跳过并给出原因", () => {
  const built = buildPiProviders(registry(), () => false, catalogMeta);
  assert.deepEqual(Object.keys(built.providers), []);
  assert.equal(built.skipped[0]?.id, "deepseek");
  assert.match(built.skipped[0]?.reason ?? "", /密钥/);
});

test("有密钥：写入 provider，apiKey 是 $OMCP_KEY_<ID> 引用", () => {
  const built = buildPiProviders(registry(), () => true, catalogMeta);
  const p = built.providers.deepseek as { baseUrl: string; apiKey: string; models: unknown[] };
  assert.equal(p.baseUrl, "https://api.deepseek.com");
  assert.equal(p.apiKey, "$OMCP_KEY_DEEPSEEK");
  assert.equal(p.models.length, 1);
});

test("模型元数据从目录继承（input / contextWindow）", () => {
  const built = buildPiProviders(registry(), () => true, catalogMeta);
  const model = (built.providers.deepseek as { models: Array<Record<string, unknown>> }).models[0]!;
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.name, "DeepSeek V4.1 Flash");
});

test("用户显式写的字段优先于目录", () => {
  const reg = validateRegistry({
    version: 1,
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        models: [{ id: "deepseek-flash", input: ["text"], contextWindow: 64000 }],
      },
    },
  }).registry;
  const built = buildPiProviders(reg, () => true, catalogMeta);
  const model = (built.providers.deepseek as { models: Array<Record<string, unknown>> }).models[0]!;
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.contextWindow, 64000);
});

test("目录里没有这个模型：原样写入，不猜", () => {
  const reg = validateRegistry({
    version: 1,
    providers: { x: { baseUrl: "https://x/v1", models: [{ id: "m1" }] } },
  }).registry;
  const built = buildPiProviders(reg, () => true, () => undefined);
  const model = (built.providers.x as { models: Array<Record<string, unknown>> }).models[0]!;
  assert.deepEqual(Object.keys(model), ["id"]);
});

test("合并：保留用户手写条目，只覆盖同名 managed 条目", () => {
  const existing = {
    providers: {
      deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", apiKey: "$OMCP_KEY_DEEPSEEK", models: [] },
      "my-own": { baseUrl: "https://mine/v1", apiKey: "sk-plain", models: [{ id: "m" }] },
    },
  };
  const next = {
    deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", apiKey: "$OMCP_KEY_DEEPSEEK", models: [{ id: "deepseek-flash" }] },
  };
  const merged = mergeModelsJson(existing, next);
  assert.equal(merged.error, undefined);
  const providers = (merged.next as { providers: Record<string, unknown> }).providers;
  assert.deepEqual(Object.keys(providers).sort(), ["deepseek", "my-own"]);
  assert.deepEqual(providers["my-own"], existing.providers["my-own"]);
});

test("预览片段：不含真实密钥", () => {
  const reg = registry();
  const preview = previewPiProvider("deepseek", reg.providers.deepseek!, catalogMeta);
  const text = JSON.stringify(preview);
  assert.match(String(preview.apiKey), /^\$OMCP_KEY_DEEPSEEK$/);
  assert.equal(/sk-[A-Za-z0-9]/.test(text), false);
});
