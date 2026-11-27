import { useEffect, useState } from "react";
import type { KernelStatus } from "@oh-my-coding-pi/shared";

/**
 * 底部状态栏（PR2）：把散落的状态收成一条。
 *
 * 以前：pi 状态在顶栏右侧、内核状态只在设置页、成本在输入框角落。
 * 现在：pi / 内核 / 模型 / 权限 / 成本 同一条，窄屏自动换行。
 *
 * 空态要诚实：内核「未启动」与「启动失败」是两件事，不合并显示。
 */

export default function StatusBar({
  status,
  modelKey,
  cost,
  contextPercent,
  policyMode,
  planEnabled,
  budget,
}: {
  status: string;
  modelKey: string;
  cost?: number;
  contextPercent?: number;
  policyMode?: string;
  planEnabled?: boolean;
  /** 修改二：输入框上方那一栏删掉后，预算并到这里（看得见才有用） */
  budget?: { sessionUsd: number; sessionLimit: number; dailyUsd: number; dailyLimit: number } | null;
}) {
  const [kernels, setKernels] = useState<KernelStatus[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void (async () => {
        try {
          const list = (await window.api.getKernelStatus()) as KernelStatus[];
          if (alive) setKernels(Array.isArray(list) ? list : []);
        } catch {
          // 取不到就不显示内核段，不编造状态
        }
      })();
    };
    load();
    const timer = setInterval(load, 20_000);
    const off = window.api.onKernelEvent(() => load());
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, []);

  const piClass = status === "ready" ? "ok" : status === "error" ? "bad" : "wait";

  return (
    <div className="statusbar" role="status" aria-label="运行状态">
      <span className={`sb-item ${piClass}`} title="pi 运行时">
        <i className="dot" /> pi {status}
      </span>
      {kernels.map((k) => (
        <span
          key={k.language}
          className={`sb-item ${k.ready ? "ok" : "idle"}`}
          title={k.ready ? `内核已就绪：${k.resolvedPath}` : "内核未启动（首次运行代码时启动）"}
        >
          <i className="dot" /> {k.language === "r" ? "R" : "Py"} {k.ready ? "就绪" : "未启动"}
        </span>
      ))}
      <span className="sb-item" title="当前模型">
        {modelKey || "未选模型"}
      </span>
      {policyMode && (
        <span className={`sb-item policy ${policyMode}`} title="权限模式">
          {policyMode}
        </span>
      )}
      {planEnabled && (
        <span className="sb-item wait" title="方案期">
          方案期
        </span>
      )}
      <span className="sb-item" title="本次会话成本">
        {typeof cost === "number" ? `$${cost.toFixed(4)}` : "cost —"}
      </span>
      {budget && (
        <span
          className="sb-item"
          title="预算：本会话 / 每日（超出即拦，可在设置里调整）"
        >
          session ${budget.sessionUsd.toFixed(4)}/{budget.sessionLimit} · day $
          {budget.dailyUsd.toFixed(4)}/{budget.dailyLimit}
        </span>
      )}
      {typeof contextPercent === "number" && (
        <span className="sb-item" title="上下文占用">
          {Math.round(contextPercent)}% ctx
        </span>
      )}
    </div>
  );
}
