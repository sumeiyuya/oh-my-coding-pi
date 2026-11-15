/**
 * 发送前的模型可用性预检（P1-04 / PR1）。
 *
 * 目的：在 **发送之前** 就知道这条消息会不会失败，并把原因归成可行动的三类：
 * 缺凭据（去补）、连接信息不对（去确认）、模型不存在（去换）。
 *
 * 纯函数：不读文件、不联网、不碰密钥值——凭据「有没有」由调用方传入（主进程查安全存储）。
 */

export type PreflightReason =
  | "ok"
  | "no_credential"
  | "bad_url"
  | "model_not_found"
  | "unknown_provider";

export type PreflightFix = "add_key" | "confirm_connection" | "choose_model";

export interface PreflightProviderConfig {
  baseUrl?: string;
  api?: string;
  models?: Array<{ id: string }>;
}

export interface PreflightCatalogProvider {
  baseUrl?: string;
  requiresBaseUrl?: boolean;
  api?: string;
  models?: Array<{ id: string }>;
}

export interface PreflightInput {
  provider: string;
  modelId: string;
  /** 我们自己的配置层（用户确认过的连接信息）；没有就是 null */
  config?: PreflightProviderConfig | null;
  /** 能力层（provider-catalog）；内置 provider 用它兜底 */
  catalog?: PreflightCatalogProvider | null;
  /** 主进程查到的「有没有凭据」（安全存储 / 环境变量 / pi 的 auth.json） */
  hasCredential: boolean;
}

export interface PreflightResult {
  ok: boolean;
  reason: PreflightReason;
  message: string;
  fix?: PreflightFix;
  /** 解析后实际会用的地址（UI 可以显示出来，便于核对自己在连哪里） */
  baseUrl?: string;
}

const HTTP = /^https?:\/\//i;

export function preflightModel(input: PreflightInput): PreflightResult {
  const provider = String(input.provider ?? "").trim();
  const modelId = String(input.modelId ?? "").trim();
  if (!provider || !modelId) {
    return { ok: false, reason: "unknown_provider", message: "还不知道要用哪个模型", fix: "choose_model" };
  }

  const config = input.config ?? null;
  const catalog = input.catalog ?? null;
  if (!config && !catalog) {
    return {
      ok: false,
      reason: "unknown_provider",
      message: `pi 不认识「${provider}」这个服务商`,
      fix: "confirm_connection",
    };
  }

  // 1) 凭据：缺就是缺，不猜
  if (!input.hasCredential) {
    return {
      ok: false,
      reason: "no_credential",
      message: `${provider} 还没有可用的密钥`,
      fix: "add_key",
    };
  }

  // 2) 地址：配置优先；配置没有就用目录默认（azure / bedrock / vertex 必须自己填）
  const baseUrl = String(config?.baseUrl ?? catalog?.baseUrl ?? "").trim();
  const requiresBaseUrl = Boolean(catalog?.requiresBaseUrl);
  if (!baseUrl && requiresBaseUrl) {
    return {
      ok: false,
      reason: "bad_url",
      message: `${provider} 需要填服务地址（区域或项目相关）`,
      fix: "confirm_connection",
    };
  }
  if (baseUrl && !HTTP.test(baseUrl)) {
    return {
      ok: false,
      reason: "bad_url",
      message: `服务地址必须以 http(s) 开头：${baseUrl}`,
      fix: "confirm_connection",
      baseUrl,
    };
  }

  // 3) 模型：配置里声明过，或者目录里本来就有
  const inConfig = config?.models?.some((m) => m?.id === modelId) ?? false;
  const inCatalog = catalog?.models?.some((m) => m?.id === modelId) ?? false;
  if (!inConfig && !inCatalog) {
    return {
      ok: false,
      reason: "model_not_found",
      message: `${provider} 下找不到模型「${modelId}」`,
      fix: "choose_model",
      baseUrl,
    };
  }

  return { ok: true, reason: "ok", message: "", baseUrl };
}
