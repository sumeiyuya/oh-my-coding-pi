/**
 * 把 pi 传回来的模型错误文本，映射成一句能看懂的话。
 * 只做分类与截断，不改写原始信息：detail 里仍然保留原文的关键部分。
 */

export type ModelErrorKind =
  | "no_credential"
  | "quota"
  | "auth"
  | "missing"
  | "context"
  | "network"
  | "url"
  | "server"
  | "unknown";

export interface ModelErrorInfo {
  kind: ModelErrorKind;
  title: string;
  detail: string;
  /** 能解析出恢复时间时给一句人话，否则为空 */
  hint?: string;
}

const DETAIL_MAX = 240;

function clip(text: string, max = DETAIL_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** 错误文本常是 `429: {"type":...}`，尽量把里面的 message 抽出来 */
function extractMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const obj = JSON.parse(raw.slice(start)) as { message?: unknown; error?: unknown };
      if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
      if (obj.error && typeof obj.error === "object") {
        const inner = (obj.error as { message?: unknown }).message;
        if (typeof inner === "string" && inner.trim()) return inner;
      }
    } catch {
      // 不是完整 JSON，退回原文
    }
  }
  return raw;
}

/** 从 "resets in 3h 15m" / "reset at 2026-11-14T13:00Z" 里取一句提示 */
function resetHint(text: string): string | undefined {
  const rel = /resets? in ([^).;]+)/i.exec(text);
  if (rel) return `约 ${rel[1].trim()} 后恢复`;
  const at = /resets? at ([^).;]+)/i.exec(text);
  if (at) return `${at[1].trim()} 恢复`;
  return undefined;
}

export function describeModelError(raw: string | null | undefined): ModelErrorInfo | null {
  if (!raw || !raw.trim()) return null;
  const text = raw.trim();
  const inner = extractMessage(text);
  const detail = clip(inner);
  const hint = resetHint(inner) ?? resetHint(text);

  // 先判「没有凭据」：pi 的原文是 No API key found for <provider>
  if (/no api key found|missing api key|api key (?:is )?not set|no credential/i.test(text)) {
    return {
      kind: "no_credential",
      title: "这个服务商还没有可用的密钥",
      detail,
      hint: "点模型名旁的「缺密钥」填入，或到「设置 → 模型注册表」保存密钥",
    };
  }
  if (/invalid url|econnrefused|getaddrinfo|enotfound|未找到主机|证书/i.test(text)) {
    return { kind: "url", title: "连不上这个服务地址", detail, hint: "检查服务地址（baseUrl）与代理设置" };
  }
  if (/\b429\b|usage limit|rate.?limit|quota|额度|限流/i.test(text)) {
    return { kind: "quota", title: "模型额度用尽或被限流", detail, hint };
  }
  if (/\b401\b|\b403\b|unauthorized|invalid[ _-]?api[ _-]?key|invalid token|permission denied/i.test(text)) {
    return { kind: "auth", title: "密钥无效或无权限", detail, hint };
  }
  if (/\b404\b|model[^.]{0,20}not[^.]{0,10}found|unknown model|no such model/i.test(text)) {
    return { kind: "missing", title: "模型不存在或不可用", detail, hint };
  }
  if (/context[^.]{0,20}(length|window)|too many tokens|maximum context|token limit/i.test(text)) {
    return { kind: "context", title: "上下文超出模型窗口", detail, hint };
  }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|getaddrinfo|timed? ?out/i.test(text)) {
    return { kind: "network", title: "网络连接失败", detail, hint };
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(text)) {
    return { kind: "server", title: "模型服务端错误", detail, hint };
  }
  return { kind: "unknown", title: "模型调用失败", detail, hint };
}

/**
 * 一行给系统消息用的文字。
 * 不拼 detail：那是技术原文，只应出现在「查看原始错误」折叠区与日志里。
 */
export function modelErrorLine(info: ModelErrorInfo): string {
  return info.hint ? `${info.title}（${info.hint}）` : info.title;
}
