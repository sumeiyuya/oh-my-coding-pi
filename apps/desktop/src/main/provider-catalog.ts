/**
 * 服务商目录（修改 1 · S1）。
 *
 * 目录由 scripts/build-provider-catalog.mjs 从 pi-ai 的数据 JSON 生成，
 * 随安装包放在 resources/provider-catalog.json；开发态读仓库里的同一份。
 *
 * 只读：用户“加进来”之后，注册表才是事实来源。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CatalogModel {
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  requiresBaseUrl: boolean;
  api: string;
  modelCount: number;
  /** pi-ai 认为这个 provider 的凭据能从哪些环境变量读到（生成器从 pi-ai 源码取，不手写） */
  envKeys?: string[];
  models: CatalogModel[];
}

export interface ProviderCatalog {
  schemaVersion: 1;
  generatedFrom: { dataManifest: string | null; generatedAt: string | null };
  providers: CatalogProvider[];
}

export interface CatalogLoad {
  catalog: ProviderCatalog | null;
  path: string;
  error?: string;
}

function candidates(resourcesPath: string | undefined, appPath: string): string[] {
  const out: string[] = [];
  // 打包：resources/provider-catalog.json
  if (resourcesPath) out.push(join(resourcesPath, "provider-catalog.json"));
  // 开发：apps/desktop/resources/provider-catalog.json
  out.push(join(appPath, "resources", "provider-catalog.json"));
  // 仓库根（某些启动方式下 appPath 不在 apps/desktop）
  out.push(resolve(appPath, "..", "..", "apps", "desktop", "resources", "provider-catalog.json"));
  return [...new Set(out)];
}

let cache: { path: string; catalog: ProviderCatalog } | null = null;

export function loadProviderCatalog(resourcesPath: string | undefined, appPath: string): CatalogLoad {
  for (const path of candidates(resourcesPath, appPath)) {
    if (!existsSync(path)) continue;
    if (cache?.path === path) return { catalog: cache.catalog, path };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as ProviderCatalog;
      if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.providers)) {
        return { catalog: null, path, error: "目录格式不对（schemaVersion 不是 1）" };
      }
      cache = { path, catalog: raw };
      return { catalog: raw, path };
    } catch (err) {
      return { catalog: null, path, error: (err as Error).message };
    }
  }
  return { catalog: null, path: candidates(resourcesPath, appPath)[0], error: "没有找到 provider-catalog.json" };
}
