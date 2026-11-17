import type { ReactNode } from "react";
import type { DockTab } from "./ui-state";

/**
 * 右坞（PR2）：从「一个开关」变成「一组房客」。
 *
 * 借自 DAWN 的 `state/right-dock.ts`：
 * - 房客（文件 / 笔记本 / 产物 / 运行）各自独立，切换只改当前房客；
 * - 坞不随左侧视图（对话/路线/设置）收起——"一边看设置一边看图"是成立的动线；
 * - 收起后右侧留下 40px 图标条：点哪个房客就以它展开（2026-11-16，无布局模式后）；
 * - 面板只藏不卸，笔记本只能存在一份。
 */

const TABS: Array<{ id: DockTab; label: string; hint: string; icon: string }> = [
  { id: "files", label: "文件", hint: "浏览工作区（只读）", icon: "文" },
  { id: "notebook", label: "笔记本", hint: "Python / R 单元格", icon: "记" },
  { id: "artifacts", label: "产物", hint: "账本 + figures/ 与 results/", icon: "产" },
  { id: "run", label: "运行", hint: "内核、方案门与本次会话", icon: "运" },
];

export default function RightDock({
  open,
  tab,
  onTab,
  onOpen,
  files,
  notebook,
  artifacts,
  run,
}: {
  open: boolean;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onOpen: () => void;
  files: ReactNode;
  notebook: ReactNode;
  artifacts: ReactNode;
  run: ReactNode;
}) {
  return (
    <aside className={`dock ${open ? "" : "dock-collapsed"}`} aria-label="工作坞">
      {!open && (
        <div className="dock-rail" role="tablist" aria-label="工作坞面板">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              title={open ? t.hint : `${t.label}：${t.hint}`}
              className={tab === t.id ? "active" : ""}
              onClick={() => {
                onTab(t.id);
                onOpen();
              }}
            >
              {t.icon}
            </button>
          ))}
        </div>
      )}
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
          </button>
        ))}
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
