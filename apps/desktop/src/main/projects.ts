/**
 * 项目的纯逻辑（修改五）。
 *
 * 侧栏要分两段：「项目」= 用户指定的文件夹工作区；「会话」= 没有文件夹的临时会话。
 * 后者落在 scratch 根，不算项目。这里只放不摸盘的规则，便于单测：
 * 名字怎么取、老数据怎么补成项目、加/删/重命名时顺序怎么保持。
 */
import { basename } from "node:path";

import { sessionKey } from "./session-registry.ts";

export interface ProjectRecord {
  /** 文件夹的绝对路径（身份） */
  root: string;
  /** 显示名：默认取文件夹名，可重命名 */
  name: string;
  createdAt: string;
  lastOpenedAt?: string;
}

/** 项目名：文件夹名；盘根（`D:\`）这种取不到就退回路径本身 */
export function projectNameOf(root: string): string {
  const cleaned = String(root ?? "").trim().replace(/[\\/]+$/, "");
  const name = basename(cleaned);
  return name && name !== cleaned ? name : cleaned || root;
}

function sameRoot(a: string, b: string): boolean {
  return sessionKey(a) === sessionKey(b);
}

/**
 * 把老数据补成项目表。
 *
 * 老版本只有 `recent: string[]`（路径），没有名字与创建时间。
 * 规则：先信 `projects`，再把 `recent` 里没登记过的补进来，跳过 scratch。
 * `changed` 告诉调用方要不要落盘——不做无谓的写。
 */
export function normalizeProjects(input: {
  projects?: ProjectRecord[];
  recent?: string[];
  scratchRoot: string;
  nowIso: string;
}): { projects: ProjectRecord[]; changed: boolean } {
  const scratch = String(input.scratchRoot ?? "");
  const out: ProjectRecord[] = [];
  let changed = false;

  for (const item of input.projects ?? []) {
    const root = String(item?.root ?? "").trim();
    if (!root) {
      changed = true;
      continue;
    }
    if (scratch && sameRoot(root, scratch)) {
      changed = true; // scratch 不该出现在项目里
      continue;
    }
    if (out.some((p) => sameRoot(p.root, root))) {
      changed = true;
      continue;
    }
    out.push({
      root,
      name: String(item?.name ?? "").trim() || projectNameOf(root),
      createdAt: item?.createdAt || input.nowIso,
      ...(item?.lastOpenedAt ? { lastOpenedAt: item.lastOpenedAt } : {}),
    });
  }

  for (const raw of input.recent ?? []) {
    const root = String(raw ?? "").trim();
    if (!root) continue;
    if (scratch && sameRoot(root, scratch)) continue;
    if (out.some((p) => sameRoot(p.root, root))) continue;
    out.push({ root, name: projectNameOf(root), createdAt: input.nowIso });
    changed = true;
  }

  return { projects: out, changed };
}

/** 打开/新建项目：已存在就只更新最近打开时间，不覆盖用户改过的名字 */
export function upsertProject(
  projects: ProjectRecord[],
  root: string,
  nowIso: string,
): ProjectRecord[] {
  const target = String(root ?? "").trim();
  if (!target) return projects;
  const index = projects.findIndex((p) => sameRoot(p.root, target));
  if (index >= 0) {
    return projects.map((p, i) => (i === index ? { ...p, lastOpenedAt: nowIso } : p));
  }
  return [
    ...projects,
    { root: target, name: projectNameOf(target), createdAt: nowIso, lastOpenedAt: nowIso },
  ];
}

/** 重命名：只改显示名，不动目录 */
export function renameProject(
  projects: ProjectRecord[],
  root: string,
  name: string,
): ProjectRecord[] {
  const next = String(name ?? "").trim().slice(0, 80);
  if (!next) return projects;
  return projects.map((p) => (sameRoot(p.root, root) ? { ...p, name: next } : p));
}

/** 移出列表（**不动磁盘**）：多选里删除项目走这条 */
export function forgetProjects(projects: ProjectRecord[], roots: string[]): ProjectRecord[] {
  const drop = new Set(roots.filter(Boolean).map((r) => sessionKey(r)));
  return projects.filter((p) => !drop.has(sessionKey(p.root)));
}
