#!/usr/bin/env node
/**
 * P4.2 检查：诊断包（ZIP 结构 + 脱敏）。
 * 用法：node scripts/p42-checks.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnosticZip } from "../apps/desktop/src/main/diagnostics.ts";

const dir = mkdtempSync(join(tmpdir(), "omcp-p42-"));
const failures = [];
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
  if (!ok) failures.push(label);
}

const zipPath = buildDiagnosticZip(
  {
    version: "0.4.0",
    pi: {
      origin: "bundled",
      entry: "C:/app/resources/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      expected: "1.5.2",
      actual: "1.5.2",
      configDir: "C:/Users/tester/.pi/agent",
      isolated: false,
      systemPath: "C:/npm/pi.cmd",
      systemVersion: "0.86.1",
    },
    electron: "45.3.0",
    chrome: "140.0.0.0",
    node: "22.0.0",
    platform: "win32",
    arch: "x64",
    workspace: "D:/tmp/project",
    policy: { mode: "ask", source: "default", path: null, errors: [] },
    grants: 2,
    auditEntries: 7,
    settings: {
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      apiKey: "sk-live-abcdefghijklmn",
      authToken: "bearer abcdefghijklmnop",
    },
    pythonPath: "python",
    rKernel: "sci-ir (Rterm.exe)",
    auditTail: [
      {
        ts: "2026-11-12T00:00:00.000Z",
        toolName: "bash",
        ruleId: "cmd:deny:0",
        decision: "deny",
        scope: "policy",
        summary: "case-1 token=abcdefgh",
      },
    ],
    appLogTail: "error: Authorization: Bearer abcdefghijklmnop\nnormal line\n",
  },
  dir,
);

expect("生成 zip", existsSync(zipPath), true);
const head = readFileSync(zipPath).subarray(0, 4).toString("hex");
expect("ZIP 魔数", head, "504b0304");

// 用系统解压验证（证明不是伪 zip）
const expanded = join(dir, "expanded");
execFileSync("powershell", [
  "-NoProfile",
  "-Command",
  `Expand-Archive -Path '${zipPath}' -DestinationPath '${expanded}' -Force`,
]);
expect("解压出 manifest", existsSync(join(expanded, "manifest.json")), true);
expect("解压出 diagnostic", existsSync(join(expanded, "diagnostic.md")), true);
expect("解压出审计尾部", existsSync(join(expanded, "audit-tail.jsonl")), true);

const settingsText = readFileSync(join(expanded, "settings.json"), "utf8");
expect("设置里 apiKey 被脱敏", /sk-live-abcdefghijklmn/.test(settingsText), false);
expect("设置里 authToken 被置空", /abcdefghijklmnop/.test(settingsText), false);

const diagText = readFileSync(join(expanded, "diagnostic.md"), "utf8");
expect("诊断包含版本", diagText.includes("0.4.0"), true);
expect("诊断包含策略模式", diagText.includes("mode=ask"), true);

const auditText = readFileSync(join(expanded, "audit-tail.jsonl"), "utf8");
expect("审计摘要被脱敏", /abcdefgh/.test(auditText), false);

const logText = readFileSync(join(expanded, "app-log-tail.txt"), "utf8");
expect("日志里 Bearer 被脱敏", /Bearer abcdefghijklmnop/.test(logText), false);

const manifest = JSON.parse(readFileSync(join(expanded, "manifest.json"), "utf8"));
expect("manifest 文件数 >= 5", manifest.files.length >= 5, true);

rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join("；")}` : "\nP4.2 检查全部通过");
process.exit(failures.length ? 1 : 0);
