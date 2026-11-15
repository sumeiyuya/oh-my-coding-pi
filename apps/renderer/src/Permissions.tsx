import { useCallback, useEffect, useState } from "react";
import type {
  AppSettingsView,
  AuditPage,
  PermissionMode,
  PermissionState,
  PersistentGrant,
  PolicyInfo,
} from "@oh-my-coding-pi/shared";

const TIERS: Array<{ mode: PermissionMode; name: string; hint: string }> = [
  { mode: "deny-risky", name: "自动拦截", hint: "风险操作直接拒绝，把理由回给模型" },
  { mode: "ask-risky", name: "请求批准", hint: "危险操作始终询问你" },
  { mode: "allow-all", name: "完全访问权限", hint: "只拦硬拒清单" },
];

const PAGE_SIZE = 50;

const TTL_OPTIONS = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 0, label: "永久" },
];

export default function Permissions() {
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);
  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [grants, setGrants] = useState<PersistentGrant[]>([]);
  const [page, setPage] = useState<AuditPage>({ total: 0, items: [] });
  const [offset, setOffset] = useState(0);
  const [tool, setTool] = useState("");
  const [decision, setDecision] = useState<"" | "allow" | "deny" | "timeout">("");
  const [q, setQ] = useState("");
  const [exported, setExported] = useState("");
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [asDefault, setAsDefault] = useState(false);

  const refreshPolicyAndGrants = useCallback(async () => {
    try {
      const [p, g, s] = await Promise.all([
        window.api.getPolicy(),
        window.api.listGrants(),
        window.api.getAppSettings(),
      ]);
      setPolicy(p ?? null);
      setGrants(g ?? []);
      setSettings(s ?? null);
      setPerm((await window.api.getPermission()) as PermissionState);
    } catch {
      // ignore
    }
  }, []);

  const refreshAudit = useCallback(async () => {
    try {
      const result = (await window.api.queryAudit({
        limit: PAGE_SIZE,
        offset,
        tool: tool.trim() || undefined,
        decision: decision || undefined,
        q: q.trim() || undefined,
      })) as AuditPage;
      setPage(result ?? { total: 0, items: [] });
    } catch {
      setPage({ total: 0, items: [] });
    }
  }, [offset, tool, decision, q]);

  useEffect(() => {
    void refreshPolicyAndGrants();
  }, [refreshPolicyAndGrants]);

  useEffect(() => {
    void refreshAudit();
  }, [refreshAudit]);

  const revoke = async (id: string) => {
    await window.api.revokeGrant(id);
    await refreshPolicyAndGrants();
  };

  const clearAll = async () => {
    if (!confirm("清空所有持久授权？")) return;
    await window.api.clearGrants();
    await refreshPolicyAndGrants();
  };

  const prune = async () => {
    const removed = await window.api.pruneGrants();
    setExported(`已清理 ${removed} 条过期授权`);
    await refreshPolicyAndGrants();
  };

  const reloadPolicy = async () => {
    setBusy(true);
    try {
      setPolicy(await window.api.reloadPolicy());
      await refreshPolicyAndGrants();
    } finally {
      setBusy(false);
    }
  };

  const exportAudit = async () => {
    const file = await window.api.exportAudit();
    setExported(file ?? "导出失败");
  };

  const changeTtl = async (days: number) => {
    const next = (await window.api.setAppSettings({ grantTtlDays: days })) as AppSettingsView;
    setSettings(next);
  };

  const changeReadonlyNotebook = async (allowed: boolean) => {
    const next = (await window.api.setAppSettings({
      readonlyNotebook: allowed,
    })) as AppSettingsView;
    setSettings(next);
  };

  const maxPage = Math.max(0, Math.ceil(page.total / PAGE_SIZE) - 1);
  const currentPage = Math.floor(offset / PAGE_SIZE);

  return (
    <div className="perm">
      <section className="perm-card">
        <div className="perm-head">
          <b>策略</b>
          <button onClick={reloadPolicy} disabled={busy}>
            重新加载
          </button>
        </div>
        {policy ? (
          <>
            <div className="perm-row" style={{ alignItems: "flex-start" }}>
              <span>模式</span>
              <div className="perm-tiers">
                {TIERS.map((tier) => (
                  <button
                    key={tier.mode}
                    className={`perm-tier ${perm?.effective === tier.mode ? "on" : ""}`}
                    data-tier={tier.mode}
                    title={tier.hint}
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        try {
                          setPerm((await window.api.setPermission(tier.mode, asDefault)) as PermissionState);
                          setPolicy((await window.api.getPolicy()) ?? null);
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    {tier.name}
                  </button>
                ))}
                <label className="perm-tier-default">
                  <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
                  设为新会话默认
                </label>
              </div>
            </div>
            <div className="perm-row">
              <span>覆盖</span>
              <span className="perm-note">
                审批覆盖 <code>run_code</code> 与脚本前 4 KB 的危险模式；bash 命令里的内联代码（如 <code>python -c</code>）按 bash 规则走，不触发 <code>run_code</code> 审批。权限门防误操作，不是沙箱。
              </span>
            </div>
            <div className="perm-row">
              <span>来源</span>
              <span className="perm-note">
                {perm?.sessionOverride
                  ? `这一段单独设为「${TIERS.find((t) => t.mode === perm.sessionOverride)?.name ?? perm.sessionOverride}」`
                  : `跟随应用默认（${TIERS.find((t) => t.mode === perm?.default)?.name ?? perm?.default ?? "—"}）`}
                {" · 策略文件："}
                <code>{policy.source}</code>
              </span>
            </div>
            <div className="perm-row">
              <span>文件</span>
              <code className="perm-path">{policy.path ?? "（默认策略）"}</code>
            </div>
            {policy.errors.length > 0 && (
              <div className="perm-error">
                策略不可用，已按 fail-closed 全部拒绝：{policy.errors.join("；")}
              </div>
            )}
          </>
        ) : (
          <div className="perm-empty">未取到策略</div>
        )}
        <div className="perm-row perm-settings">
          <span>授权期限</span>
          <select
            value={settings?.grantTtlDays ?? 30}
            onChange={(e) => void changeTtl(Number(e.target.value))}
          >
            {TTL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="perm-check">
            <input
              type="checkbox"
              checked={!!settings?.readonlyNotebook}
              onChange={(e) => void changeReadonlyNotebook(e.target.checked)}
            />
            只读时允许执行笔记本 cell
          </label>
        </div>
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>授权（{grants.length}）</b>
          <div className="perm-actions">
            <button onClick={prune}>清理过期</button>
            <button onClick={clearAll} disabled={grants.length === 0}>
              清空
            </button>
          </div>
        </div>
        {grants.length === 0 ? (
          <div className="perm-empty">本工作区没有持久授权。</div>
        ) : (
          <table className="perm-table">
            <thead>
              <tr>
                <th>规则</th>
                <th>创建</th>
                <th>过期</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>
                    <code>{g.ruleId}</code>
                  </td>
                  <td>{g.createdAt.slice(0, 19).replace("T", " ")}</td>
                  <td>{g.expiresAt ? g.expiresAt.slice(0, 19).replace("T", " ") : "永久"}</td>
                  <td>
                    <button onClick={() => revoke(g.id)}>撤销</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>审计（{page.total} 条）</b>
          <div className="perm-actions">
            <button onClick={exportAudit}>导出 CSV</button>
          </div>
        </div>
        <div className="perm-filters">
          <input
            placeholder="工具（如 bash）"
            value={tool}
            onChange={(e) => {
              setOffset(0);
              setTool(e.target.value);
            }}
          />
          <select
            value={decision}
            onChange={(e) => {
              setOffset(0);
              setDecision(e.target.value as "" | "allow" | "deny" | "timeout");
            }}
          >
            <option value="">全部决定</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
            <option value="timeout">timeout</option>
          </select>
          <input
            placeholder="搜索摘要 / 规则"
            value={q}
            onChange={(e) => {
              setOffset(0);
              setQ(e.target.value);
            }}
          />
          {exported && <span className="perm-note">{exported}</span>}
        </div>

        {page.items.length === 0 ? (
          <div className="perm-empty">没有符合条件的记录。</div>
        ) : (
          <table className="perm-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>工具</th>
                <th>规则</th>
                <th>决定</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((e, i) => (
                <tr key={i}>
                  <td>{e.ts.slice(5, 19).replace("T", " ")}</td>
                  <td>{e.toolName}</td>
                  <td>
                    <code>{e.ruleId}</code>
                  </td>
                  <td className={`perm-decision ${e.decision}`}>{e.decision}</td>
                  <td className="perm-summary" title={e.summary}>
                    {e.summary.slice(0, 60)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="perm-pager">
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
            上一页
          </button>
          <span>
            {currentPage + 1} / {maxPage + 1}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= page.total}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  );
}
