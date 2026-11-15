import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PersistentGrant } from "@oh-my-coding-pi/shared";

interface GrantsFile {
  version: 1;
  grants: PersistentGrant[];
}

/** 授权按「工作区 + 规则 id」记录（ADR-006），不按完整命令。 */
export class GrantStore {
  private grants: PersistentGrant[] = [];
  private session = new Set<string>();

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  /** 规范化后的工作区路径哈希：切目录即失效，避免跨项目复用授权 */
  static workspaceId(root: string): string {
    const normalized = resolve(root || ".").replace(/\\/g, "/").toLowerCase();
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  private key(workspaceId: string, ruleId: string): string {
    return workspaceId + "|" + ruleId;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as GrantsFile;
      if (Array.isArray(raw.grants)) {
        this.grants = raw.grants.filter(
          (g) => g && typeof g.workspaceId === "string" && typeof g.ruleId === "string",
        );
      }
    } catch {
      this.grants = [];
    }
  }

  private save(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const payload: GrantsFile = { version: 1, grants: this.grants };
    writeFileSync(this.file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }

  /** 会话级授权：进程内，不落盘 */
  grantSession(workspaceRoot: string, ruleId: string, sessionKey: string): void {
    this.session.add(this.key(GrantStore.workspaceId(workspaceRoot), ruleId) + "|" + sessionKey);
  }

  /** 持久授权：落 appData/grants.json，可过期 */
  grantPersistent(workspaceRoot: string, ruleId: string, ttlDays = 0): PersistentGrant {
    const now = new Date();
    const grant: PersistentGrant = {
      id: randomBytes(6).toString("hex"),
      workspaceId: GrantStore.workspaceId(workspaceRoot),
      ruleId,
      createdAt: now.toISOString(),
    };
    if (ttlDays > 0) {
      grant.expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
    }
    this.grants = this.grants.filter(
      (g) => !(g.workspaceId === grant.workspaceId && g.ruleId === grant.ruleId),
    );
    this.grants.push(grant);
    this.save();
    return grant;
  }

  has(workspaceRoot: string, ruleId: string, sessionKey: string): boolean {
    const workspaceId = GrantStore.workspaceId(workspaceRoot);
    if (this.session.has(this.key(workspaceId, ruleId) + "|" + sessionKey)) return true;
    const now = Date.now();
    return this.grants.some(
      (g) =>
        g.workspaceId === workspaceId &&
        g.ruleId === ruleId &&
        (!g.expiresAt || Date.parse(g.expiresAt) > now),
    );
  }

  list(workspaceRoot?: string): PersistentGrant[] {
    const now = Date.now();
    return this.grants.filter(
      (g) =>
        (!workspaceRoot || g.workspaceId === GrantStore.workspaceId(workspaceRoot)) &&
        (!g.expiresAt || Date.parse(g.expiresAt) > now),
    );
  }

  revoke(id: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => g.id !== id);
    if (this.grants.length !== before) this.save();
    return this.grants.length !== before;
  }

  revokeRule(workspaceRoot: string, ruleId: string): void {
    const workspaceId = GrantStore.workspaceId(workspaceRoot);
    this.grants = this.grants.filter(
      (g) => !(g.workspaceId === workspaceId && g.ruleId === ruleId),
    );
    for (const key of [...this.session]) {
      if (key.startsWith(this.key(workspaceId, ruleId) + "|")) this.session.delete(key);
    }
    this.save();
  }

  clearSession(): void {
    this.session.clear();
  }

  clear(): void {
    this.grants = [];
    this.session.clear();
    this.save();
  }

  /** 清掉过期条目，返回清理数量 */
  prune(): number {
    const now = Date.now();
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => !g.expiresAt || Date.parse(g.expiresAt) > now);
    const removed = before - this.grants.length;
    if (removed > 0) this.save();
    return removed;
  }
}
