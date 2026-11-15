import { useEffect, useMemo, useState } from "react";
import type { ModelSetupInfo } from "@oh-my-coding-pi/shared";

/**
 * 补全/修改一个服务商的连接信息与密钥（PR2）。
 *
 * 纪律（已定的决定）：
 * - **不允许只填 key 就建记录**：必须先确认 baseUrl 与至少一个模型；
 * - 确认前把「将写入 models.json 的片段」原样展示（里面只有 $OMCP_KEY_<ID> 引用，没有真实密钥）；
 * - 取消不做任何写入。
 *
 * 模型选择器与设置页共用这一个组件，只由调用方决定预填哪个 provider / 哪个模型。
 */
export default function ProviderSetupDialog({
  provider,
  initialModelId,
  onClose,
  onSaved,
}: {
  provider: string;
  initialModelId?: string;
  onClose: () => void;
  onSaved?: (info: { provider: string; restarted: boolean }) => void;
}) {
  const [info, setInfo] = useState<ModelSetupInfo | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [picked, setPicked] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = (await window.api.modelSetupInfo(provider)) as ModelSetupInfo;
        if (!alive) return;
        setInfo(next);
        setBaseUrl(next.config?.baseUrl || next.catalog?.baseUrl || "");
        setApi(next.config?.api || next.catalog?.api || "openai-completions");
        const existing = next.config?.models.map((m) => m.id) ?? [];
        const initial = initialModelId && next.models.some((m) => m.id === initialModelId) ? [initialModelId] : [];
        setPicked(initial.length ? initial : existing.length ? existing : next.models.slice(0, 1).map((m) => m.id));
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : "读取服务商信息失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider, initialModelId]);

  const models = info?.models ?? [];
  const willWrite = useMemo(() => {
    if (!info) return null;
    const preview = info.preview as { models?: Array<{ id?: string }> } & Record<string, unknown>;
    const keep = new Set(picked);
    return {
      ...preview,
      baseUrl,
      api,
      models: (preview.models ?? []).filter((m) => keep.has(String(m.id ?? ""))),
    };
  }, [info, picked, baseUrl, api]);

  const canSave = Boolean(baseUrl && /^https?:\/\//i.test(baseUrl) && picked.length > 0 && !busy);

  function toggle(id: string) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const res = (await window.api.modelSetupSave({
        provider,
        baseUrl,
        api,
        modelIds: picked,
        apiKey: apiKey.trim() || undefined,
      })) as { ok: boolean; errors?: string[]; restarted?: boolean };
      if (!res.ok) {
        setError((res.errors ?? ["保存失败"]).join("；"));
        return;
      }
      onSaved?.({ provider, restarted: Boolean(res.restarted) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup-backdrop" onClick={() => !busy && onClose()}>
      <div className="setup-box" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="服务商连接信息">
        <div className="setup-head">
          <b>{info?.known ? "确认连接信息" : "添加自定义服务商"}</b>
          <code>{provider}</code>
          <button className="btn-ghost" onClick={() => !busy && onClose()} aria-label="关闭">
            ×
          </button>
        </div>

        {loadError ? (
          <div className="setup-error">{loadError}</div>
        ) : !info ? (
          <div className="setup-loading">读取中…</div>
        ) : (
          <div className="setup-body">
            {!info.known && (
              <div className="setup-note">pi 的内置目录里没有这个服务商，需要你自己填地址与模型。</div>
            )}
            {info.credential.has && (
              <div className="setup-ok">
                已有凭据（来源：{credentialLabel(info.credential.source)}）。留空密钥即保持不变。
              </div>
            )}

            <label className="setup-field">
              <span>服务地址（baseUrl）</span>
              <input
                value={baseUrl}
                spellCheck={false}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label className="setup-field">
              <span>协议（api）</span>
              <input value={api} spellCheck={false} onChange={(e) => setApi(e.target.value)} />
            </label>

            <div className="setup-field">
              <span>可用模型（勾选要用的）</span>
              <div className="setup-models">
                {models.length === 0 && <span className="setup-empty">这个服务商没有可列出的模型</span>}
                {models.map((m) => (
                  <label key={m.id} className="setup-model">
                    <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                    <span>{m.name ?? m.id}</span>
                    <code>{m.id}</code>
                  </label>
                ))}
              </div>
            </div>

            <label className="setup-field">
              <span>API 密钥{info.credential.has ? "（留空不改）" : ""}</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
              />
            </label>
            <div className="setup-note">
              会注入环境变量：<code>{info.envKeys.join("、")}</code>；磁盘上的 models.json 只写{" "}
              <code>$OMCP_KEY_{provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}</code>，不落明文。
            </div>

            <details className="setup-preview">
              <summary>将写入 models.json 的片段（不含真实密钥）</summary>
              <pre>{JSON.stringify(willWrite, null, 2)}</pre>
            </details>

            {error && <div className="setup-error">{error}</div>}

            <div className="setup-actions">
              <button onClick={() => !busy && onClose()} disabled={busy}>
                取消
              </button>
              <button className="primary" onClick={() => void save()} disabled={!canSave}>
                {busy ? "保存中…" : "确认并重启 pi"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function credentialLabel(source: "stored" | "env" | "auth" | "none"): string {
  if (source === "stored") return "本机安全存储";
  if (source === "env") return "环境变量";
  if (source === "auth") return "pi 的 auth.json";
  return "无";
}
