import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SessionMetaEntry, SessionMetaResult } from "@oh-my-coding-pi/shared";

const TITLE_MAX = 80;

export function sessionMetaPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".omcp", "session-meta.json");
}

/** 只接受会话文件名。绝对路径先取 basename，拒绝 `..` 和路径分隔符。 */
export function sessionMetaKey(file: string): string | null {
  const base = basename(String(file ?? ""));
  if (!base || base.length > 180 || base.includes("..")) return null;
  if (!/^[\w.-]+\.jsonl$/i.test(base)) return null;
  return base;
}

function emptyMeta(): SessionMetaResult {
  return { version: 1, sessions: {} };
}

function entryOf(raw: unknown): SessionMetaEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const entry: SessionMetaEntry = {};
  if (typeof obj.title === "string") {
    const title = obj.title.replace(/[\r\n\t]/g, " ").trim().slice(0, TITLE_MAX);
    if (title) entry.title = title;
  }
  if (obj.archived === true) entry.archived = true;
  if (typeof obj.lastOpenedAt === "string" && !Number.isNaN(Date.parse(obj.lastOpenedAt))) {
    entry.lastOpenedAt = obj.lastOpenedAt;
  }
  if (
    obj.permissionMode === "deny-risky" ||
    obj.permissionMode === "ask-risky" ||
    obj.permissionMode === "allow-all"
  ) {
    entry.permissionMode = obj.permissionMode;
  }
  if (!entry.title && !entry.archived && !entry.lastOpenedAt && !entry.permissionMode) return null;
  return entry;
}

export function loadSessionMeta(workspaceRoot: string): SessionMetaResult {
  const file = sessionMetaPath(workspaceRoot);
  if (!existsSync(file)) return emptyMeta();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { ...emptyMeta(), ignored: true };
    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1 || !obj.sessions || typeof obj.sessions !== "object" || Array.isArray(obj.sessions)) {
      return { ...emptyMeta(), ignored: true };
    }
    const sessions: Record<string, SessionMetaEntry> = {};
    for (const [key, value] of Object.entries(obj.sessions as Record<string, unknown>)) {
      if (sessionMetaKey(key) !== key) continue;
      const entry = entryOf(value);
      if (entry) sessions[key] = entry;
    }
    return { version: 1, sessions };
  } catch {
    return { ...emptyMeta(), ignored: true };
  }
}

function writeMeta(workspaceRoot: string, doc: SessionMetaResult): { ok: boolean; error?: string } {
  try {
    const file = sessionMetaPath(workspaceRoot);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: doc.sessions }, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function patchSessionMeta(
  workspaceRoot: string,
  sessionFile: string,
  patch: {
    title?: string;
    archived?: boolean;
    lastOpenedAt?: string;
    permissionMode?: SessionMetaEntry["permissionMode"] | null;
  },
): { ok: boolean; error?: string } {
  const key = sessionMetaKey(sessionFile);
  if (!key) return { ok: false, error: "会话文件名不合法" };
  const loaded = loadSessionMeta(workspaceRoot);
  if (loaded.ignored) return { ok: false, error: "session-meta.json 已损坏，未覆盖" };
  const next: SessionMetaEntry = { ...(loaded.sessions[key] ?? {}) };
  if ("title" in patch) {
    const title = String(patch.title ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, TITLE_MAX);
    if (title) next.title = title;
    else delete next.title;
  }
  if ("archived" in patch) {
    if (patch.archived) next.archived = true;
    else delete next.archived;
  }
  if (patch.lastOpenedAt && !Number.isNaN(Date.parse(patch.lastOpenedAt))) {
    next.lastOpenedAt = patch.lastOpenedAt;
  }
  if ("permissionMode" in patch) {
    const mode = patch.permissionMode;
    if (mode === "deny-risky" || mode === "ask-risky" || mode === "allow-all") next.permissionMode = mode;
    else delete next.permissionMode;
  }
  const sessions = { ...loaded.sessions };
  if (!next.title && !next.archived && !next.lastOpenedAt && !next.permissionMode) delete sessions[key];
  else sessions[key] = next;
  return writeMeta(workspaceRoot, { version: 1, sessions });
}
