import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ProviderSetupDialog from "./ProviderSetupDialog";
import type { ModelInfo } from "@oh-my-coding-pi/shared";
import {
  contextLabel,
  filterCatalog,
  modelKeyOf,
  priceLabel,
  supportsImage,
  useModelCatalog,
} from "./useModelCatalog";

/**
 * 模型选择面板（B2–B4）。
 *
 * 照 DAWN 的纪律：
 * - 列表来自 pi 的 available（useModelCatalog），取不到就显示「去设置添加」；
 * - 选中后等 setModel 真的成功才关面板，失败把 pi 原文显示在面板里（不乐观更新）；
 * - 名称单行省略，面板宽 240–300px，不换行撑破顶栏。
 */

export default function ModelPicker({
  models,
  value,
  disabled,
  onPick,
  triggerRef,
}: {
  models: ModelInfo[];
  value: string;
  disabled?: boolean;
  onPick: (provider: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const catalog = useModelCatalog(models);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  /** 正在补连接信息的 provider（PR2：缺密钥就地补，不用跳设置） */
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterCatalog(catalog.groups, query), [catalog.groups, query]);
  const flat = useMemo(() => visible.flatMap((g) => g.models), [visible]);
  const current = catalog.findByKey(value);
  const flatKey = (i: number) => (flat[i] ? modelKeyOf(flat[i]!.model) : "");

  // 打开时把焦点给搜索框，并把高亮放在当前模型上
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError("");
    const index = catalog.flat.findIndex((e) => modelKeyOf(e.model) === value);
    setActive(index >= 0 ? index : 0);
    setTimeout(() => searchRef.current?.focus(), 0);
  }, [open, value, catalog.flat]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // 筛选后高亮越界就收回
  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);

  async function pick(index: number) {
    const entry = flat[index];
    if (!entry) return;
    const res = await onPick(entry.model.provider, entry.model.id);
    if (res.ok) {
      setOpen(false);
      return;
    }
    setError(res.error ?? "切换失败");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      triggerRef?.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void pick(active);
    }
  }

  const title = current ? (current.model.name ?? current.model.id) : value || "（未选择模型）";

  return (
    <div className="model-picker" ref={box}>
      <button
        className="model-picker-trigger"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ? `${value}（点击切换）` : "选择模型"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-picker-name">{title}</span>
        <span className="model-picker-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="model-picker-menu" role="listbox" onKeyDown={onKeyDown}>
          <div className="model-picker-search">
            <input
              ref={searchRef}
              value={query}
              placeholder="搜索模型 / provider"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>

          {flat.length === 0 ? (
            <div className="model-picker-empty">
              {catalog.flat.length === 0
                ? "pi 还没有可用模型：去「设置 → 模型注册表」添加 provider"
                : "没有匹配的模型"}
            </div>
          ) : (
            <div className="model-picker-list">
              {visible.map((group) => (
                <div key={group.provider} className="model-picker-group">
                  <div className="model-picker-group-head">
                    <span>{group.provider}</span>
                    {group.credentialSource === "none" && (
                      <button
                        className="model-picker-badge warn model-picker-fix"
                        title="填入密钥并确认连接信息"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSetupFor(group.provider);
                        }}
                      >
                        缺密钥 · 填入
                      </button>
                    )}
                    {group.credentialSource === "env" && <span className="model-picker-badge">环境变量</span>}
                    {group.credentialSource === "auth" && <span className="model-picker-badge">已登录</span>}
                  </div>
                  {group.models.map((entry) => {
                    const key = modelKeyOf(entry.model);
                    const index = flat.findIndex((e) => modelKeyOf(e.model) === key);
                    const selected = key === value;
                    const ctx = contextLabel(entry.model.contextWindow);
                    const price = priceLabel(entry.model.cost);
                    return (
                      <button
                        key={key}
                        className={`model-picker-item ${index === active ? "active" : ""} ${selected ? "selected" : ""}`}
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => void pick(index)}
                      >
                        <span className="model-picker-main">
                          <span className="model-picker-title">
                            {entry.model.name ?? entry.model.id}
                            {selected && <span className="model-picker-check"> ✓</span>}
                          </span>
                          <span className="model-picker-sub">
                            <span className="mono">{entry.model.id}</span>
                            {supportsImage(entry.model) && <span className="model-picker-badge">图片</span>}
                            {entry.model.reasoning && <span className="model-picker-badge">推理</span>}
                          </span>
                        </span>
                        <span className="model-picker-meta">
                          {ctx && <span>{ctx}</span>}
                          {price && <span className="muted">{price}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {error && <div className="model-picker-error">切换失败：{error}</div>}
          {flat.length > 0 && (
            <div className="model-picker-foot">
              {catalog.groups.length} 个 provider · {catalog.flat.length} 个模型 · ↑↓ 选择，Enter 确认，Esc 关闭
            </div>
          )}
        </div>
      )}

      {setupFor && (
        <ProviderSetupDialog
          provider={setupFor}
          initialModelId={current && current.model.provider === setupFor ? current.model.id : undefined}
          onClose={() => setSetupFor(null)}
          onSaved={() => {
            setSetupFor(null);
            catalog.refresh();
            setError("");
          }}
        />
      )}
    </div>
  );
}
