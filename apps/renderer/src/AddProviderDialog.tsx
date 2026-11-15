import { useEffect, useMemo, useState } from "react";
import type { CatalogProvider, ModelTestResult, ProviderCatalogResult } from "@oh-my-coding-pi/shared";

/**
 * 添加模型服务（修改 1 · S2/S3）。
 * 两个页签：从 pi 认识的里面挑 / 自定义端点。
 * 「加进来」= 写入注册表并同步 models.json；已存在的 provider 不重复加，
 * 但可以在这里「保存密钥并同步」——否则用户看到「已添加」和一个灰按钮，不知道下一步去哪。
 */

type Tab = "catalog" | "custom";

export default function AddProviderDialog({
  existing,
  onClose,
  onAdded,
}: {
  existing: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [tab, setTab] = useState<Tab>("catalog");
  const [catalog, setCatalog] = useState<ProviderCatalogResult | null>(null);
  const [filter, setFilter] = useState("");
  const [pickedId, setPickedId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [modelsText, setModelsText] = useState("");
  const [customId, setCustomId] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<ModelTestResult | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setCatalog((await window.api.getProviderCatalog()) as ProviderCatalogResult);
      } catch {
        setCatalog({ providers: [], path: "", error: "读取目录失败" });
      }
    })();
  }, []);

  const providers = catalog?.providers ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? providers.filter((p) => p.id.toLowerCase().includes(q)) : providers;
    return list.slice(0, 200);
  }, [providers, filter]);

  const picked: CatalogProvider | undefined = providers.find((p) => p.id === pickedId);

  function pick(p: CatalogProvider) {
    setPickedId(p.id);
    setBaseUrl(p.requiresBaseUrl ? "" : p.baseUrl);
    setApi(p.api);
    setTest(null);
    setMsg("");
  }

  const effectiveBaseUrl = tab === "catalog" ? baseUrl || picked?.baseUrl || "" : baseUrl;

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const res = (await window.api.probeModelEndpoint(effectiveBaseUrl, key, api)) as ModelTestResult;
      setTest(res);
    } catch {
      setTest({ ok: false, ms: 0, error: "探测失败" });
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    setMsg("");
    try {
      let input: {
        id: string;
        baseUrl: string;
        api: string;
        models: Array<{ id: string; name?: string } | CatalogProvider["models"][number]>;
        apiKey?: string;
      };
      if (tab === "catalog") {
        if (!picked) {
          setMsg("先挑一个服务商");
          return;
        }
        // 修改 1 的决策：模型全量导入，不截断
        input = {
          id: picked.id,
          baseUrl: effectiveBaseUrl,
          api: picked.api,
          models: picked.models,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        };
      } else {
        const models = modelsText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((line) => {
            const [id, name] = line.split("|").map((s) => s.trim());
            return { id, ...(name ? { name } : {}) };
          });
        input = {
          id: customId.trim(),
          baseUrl: effectiveBaseUrl,
          api,
          models,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        };
      }
      const res = (await window.api.addModelProvider(input)) as {
        ok: boolean;
        error?: string;
        written?: boolean;
        warnings?: string[];
      };
      if (!res.ok) {
        setMsg(res.error ?? "添加失败");
        return;
      }
      const parts = ["已加入"];
      if (res.written) parts.push("models.json 已更新");
      if (res.warnings?.length) parts.push("跳过：" + res.warnings.join("；"));
      setMsg(parts.join(" · "));
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  /** 目录里已经加过这个服务商：不重复加，但允许补/换密钥 */
  const alreadyAdded = tab === "catalog" && Boolean(picked) && existing.includes(picked!.id);
  const canAdd = alreadyAdded
    ? Boolean(key.trim())
    : tab === "catalog"
      ? Boolean(picked) && Boolean(effectiveBaseUrl) && !existing.includes(picked?.id ?? "")
      : Boolean(customId.trim()) && Boolean(baseUrl) && modelsText.trim().length > 0;

  /** 按钮禁用时把原因说出来：灰按钮不该是死路 */
  const blockedReason = alreadyAdded
    ? key.trim()
      ? ""
      : "这个服务商已经在注册表里了：填一个 API key，点「保存密钥并同步」即可（会自动重启 pi）"
    : tab === "catalog"
      ? !picked
        ? "先挑一个服务商"
        : !effectiveBaseUrl
          ? "这个服务商需要先填 Base URL"
          : ""
      : !customId.trim()
        ? "自定义端点要先填 id"
        : !baseUrl
          ? "自定义端点要先填 Base URL"
          : !modelsText.trim()
            ? "自定义端点至少要写一个模型（一行一个）"
            : "";

  async function submit() {
    if (busy) return;
    // 已存在：只更新密钥并同步（models:key-set 会重启 pi）
    if (alreadyAdded && picked) {
      setBusy(true);
      setMsg("");
      try {
        const res = (await window.api.setModelProviderKey(picked.id, key.trim())) as {
          ok: boolean;
          error?: string;
          warnings?: string[];
        };
        if (!res.ok) {
          setMsg(res.error ?? "保存密钥失败");
          return;
        }
        setMsg("密钥已保存并同步；pi 会按新密钥重启。");
        onAdded();
      } finally {
        setBusy(false);
      }
      return;
    }
    await add();
  }

  return (
    <div className="add-backdrop" onClick={onClose}>
      <div className="add-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="添加模型服务">
        <div className="add-head">
          <b>添加模型服务</b>
          <span className="perm-note">只支持 OpenAI 兼容协议的端点</span>
          <button onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="add-tabs">
          <button
            className={tab === "catalog" ? "active" : ""}
            onClick={() => {
              setTab("catalog");
              setTest(null);
              setMsg("");
            }}
          >
            从 pi 认识的里面挑（{providers.length}）
          </button>
          <button
            className={tab === "custom" ? "active" : ""}
            onClick={() => {
              setTab("custom");
              setTest(null);
              setMsg("");
            }}
          >
            自定义端点
          </button>
        </div>

        {catalog?.error && <div className="add-warn">目录不可用：{catalog.error}</div>}

        {tab === "catalog" ? (
          <>
            <div className="add-label">挑一个</div>
            <div className="perm-note" style={{ marginBottom: 6 }}>
              地址、协议与模型目录已内置，只需 key。模型会全量导入。
            </div>
            <div className="add-row">
              <input
                value={filter}
                placeholder="筛选，例如 anthropic"
                onChange={(e) => setFilter(e.target.value)}
              />
              <select
                value={pickedId}
                onChange={(e) => {
                  const p = providers.find((x) => x.id === e.target.value);
                  if (p) pick(p);
                  else setPickedId("");
                }}
              >
                <option value="">选择一个服务商</option>
                {filtered.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                    {p.requiresBaseUrl ? "（还要填地址）" : ""}
                    {existing.includes(p.id) ? " · 已添加" : ""}
                    {` · ${p.modelCount} 个模型`}
                  </option>
                ))}
              </select>
            </div>

            {picked && (
              <div className="add-picked">
                {picked.modelCount} 个模型 · {picked.api}
                {picked.requiresBaseUrl && (
                  <span className="add-req">需要填地址</span>
                )}
              </div>
            )}

            {(picked?.requiresBaseUrl || pickedId) && (
              <label className="add-field">
                Base URL
                <input
                  value={baseUrl}
                  placeholder={picked?.baseUrl || "https://…"}
                  spellCheck={false}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </label>
            )}
          </>
        ) : (
          <>
            <label className="add-field">
              provider id
              <input
                value={customId}
                placeholder="例如 my-endpoint"
                spellCheck={false}
                onChange={(e) => setCustomId(e.target.value)}
              />
            </label>
            <label className="add-field">
              Base URL
              <input
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
            <label className="add-field">
              API
              <select value={api} onChange={(e) => setApi(e.target.value)}>
                {["openai-completions", "anthropic-messages", "openai-responses"].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="add-field">
              模型（一行一个：id | 名称）
              <textarea
                value={modelsText}
                spellCheck={false}
                placeholder={"deepseek-chat | DeepSeek Chat"}
                onChange={(e) => setModelsText(e.target.value)}
              />
            </label>
          </>
        )}

        <label className="add-field">
          API key
          <input
            type="password"
            value={key}
            placeholder="粘贴 API key（存进系统加密存储，不写进 models.json）"
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {!alreadyAdded && !key.trim() && (
          <div className="add-warn">
            没填密钥也能加进来，但 <b>pi 不会加载这个服务商</b>（模型列表里看不到它）；
            之后可在「模型注册表」里补密钥，保存后会重启 pi。
          </div>
        )}

        {blockedReason && <div className="add-warn">{blockedReason}</div>}
        <div className="add-actions">
          <button onClick={() => void runTest()} disabled={busy || !effectiveBaseUrl}>
            测试连通
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !canAdd}>
            {alreadyAdded ? "保存密钥并同步" : "加进来"}
          </button>
        </div>

        {test && (
          <div className={`add-test ${test.ok ? "ok" : "bad"}`}>
            {test.ok
              ? `通 · ${test.ms}ms${test.modelCount !== undefined ? ` · ${test.modelCount} 个模型` : ""}`
              : `${test.error ?? "失败"}${test.status ? ` (${test.status})` : ""} · ${test.ms}ms`}
          </div>
        )}
        {msg && <div className="add-msg">{msg}</div>}
      </div>
    </div>
  );
}
