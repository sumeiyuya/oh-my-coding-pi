import { useCallback, useEffect, useMemo, useState } from "react";
import AddProviderDialog from "./AddProviderDialog";
import type { ModelRegistryView, ModelTestResult } from "@oh-my-coding-pi/shared";

/**
 * 模型注册表的卡片式编辑（P2）。
 * 保存时整体替换注册表，managed 列表由主进程维护。
 */

interface DraftProvider {
  id: string;
  baseUrl: string;
  api: string;
  local: boolean;
  modelsText: string;
  /** 新建的 provider 允许改 id；已有的锁定 */
  isNew: boolean;
}

const API_OPTIONS = ["openai-completions", "anthropic-messages", "openai-responses"];

/** 一行一个模型：id | name | contextWindow | maxTokens | image */
function formatModels(raw: unknown): string {
  const models = (raw as Array<Record<string, unknown>> | undefined) ?? [];
  return models
    .map((m) => {
      const parts = [String(m.id ?? "")];
      const hasImage = (m.input as string[] | undefined)?.includes("image") ?? false;
      if (m.name) parts.push(String(m.name));
      else if (m.contextWindow || m.maxTokens || hasImage) parts.push("-");
      if (m.contextWindow) parts.push(String(m.contextWindow));
      else if (m.maxTokens || hasImage) parts.push("-");
      if (m.maxTokens) parts.push(String(m.maxTokens));
      else if (hasImage) parts.push("-");
      if ((m.input as string[] | undefined)?.includes("image")) parts.push("image");
      return parts.join(" | ").replace(/\s+$/, "");
    })
    .join("\n");
}

function parseModels(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, name, ctx, max, ...flags] = trimmed.split("|").map((s) => s.trim());
    if (!id || id === "-") continue;
    const model: Record<string, unknown> = { id };
    if (name && name !== "-") model.name = name;
    if (ctx && ctx !== "-" && Number(ctx) > 0) model.contextWindow = Number(ctx);
    if (max && max !== "-" && Number(max) > 0) model.maxTokens = Number(max);
    if (flags.some((f) => f === "image")) model.input = ["text", "image"];
    out.push(model);
  }
  return out;
}

