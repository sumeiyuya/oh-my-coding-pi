import { useCallback, useEffect, useState } from "react";
import KernelSettings from "./KernelSettings";
import UsagePanel from "./UsagePanel";
import ModelRegistry from "./ModelRegistry";
import AddProviderDialog from "./AddProviderDialog";
import ProviderSetupDialog from "./ProviderSetupDialog";
import PluginSettings from "./PluginSettings";
import McpSettings from "./McpSettings";
import type {
  AppSettingsDetail,
  ModelInfo,
  PiRuntimeInfo,
  PolicyInfo,
  UpdateCheckResult,
  UpdateErrorKind,
} from "@oh-my-coding-pi/shared";

type Draft = Partial<AppSettingsDetail>;

/** 检查更新失败的分类提示（D2）：分类由主进程 updater 给，UI 不解析 error 文本。 */
const UPDATE_HINT: Record<UpdateErrorKind, string> = {
  auth: "仓库不可访问，可能是私有仓库。当前只支持公开仓库的更新检查，请手动下载。",
  not_found: "仓库或 release 不存在：检查上面的 owner/repo 是否写对。",
  ratelimit: "GitHub 限流了，过几分钟再试。",
  timeout: "请求超时：网络可能不通，或需要代理。",
  network: "网络不可用：检查连接或代理后重试。",
  parse: "发布信息格式异常，可能与 GitHub API 变化有关。",
};

