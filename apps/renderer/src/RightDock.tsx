import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DockTab } from "./ui-state";

/**
 * 右坞（修改3，参照 DAWN）：
 * - 顶部是标签条 + `⋯` 更多 + `×` 关闭；
 * - 关闭后不保留 40px 图标条，主区占满；顶栏「面板：X」负责重新打开；
 * - 面板只藏不卸，笔记本只能存在一份。
 */

const TABS: Array<{ id: DockTab; label: string; hint: string }> = [
  { id: "files", label: "文件", hint: "浏览工作区（只读）" },
  { id: "notebook", label: "笔记本", hint: "Python / R 单元格" },
  { id: "artifacts", label: "产物", hint: "账本 + figures/ 与 results/" },
  { id: "run", label: "运行", hint: "内核、方案门与本次会话" },
];

export default function RightDock({
  open,
  tab,
  onTab,
  onClose,
  onResetWidth,
  counts,
  files,
  notebook,
  artifacts,
  run,
}: {
  open: boolean;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onClose: () => void;
  onResetWidth: () => void;
  /** 可选：标签上的数量（例如「产物 54」） */
  counts?: Partial<Record<DockTab, number>>;
  files: ReactNode;
  notebook: ReactNode;
  artifacts: ReactNode;
  run: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) setMenu(false);
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.parentElement?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(false);
        moreRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <aside
      id="right-dock"
      className={`dock ${open ? "" : "dock-collapsed"}`}
      aria-label="工作坞"
      aria-hidden={!open}
    >
      <div className="dock-head">
        <div className="dock-tabs" role="tablist" aria-label="工作坞面板">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              title={t.hint}
              className={tab === t.id ? "active" : ""}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {counts?.[t.id] !== undefined && (
                <span className="dock-count">{counts[t.id]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="dock-head-actions">
          <button
            ref={moreRef}
            type="button"
            className="dock-icon"
            aria-label="更多"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            ⋯
          </button>
          <button type="button" className="dock-icon" aria-label="关闭面板" onClick={onClose}>
            ×
          </button>
          {menu && (
            <div className="dock-menu" role="menu" aria-label="面板操作">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onResetWidth();
                }}
              >
                重置面板宽度
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onClose();
                }}
              >
                关闭面板
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="dock-body" style={{ display: tab === "files" ? undefined : "none" }}>
        {files}
      </div>
      <div className="dock-body" style={{ display: tab === "artifacts" ? undefined : "none" }}>
        {artifacts}
      </div>
      <div className="dock-body" style={{ display: tab === "run" ? undefined : "none" }}>
        {run}
      </div>
      <div className="dock-body dock-nb" style={{ display: tab === "notebook" ? undefined : "none" }}>
        {notebook}
      </div>
    </aside>
  );
}
