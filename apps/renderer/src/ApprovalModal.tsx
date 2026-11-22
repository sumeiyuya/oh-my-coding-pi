import { useEffect, useState } from "react";
import type { ApprovalRequest, ApprovalScope } from "@oh-my-coding-pi/shared";
import { approvalScopeHint } from "./approval-hint";

const SCOPE_HINT: Record<string, string> = {
  once: "只放行这一次调用",
  session: "本会话内同类操作不再询问",
  always: "在本工作区长期允许这一类操作（30 天，可在权限页撤销）",
  deny: "不执行，并把原因告诉模型",
};

export default function ApprovalModal({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (scope: ApprovalScope) => void;
}) {
  const [remaining, setRemaining] = useState(Math.max(0, Math.floor(request.timeoutMs / 1000)));
  const scopeHint = approvalScopeHint(request.ruleId);

  useEffect(() => {
    setRemaining(Math.max(0, Math.floor(request.timeoutMs / 1000)));
    const timer = setInterval(() => {
      setRemaining((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [request.id, request.timeoutMs]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onRespond("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRespond]);

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true">
      <div className="approval">
        <div className="approval-head">
          <b>需要确认</b>
          <span className={`approval-count ${remaining <= 10 ? "low" : ""}`}>{remaining}s</span>
        </div>
        <div className="approval-meta">
          <span>
            工具 <code>{request.toolName}</code>
          </span>
          <span>
            规则 <code>{request.ruleId}</code>
          </span>
        </div>
        <pre className="approval-summary">{request.summary || "（无摘要）"}</pre>
        {scopeHint && <div className="approval-scope-hint">{scopeHint}</div>}
        <div className="approval-options">
          {request.options.map((option) => (
            <button
              key={option.value}
              className={option.value === "deny" ? "approval-deny" : ""}
              autoFocus={option.value === "deny"}
              onClick={() => onRespond(option.value)}
              title={SCOPE_HINT[option.value] ?? ""}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="approval-foot">
          默认拒绝；{Math.round(request.timeoutMs / 1000)} 秒无操作按拒绝处理。授权范围：仅本次 / 本会话 /
          本工作区（30 天）。
        </div>
      </div>
    </div>
  );
}
