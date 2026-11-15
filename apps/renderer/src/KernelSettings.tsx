import { useCallback, useEffect, useState } from "react";
import type { KernelCandidate, KernelLanguage, KernelSpecsResult, KernelStatus } from "@oh-my-coding-pi/shared";

/**
 * 内核设置（K4，对齐 DAWN 截图）：
 * 每种语言一行 —— 状态徽标、检测本机解释器、路径框、保存、依赖提示；
 * 底部折叠「参考：本机注册过的 Jupyter 内核」与「重新扫描」。
 */

const LABEL: Record<KernelLanguage, string> = { python: "Python", r: "R" };
const DEP: Record<KernelLanguage, { name: string; how: string }> = {
  python: { name: "ipykernel", how: "python -m pip install ipykernel" },
  r: { name: "IRkernel", how: 'R 里执行 install.packages("IRkernel")，再 IRkernel::installspec()' },
};

export default function KernelSettings() {
  const [statuses, setStatuses] = useState<KernelStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<KernelLanguage, string>>({ python: "", r: "" });
  const [busy, setBusy] = useState<KernelLanguage | null>(null);
  const [msg, setMsg] = useState<Record<KernelLanguage, string>>({ python: "", r: "" });
  /** 已点过一次保存、等用户确认“重启并清空变量”（P1-03） */
  const [armed, setArmed] = useState<Record<KernelLanguage, boolean>>({ python: false, r: false });
  const [candidates, setCandidates] = useState<Record<KernelLanguage, KernelCandidate[] | null>>({
    python: null,
    r: null,
  });
  const [specs, setSpecs] = useState<KernelSpecsResult | null>(null);
  const [openSpecs, setOpenSpecs] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = (await window.api.getKernelStatus()) as KernelStatus[];
      setStatuses(list);
      setDrafts({
        python: list.find((s) => s.language === "python")?.configuredPath ?? "",
        r: list.find((s) => s.language === "r")?.configuredPath ?? "",
      });
    } catch {
      setMsg((m) => ({ ...m, python: "读取内核状态失败" }));
    }
  }, []);

  const loadSpecs = useCallback(async () => {
    try {
      setSpecs((await window.api.listKernelSpecs()) as KernelSpecsResult);
    } catch {
      setSpecs({ specs: [], problems: [], shadowed: [] });
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadSpecs();
  }, [refresh, loadSpecs]);

  function statusOf(lang: KernelLanguage): KernelStatus | undefined {
    return statuses.find((s) => s.language === lang);
  }

  /** 徽标只表达三态：未配置 / 已配置 / 缺内核包（以最近一次探测为准） */
  function badge(lang: KernelLanguage): { text: string; cls: string } {
    const st = statusOf(lang);
    const cands = candidates[lang];
    const missing = cands?.length ? cands.every((c) => c.kernelPackage === "missing") : false;
    if (missing) return { text: `缺 ${DEP[lang].name}`, cls: "bad" };
    if (!st?.configuredPath) return { text: "未配置（用系统默认）", cls: "muted" };
    return { text: "已配置", cls: "ok" };
  }

  async function detect(lang: KernelLanguage) {
    setBusy(lang);
    setMsg((m) => ({ ...m, [lang]: "正在检测本机解释器…" }));
    try {
      const list = (await window.api.detectKernels(lang)) as KernelCandidate[];
      setCandidates((c) => ({ ...c, [lang]: list }));
      setMsg((m) => ({
        ...m,
        [lang]:
          list.length === 0
            ? "没找到候选。可以在路径框里直接填绝对路径。"
            : `找到 ${list.length} 个候选，点一条填入（不会自动保存）`,
      }));
    } catch {
      setMsg((m) => ({ ...m, [lang]: "检测失败" }));
    } finally {
      setBusy(null);
    }
  }

  /** 保存会使正在运行的内核重启（变量全部丢失），所以先问一次 */
  function needsConfirm(lang: KernelLanguage): boolean {
    const st = statusOf(lang);
    if (!st?.ready) return false; // 没起来就没什么可丢的
    const next = (drafts[lang] ?? "").trim();
    return next !== (st.configuredPath ?? "");
  }

  async function save(lang: KernelLanguage) {
    if (!armed[lang] && needsConfirm(lang)) {
      setArmed((a) => ({ ...a, [lang]: true }));
      setMsg((m) => ({
        ...m,
        [lang]: `内核正在运行。保存会立即重启并清空全部变量；确认请再点一次“确认重启”，或点“取消”。`,
      }));
      return;
    }
    setArmed((a) => ({ ...a, [lang]: false }));
    setBusy(lang);
    try {
      const res = (await window.api.saveKernelPath(lang, drafts[lang])) as {
        ok: boolean;
        error?: string;
        restarted?: boolean;
      };
      if (!res.ok) {
        setMsg((m) => ({ ...m, [lang]: res.error ?? "保存失败" }));
        return;
      }
      setMsg((m) => ({
        ...m,
        [lang]: res.error ?? (res.restarted ? "已保存，内核按新路径重启（变量已清空）" : "已保存"),
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="perm-card">
      <div className="perm-head">
        <b>内核</b>
        <span className="perm-note">内核型 agent 使用以下解释器。留空则用机器注册项。</span>
      </div>

      {(["python", "r"] as KernelLanguage[]).map((lang) => {
        const b = badge(lang);
        const st = statusOf(lang);
        const list = candidates[lang];
        return (
          <div className="k-row" key={lang}>
            <div className="k-row-head">
              <b>{LABEL[lang]}</b>
              <span className={`k-badge ${b.cls}`}>{b.text}</span>
              <button onClick={() => void detect(lang)} disabled={busy === lang}>
                {busy === lang ? "检测中…" : "检测本机解释器"}
              </button>
            </div>

            <div className="k-input-row">
              <input
                value={drafts[lang]}
                spellCheck={false}
                placeholder={
                  lang === "python" ? "D:/Python313/python.exe（留空 = .venv → 系统 python）" : "D:/R-4.5.2/bin/R.exe（留空 = sci-ir）"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  setDrafts((d) => ({ ...d, [lang]: v }));
                  // 改了路径就作废上一次确认，避免“确认了旧路径”
                  if (armed[lang]) setArmed((a) => ({ ...a, [lang]: false }));
                }}
              />
              <button onClick={() => void save(lang)} disabled={busy === lang}>
                {armed[lang] ? "确认重启（清空变量）" : "保存"}
              </button>
              {armed[lang] && (
                <button
                  onClick={() => {
                    setArmed((a) => ({ ...a, [lang]: false }));
                    setMsg((m) => ({ ...m, [lang]: "已取消：内核路径未改动，变量还在。" }));
                  }}
                  disabled={busy === lang}
                >
                  取消
                </button>
              )}
            </div>

            <div className="k-note">
              需已安装 {DEP[lang].name}。{st?.resolvedPath ? `当前：${st.resolvedPath}` : ""}
              {st?.specSource === "generated" ? " · 用配置路径生成的内核" : ""}
              {` · 安装：${DEP[lang].how}`}
            </div>

            {list && list.length > 0 && (
              <ul className="k-cands">
                {list.map((c) => (
                  <li key={c.path}>
                    <button
                      type="button"
                      onClick={() => setDrafts((d) => ({ ...d, [lang]: c.path }))}
                      title="填入路径，需再点保存"
                    >
                      <span className="k-cand-path">{c.path}</span>
                      <span className={`k-cand-meta ${c.kernelPackage}`}>
                        {c.version ? c.version + " · " : ""}
                        {c.kernelPackage === "present"
                          ? `${DEP[lang].name} 已装`
                          : c.kernelPackage === "missing"
                            ? `缺 ${DEP[lang].name}`
                            : (c.problem ?? "未知")}
                        {" · "}
                        {c.source}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {msg[lang] && <div className="k-msg">{msg[lang]}</div>}
          </div>
        );
      })}

      <div className="k-specs">
        <button className="k-specs-toggle" onClick={() => setOpenSpecs((v) => !v)}>
          {openSpecs ? "▾" : "▸"} 参考：本机注册过的 Jupyter 内核（{specs?.specs.length ?? 0}）
        </button>
        <button
          className="k-rescan"
          onClick={() => {
            void loadSpecs();
            void refresh();
            setCandidates({ python: null, r: null });
          }}
        >
          重新扫描
        </button>
        {openSpecs && specs && (
          <div className="k-specs-body">
            {specs.specs.length === 0 && <div className="perm-note">本机没有注册内核。</div>}
            {specs.specs.map((s) => (
              <div className="k-spec" key={s.dir}>
                <div>
                  <b>{s.displayName}</b> <span className="k-spec-lang">{s.language ?? "?"}</span>
                </div>
                <div className="k-spec-path">{s.executable ?? "（argv 为空）"}</div>
              </div>
            ))}
            {specs.shadowed.length > 0 && (
              <div className="perm-note">被同名项挡住：{specs.shadowed.map((s) => s.name).join("、")}</div>
            )}
            {specs.problems.length > 0 && (
              <div className="perm-note">
                读不出来：{specs.problems.map((p) => `${p.dir}（${p.reason}）`).join("；")}
              </div>
            )}
            <div className="perm-note">这里只读展示，不会改动你的 Jupyter 配置。</div>
          </div>
        )}
      </div>
    </section>
  );
}
