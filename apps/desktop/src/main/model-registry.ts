/**
 * 模型注册表：oh my coding pi 自己的 provider 清单。
 * 只负责“读/校验/生成 pi 的 models.json 片段/合并”，不碰网络，不读密钥。
 */

export interface RegistryModel {
  id: string;
  name?: string;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface RegistryProvider {
  baseUrl: string;
  api?: string;
  /** 本地服务（Ollama / LM Studio 等）：不需要真 key，pi 也要求有个占位 */
  local?: boolean;
  /** 记录这条是「pi 内置目录里的」还是用户自定义的（只作说明用，不参与判定） */
  origin?: "builtin" | "custom";
  models: RegistryModel[];
}

export interface RegistryVision {
  enabled: boolean;
  provider: string;
  model: string;
}

export interface ModelRegistry {
  version: 1;
  providers: Record<string, RegistryProvider>;
  /** 图片转述用的 provider + model；空则回落到旧的独立视觉配置 */
  vision?: RegistryVision;
  /** 上一次同步时由本应用写入 models.json 的 provider id，用于对称删除 */
  managed?: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const NUM_FIELDS = ["contextWindow", "maxTokens"] as const;

export function emptyRegistry(): ModelRegistry {
  return { version: 1, providers: {}, managed: [] };
}

/** 密钥注入用的环境变量名：OMCP_KEY_<ID>，非字母数字转下划线 */
export function providerEnvKey(id: string): string {
  return "OMCP_KEY_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function validateRegistry(raw: unknown): { registry: ModelRegistry; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { registry: emptyRegistry(), errors: ["注册表必须是 JSON 对象"] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) errors.push("version 必须是 1");

  const providers: Record<string, RegistryProvider> = {};
  const rawProviders = obj.providers;
  if (rawProviders !== undefined && (typeof rawProviders !== "object" || Array.isArray(rawProviders))) {
    errors.push("providers 必须是对象");
  }
  for (const [id, value] of Object.entries((rawProviders as Record<string, unknown>) ?? {})) {
    if (!ID_RE.test(id)) {
      errors.push(`provider id 非法：${id}（只允许字母数字与 . _ -）`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${id} 必须是对象`);
      continue;
    }
    const p = value as Record<string, unknown>;
    const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
    if (!/^https?:\/\//i.test(baseUrl)) {
      errors.push(`${id}.baseUrl 必须是 http(s) 地址`);
    }
    if (p.api !== undefined && typeof p.api !== "string") errors.push(`${id}.api 必须是字符串`);
    if (p.local !== undefined && typeof p.local !== "boolean") errors.push(`${id}.local 必须是布尔值`);

    const models: RegistryModel[] = [];
    if (!Array.isArray(p.models) || p.models.length === 0) {
      errors.push(`${id}.models 不能为空`);
    } else {
      p.models.forEach((m, i) => {
        if (!m || typeof m !== "object" || Array.isArray(m)) {
          errors.push(`${id}.models[${i}] 必须是对象`);
          return;
        }
        const item = m as Record<string, unknown>;
        const mid = typeof item.id === "string" ? item.id.trim() : "";
        if (!mid) {
          errors.push(`${id}.models[${i}].id 不能为空`);
          return;
        }
        const model: RegistryModel = { id: mid };
        if (typeof item.name === "string" && item.name.trim()) model.name = item.name.trim();
        if (Array.isArray(item.input)) {
          const input = item.input.filter((x): x is "text" | "image" => x === "text" || x === "image");
          if (input.length) model.input = input;
        }
        for (const f of NUM_FIELDS) {
          const n = num(item[f]);
          if (n !== undefined) model[f] = n;
        }
        if (typeof item.reasoning === "boolean") model.reasoning = item.reasoning;
        if (item.cost && typeof item.cost === "object" && !Array.isArray(item.cost)) {
          const c = item.cost as Record<string, unknown>;
          const cost: NonNullable<RegistryModel["cost"]> = {};
          for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
            const n = num(c[k]);
            if (n !== undefined) cost[k] = n;
          }
          if (Object.keys(cost).length) model.cost = cost;
        }
        models.push(model);
      });
    }

    providers[id] = {
      baseUrl,
      ...(typeof p.api === "string" && p.api.trim() ? { api: p.api.trim() } : {}),
      ...(p.local === true ? { local: true } : {}),
      models,
    };
  }

  let vision: RegistryVision | undefined;
  if (obj.vision && typeof obj.vision === "object" && !Array.isArray(obj.vision)) {
    const v = obj.vision as Record<string, unknown>;
    if (typeof v.provider === "string" && v.provider.trim() && typeof v.model === "string" && v.model.trim()) {
      vision = {
        enabled: v.enabled !== false,
        provider: v.provider.trim(),
        model: v.model.trim(),
      };
    }
  }

  const managed = Array.isArray(obj.managed)
    ? obj.managed.filter((x): x is string => typeof x === "string" && ID_RE.test(x))
    : [];
  return { registry: { version: 1, providers, managed, ...(vision ? { vision } : {}) }, errors };
}

/** 目录里的模型元数据（用于补齐用户没写的字段；用户写了的以用户为准） */
export type CatalogModelLookup = (providerId: string, modelId: string) => RegistryModel | undefined;

/**
 * 注册表 → 可直接写进 models.json 的 providers 片段。
 *
 * 元数据继承（PR3）：pi 读 models.json 里列出的模型时**不会回填内置条目**，
 * 所以 input / cost / contextWindow 这些必须我们自己补全，否则会把收图模型声明成
 * 纯文本（或反过来），轻则静默丢图，重则整轮 400。
 */
export function buildPiProviders(
  registry: ModelRegistry,
  hasKey: (id: string) => boolean,
  catalogModel?: CatalogModelLookup,
): { providers: Record<string, unknown>; skipped: Array<{ id: string; reason: string }> } {
  const providers: Record<string, unknown> = {};
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const [id, p] of Object.entries(registry.providers)) {
    if (!p.local && !hasKey(id)) {
      skipped.push({ id, reason: "未设置密钥" });
      continue;
    }
    const models = p.models.map((m) => {
      const meta = catalogModel?.(id, m.id);
      if (!meta) return m;
      const merged: RegistryModel = { ...meta, ...m };
      if (!m.name && meta.name) merged.name = meta.name;
      return merged;
    });
    providers[id] = {
      baseUrl: p.baseUrl,
      api: p.api ?? "openai-completions",
      // 本地服务用占位值；云服务用环境变量引用，磁盘上不落明文
      apiKey: p.local ? "local" : `$${providerEnvKey(id)}`,
      models,
    };
  }
  return { providers, skipped };
}

/**
 * 预览「将写入 models.json 的片段」——给确认对话框用。
 * 只含 `$OMCP_KEY_<ID>` 引用，绝不含真实 key。
 */
export function previewPiProvider(
  id: string,
  provider: { baseUrl: string; api?: string; local?: boolean; models: RegistryModel[] },
  catalogModel?: CatalogModelLookup,
): Record<string, unknown> {
  const models = provider.models.map((m) => {
    const meta = catalogModel?.(id, m.id);
    return meta ? { ...meta, ...m } : { ...m };
  });
  return {
    baseUrl: provider.baseUrl,
    api: provider.api ?? "openai-completions",
    apiKey: provider.local ? "local" : `$${providerEnvKey(id)}`,
    models,
  };
}

/** 把生成的片段合并进已有 models.json：只覆盖同名 provider，其它键原样保留 */
export function mergeModelsJson(
  existing: unknown,
  generated: Record<string, unknown>,
  removeIds: string[] = [],
): { next: Record<string, unknown> | null; changed: boolean; error?: string } {
  if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
    return { next: null, changed: false, error: "现有 models.json 不是 JSON 对象，拒绝覆盖" };
  }
  const base = (existing as Record<string, unknown>) ?? {};
  const baseProviders =
    base.providers && typeof base.providers === "object" && !Array.isArray(base.providers)
      ? (base.providers as Record<string, unknown>)
      : {};
  const providers: Record<string, unknown> = { ...baseProviders, ...generated };
  // 只删“上一次由我们写入、这次已从注册表移除”的 id，不碰用户自己的
  for (const id of removeIds) {
    if (!(id in generated)) delete providers[id];
  }
  const next: Record<string, unknown> = { ...base, providers };
  const changed = JSON.stringify(next) !== JSON.stringify(base);
  return { next, changed };
}

/** models.json 里的 providers → 注册表条目（丢掉 apiKey，密钥不进注册表） */
export function fromPiProviders(raw: unknown): { registry: ModelRegistry; count: number; skipped: string[] } {
  const registry = emptyRegistry();
  const skipped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { registry, count: 0, skipped };
  for (const [id, value] of Object.entries((raw as Record<string, unknown>).providers as Record<string, unknown> ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      skipped.push(id);
      continue;
    }
    const p = value as Record<string, unknown>;
    if (typeof p.baseUrl !== "string") {
      skipped.push(id);
      continue;
    }
    const rawModels = Array.isArray(p.models) ? p.models : [];
    const models: RegistryModel[] = [];
    for (const m of rawModels) {
      if (typeof m === "string") {
        models.push({ id: m });
      } else if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
        const obj = m as Record<string, unknown>;
        models.push({ ...(obj as unknown as RegistryModel) });
      }
    }
    if (!models.length) {
      skipped.push(id);
      continue;
    }
    registry.providers[id] = {
      baseUrl: p.baseUrl,
      ...(typeof p.api === "string" ? { api: p.api } : {}),
      ...(p.apiKey === "local" ? { local: true } : {}),
      models,
    };
  }
  return { registry, count: Object.keys(registry.providers).length, skipped };
}
