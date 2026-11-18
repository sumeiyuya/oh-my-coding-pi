import { useEffect, useRef, useState, type RefObject } from "react";
import type { ThinkingLevel } from "@oh-my-coding-pi/shared";

/**
 * 顶栏推理强度下拉（方案：模型栏增加推理强度）。
 *
 * 纪律与 ModelPicker 一致：
 * - 档位来自 pi 的 get_available_thinking_levels，不在前端硬编码「哪些档能用」；
 * - 只有 pi 接受后才更新显示（不乐观更新），失败把原文放回菜单里；
 * - 当前档以 get_state 回读为准（模型可能把请求的档钳制过）。
 *
 * 空态（P2）：失败与「pi 正常返回空数组」是两件事，不能合并成一句：
 * - 请求失败/超时 → 可重试；
 * - 正常返回空 → 当前模型没有可调档位，建议换模型。
 */

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "更高",
  max: "最高",
};

export function thinkingLabel(level: ThinkingLevel | null | undefined): string {
  return level ? LEVEL_LABEL[level] : "推理";
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; levels: ThinkingLevel[] }
  | { kind: "empty" }
  | { kind: "error" };

export default function ThinkingPicker({
  level,
  disabled,
  onOpenLevels,
  onPick,
  triggerRef,
}: {
  level: ThinkingLevel | null;
  disabled?: boolean;
  /** 每次打开菜单时向 pi 要一次可用档位（模型不同，档位可能不同） */
  onOpenLevels: () => Promise<ThinkingLevel[]>;
  onPick: (level: ThinkingLevel) => Promise<{ ok: boolean; error?: string }>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  /** 改档失败（pi 原文）；与“读不到档位列表”分开，避免互相覆盖 */
  const [pickError, setPickError] = useState("");
  const [pending, setPending] = useState<ThinkingLevel | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function load() {
    setState({ kind: "loading" });
    try {
      const list = await onOpenLevels();
      setState(list.length > 0 ? { kind: "ready", levels: list } : { kind: "empty" });
    } catch {
      // 不在界面里暴露 IPC 原文：这里只有“没问到”这一种可行动信息
      setState({ kind: "error" });
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setPickError("");
    void load();
  }

  async function pick(target: ThinkingLevel) {
    if (target === level || pending) return;
    setPending(target);
    setPickError("");
    try {
      const res = await onPick(target);
      if (res.ok) {
        setOpen(false);
      } else {
        setPickError(res.error ?? "切换失败");
      }
    } finally {
      setPending(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef?.current?.focus();
    }
  }

  const emptyText = level
    ? `当前模型没有可调档位（当前「${LEVEL_LABEL[level]}」）。换一个支持推理的模型即可调整。`
    : "还没有可用的推理档位：先选一个支持推理的模型。";

  return (
    <div className="thinking-picker" ref={box}>
      <button
        type="button"
        className="thinking-picker-trigger"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="推理强度：模型先想多久再答（越高越慢、越贵）"
        onClick={toggle}
      >
        {thinkingLabel(level)}
        <span className="thinking-picker-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="thinking-picker-menu" role="listbox" onKeyDown={onKeyDown}>
          <div className="thinking-picker-head">推理强度</div>
          <div className="thinking-picker-note">模型先想多久再答。越高越慢、越贵</div>

          {state.kind === "loading" && (
            <div className="thinking-picker-empty">正在读取可用档位…</div>
          )}

          {state.kind === "ready" &&
            state.levels.map((item) => (
              <button
                key={item}
                type="button"
                role="option"
                aria-selected={item === level}
                className={`thinking-picker-item ${item === level ? "selected" : ""}`}
                disabled={pending !== null}
                onClick={() => void pick(item)}
              >
                <span>{LEVEL_LABEL[item]}</span>
                {item === level && <span className="thinking-picker-check">✓</span>}
                {pending === item && <span className="thinking-picker-pending">…</span>}
              </button>
            ))}

          {state.kind === "empty" && <div className="thinking-picker-empty">{emptyText}</div>}

          {state.kind === "error" && (
            <div className="thinking-picker-empty">
              读取可用档位失败：pi 未响应或还没启动。
              <div>
                <button type="button" className="thinking-picker-retry" onClick={() => void load()}>
                  重试
                </button>
              </div>
            </div>
          )}

          {pickError && <div className="thinking-picker-error">{pickError}</div>}
        </div>
      )}
    </div>
  );
}
