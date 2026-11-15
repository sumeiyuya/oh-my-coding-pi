import test from "node:test";
import assert from "node:assert/strict";

import { UI_DEFAULTS, UI_LIMITS, clampWidth, layoutPreset } from "../src/ui-state.ts";

/** 布局状态的纯逻辑（PR1）：宽度夹紧与模式预设。持久化本身在浏览器里，单测不碰 localStorage。 */

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

test("预设：四种模式都在合法区间内", () => {
  for (const mode of ["chat", "analysis", "focus", "notebook"] as const) {
    const p = layoutPreset(mode);
    assert.equal(clampWidth("sidebar", p.sidebarWidth), p.sidebarWidth, `${mode} 左栏越界`);
    assert.equal(clampWidth("dock", p.dockWidth), p.dockWidth, `${mode} 右坞越界`);
  }
});

test("预设：专注模式收起左栏且关右坞", () => {
  const p = layoutPreset("focus");
  assert.equal(p.collapsed, true);
  assert.equal(p.dockOpen, false);
});

test("预设：分析/笔记本模式右坞更宽，且都展开", () => {
  assert.ok(layoutPreset("analysis").dockWidth > layoutPreset("chat").dockWidth);
  assert.ok(layoutPreset("notebook").dockWidth >= layoutPreset("analysis").dockWidth);
  assert.equal(layoutPreset("analysis").dockOpen, true);
  assert.equal(layoutPreset("notebook").dockOpen, true);
});
