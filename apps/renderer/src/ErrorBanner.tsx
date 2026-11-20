import type { ReactNode } from "react";
import type { ErrorView } from "./error-view";

/**
 * 错误横幅（对齐 DAWN 的 failed-notice）：
 * 固定结构 = 结论 + 一句原因 + 操作 + 「查看原始错误」折叠。
 * 技术原文只在折叠里出现；主行不显示 IP/端口/UND_ERR。
 */
export default function ErrorBanner({
  view,
  actions,
  onClose,
}: {
  view: ErrorView;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className={`banner error-banner ${view.tone === "warn" ? "warn" : "fatal"}`} role="status">
      <div className="failed-notice">
        <p className="failed-notice-line">
          <span className="failed-notice-dot" aria-hidden="true" />
          <strong className="failed-notice-title">{view.title}</strong>
          {view.reason && view.reason !== view.title && (
            <span className="failed-notice-reason">{view.reason}</span>
          )}
        </p>
        {view.raw && (
          <details className="failed-notice-details">
            <summary>查看原始错误</summary>
            <pre>{view.raw}</pre>
          </details>
        )}
      </div>
      <div className="error-actions">
        {actions}
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
