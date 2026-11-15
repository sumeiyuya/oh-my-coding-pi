/**
 * 权限扩展：在每次工具调用前向主进程策略服务询问，按 allow / deny / ask 执行。
 *
 * 约定（ADR-008）：审批请求的 title 是 `omcp-approval:` + JSON，
 * 主进程解析成 ApprovalRequest 再交给渲染进程弹窗。
 *
 * 失败方向：策略服务不可用时 fail-closed（阻止工具调用）。
 */

declare const process: { env: Record<string, string | undefined> };

const TITLE_PREFIX = "omcp-approval:";
const DENY_LABEL = "拒绝";

export const APPROVAL_OPTION_LABELS = ["仅本次", "本会话", "总是允许", DENY_LABEL] as const;

interface Decision {
  action: "allow" | "deny" | "ask";
  ruleId: string;
  summary: string;
  reason: string;
}

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

interface UICtx {
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>;
  };
}

interface ExtensionAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: UICtx) => unknown): void;
}

export default function permissionExt(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const base = process.env.OMCP_POLICY_URL;
    const token = process.env.OMCP_POLICY_TOKEN;
    if (!base || !token) return;

    let decision: Decision;
    try {
      const res = await fetch(`${base}/decide`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ toolName: event.toolName, input: event.input ?? {} }),
      });
      if (!res.ok) throw new Error(`policy service returned ${res.status}`);
      const data = (await res.json()) as { decision?: Decision };
      if (!data.decision) throw new Error("policy service returned no decision");
      decision = data.decision;
    } catch (err) {
      return {
        block: true,
        reason: `权限服务不可用，已按 fail-closed 拒绝：${(err as Error).message}`,
      };
    }

    if (decision.action === "allow") return;

    if (decision.action === "deny") {
      return {
        block: true,
        reason: `被权限策略拒绝（${decision.ruleId}）：${decision.reason}`,
      };
    }

    const title =
      TITLE_PREFIX +
      JSON.stringify({
        v: 1,
        toolName: event.toolName,
        ruleId: decision.ruleId,
        summary: decision.summary,
      });

    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(title, [...APPROVAL_OPTION_LABELS]);
    } catch {
      choice = undefined;
    }

    if (!choice || choice === DENY_LABEL) {
      return {
        block: true,
        reason: `用户拒绝了该操作（${decision.ruleId}），未执行。`,
      };
    }
    return;
  });
}
