import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlanGateStatus, RouteDoc, RouteEvidence, RouteStatus, RouteStep } from "@oh-my-coding-pi/shared";

const STATUS: Array<{ value: RouteStatus; label: string }> = [
  { value: "todo", label: "待办" },
  { value: "doing", label: "进行中" },
  { value: "done", label: "完成" },
  { value: "blocked", label: "阻塞" },
];

const EVIDENCE: Array<{ value: RouteEvidence; label: string }> = [
  { value: "none", label: "无" },
  { value: "limited", label: "有限" },
  { value: "strong", label: "较强" },
];

function newStep(index: number): RouteStep {
  return {
    id: `s${Date.now()}-${index}`,
    title: "",
    purpose: "",
    inputs: "",
    outputs: "",
    status: "todo",
    evidence: "none",
  };
}

export default function Route() {
  const [doc, setDoc] = useState<RouteDoc | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [plan, setPlan] = useState<PlanGateStatus | null>(null);
  const [planPath, setPlanPath] = useState("");

  const load = useCallback(async () => {
    const result = (await window.api.loadRoute()) as { doc: RouteDoc; errors: string[] };
    setDoc(result.doc);
    setErrors(result.errors ?? []);
    setPlan((await window.api.getPlanStatus()) as PlanGateStatus);
    setDirty(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const steps = doc?.steps ?? [];

  const update = (index: number, patch: Partial<RouteStep>) => {
    if (!doc) return;
    const next = doc.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    setDoc({ ...doc, steps: next });
    setDirty(true);
  };

  const move = (index: number, delta: number) => {
    if (!doc) return;
    const target = index + delta;
    if (target < 0 || target >= doc.steps.length) return;
    const steps = [...doc.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    setDoc({ ...doc, steps });
    setDirty(true);
  };

  const save = async () => {
    if (!doc) return;
    const result = (await window.api.saveRoute(doc)) as {
      ok: boolean;
      doc: RouteDoc;
      errors: string[];
    };
    if (result.ok) {
      setDoc(result.doc);
      setErrors([]);
      setDirty(false);
      setMsg("已保存 " + new Date().toTimeString().slice(0, 8));
    } else {
      setErrors(result.errors ?? ["保存失败"]);
    }
  };

  const exportMd = async () => {
    const result = (await window.api.exportRoute()) as { path: string | null; error?: string };
    setMsg(result.path ? "已导出：" + result.path : "导出失败：" + (result.error ?? ""));
  };

  const togglePlan = async (enabled: boolean) => {
    setPlan((await window.api.setPlanMode(enabled)) as PlanGateStatus);
  };

  const approve = async () => {
    const next = (await window.api.approvePlan(planPath)) as PlanGateStatus;
    setPlan(next);
    setMsg(
      next.approved
        ? `已批准：${next.planPath ?? ""}（内容摘要 ${(next.digest ?? "").slice(0, 12)}）`
        : "批准失败：方案文件必须在 .omcp/plans/ 下、存在且可读",
    );
  };

  const doneCount = useMemo(() => steps.filter((s) => s.status === "done").length, [steps]);

  return (
    <div className="perm">
      <section className="perm-card">
        <div className="perm-head">
          <b>分析路线（{doneCount}/{steps.length} 完成）</b>
          <div className="perm-actions">
            <button onClick={() => void save()} disabled={!dirty}>
              保存
            </button>
            <button onClick={() => void exportMd()}>导出 Markdown</button>
            <button onClick={() => void load()}>重新加载</button>
          </div>
        </div>
        <div className="perm-row">
          <span>说明</span>
          <span className="perm-note">
            这是人写的记录，不是自动推断。证据档位只表示“有无产物与复核”，三档：
            无 / 有限 / 较强。保存到 <code>.omcp/route.json</code>。
          </span>
        </div>
        {errors.length > 0 && <div className="perm-error">{errors.join("；")}</div>}
        {msg && <div className="perm-note">{msg}</div>}

        {steps.length === 0 ? (
          <div className="perm-empty">还没有步骤。点下面的“新增步骤”。</div>
        ) : (
          steps.map((s, i) => (
            <div className="route-step" key={s.id}>
              <div className="route-head">
                <b>#{i + 1}</b>
                <input
                  className="route-title"
                  value={s.title}
                  placeholder="步骤名，例如：读数据并检查缺失"
                  onChange={(e) => update(i, { title: e.target.value })}
                />
                <select value={s.status} onChange={(e) => update(i, { status: e.target.value as RouteStatus })}>
                  {STATUS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  value={s.evidence}
                  onChange={(e) => update(i, { evidence: e.target.value as RouteEvidence })}
                >
                  {EVIDENCE.map((o) => (
                    <option key={o.value} value={o.value}>
                      证据：{o.label}
                    </option>
                  ))}
                </select>
                <button onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button onClick={() => move(i, 1)} disabled={i === steps.length - 1}>
                  ↓
                </button>
                <button
                  onClick={() => {
                    if (!doc) return;
                    setDoc({ ...doc, steps: doc.steps.filter((_, idx) => idx !== i) });
                    setDirty(true);
                  }}
                >
                  ×
                </button>
              </div>
              <input
                className="route-line"
                value={s.purpose}
                placeholder="目的：这一步要回答什么"
                onChange={(e) => update(i, { purpose: e.target.value })}
              />
              <input
                className="route-line"
                value={s.inputs}
                placeholder="输入：文件/表/上游步骤"
                onChange={(e) => update(i, { inputs: e.target.value })}
              />
              <input
                className="route-line"
                value={s.outputs}
                placeholder="产出：results/tables/x.csv, figures/x.png"
                onChange={(e) => update(i, { outputs: e.target.value })}
              />
            </div>
          ))
        )}
        <div className="perm-row">
          <span />
          <button
            onClick={() => {
              if (!doc) return;
              setDoc({ ...doc, steps: [...doc.steps, newStep(doc.steps.length)] });
              setDirty(true);
            }}
          >
            ＋ 新增步骤
          </button>
        </div>
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>方案期（只读门）</b>
          <label className="perm-check">
            <input
              type="checkbox"
              checked={!!plan?.enabled}
              onChange={(e) => void togglePlan(e.target.checked)}
            />
            进入方案期
          </label>
        </div>
        <div className="perm-note">
          方案期内只放 <code>read / grep / find / ls / glob</code>；<b>bash 与 powershell 整件拒</b>、
          run_code / write / edit 也拒。批准方案文件后解锁。
          <br />
          批准的是<b>这份内容</b>：批准时记下文件摘要，之后只要文件被修改、删除或读不出来，批准立刻失效并退回只读，需要重新批准。
          切会话或切工作区也会回到未批准。
        </div>
        <div className="perm-form">
          <label>
            方案文件（必须位于 .omcp/plans/）
            <input
              value={planPath}
              onChange={(e) => setPlanPath(e.target.value)}
              placeholder=".omcp/plans/2026-11-13-分析方案.md"
            />
          </label>
          <label>
            状态
            <span className="perm-note" style={{ paddingTop: 6 }}>
              {plan?.enabled
                ? plan.approved
                  ? `已批准：${plan.planPath ?? ""}（sha256 ${(plan.digest ?? "").slice(0, 12)}）`
                  : "未批准（只读）"
                : "未开启"}
            </span>
          </label>
        </div>
        <div className="perm-row">
          <span />
          <button onClick={() => void approve()} disabled={!plan?.enabled}>
            批准该方案
          </button>
        </div>
      </section>
    </div>
  );
}
