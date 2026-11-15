import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RouteDoc, RouteEvidence, RouteStatus, RouteStep } from "@oh-my-coding-pi/shared";

const STATUS: RouteStatus[] = ["todo", "doing", "done", "blocked"];
const EVIDENCE: RouteEvidence[] = ["none", "limited", "strong"];

export function routeFile(workspaceRoot: string): string {
  return join(workspaceRoot, ".omcp", "route.json");
}

export function emptyRoute(): RouteDoc {
  return { version: 1, updatedAt: new Date().toISOString(), steps: [] };
}

export function validateRoute(raw: unknown): { doc: RouteDoc; errors: string[] } {
  const errors: string[] = [];
  const base = emptyRoute();
  if (!raw || typeof raw !== "object") return { doc: base, errors: ["route 必须是 JSON 对象"] };
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) errors.push("version 必须是 1");
  const steps: RouteStep[] = [];
  if (Array.isArray(obj.steps)) {
    obj.steps.forEach((item, i) => {
      if (!item || typeof item !== "object") {
        errors.push(`steps[${i}] 必须是对象`);
        return;
      }
      const s = item as Record<string, unknown>;
      const status = String(s.status ?? "todo") as RouteStatus;
      const evidence = String(s.evidence ?? "none") as RouteEvidence;
      if (!STATUS.includes(status)) errors.push(`steps[${i}].status 非法：${status}`);
      if (!EVIDENCE.includes(evidence)) errors.push(`steps[${i}].evidence 非法：${evidence}`);
      steps.push({
        id: String(s.id ?? `s${i + 1}`),
        title: String(s.title ?? ""),
        purpose: String(s.purpose ?? ""),
        inputs: String(s.inputs ?? ""),
        outputs: String(s.outputs ?? ""),
        status: STATUS.includes(status) ? status : "todo",
        evidence: EVIDENCE.includes(evidence) ? evidence : "none",
      });
    });
  } else if (obj.steps !== undefined) {
    errors.push("steps 必须是数组");
  }
  return {
    doc: { version: 1, updatedAt: String(obj.updatedAt ?? base.updatedAt), steps },
    errors,
  };
}

export function loadRoute(workspaceRoot: string): { doc: RouteDoc; errors: string[]; exists: boolean } {
  const file = routeFile(workspaceRoot);
  if (!existsSync(file)) return { doc: emptyRoute(), errors: [], exists: false };
  try {
    return { ...validateRoute(JSON.parse(readFileSync(file, "utf8"))), exists: true };
  } catch (err) {
    return { doc: emptyRoute(), errors: ["读取失败：" + (err as Error).message], exists: true };
  }
}

/** 原子写：先写 .tmp 再 rename，掉电/并发不会留半个文件 */
export function saveRoute(workspaceRoot: string, raw: unknown): { ok: boolean; errors: string[]; doc: RouteDoc } {
  const { doc, errors } = validateRoute(raw);
  if (errors.length) return { ok: false, errors, doc };
  const file = routeFile(workspaceRoot);
  mkdirSync(dirname(file), { recursive: true });
  const next: RouteDoc = { ...doc, version: 1, updatedAt: new Date().toISOString() };
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return { ok: true, errors: [], doc: next };
}

const STATUS_LABEL: Record<RouteStatus, string> = {
  todo: "待办",
  doing: "进行中",
  done: "完成",
  blocked: "阻塞",
};
const EVIDENCE_LABEL: Record<RouteEvidence, string> = {
  none: "无",
  limited: "有限",
  strong: "较强",
};

export function routeToMarkdown(doc: RouteDoc, workspaceRoot: string): string {
  const lines = [
    "# 分析路线",
    "",
    `- 导出时间：${new Date().toISOString()}`,
    `- 工作区：${workspaceRoot}`,
    `- 步骤数：${doc.steps.length}`,
    "",
    "| # | 步骤 | 目的 | 输入 | 产出 | 状态 | 证据 |",
    "|---|---|---|---|---|---|---|",
  ];
  doc.steps.forEach((s, i) => {
    const out = s.outputs
      ? s.outputs
          .split(/[,;\\s]+/)
          .filter(Boolean)
          .map((p) => {
            const abs = p.includes(":") || p.startsWith("/") ? p : join(workspaceRoot, p);
            return existsSync(abs) ? p : `${p}（缺失）`;
          })
          .join("<br>")
      : "—";
    lines.push(
      `| ${i + 1} | ${s.title} | ${s.purpose} | ${s.inputs || "—"} | ${out} | ${STATUS_LABEL[s.status]} | ${EVIDENCE_LABEL[s.evidence]} |`,
    );
  });
  lines.push("", "> 本表由作者手动维护，不是自动推断；证据档位仅表示“有无产物与复核”。", "");
  return lines.join("\n");
}

export function exportRoute(workspaceRoot: string): { path: string | null; error?: string } {
  const { doc, errors } = loadRoute(workspaceRoot);
  if (errors.length) return { path: null, error: errors.join("；") };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(workspaceRoot, "results", "reports", `route-${stamp}.md`);
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, routeToMarkdown(doc, workspaceRoot), "utf8");
    return { path: out };
  } catch (err) {
    return { path: null, error: (err as Error).message };
  }
}

/** 方案文件的绝对路径（调用方先确保路径合法） */
export function planAbsPath(workspaceRoot: string, planPath: string): string {
  const normalized = planPath.replace(/\\\\/g, "/");
  return normalized.includes(":") || normalized.startsWith("/") ? normalized : join(workspaceRoot, normalized);
}

/** 方案文件必须落在 .omcp/plans/ 下，避免“批准任意文件” */
export function isValidPlanPath(workspaceRoot: string, planPath: string): boolean {
  if (!planPath) return false;
  const normalized = planPath.replace(/\\\\/g, "/");
  if (!normalized.includes(".omcp/plans/")) return false;
  try {
    return statSync(planAbsPath(workspaceRoot, planPath)).isFile();
  } catch {
    return false;
  }
}
