#!/usr/bin/env node
/**
 * 生成「从 pi 认识的服务商里挑」的目录（修改 1 · S1）。
 *
 * 数据来自 pi-ai 自带的 provider 数据（纯 JSON，不执行 pi 代码）：
 *   vendor/pi-bundle/payload/node_modules/@earendil-works/pi-ai/dist/providers/data/*.json
 *
 * 输出：apps/desktop/resources/provider-catalog.json
 * 决策（修改 1）：取全部 43 个 provider，不过滤；模型清单全量保留，不截断。
 *
 * 用法：
 *   node scripts/build-provider-catalog.mjs           生成并写入
 *   node scripts/build-provider-catalog.mjs --check   只比对，不一致则退出码 1（CI / 打包用）
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEYS_JS = join(
  root,
  "vendor/pi-bundle/payload/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js",
);
const DATA_DIR = join(
  root,
  "vendor/pi-bundle/payload/node_modules/@earendil-works/pi-ai/dist/providers/data",
);
const OUT = join(root, "apps/desktop/resources/provider-catalog.json");
const CHECK_ONLY = process.argv.includes("--check");

/** 这些 provider 的地址是区域/资源相关的，必须由用户填 */
const REQUIRES_BASE = new Set(["azure", "amazon-bedrock", "google-vertex"]);

/**
 * 从 pi-ai 自己的代码里问“这个 provider 读哪些环境变量”，不自己维护映射表。
 *
 * 做法：给 findEnvKeys 一个“什么都有的” env 代理，它会把这个 provider 关心的
 * 变量名全都返回。pi 升级后新增/改名的变量会自动跟上来；
 * 如果哪天这个函数没了，下面会直接报错，而不是静静生成一份空映射。
 */
async function createEnvKeyLookup() {
  if (!existsSync(ENV_KEYS_JS)) {
    console.error("找不到 pi-ai 的 env-api-keys.js：", ENV_KEYS_JS);
    console.error("先跑 node scripts/prepare-pi-bundle.mjs");
    process.exit(1);
  }
  const mod = await import(pathToFileURL(ENV_KEYS_JS).href);
  if (typeof mod.findEnvKeys !== "function") {
    console.error("pi-ai 的 env-api-keys.js 不再导出 findEnvKeys；需要更新生成器");
    process.exit(1);
  }
  const probeEnv = new Proxy(
    {},
    {
      get(_target, key) {
        return typeof key === "string" ? "probe" : undefined;
      },
      has() {
        return true;
      },
    },
  );
  return (providerId) => {
    try {
      return mod.findEnvKeys(providerId, probeEnv) ?? [];
    } catch {
      return [];
    }
  };
}

async function main() {  if (!existsSync(DATA_DIR)) {
    console.error("找不到 pi-ai 的 provider 数据目录：", DATA_DIR);
    console.error("先跑 pnpm fetch:pi / node scripts/prepare-pi-bundle.mjs");
    process.exit(1);
  }

  const envKeysOf = await createEnvKeyLookup();
  if (!envKeysOf("deepseek").includes("DEEPSEEK_API_KEY")) {
    console.error("env 映射自检失败：deepseek 应为 DEEPSEEK_API_KEY，实际：", envKeysOf("deepseek"));
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(DATA_DIR, ".manifest.json"), "utf8"));
  const files = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();

  const providers = [];
  let modelTotal = 0;

  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    const raw = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8"));
    const models = new Map();
    const apis = new Map();

    for (const [api, entries] of Object.entries(raw)) {
      if (!entries || typeof entries !== "object") continue;
      for (const entry of Object.values(entries)) {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
        if (!models.has(entry.id)) {
          models.set(entry.id, {
            id: entry.id,
            ...(typeof entry.name === "string" ? { name: entry.name } : {}),
            ...(Array.isArray(entry.input) ? { input: entry.input } : {}),
            ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
            ...(typeof entry.maxTokens === "number" ? { maxTokens: entry.maxTokens } : {}),
            ...(entry.cost && typeof entry.cost === "object" ? { cost: entry.cost } : {}),
            ...(typeof entry.baseUrl === "string" && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          });
        }
        apis.set(api, (apis.get(api) ?? 0) + 1);
      }
    }

    const list = [...models.values()];
    if (list.length === 0) continue;
    modelTotal += list.length;

    const baseUrl = list.find((m) => m.baseUrl)?.baseUrl ?? "";
    const api = [...apis.entries()].sort((a, b) => b[1] - a[1])[0][0];

    providers.push({
      id,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      requiresBaseUrl: REQUIRES_BASE.has(id) || !baseUrl,
      api,
      modelCount: list.length,
      /** 这个 provider 的凭据能从哪些环境变量读到（来自 pi-ai，不手写） */
      envKeys: envKeysOf(id),
      models: list.map(({ baseUrl: _drop, ...rest }) => rest),
    });
  }

  const doc = {
    schemaVersion: 1,
    generatedFrom: {
      dataManifest: manifest.structureHash ?? null,
      generatedAt: manifest.generatedAt ?? null,
    },
    providers,
  };
  const text = JSON.stringify(doc, null, 2) + "\n";

  if (CHECK_ONLY) {
    if (!existsSync(OUT)) {
      console.error("provider-catalog.json 不存在：", OUT);
      console.error("修复：node scripts/build-provider-catalog.mjs");
      process.exit(1);
    }
    const current = readFileSync(OUT, "utf8");
    if (current === text) {
      console.log(`provider-catalog 一致：${providers.length} providers · dataManifest 匹配`);
      return;
    }
    let old = null;
    try {
      old = JSON.parse(current);
    } catch {
      old = null;
    }
    console.error("provider-catalog.json 已过期（与当前 pi-ai 数据不一致）");
    console.error(
      `  文件内：providers=${old?.providers?.length ?? "?"} dataManifest=${old?.generatedFrom?.dataManifest ?? "?"}`,
    );
    console.error(
      `  当前数据：providers=${doc.providers.length} dataManifest=${doc.generatedFrom.dataManifest}`,
    );
    console.error("修复：node scripts/build-provider-catalog.mjs（然后提交变更）");
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, "utf8");

  const needBase = providers.filter((p) => p.requiresBaseUrl).map((p) => p.id);
  console.log(`providers ${providers.length} · models ${modelTotal}`);
  console.log(`需要填地址：${needBase.join("、") || "（无）"}`);
  console.log(`输出 ${OUT}`);
}

main();
