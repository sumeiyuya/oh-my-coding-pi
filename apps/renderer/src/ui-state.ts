/**
 * 工作区界面状态的持久化（PR1）。
 *
 * 纪律（借自 DAWN 的 state/sidebar.ts 与 state/right-dock.ts）：
 * - key 里显式写作用域：`.global.` —— 宽度不属于某段会话，也不属于某个项目；
 * - 只有「偏好」落盘：宽度、折叠、当前面板、右坞开合；
 * - 2026-11-16 起没有「布局模式」：四个预设删掉了，右坞开合变成自己的偏好。
 *   旧键 `omcp.global.layout-mode` 只在第一次读取时用来换算开合，随后删除。
 */

export type DockTab = "files" | "notebook" | "artifacts" | "run";

export interface UiState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  dockWidth: number;
  dockTab: DockTab;
  dockOpen: boolean;
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
  dockOpen: true,
};

const KEYS = {
  sidebarWidth: "omcp.global.sidebar-width",
  sidebarCollapsed: "omcp.global.sidebar-collapsed",
  dockWidth: "omcp.global.dock-width",
  dockTab: "omcp.global.dock-tab",
  dockOpen: "omcp.global.dock-open",
} as const;

/** 旧版布局模式；只读一次，读完即删 */
const LEGACY_LAYOUT_KEY = "omcp.global.layout-mode";

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
  let dockTab: DockTab = UI_DEFAULTS.dockTab;
  // 旧模式的语义只保留“开/合”这一半：尺寸本来就是分开存的，不需要重算
  let legacyDockOpen: boolean | null = null;
  try {
    const rawTab = localStorage.getItem(KEYS.dockTab) as DockTab | null;
    if (rawTab && TABS.includes(rawTab)) dockTab = rawTab;
    const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (legacy !== null) {
      if (localStorage.getItem(KEYS.dockOpen) === null) legacyDockOpen = legacy !== "focus";
      localStorage.removeItem(LEGACY_LAYOUT_KEY);
    }
  } catch {
    // 读不到就用默认
  }
  return {
    sidebarWidth: clampWidth("sidebar", readNumber(KEYS.sidebarWidth, UI_DEFAULTS.sidebarWidth)),
    sidebarCollapsed: readBool(KEYS.sidebarCollapsed, UI_DEFAULTS.sidebarCollapsed),
    dockWidth: clampWidth("dock", readNumber(KEYS.dockWidth, UI_DEFAULTS.dockWidth)),
    dockTab,
    dockOpen: readBool(KEYS.dockOpen, legacyDockOpen ?? UI_DEFAULTS.dockOpen),
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
    if (patch.dockOpen !== undefined) localStorage.setItem(KEYS.dockOpen, patch.dockOpen ? "1" : "0");
  } catch {
    // localStorage 不可用（隐私模式）：不写入，也不阻断界面
  }
}
