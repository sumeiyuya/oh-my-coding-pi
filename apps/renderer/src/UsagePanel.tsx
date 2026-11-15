import { useEffect, useMemo, useState } from "react";
import type { UsageDataView, UsageResult } from "@oh-my-coding-pi/shared";

/**
 * 用量（修改 4 · U3/U4）。
 *
 * 口径写在界面上：用掉的 token = input + output，不含 cacheRead。
 * 数据来自会话 jsonl，本地读取，不上传。
 */

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  if (n < 1e9) return (n / 1e6).toFixed(1) + "M";
  return (n / 1e9).toFixed(1) + "B";
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WEEKS = 26;

export default function UsagePanel() {
  const [data, setData] = useState<UsageDataView | null>(null);
  const [meta, setMeta] = useState<UsageResult["meta"] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = (await window.api.getUsage()) as UsageResult;
        setData(res.data);
        setMeta(res.meta);
        if (res.meta.error) setErr(res.meta.error);
      } catch {
        setErr("读取用量失败");
      }
    })();
  }, []);

  const today = ymd(new Date());
  const dayMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data?.daily ?? []) m.set(d.date, d.tokens);
    return m;
  }, [data]);

  const maxDay = useMemo(
    () => Math.max(1, ...(data?.daily ?? []).map((d) => d.tokens)),
    [data],
  );

  /** 从 26 周前那一周的周日开始，按周排列 */
  const cells = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - (WEEKS * 7 - 1));
    // 对齐到周日，避免第一列缺格
    start.setDate(start.getDate() - start.getDay());
    const out: { date: string; tokens: number; level: number }[] = [];
    for (let i = 0; i < WEEKS * 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      if (d > end) break;
      const date = ymd(d);
      const tokens = dayMap.get(date) ?? 0;
      const ratio = tokens / maxDay;
      const level = tokens === 0 ? 0 : ratio > 0.6 ? 4 : ratio > 0.3 ? 3 : ratio > 0.1 ? 2 : 1;
      out.push({ date, tokens, level });
    }
    return out;
  }, [dayMap, maxDay]);

  const totals = data ?? {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    daily: [],
    byModel: [],
    activeDays: 0,
    streak: { current: 0, longest: 0 },
    unattributed: { runs: 0, tokens: 0 },
    silentTurns: 0,
  };

  const todayTokens = dayMap.get(today) ?? 0;
  const models = totals.byModel.slice(0, 8);
  const restTokens = totals.byModel.slice(8).reduce((a, m) => a + m.tokens, 0);
  const palette = ["#1f2937", "#166534", "#b45309", "#6b7280", "#9ca3af", "#7c2d12", "#0f766e", "#4b5563"];
  let acc = 0;
  const slices = models.map((m, i) => {
    const start = totals.total > 0 ? (acc / totals.total) * 360 : 0;
    acc += m.tokens;
    const end = totals.total > 0 ? (acc / totals.total) * 360 : 0;
    return { ...m, color: palette[i % palette.length], start, end };
  });
  const donut = slices.length
    ? `conic-gradient(${slices
        .map((s) => `${s.color} ${s.start}deg ${s.end}deg`)
        .join(", ")}${restTokens > 0 ? `, #e2e8f0 ${(acc / Math.max(1, totals.total)) * 360}deg 360deg` : ""})`
    : "#e2e8f0";

  return (
    <section className="perm-card">
      <div className="perm-head">
        <b>用量</b>
        <span className="perm-note">
          用掉的 token = 输入 + 输出，不含缓存读 · 本地统计，不上传
        </span>
      </div>

      <div className="u-stats">
        {[
          { label: "累计 Token", value: fmt(totals.total) },
          { label: "今天", value: fmt(todayTokens) },
          { label: "单日峰值", value: totals.peak ? fmt(totals.peak.tokens) : "—" },
          { label: "当前连续天数", value: `${totals.streak.current} 天` },
          { label: "最长连续天数", value: `${totals.streak.longest} 天` },
        ].map((s) => (
          <div className="u-stat" key={s.label}>
            <div className="u-stat-v">{s.value}</div>
            <div className="u-stat-l">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="u-section-title">Token 活动</div>
      <div className="u-heat" aria-label="每日 token 用量">
        {cells.map((c) => (
          <span
            key={c.date}
            className={`u-cell l${c.level}`}
            title={`${c.date}：${c.tokens ? fmt(c.tokens) : "没有用量"}`}
          />
        ))}
      </div>
      <div className="u-legend">
        少 <span className="u-cell l0" /> <span className="u-cell l1" /> <span className="u-cell l2" />
        <span className="u-cell l3" /> <span className="u-cell l4" /> 多
        <span className="u-legend-note">近 {WEEKS} 周</span>
      </div>

      <div className="u-section-title">按模型 Total: {fmt(totals.total)} tokens</div>
      <div className="u-models">
        <div className="u-donut" style={{ background: donut }} aria-hidden="true" />
        <div className="u-list">
          {slices.length === 0 && <div className="perm-note">还没有用量。</div>}
          {slices.map((m) => (
            <div className="u-row" key={m.model}>
              <span className="u-dot" style={{ background: m.color }} />
              <span className="u-name" title={m.model}>
                {m.model}
              </span>
              <span className="u-num">{fmt(m.tokens)}</span>
              <span className="u-pct">
                {totals.total ? Math.round((m.tokens / totals.total) * 100) : 0}%
              </span>
              <span className="u-runs">{m.runs} 回合</span>
            </div>
          ))}
          {restTokens > 0 && (
            <div className="u-row">
              <span className="u-dot" style={{ background: "#e2e8f0" }} />
              <span className="u-name">其他</span>
              <span className="u-num">{fmt(restTokens)}</span>
              <span className="u-pct">
                {totals.total ? Math.round((restTokens / totals.total) * 100) : 0}%
              </span>
              <span className="u-runs" />
            </div>
          )}
        </div>
      </div>

      {totals.unattributed.tokens > 0 && (
        <div className="perm-note">
          另有 {fmt(totals.unattributed.tokens)} token（{totals.unattributed.runs} 回合）不知道是哪个模型花的，未计入上表。
        </div>
      )}
      {totals.silentTurns > 0 && (
        <div className="perm-note">有 {totals.silentTurns} 个回合没有记录 usage。</div>
      )}

      <div className="u-meta">
        {meta
          ? `${filesText(meta)}${meta.reused ? ` · 复用缓存 ${meta.reused}` : ""}`
          : "统计中…"}
        {err ? ` · ${err}` : ""}
      </div>
    </section>
  );
}

function filesText(meta: UsageResult["meta"]): string {
  if (meta.files === 0) return "当前工作区还没有会话";
  return `扫描 ${meta.files} 个会话文件`;
}
