/**
 * 记忆队列（ADR-046）：待确认 / 已采纳两份 jsonl，存应用数据目录。
 *
 * 为什么不放工作区：记忆里有项目约定与人的偏好，落进仓库会随 git 泄漏，
 * 也会被 `AGENTS.md` 那套“项目文件即指令”的权力面污染。
 *
 * 写入只有两条路：扩展的 memory_propose / skill_propose 追加 pending，
 * 以及这里 adopt / reject 的整份重写。都只动 pending / approved 两个文件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryItem, MemoryQueue } from "@oh-my-coding-pi/shared";

function pendingFile(dir: string): string {
  return join(dir, "pending.jsonl");
}

function approvedFile(dir: string): string {
  return join(dir, "approved.jsonl");
}

function readJsonl(file: string): MemoryItem[] {
  if (!existsSync(file)) return [];
  const out: MemoryItem[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as MemoryItem;
      if (parsed && typeof parsed.id === "string" && typeof parsed.ts === "string") out.push(parsed);
    } catch {
      // 坏行跳过：一行坏了不能让整份记忆失效
    }
  }
  return out;
}

function writeJsonl(file: string, entries: MemoryItem[]): void {
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
}

export function readMemoryQueue(dir: string): MemoryQueue {
  return { pending: readJsonl(pendingFile(dir)), approved: readJsonl(approvedFile(dir)) };
}

/** 采纳：从 pending 挪到 approved，并盖上 adoptedAt（注入时按时间排序）。 */
export function adoptMemory(dir: string, id: string): { ok: boolean; error?: string } {
  const pending = readJsonl(pendingFile(dir));
  const index = pending.findIndex((e) => e.id === id);
  if (index < 0) return { ok: false, error: "没有这条待确认记忆（可能已被采纳或忽略）" };
  const [entry] = pending.splice(index, 1);
  const adopted: MemoryItem = { ...entry, adoptedAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  appendFileSync(approvedFile(dir), JSON.stringify(adopted) + "\n", "utf8");
  writeJsonl(pendingFile(dir), pending);
  return { ok: true };
}

export function rejectMemory(dir: string, id: string): { ok: boolean; error?: string } {
  const pending = readJsonl(pendingFile(dir));
  const next = pending.filter((e) => e.id !== id);
  if (next.length === pending.length) return { ok: false, error: "没有这条待确认记忆" };
  writeJsonl(pendingFile(dir), next);
  return { ok: true };
}
