import type { AppError } from "@oh-my-coding-pi/shared";
import type { ModelErrorInfo } from "./model-error";

/**
 * 错误呈现（对齐 DAWN 的 failed-notice）：
 * - 主行只给「标题 + 一句原因」，原因里不出现 IP/端口/UND_ERR；
 * - 技术原文放进「查看原始错误」折叠区；
 * - 完整原文仍在 app.jsonl 与诊断包，排障不丢信息。
 */

export interface ErrorView {
  title: string;
  reason: string;
  /** 折叠区里的原文；没有就不再显示「查看原始错误」 */
  raw?: string;
  tone: "warn" | "error";
}

const ADDRESS_LIST = /attempted addresses:\s*[^,)]+/gi;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b(?::\d{1,5})?/gi;

/** 折叠原文里也把地址列表替换成人话，避免一眼全是 IPv6 */
export function stripAddresses(text: string): string {
  return text.replace(ADDRESS_LIST, "attempted addresses: （地址已隐藏）").replace(IPV6, "（地址已隐藏）");
}

function firstLine(text: string): string {
  const one = stripAddresses(text).replace(/\s+/g, " ").trim();
  return one.length > 72 ? `${one.slice(0, 71)}…` : one;
}

/** 把技术错误归成一句人话；认不出来就退回首行（已去地址） */
export function humanize(text: string | null | undefined): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const t = raw.toLowerCase();
  if (/enotfound|getaddrinfo|eai_again|\bdns\b/.test(t)) return "域名解析失败";
  if (/connect timeout|econnaborted|etimedout|timed? ?out|timeout/.test(t)) return "网络请求超时";
  if (/econnrefused/.test(t)) return "连接被拒绝";
  if (/econnreset|socket hang up|fetch failed|und_err_|network/.test(t)) return "连接被中断";
  if (/certificate|cert_|self[- ]signed/.test(t)) return "证书校验失败";
  if (/\b407\b|proxy/.test(t)) return "代理拒绝连接";
  if (/\b429\b|rate.?limit|usage limit|quota/.test(t)) return "被限流，稍后重试";
  if (/\b401\b|\b403\b|unauthorized|invalid[ _-]?api[ _-]?key|permission denied/.test(t)) {
    return "密钥无效或无权限";
  }
  if (/\b404\b|model[^.]{0,20}not[^.]{0,10}found|no such model/.test(t)) return "模型不存在或不可用";
  if (/context[^.]{0,20}(length|window)|too many tokens|token limit/.test(t)) return "上下文超出模型窗口";
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|gateway timeout/.test(t)) {
    return "服务端错误";
  }
  return firstLine(raw);
}

/** 这段文本是否值得放进「查看原始错误」 */
export function isTechnical(text: string | null | undefined): boolean {
  if (!text) return false;
  return /attempted addresses|und_err_|econn|etimedout|enotfound|getaddrinfo|socket hang up|connect timeout|timed out|fetch failed|at .+:\d+:\d+|\b\d{3}\b|error/i.test(
    text,
  );
}

export function presentAppError(err: AppError): ErrorView {
  const detail = err.detail ?? "";
  const reason = humanize(detail) || err.title;
  const rawText = err.raw ?? (isTechnical(detail) ? detail : undefined);
  return {
    title: err.title,
    reason,
    raw: rawText ? stripAddresses(rawText) : undefined,
    tone: err.severity === "warning" ? "warn" : "error",
  };
}

export function presentModelError(info: ModelErrorInfo): ErrorView {
  const reason = humanize(info.detail) || info.title;
  return {
    title: info.title,
    reason: info.hint ? `${reason}（${info.hint}）` : reason,
    raw: isTechnical(info.detail) ? stripAddresses(info.detail) : undefined,
    tone: "error",
  };
}
