import test from "node:test";
import assert from "node:assert/strict";

import {
  forgetProjects,
  normalizeProjects,
  projectNameOf,
  renameProject,
  upsertProject,
} from "../src/main/projects.ts";

/** 修改五：项目表的纯逻辑（老数据迁移、加/删/改名、scratch 不算项目）。 */

const NOW = "2026-11-27T12:00:00.000Z";
const SCRATCH = "C:/Users/u/AppData/Roaming/oh-my-coding-pi/scratch";

test("项目名：取文件夹名，盘根退回路径本身", () => {
  assert.equal(projectNameOf("D:/desktop/lab-a"), "lab-a");
  assert.equal(projectNameOf("D:/desktop/lab-a/"), "lab-a");
  assert.equal(projectNameOf("D:/"), "D:");
});

test("老数据只有 recent → 补成项目，名字取文件夹名", () => {
  const { projects, changed } = normalizeProjects({
    recent: ["D:/a", "D:/b"],
    scratchRoot: SCRATCH,
    nowIso: NOW,
  });
  assert.equal(changed, true);
  assert.deepEqual(projects.map((p) => p.name), ["a", "b"]);
  assert.equal(projects[0]?.createdAt, NOW);
});

test("已有 projects 时保留名字与创建时间，只补缺的 recent", () => {
  const { projects, changed } = normalizeProjects({
    projects: [{ root: "D:/a", name: "我的项目", createdAt: "2026-01-01T00:00:00.000Z" }],
    recent: ["D:/a", "D:/b"],
    scratchRoot: SCRATCH,
    nowIso: NOW,
  });
  assert.equal(changed, true);
  assert.equal(projects.length, 2);
  assert.equal(projects[0]?.name, "我的项目", "用户改过的名字不能被覆盖");
  assert.equal(projects[0]?.createdAt, "2026-01-01T00:00:00.000Z");
});

test("scratch 永远不算项目（哪怕在 recent 里）", () => {
  const { projects } = normalizeProjects({
    recent: [SCRATCH, "D:/a"],
    scratchRoot: SCRATCH,
    nowIso: NOW,
  });
  assert.deepEqual(projects.map((p) => p.root), ["D:/a"]);
});

test("重复路径只留一条（大小写不敏感）", () => {
  const { projects } = normalizeProjects({
    projects: [{ root: "D:/Lab", name: "Lab", createdAt: NOW }],
    recent: ["d:/lab"],
    scratchRoot: SCRATCH,
    nowIso: NOW,
  });
  assert.equal(projects.length, 1);
});

test("upsert：已存在只更新最近打开时间，不改名字", () => {
  const base = [{ root: "D:/a", name: "手改名", createdAt: "2026-01-01T00:00:00.000Z" }];
  const next = upsertProject(base, "D:/a", NOW);
  assert.equal(next[0]?.name, "手改名");
  assert.equal(next[0]?.lastOpenedAt, NOW);
  assert.equal(next.length, 1);
});

test("upsert：新项目追加在后面", () => {
  const next = upsertProject([], "D:/b", NOW);
  assert.deepEqual(next.map((p) => p.name), ["b"]);
  assert.equal(next[0]?.createdAt, NOW);
});

test("rename：只改显示名；空名忽略", () => {
  const base = [{ root: "D:/a", name: "a", createdAt: NOW }];
  assert.equal(renameProject(base, "D:/a", "新名字")[0]?.name, "新名字");
  assert.equal(renameProject(base, "D:/a", "   ")[0]?.name, "a");
});

test("forget：移出列表但不碰磁盘（只改表）", () => {
  const base = [
    { root: "D:/a", name: "a", createdAt: NOW },
    { root: "D:/b", name: "b", createdAt: NOW },
  ];
  assert.deepEqual(forgetProjects(base, ["D:/a"]).map((p) => p.name), ["b"]);
  assert.deepEqual(forgetProjects(base, ["d:/A"]).map((p) => p.name), ["b"], "大小写不敏感");
});
