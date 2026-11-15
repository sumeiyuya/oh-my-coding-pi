import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 可拖的分隔条（PR1）。
 *
 * 借自 DAWN 的 `sash.tsx`：
 * - **命中区 4px、可见 1px**：看得见的那条细，能抓住的那条粗（Fitts 定律）；
 * - 它是 `separator` 而不是按钮：可聚焦，←/→ 每次 16px，Shift 64px——
 *   「看不见的能力等于不存在」，只给拖等于对键盘用户不存在；
 * - 拖动过程只改界面（`onChange`），抬手/取消才落盘（`onCommit`）。
 */

const STEP = 16;
const STEP_FAST = 64;

export default function Sash({
  side,
  width,
  min,
  max,
  onChange,
  onCommit,
  label,
}: {
  /** left = 侧栏在左（往右拖变宽）；right = 右坞在右（往左拖变宽） */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  onCommit: (next: number) => void;
  label: string;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });
  const latest = useRef(width);

  useEffect(() => {
    latest.current = width;
  }, [width]);

  const clamp = useCallback((n: number) => Math.max(min, Math.min(max, Math.round(n))), [min, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, width };
    latest.current = width;
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const dx = e.clientX - start.current.x;
    const next = clamp(start.current.width + (side === "left" ? dx : -dx));
    latest.current = next;
    onChange(next);
  };

  const endDrag = (commit: boolean) => {
    if (!dragging) return;
    setDragging(false);
    if (commit) onCommit(latest.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_FAST : STEP;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const next = clamp(width + (e.key === grow ? step : -step));
    latest.current = next;
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      className={`sash ${side} ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label}（拖动或 ←/→ 调整）`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(true)}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        const reset = side === "left" ? 280 : 320;
        onChange(clamp(reset));
        onCommit(clamp(reset));
      }}
    />
  );
}