export default function Settings({
  theme,
  onThemeChange,
}: {
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
}) {
  const [settings, setSettings] = useState<AppSettingsDetail | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState("");
  const [diagPath, setDiagPath] = useState("");
  const [pi, setPi] = useState<PiRuntimeInfo | null>(null);
  /** 顶部快捷入口：添加模型服务（结果同时刷新注册表卡片） */
  const [addingProvider, setAddingProvider] = useState(false);
  const [registryIds, setRegistryIds] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [s, m, p] = await Promise.all([
        window.api.getSettingsDetail(),
        window.api.getAvailableModels(),
        window.api.getPolicy(),
      ]);
      setSettings(s ?? null);
      setDraft({});
      setModels(m ?? []);
      setPolicy(p ?? null);
      setPi((await window.api.getPiInfo()) as PiRuntimeInfo);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = <K extends keyof AppSettingsDetail>(key: K): AppSettingsDetail[K] | "" =>
    (draft[key] ?? settings?.[key] ?? "") as AppSettingsDetail[K] | "";

  const set = <K extends keyof AppSettingsDetail>(key: K, next: AppSettingsDetail[K]) => {
    setDraft((cur) => ({ ...cur, [key]: next }));
  };

  const save = async () => {
    // 内核路径走专用接口：带校验，而且只重启对应那个内核
    const { pythonPath, rPath, ...rest } = draft;
    for (const [lang, path] of [
      ["python", pythonPath],
      ["r", rPath],
    ] as const) {
      if (typeof path !== "string") continue;
      const res = (await window.api.saveKernelPath(lang, path)) as {
        ok: boolean;
        error?: string;
        restarted?: boolean;
      };
      if (!res.ok) {
        setSaved(`${lang === "r" ? "R" : "Python"} 路径未保存：${res.error ?? "未知错误"}`);
        return;
      }
      if (res.restarted) setSaved(`${lang === "r" ? "R" : "Python"} 内核已按新路径重启`);
    }

    const next = (await window.api.updateSettingsDetail(rest)) as AppSettingsDetail;
    setSettings(next);
    setDraft({});
    if (Object.keys(rest).length > 0) setSaved("已保存 " + new Date().toTimeString().slice(0, 8));
    setPolicy((await window.api.getPolicy()) ?? null);
  };

  const openAddProvider = async () => {
    try {
      const res = (await window.api.getModelRegistry()) as {
        registry?: { providers?: Record<string, unknown> };
      };
      setRegistryIds(Object.keys(res?.registry?.providers ?? {}));
    } catch {
      setRegistryIds([]);
    }
    setAddingProvider(true);
  };

  /** 打开「确认连接信息 + 存密钥」对话框：当前 provider 或内置目录里的任一条 */
  const [setupProvider, setSetupProvider] = useState<string | null>(null);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      setUpdate((await window.api.checkUpdate()) as UpdateCheckResult);
    } finally {
      setChecking(false);
    }
  };

  // 检查失败时仍然给一个能操作的动作：直接去发布页手动下载
  const repoInput = String(value("updateRepo") ?? "").trim();
  const repoReleases = /^[\w.-]+\/[\w.-]+$/.test(repoInput)
    ? `https://github.com/${repoInput}/releases`
    : null;

  const exportDiag = async () => {
    const file = await window.api.exportDiagnostics();
    setDiagPath(file ?? "导出失败");
  };

  return (
    <div className="perm">
      <section className="perm-card">
        <div className="perm-head">
          <b>外观</b>
        </div>
        <div className="perm-row">
          <span>界面颜色</span>
          <span className="seg" role="group" aria-label="界面颜色">
            <button
              type="button"
              className={theme === "dark" ? "on" : ""}
              aria-pressed={theme === "dark"}
              onClick={() => onThemeChange("dark")}
            >
              深色
            </button>
            <button
              type="button"
              className={theme === "light" ? "on" : ""}
              aria-pressed={theme === "light"}
              onClick={() => onThemeChange("light")}
            >
              浅色
            </button>
          </span>
        </div>
        <div className="perm-row">
          <span />
          <span className="perm-note">切换立即生效，并记住到下次启动（原来在顶栏的按钮已移到这里）。</span>
        </div>
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>模型与预算</b>
          <span className="perm-note">{saved}</span>
        </div>
        <div className="perm-form">
          <label>
            Provider
            <input
              value={String(value("provider"))}
              onChange={(e) => set("provider", e.target.value)}
              placeholder="opencode-go"
            />
          </label>
          <label>
            Model
            <input
              value={String(value("model"))}
              onChange={(e) => set("model", e.target.value)}
              list="pi-models"
              placeholder="deepseek-v4.1-flash"
            />
            <datalist id="pi-models">
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={m.id}>
                  {m.provider}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            单会话上限（$）
            <input
              type="number"
              step="0.5"
              min="0"
              value={Number(value("sessionLimit"))}
              onChange={(e) => set("sessionLimit", Number(e.target.value))}
            />
          </label>
          <label>
            单日上限（$）
            <input
              type="number"
              step="0.5"
              min="0"
              value={Number(value("dailyLimit"))}
              onChange={(e) => set("dailyLimit", Number(e.target.value))}
            />
          </label>
        </div>
        {!value("provider") || !value("model") ? (
          <div className="perm-row">
            <span>提示</span>
            <span className="perm-note">
              当前没有默认模型，发送会被拦下。装好后请先在这里填写 provider / 模型，或在顶栏选择器里选一个（会自动记住）。
            </span>
          </div>
        ) : null}
        <div className="perm-row">
          <span>生效</span>
          <span className="perm-note">
            模型切换对当前会话生效；provider 变更会重启 pi。预算立即生效。
          </span>
        </div>
        <div className="perm-row">
          <span>服务商</span>
          <span className="perm-note">
            从内置目录（43 个服务商，地址与模型目录已就绪）挑一个；新增与补全都会先确认服务地址与模型，再保存密钥。
          </span>
          <button onClick={() => void openAddProvider()}>＋ 添加模型服务</button>
          <button
            onClick={() => setSetupProvider(String(value("provider") ?? "").trim())}
            disabled={!String(value("provider") ?? "").trim()}
            title="为当前 Provider 确认连接信息并保存密钥"
          >
            补全当前 Provider
          </button>
        </div>
      </section>

      <KernelSettings />

      <section className="perm-card">
        <div className="perm-head">
          <b>策略</b>
        </div>
        <div className="perm-form">
          <label>
            策略文件
            <input
              value={String(value("policyPath"))}
              onChange={(e) => set("policyPath", e.target.value)}
              placeholder="留空 = <工作区>/.omcp/policy.json → 默认策略"
            />
          </label>
        </div>
        <div className="perm-row perm-settings">
          <span>项目资源</span>
          <label className="perm-check">
            <input
              type="checkbox"
              checked={!!value("trustProject")}
              onChange={(e) => set("trustProject", e.target.checked)}
            />
            信任本项目的 .pi 设置与 .agents/skills（保存后重启 pi）
          </label>
        </div>
        <div className="perm-row">
          <span>当前</span>
          <span className="perm-note">
            策略 mode={policy?.mode ?? "—"} · source={policy?.source ?? "—"} · pi cwd=
            {settings ? "（见启动日志）" : "—"}。
          </span>
        </div>
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>pi 运行时</b>
          <button onClick={async () => setPi((await window.api.getPiInfo()) as PiRuntimeInfo)}>
            刷新
          </button>
        </div>
        {pi ? (
          <>
            <div className="perm-row">
              <span>来源</span>
              <code>{pi.origin === "bundled" ? "内置" : pi.origin === "env" ? "环境变量" : pi.origin === "path" ? "PATH" : "错误"}</code>
              <span>版本</span>
              <code>{pi.actual ?? "未探测到"}</code>
              {pi.expected && (
                <span className={pi.ok ? "perm-ok" : "perm-new"}>
                  {pi.ok ? "与期望一致" : `期望 ${pi.expected}`}
                </span>
              )}
            </div>
            <div className="perm-row">
              <span>入口</span>
              <code className="perm-path">{pi.entry}</code>
            </div>
            <div className="perm-row">
              <span>配置目录</span>
              <code className="perm-path">{pi.configDir}</code>
              <label className="perm-check">
                <input
                  type="checkbox"
                  checked={!!value("piConfigDir")}
                  onChange={(e) =>
                    set("piConfigDir", e.target.checked ? pi.defaultIsolatedDir : "")
                  }
                />
                使用独立配置目录（需要重新登录）
              </label>
            </div>
            {pi.system.path && (
              <div className="perm-row">
                <span>系统 pi</span>
                <span className="perm-note">
                  {pi.system.path} · {pi.system.version ?? "版本未知"}（仅诊断，不影响本应用）
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="perm-empty">未取到 pi 信息</div>
        )}
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>多会话</b>
          <span className="perm-note">默认 3 个活跃 runtime（上限 4）</span>
        </div>
        <div className="perm-form">
          <label>
            最多活跃 runtime
            <input
              type="number"
              min={1}
              max={4}
              value={String(value("maxRuntimes"))}
              onChange={(e) => set("maxRuntimes", Number(e.target.value))}
            />
          </label>
          <label>
            空闲回收（分钟）
            <input
              type="number"
              min={1}
              max={1440}
              value={String(value("runtimeIdleMinutes"))}
              onChange={(e) => set("runtimeIdleMinutes", Number(e.target.value))}
            />
          </label>
        </div>
        <div className="perm-note">
          后台 runtime 空闲超过该分钟会停 pi，标签保留；切回时自动恢复。默认标签与当前标签不会被回收。
        </div>
      </section>

      {setupProvider && (
        <ProviderSetupDialog
          provider={setupProvider}
          initialModelId={String(value("model")) || undefined}
          onClose={() => setSetupProvider(null)}
          onSaved={() => setSaved("连接信息已保存，pi 已重启")}
        />
      )}

      <section className="perm-card">
        <div className="perm-head">
          <b>更新</b>
          <button onClick={checkUpdate} disabled={checking}>
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
        <div className="perm-form">
          <label>
            GitHub 仓库
            <input
              value={String(value("updateRepo"))}
              onChange={(e) => set("updateRepo", e.target.value)}
              placeholder="owner/repo（留空则不检查）"
            />
          </label>
        </div>
        {update && (
          <div className="perm-update">
            {!update.configured ? (
              <div className="perm-note">未配置更新源：填上 owner/repo 后再检查。</div>
            ) : update.error ? (
              <>
                <div className="perm-error">{update.error}</div>
                {update.errorKind && (
                  <div className="perm-note">{UPDATE_HINT[update.errorKind]}</div>
                )}
                {repoReleases && (
                  <div className="perm-note">
                    仍可手动下载：
                    <a href={repoReleases} target="_blank" rel="noreferrer">
                      {repoReleases}
                    </a>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="perm-row">
                  <span>当前</span>
                  <code>{update.current}</code>
                  <span>最新</span>
                  <code>{update.latest}</code>
                  <b className={update.hasUpdate ? "perm-new" : "perm-ok"}>
                    {update.hasUpdate ? "有新版本" : "已是最新"}
                  </b>
                </div>
                {update.url && (
                  <div className="perm-row">
                    <span>发布页</span>
                    <a href={update.url} target="_blank" rel="noreferrer">
                      {update.url}
                    </a>
                  </div>
                )}
                {update.sha256 && (
                  <pre className="perm-sha">{update.sha256.slice(0, 600)}</pre>
                )}
                {update.notes && <pre className="perm-notes">{update.notes}</pre>}
                <div className="perm-note">
                  下载后请用发布页的 SHA256 校验；v1 不自动安装（ADR-002）。
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <ModelRegistry />

      <McpSettings />

      <PluginSettings />

      <UsagePanel />

      <section className="perm-card">
        <div className="perm-head">
          <b>诊断</b>
          <button onClick={exportDiag}>导出诊断包</button>
        </div>
        <div className="perm-row">
          <span>说明</span>
          <span className="perm-note">
            打包版本、系统、策略摘要、设置（脱敏）、最近 100 条审计与日志尾部，写到
            `%APPDATA%\oh-my-coding-pi\exports\`。
          </span>
        </div>
        {diagPath && <div className="perm-note">{diagPath}</div>}
      </section>

      <div className="perm-save">
        <button className="perm-primary" onClick={save} disabled={Object.keys(draft).length === 0}>
          保存设置
        </button>
        {Object.keys(draft).length > 0 && <span className="perm-note">有未保存的修改</span>}
      </div>

      {addingProvider && (
        <AddProviderDialog
          existing={registryIds}
          onClose={() => setAddingProvider(false)}
          onAdded={() => {
            void refresh();
            window.dispatchEvent(new Event("omcp:models-changed"));
          }}
        />
      )}
    </div>
  );
}
