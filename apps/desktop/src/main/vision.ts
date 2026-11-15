export interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface DescribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const PROMPT = [
  "请只描述你在图片中实际看到的内容，用中文分点：",
  "1) 标题与副标题（原文照抄）；2) 坐标轴名称、刻度范围与单位；",
  "3) 图例项；4) 图中可见的数字与标注；5) 整体趋势或形状。",
  "不要推断原因，不要补全看不清的内容；看不清就写“看不清”。",
].join("");

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/**
 * 调一个 OpenAI 兼容的视觉端点把图片转述成文字。
 * 只做“一次请求、超时、错误可读”，不重试、不缓存。
 */
export async function describeImage(
  config: VisionConfig,
  dataBase64: string,
  mimeType = "image/png",
  timeoutMs = 30_000,
): Promise<DescribeResult> {
  if (!config.baseUrl || !config.model) {
    return { ok: false, error: "未配置视觉服务（baseUrl 或 model 为空）" };
  }
  try {
    const res = await fetch(endpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${dataBase64}` },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, error: `视觉服务返回 ${res.status}${body ? "：" + body : ""}` };
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((part) =>
          typeof part === "object" && part && "text" in part ? String((part as { text?: string }).text ?? "") : "",
        )
        .join("");
    }
    text = text.trim();
    if (!text) return { ok: false, error: "视觉服务返回了空内容" };
    return { ok: true, text };
  } catch (err) {
    const name = (err as Error).name;
    const message = name === "TimeoutError" ? "请求超时" : (err as Error).message;
    return { ok: false, error: `视觉转述失败：${message}` };
  }
}

export function formatDescription(index: number, total: number, text: string): string {
  const head = total > 1 ? `[图片 ${index + 1}/${total} 转述]` : "[图片转述]";
  return `${head}\n${text}`;
}