export default function ModelRegistry() {
  const [view, setView] = useState<ModelRegistryView | null>(null);
  const [drafts, setDrafts] = useState<DraftProvider[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, ModelTestResult>>({});
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionProvider, setVisionProvider] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = (await window.api.getModelRegistry()) as ModelRegistryView;
      setView(next);
      const list = Object.entries(next.registry.providers ?? {}).map(([id, raw]) => {
        const p = raw as Record<string, unknown>;
        return {
          id,
          baseUrl: String(p.baseUrl ?? ""),
          api: String(p.api ?? "openai-completions"),
          local: p.local === true,
          modelsText: formatModels(p.models),
          isNew: false,
        } satisfies DraftProvider;
      });
      setDrafts(list);
      const v = (next.registry as { vision?: { enabled?: boolean; provider?: string; model?: string } }).vision;
      setVisionEnabled(v?.enabled !== false && Boolean(v?.provider));
      setVisionProvider(v?.provider ?? "");
      setVisionModel(v?.model ?? "");
    } catch {
      setMessage("读取注册表失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const keyed = view?.keys ?? {};
  const dirty = useMemo(() => {
    const original = Object.entries(view?.registry.providers ?? {}).map(([id, raw]) => {
      const p = raw as Record<string, unknown>;
      return JSON.stringify({
        id,
        baseUrl: String(p.baseUrl ?? ""),
        api: String(p.api ?? "openai-completions"),
        local: p.local === true,
        modelsText: formatModels(p.models),
      });
    });
    const current = drafts.map((d) =>
      JSON.stringify({ id: d.id, baseUrl: d.baseUrl, api: d.api, local: d.local, modelsText: d.modelsText }),
    );
    return JSON.stringify(original) !== JSON.stringify(current);
  }, [drafts, view]);

  function patch(id: string, next: Partial<DraftProvider>) {
    setDrafts((cur) => cur.map((d) => (d.id === id ? { ...d, ...next } : d)));
  }

  function addProvider() {
    let n = 1;
    while (drafts.some((d) => d.id === `provider-${n}`)) n++;
    const id = `provider-${n}`;
    setDrafts((cur) => [
      ...cur,
      { id, baseUrl: "", api: "openai-completions", local: false, modelsText: "", isNew: true },
    ]);
  }

  function removeProvider(id: string) {
    setDrafts((cur) => cur.filter((d) => d.id !== id));
  }

  async function save() {
    setBusy(true);
    try {
      const providers: Record<string, unknown> = {};
      for (const d of drafts) {
        const models = parseModels(d.modelsText);
        if (!d.id || !d.baseUrl || models.length === 0) {
          setMessage(`${d.id || "未命名"}：id / baseUrl / 至少一个模型都要填`);
          setBusy(false);
          return;
        }
        providers[d.id] = {
          baseUrl: d.baseUrl,
          api: d.api,
          ...(d.local ? { local: true } : {}),
          models,
        };
      }
      const vision =
        visionEnabled && visionProvider && visionModel
          ? { enabled: true, provider: visionProvider, model: visionModel }
          : undefined;
      const res = (await window.api.setModelRegistry({ version: 1, providers, ...(vision ? { vision } : {}) })) as {
        ok: boolean;
        errors: string[];
        warnings: string[];
        written: boolean;
        backup?: string;
      };
      const parts: string[] = [];
      if (!res.ok) parts.push("未保存");
      else if (res.written) parts.push("已写入 models.json");
      else parts.push("models.json 无变化");
      if (res.backup) parts.push("备份 " + res.backup.split(/[\\/]/).pop());
      if (res.errors.length) parts.push(...res.errors);
      if (res.warnings.length) {
        parts.push("未同步 " + res.warnings.length + " 个 provider（pi 不会加载）：" + res.warnings.join("；"));
      }
      setMessage(parts.join(" · "));
      await load();
      window.dispatchEvent(new Event("omcp:models-changed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(id: string) {
    const res = (await window.api.setModelProviderKey(id, keyDraft[id] ?? "")) as {
      ok: boolean;
      error?: string;
      written: boolean;
    };
    setMessage(res.ok ? (res.written ? `${id}：密钥已保存，models.json 已更新` : `${id}：密钥已保存`) : res.error || "保存失败");
    setKeyDraft((cur) => ({ ...cur, [id]: "" }));
    await load();
    window.dispatchEvent(new Event("omcp:models-changed"));
  }

  async function test(id: string) {
    setBusy(true);
    try {
      const res = (await window.api.testModelProvider(id)) as ModelTestResult;
      setTestResult((cur) => ({ ...cur, [id]: res }));
    } finally {
      setBusy(false);
    }
  }

  async function importFromPi() {
    const res = (await window.api.importModelRegistry()) as {
      ok: boolean;
      count: number;
      skipped: string[];
      error?: string;
    };
    setMessage(
      res.ok
        ? `已导入 ${res.count} 个 provider${res.skipped.length ? "，跳过：" + res.skipped.join("、") : ""}`
        : res.error || "导入失败",
    );
    await load();
    window.dispatchEvent(new Event("omcp:models-changed"));
  }

  return (
    <section className="perm-card">
      <div className="perm-head">
        <b>模型注册表</b>
        <span className="perm-note">
          {drafts.length} 个 provider{dirty ? " · 有未保存修改" : ""}
        </span>
      </div>
      <div className="perm-note" style={{ marginBottom: 8 }}>
        写入 pi 的 models.json：只覆盖同名 provider，其它内容原样保留；内容没变不写；改前备份。密钥存在本机安全存储，不写进 models.json。
      </div>
      {view && (
        <div className="perm-note" style={{ marginBottom: 8 }}>
          <code>{view.piModelsPath}</code>
        </div>
      )}

      {drafts.map((d) => {
        const test1 = testResult[d.id];
        return (
          <div className="reg-card" key={d.id}>
            <div className="reg-card-head">
              <input
                className="reg-id"
                value={d.id}
                disabled={!d.isNew}
                spellCheck={false}
                onChange={(e) => patch(d.id, { id: e.target.value })}
                title={d.isNew ? "新 provider 的 id" : "id 不允许修改"}
              />
              <label className="switch" style={{ fontSize: 11.5 }}>
                <input
                  type="checkbox"
                  checked={d.local}
                  onChange={(e) => patch(d.id, { local: e.target.checked })}
                />
                本地服务
              </label>
              {!d.local && !keyed[d.id] && (
                <span className="perm-decision deny" title="没有密钥的 provider 不会写进 models.json，pi 也就看不到它">
                  缺密钥·未同步
                </span>
              )}
              {keyed[d.id] && (
                <span className="perm-ok" title="密钥存在本机安全存储（safeStorage 加密），不写进 models.json">
                  密钥已存
                </span>
              )}
              <button className="reg-del" onClick={() => removeProvider(d.id)}>
                删除
              </button>
            </div>

            <div className="reg-fields">
              <label>
                Base URL
                <input
                  value={d.baseUrl}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  onChange={(e) => patch(d.id, { baseUrl: e.target.value })}
                />
              </label>
              <label>
                API
                <select value={d.api} onChange={(e) => patch(d.id, { api: e.target.value })}>
                  {API_OPTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="reg-models">
              模型（一行一个：<code>id | 名称 | 上下文 | 最大输出 | image</code>，空位写 <code>-</code>）
              <textarea
                value={d.modelsText}
                spellCheck={false}
                placeholder={"deepseek-v4.1-flash | DeepSeek V4.1 Flash | 1000000 | 384000 | image"}
                onChange={(e) => patch(d.id, { modelsText: e.target.value })}
              />
            </label>

            <div className="reg-key">
              <span className="perm-note">{keyed[d.id] ? "已存密钥" : d.local ? "本地服务不需要密钥" : "未存密钥"}</span>
              <input
                type="password"
                placeholder={keyed[d.id] ? "替换密钥（留空不删）" : "粘贴 API key"}
                value={keyDraft[d.id] ?? ""}
                onChange={(e) => setKeyDraft((cur) => ({ ...cur, [d.id]: e.target.value }))}
              />
              <button onClick={() => void saveKey(d.id)}>保存密钥</button>
              <button onClick={() => void test(d.id)} disabled={busy}>
                测试连接
              </button>
              {test1 && (
                <span className={`reg-test ${test1.ok ? "ok" : "bad"}`}>
                  {test1.ok
                    ? `通 · ${test1.ms}ms${test1.modelCount !== undefined ? ` · ${test1.modelCount} 个模型` : ""}`
                    : `${test1.error ?? "失败"}${test1.status ? ` (${test1.status})` : ""} · ${test1.ms}ms`}
                </span>
              )}
            </div>
          </div>
        );
      })}

      <div className="reg-vision">
        <div className="reg-vision-head">
          <b>视觉服务（图片转述）</b>
          <label className="switch" style={{ fontSize: 11.5 }}>
            <input
              type="checkbox"
              checked={visionEnabled}
              onChange={(e) => setVisionEnabled(e.target.checked)}
            />
            启用
          </label>
        </div>
        <div className="perm-note" style={{ marginBottom: 6 }}>
          选一个 provider 与模型做图片转述；密钥复用该 provider 的。不启用时回落到旧的独立视觉配置（若设置过）。
        </div>
        <div className="reg-fields">
          <label>
            Provider
            <select
              value={visionProvider}
              onChange={(e) => {
                setVisionProvider(e.target.value);
                setVisionModel("");
              }}
            >
              <option value="">（不使用）</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select value={visionModel} onChange={(e) => setVisionModel(e.target.value)}>
              <option value="">（未选）</option>
              {parseModels(drafts.find((d) => d.id === visionProvider)?.modelsText ?? "").map((m) => (
                <option key={String(m.id)} value={String(m.id)}>
                  {String(m.name ?? m.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="perm-form">
        <button onClick={() => setAdding(true)}>＋ 从目录添加</button>
        <button onClick={addProvider}>＋ 手工新建</button>
        <button onClick={() => void save()} disabled={busy || !dirty}>
          保存并同步
        </button>
        <button onClick={() => void importFromPi()}>从 pi 导入</button>
        <button onClick={() => void load()}>放弃修改</button>
      </div>
      {message && <div className="perm-note" style={{ marginTop: 8 }}>{message}</div>}

      {adding && (
        <AddProviderDialog
          existing={drafts.map((d) => d.id)}
          onClose={() => setAdding(false)}
          onAdded={() => {
            void load();
            window.dispatchEvent(new Event("omcp:models-changed"));
          }}
        />
      )}
    </section>
  );
}
