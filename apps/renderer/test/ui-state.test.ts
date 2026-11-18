import test from "node:test";
import assert from "node:assert/strict";

import { UI_DEFAULTS, UI_LIMITS, clampWidth, loadUiState, saveUiState } from "../src/ui-state.ts";

/**
 * 界面状态的纯逻辑（PR1 / 2026-11-16）。
 *
 * 布局模式已删除，所以这里锁两件事：
 * 1. 宽度钳制没变；
 * 2. 旧键 `layout-mode` 只在第一次读取时换算成右坞开合，随后删除——不能把老用户弹一脸。
 */

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

function freshStorage(): MemoryStorage {
  const s = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
  return s;
}

test("左栏宽度：低于下限/高于上限都被夹住", () => {
  assert.equal(clampWidth("sidebar", 100), UI_LIMITS.sidebar.min);
  assert.equal(clampWidth("sidebar", 999), UI_LIMITS.sidebar.max);
  assert.equal(clampWidth("sidebar", 300), 300);
});

test("右坞宽度：280–520", () => {
  assert.equal(clampWidth("dock", 0), UI_LIMITS.dock.min);
  assert.equal(clampWidth("dock", 800), UI_LIMITS.dock.max);
  assert.equal(clampWidth("dock", 480), 480);
});

test("非数字输入回落到默认值", () => {
  assert.equal(clampWidth("sidebar", Number.NaN), UI_DEFAULTS.sidebarWidth);
  assert.equal(clampWidth("dock", Number.NaN), UI_DEFAULTS.dockWidth);
});

test("没有旧键时：右坞默认展开", () => {
  freshStorage();
  assert.equal(loadUiState().dockOpen, true);
});

test("旧“专注”迁移成“右坞收起”，并删掉旧键", () => {
  const s = freshStorage();
  s.setItem("omcp.global.layout-mode", "focus");
  const ui = loadUiState();
  assert.equal(ui.dockOpen, false);
  assert.equal(s.getItem("omcp.global.layout-mode"), null);
});

test("旧“笔记本优先”迁移成“右坞展开”", () => {
  const s = freshStorage();
  s.setItem("omcp.global.layout-mode", "notebook");
  assert.equal(loadUiState().dockOpen, true);
  assert.equal(s.getItem("omcp.global.layout-mode"), null);
});

test("新键优先于旧键（迁移不覆盖用户当前状态）", () => {
  const s = freshStorage();
  s.setItem("omcp.global.layout-mode", "chat");
  s.setItem("omcp.global.dock-open", "0");
  assert.equal(loadUiState().dockOpen, false);
});

test("saveUiState 写入 dockOpen，再读回来一致", () => {
  const s = freshStorage();
  saveUiState({ dockOpen: false });
  assert.equal(s.getItem("omcp.global.dock-open"), "0");
  assert.equal(loadUiState().dockOpen, false);
  saveUiState({ dockOpen: true });
  assert.equal(loadUiState().dockOpen, true);
});

test("保存时宽度仍然被钳制", () => {
  const s = freshStorage();
  saveUiState({ sidebarWidth: 10, dockWidth: 9999 });
  assert.equal(s.getItem("omcp.global.sidebar-width"), String(UI_LIMITS.sidebar.min));
  assert.equal(s.getItem("omcp.global.dock-width"), String(UI_LIMITS.dock.max));
});

test("修改3：旧左栏折叠键被删除，状态里不再有 sidebarCollapsed", () => {
  const s = freshStorage();
  s.setItem("omcp.global.sidebar-collapsed", "1");
  const ui = loadUiState();
  assert.equal((ui as Record<string, unknown>).sidebarCollapsed, undefined);
  assert.equal(s.getItem("omcp.global.sidebar-collapsed"), null);
});

test("展开的工作区分组可保存/读回", () => {
  const s = freshStorage();
  saveUiState({ expandedWorkspaces: ["D:\a", "D:\b"] });
  assert.deepEqual(loadUiState().expandedWorkspaces, ["D:\a", "D:\b"]);
  s.setItem("omcp.global.expanded-workspaces", "not json");
  assert.deepEqual(loadUiState().expandedWorkspaces, []);
});
