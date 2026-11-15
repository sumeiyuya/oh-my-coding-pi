/**
 * 工作区界面状态的持久化（PR1）。
 *
 * 纪律（借自 DAWN 的 state/sidebar.ts 与 state/right-dock.ts）：
 * - key 里显式写作用域：`.global.` —— 宽度不属于某段会话，也不属于某个项目；
 * - 只有「偏好」落盘：宽度、折叠、当前面板、布局模式；
 * - 「窗口此刻的样子」（右坞开/关）不落盘，重开回到默认。
 */

export type LayoutMode = "chat" | "analysis" | "focus" | "notebook";
export type DockTab = "files" | "notebook" | "artifacts" | "run";

export interface UiState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  dockWidth: number;
  dockTab: DockTab;
  layout: LayoutMode;
}

export const UI_LIMITS = {
  sidebar: { min: 240, max: 420 },
  dock: { min: 280, max: 520 },
  /** 正文保底宽度：两边加起来不能把主区压破这个数 */
  main: 420,
} as const;

export const UI_DEFAULTS: UiState = {
  sidebarWidth: 280,
  sidebarCollapsed: false,
  dockWidth: 320,
  dockTab: "files",
  layout: "chat",
};

const KEYS = {
  sidebarWidth: "omcp.global.sidebar-width",
  sidebarCollapsed: "omcp.global.sidebar-collapsed",
  dockWidth: "omcp.global.dock-width",
  dockTab: "omcp.global.dock-tab",
  layout: "omcp.global.layout-mode",
} as const;

const LAYOUTS: LayoutMode[] = ["chat", "analysis", "focus", "notebook"];
const TABS: DockTab[] = ["files", "notebook", "artifacts", "run"];

export function clampWidth(which: "sidebar" | "dock", value: number): number {
  const { min, max } = UI_LIMITS[which];
  const n = Number.isFinite(value) ? Math.round(value) : UI_DEFAULTS[`${which}Width` as const];
  return Math.max(min, Math.min(max, n));
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function loadUiState(): UiState {
  let layout: LayoutMode = UI_DEFAULTS.layout;
  let dockTab: DockTab = UI_DEFAULTS.dockTab;
  try {
    const rawLayout = localStorage.getItem(KEYS.layout) as LayoutMode | null;
    if (rawLayout && LAYOUTS.includes(rawLayout)) layout = rawLayout;
    const rawTab = localStorage.getItem(KEYS.dockTab) as DockTab | null;
    if (rawTab && TABS.includes(rawTab)) dockTab = rawTab;
  } catch {
    // 读不到就用默认
  }
  return {
    sidebarWidth: clampWidth("sidebar", readNumber(KEYS.sidebarWidth, UI_DEFAULTS.sidebarWidth)),
    sidebarCollapsed: readBool(KEYS.sidebarCollapsed, UI_DEFAULTS.sidebarCollapsed),
    dockWidth: clampWidth("dock", readNumber(KEYS.dockWidth, UI_DEFAULTS.dockWidth)),
    dockTab,
    layout,
  };
}

export function saveUiState(patch: Partial<UiState>): void {
  try {
    if (patch.sidebarWidth !== undefined) {
      localStorage.setItem(KEYS.sidebarWidth, String(clampWidth("sidebar", patch.sidebarWidth)));
    }
    if (patch.dockWidth !== undefined) {
      localStorage.setItem(KEYS.dockWidth, String(clampWidth("dock", patch.dockWidth)));
    }
    if (patch.sidebarCollapsed !== undefined) {
      localStorage.setItem(KEYS.sidebarCollapsed, patch.sidebarCollapsed ? "1" : "0");
    }
    if (patch.dockTab !== undefined) localStorage.setItem(KEYS.dockTab, patch.dockTab);
    if (patch.layout !== undefined) localStorage.setItem(KEYS.layout, patch.layout);
  } catch {
    // localStorage 不可用（隐私模式）：不写入，也不阻断界面
  }
}

/** 布局模式只是「宽度 + 展开状态」的预设，不引入第二套真实尺寸 */
export function layoutPreset(mode: LayoutMode): { sidebarWidth: number; dockWidth: number; collapsed: boolean; dockOpen: boolean } {
  switch (mode) {
    case "analysis":
      return { sidebarWidth: 240, dockWidth: 480, collapsed: false, dockOpen: true };
    case "focus":
      return { sidebarWidth: UI_DEFAULTS.sidebarWidth, dockWidth: UI_DEFAULTS.dockWidth, collapsed: true, dockOpen: false };
    case "notebook":
      return { sidebarWidth: 240, dockWidth: 520, collapsed: false, dockOpen: true };
    case "chat":
    default:
      return { sidebarWidth: 280, dockWidth: 320, collapsed: false, dockOpen: true };
  }
}
