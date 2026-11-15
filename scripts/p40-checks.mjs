#!/usr/bin/env node
/**
 * P4.0 检查：审计筛选/分页 + 授权期限与撤销。
 * 用法：node scripts/p40-checks.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../apps/desktop/src/main/audit.ts";
import { GrantStore } from "../apps/desktop/src/main/grants.ts";

const dir = mkdtempSync(join(tmpdir(), "omcp-p40-"));
const auditFile = join(dir, "audit.jsonl");
const grantsFile = join(dir, "grants.json");
const failures = [];

function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : " (期望 " + JSON.stringify(wanted) + ")"}`);
  if (!ok) failures.push(label);
}

/* ---------------- 审计 ---------------- */
const log = new AuditLog(() => auditFile);
for (let i = 0; i < 250; i++) {
  log.write({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    toolName: i % 3 === 0 ? "bash" : i % 3 === 1 ? "run_code" : "write",
    ruleId: i % 5 === 0 ? "cmd:deny:0" : "default",
    decision: i % 4 === 0 ? "deny" : "allow",
    scope: "policy",
    summary: `case-${i} token=abcdefgh`,
  });
}

const all = log.query({ limit: 10, offset: 0 });
expect("审计总数", all.total, 250);
expect("首页条数", all.items.length, 10);
expect("倒序（最新在前）", all.items[0].summary.startsWith("case-249"), true);

const page2 = log.query({ limit: 10, offset: 240 });
expect("末页条数", page2.items.length, 10);
expect("越界页", log.query({ limit: 10, offset: 900 }).items.length, 0);

const bashOnly = log.query({ tool: "bash", limit: 500 });
expect("按工具筛选计数", bashOnly.total, 84);
const denies = log.query({ decision: "deny", limit: 500 });
expect("按决定筛选计数", denies.total, 63);
const search = log.query({ q: "case-42 ", limit: 500 });
expect("摘要搜索命中", search.total, 1);
expect("脱敏：token 被替换", /abcdefgh/.test(all.items[0].summary), false);

/* ---------------- 授权 ---------------- */
const store = new GrantStore(grantsFile);
const root = "D:/tmp/project-a";
const rootB = "D:/tmp/project-b";

const permanent = store.grantPersistent(root, "cmd:ask:0", 0);
expect("永久授权无过期时间", permanent.expiresAt ?? null, null);
expect("永久授权生效", store.has(root, "cmd:ask:0", "s1"), true);

const seven = store.grantPersistent(root, "cmd:ask:1", 7);
const days = (Date.parse(seven.expiresAt) - Date.parse(seven.createdAt)) / 86_400_000;
expect("7 天期限", Math.round(days), 7);

store.grantSession(root, "script:danger", "session-1");
expect("会话授权生效", store.has(root, "script:danger", "session-1"), true);
expect("会话授权不跨会话", store.has(root, "script:danger", "session-2"), false);

expect("跨工作区不生效", store.has(rootB, "cmd:ask:0", "s1"), false);

store.revoke(permanent.id);
expect("撤销后失效", store.has(root, "cmd:ask:0", "s1"), false);

// 注入一条过期记录，验证 prune
const raw = JSON.parse(readFileSync(grantsFile, "utf8"));
raw.grants.push({
  id: "expired1",
  workspaceId: GrantStore.workspaceId(root),
  ruleId: "cmd:ask:9",
  createdAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2020-01-02T00:00:00.000Z",
});
writeFileSync(grantsFile, JSON.stringify(raw, null, 2), "utf8");
const store2 = new GrantStore(grantsFile);
expect("过期授权不生效", store2.has(root, "cmd:ask:9", "s1"), false);
expect("清理条数", store2.prune(), 1);
expect("清理后文件可读", existsSync(grantsFile), true);

rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join("；")}` : "\nP4.0 检查全部通过");
process.exit(failures.length ? 1 : 0);
