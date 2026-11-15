/**
 * 模型端点探测（配置模型服务时的「测试连通」）。
 *
 * 原来的实现一律 `GET {baseUrl}/models`，只对「baseUrl 自带版本段」的服务商成立：
 * - openai  `https://api.openai.com/v1` → `/v1/models` ✅
 * - openrouter `https://openrouter.ai/api` → `/api/models` ❌（真实是 `/api/v1/models`）
 * - anthropic `https://api.anthropic.com` → `/models` ❌（真实是 `/v1/models`，且要 x-api-key）
 * 于是「服务商能用、只是探测路径不对」被显示成 404。
 *
 * 这里把「候选路径 + 认证头」按 api 类型收在一处，并保证：
 * - 404 才继续试下一个候选；401/403 立即返回（路径对、钥匙不对）；
 * - 失败时把试过的 URL 一起带回去，用户能自己看出来是路径问题；
 * - Azure / Bedrock 这类需要额外参数的，直接说「不适用」，不冒充 404。
 */

export interface ProbeOutcome {
  ok: boolean;
  status?: number;
  ms: number;
  modelCount?: number;
  error?: string;
  /** 试过的 URL（失败时给用户看） */
  tried?: string[];
}

export interface ProbePlan {
  urls: string[];
  headers: Record<string, string>;
  /** 密钥放在 query 里（Google） */
  keyInQuery?: boolean;
  /** 该 api 不适合统一探测时的说明 */
  unsupported?: string;
}

const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/chat/completion",
  "/completions",
  "/responses",
  "/messages",
  "/embeddings",
];

/** baseUrl 归一：去尾斜杠、去掉误填的具体端点 */
export function normalizeBaseUrl(raw: string): string {
  let base = String(raw ?? "").trim().replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return base;
}

function hasVersionSegment(base: string): boolean {
  return /\/v\d+(beta\d*|alpha\d*)?$/i.test(base);
}

/**
 * 按 api 类型给出探测计划。纯函数，单测直接打。
 */
export function probePlan(rawBase: string, api: string): ProbePlan {
  const base = normalizeBaseUrl(rawBase);
  const kind = String(api ?? "").toLowerCase();

  if (kind.startsWith("azure")) {
    return {
      urls: [],
      headers: {},
      unsupported:
        "Azure OpenAI 的模型列表要带部署名与 api-version，统一探测不适用。添加后直接发一条消息验证即可。",
    };
  }
  if (kind.startsWith("bedrock")) {
    return {
      urls: [],
      headers: {},
      unsupported: "Amazon Bedrock 需要区域与签名（SigV4），统一探测不适用。添加后直接发一条消息验证即可。",
    };
  }

  if (kind.startsWith("anthropic")) {
    // Anthropic 的 /v1/models 用 x-api-key + anthropic-version，不是 Bearer
    const origin = base.replace(/\/v1$/i, "");
    return {
      urls: [`${origin}/v1/models`],
      headers: { "x-api-key": "__KEY__", "anthropic-version": "2023-06-01" },
    };
  }

  if (kind.startsWith("google")) {
    // Google 的 key 走 query，不是 Bearer
    return {
      urls: [`${base}/models`],
      headers: {},
      keyInQuery: true,
    };
  }

  // OpenAI 兼容：先按原样；没有版本段（或形如 /api）再补 /v1
  const urls = [`${base}/models`];
  if (!hasVersionSegment(base)) urls.push(`${base}/v1/models`);
  return { urls: [...new Set(urls)], headers: { authorization: "Bearer __KEY__" } };
}

export async function probeModels(rawBase: string, key: string, api = "openai-completions"): Promise<ProbeOutcome> {
  const started = Date.now();
  const plan = probePlan(rawBase, api);
  const tried: string[] = [];
  if (plan.unsupported || plan.urls.length === 0) {
    return { ok: false, ms: 0, error: plan.unsupported ?? "没有可用的探测路径", tried };
  }

  let lastStatus: number | undefined;
  let lastStatusText = "";
  for (const template of plan.urls) {
    const url = plan.keyInQuery
      ? `${template}${template.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`
      : template;
    // 展示用：query 里的 key 不落进 tried
    tried.push(plan.keyInQuery ? template : url);
    try {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(plan.headers)) {
        headers[name] = value.replace("__KEY__", key);
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      const ms = Date.now() - started;
      if (res.status === 404) {
        lastStatus = 404;
        lastStatusText = res.statusText;
        continue;
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          ms,
          tried,
          error:
            res.status === 401 || res.status === 403
              ? `HTTP ${res.status}：路径是对的，但密钥被拒绝（检查 key 是否属于这个服务商）`
              : `HTTP ${res.status} ${res.statusText}`.trim(),
        };
      }
      const body = (await res.json().catch(() => null)) as { data?: unknown[]; models?: unknown[] } | null;
      const count = Array.isArray(body?.data) ? body.data.length : Array.isArray(body?.models) ? body.models.length : undefined;
      return { ok: true, status: res.status, ms, ...(count !== undefined ? { modelCount: count } : {}), tried };
    } catch (err) {
      const ms = Date.now() - started;
      const e = err as Error;
      const message = e.name === "TimeoutError" ? "8 秒超时" : e.message;
      // 网络错误不再换路径（多半是地址/网络本身的问题）
      return { ok: false, ms, error: message, tried };
    }
  }

  return {
    ok: false,
    status: lastStatus ?? 404,
    ms: Date.now() - started,
    tried,
    error:
      `HTTP ${lastStatus ?? 404}：这个服务商的模型列表不在这些路径上。` +
      `已尝试 ${tried.join("、")}。如果服务本身可用，可以跳过测试直接添加，再发一条消息验证。`,
  };
}
