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

/**
 * 方案期门的账本（修改 4 · M2）。
 *
 * 原来是主进程里的一个单对象：A 会话批准方案后，B 会话也立刻变成
 * 「已批准只读」；B 一改方案文件，A 的批准也跟着失效。方案文件属于工作区，
 * 但「批没批」是这段对话自己的状态，所以按会话记。
 */
export interface PlanGateState {
  enabled: boolean;
  approved: boolean;
  planPath: string | null;
  /** 批准时的内容摘要；非只读操作前用它复核 */
  digest: string | null;
}

export type PlanGateView = Pick<PlanGateState, "enabled" | "approved" | "planPath" | "digest">;

const EMPTY: PlanGateState = { enabled: false, approved: false, planPath: null, digest: null };

export class PlanGateBook {
  private readonly gates = new Map<string, PlanGateState>();

  for(key: string): PlanGateState {
    let gate = this.gates.get(key);
    if (!gate) {
      gate = { ...EMPTY };
      this.gates.set(key, gate);
    }
    return gate;
  }

  status(key: string): PlanGateView {
    const gate = this.for(key);
    return {
      enabled: gate.enabled,
      approved: gate.approved,
      planPath: gate.planPath,
      digest: gate.digest,
    };
  }

  setEnabled(key: string, enabled: boolean): PlanGateView {
    const gate = this.for(key);
    gate.enabled = enabled;
    if (!enabled) this.revoke(key);
    return this.status(key);
  }

  /** 批准：内容摘要由调用方算（它负责读盘与路径校验） */
  approve(key: string, planPath: string, digest: string): PlanGateView {
    const gate = this.for(key);
    gate.planPath = planPath;
    gate.digest = digest;
    gate.approved = true;
    return this.status(key);
  }

  /** 撤销批准（保留 enabled）；内容漂移、批准失败都走这里 */
  revoke(key: string): void {
    const gate = this.for(key);
    gate.approved = false;
    gate.planPath = null;
    gate.digest = null;
  }

  /**
   * 批准后的复核：文件被删/读不了/被改过就撤销批准并返回失败。
   * 只读工具不调用（不影响"看方案"）。
   */
  revalidate(
    key: string,
    verify: (absPath: string, digest: string) => PlanVerifyResult,
    planAbsPath: (rel: string) => string,
  ): PlanVerifyResult {
    const gate = this.for(key);
    if (!gate.enabled || !gate.approved) return { ok: true };
    // 已批准却丢了路径/摘要：无法证明批准的是哪份内容，按失效处理（fail-closed）
    const result =
      gate.planPath && gate.digest
        ? verify(planAbsPath(gate.planPath), gate.digest)
        : { ok: false, reason: "批准状态缺少路径或内容摘要" };
    if (!result.ok) this.revoke(key);
    return result;
  }

  clear(): void {
    this.gates.clear();
  }

  /** 诊断用：此刻有几段会话开过方案期 */
  size(): number {
    return this.gates.size;
  }
}
