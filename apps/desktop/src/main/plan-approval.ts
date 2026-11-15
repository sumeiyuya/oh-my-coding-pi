/**
 * 方案批准的「内容绑定」（P1-01）。
 *
 * 批准时记下计划文件的内容摘要；之后每次要执行非只读操作前重新读一遍文件比对：
 * 文件被删、读不了、内容被改，都算批准失效，退回只读。
 *
 * 只做两件规范化：去掉 BOM、把 CRLF/CR 统一成 LF。
 * 不做“去空白/去注释”之类的宽松归一化——否则改了内容却仍匹配，等于没有绑定。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function normalizePlanText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** sha256 十六进制（对规范化后的文本取，避免 Windows/Linux 换行差异误判） */
export function planDigest(raw: string): string {
  return createHash("sha256").update(normalizePlanText(raw), "utf8").digest("hex");
}

export interface PlanVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 比对磁盘上的计划文件与批准时的摘要。
 * 这里只判断，不改任何批准状态——撤销批准与写审计由调用方（主进程）做。
 */
export function verifyPlanFile(absPath: string, expectedDigest: string): PlanVerifyResult {
  if (!expectedDigest) return { ok: false, reason: "批准时没有记录内容摘要" };
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "方案文件已被删除" };
    return { ok: false, reason: `方案文件读取失败（${code ?? "未知错误"}）` };
  }
  return planDigest(raw) === expectedDigest
    ? { ok: true }
    : { ok: false, reason: "方案文件在批准后被修改" };
}
