#!/usr/bin/env node
/**
 * 内置 pi 冒烟（CI 用，不需要 GUI）：
 *   1) 裁剪包里的 cli.js 存在
 *   2) --version 等于 package.json 的 piVersion
 *   3) 能以 RPC 模式启动并返回 get_state
 *
 * 用法：node scripts/prepare-pi-bundle.mjs && node scripts/pi-smoke.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = pkg.piVersion;
const cli = join(
  root,
  "vendor",
  "pi-bundle",
  "payload",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);

function fail(message) {
  console.error("PI_SMOKE_FAIL " + message);
  process.exit(1);
}

if (!expected) fail("package.json 缺少 piVersion");
if (!existsSync(cli)) fail(`找不到 ${cli}，先跑 prepare-pi-bundle`);

const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

let version = "";
try {
  version = execFileSync(process.execPath, [cli, "--version"], {
    env: nodeEnv,
    encoding: "utf8",
    timeout: 20000,
  })
    .trim()
    .split(/\r?\n/)
    .pop();
} catch (err) {
  fail("--version 执行失败：" + (err?.message ?? err));
}
if (version !== expected) fail(`版本不符：实际 ${version}，期望 ${expected}`);

// RPC：不调用模型，只验证协议通道
const sessionDir = mkdtempSync(join(tmpdir(), "pi-smoke-"));
const child = (await import("node:child_process")).spawn(
  process.execPath,
  [cli, "--mode", "rpc", "--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--session-dir", sessionDir, "--no-approve"],
  { env: nodeEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);

const result = await new Promise((resolvePromise) => {
  let buffer = "";
  const timer = setTimeout(() => resolvePromise({ ok: false, error: "timeout" }), 30000);
  const finish = (value) => {
    clearTimeout(timer);
    resolvePromise(value);
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id === "smoke1" && item.type === "response") {
          finish({ ok: item.success === true, error: item.error ?? null });
          return;
        }
      } catch {
        // 忽略非 JSON 行
      }
    }
  });
  child.on("error", (err) => finish({ ok: false, error: err.message }));
  child.stdin.write(JSON.stringify({ type: "get_state", id: "smoke1" }) + "\n");
});

try {
  child.kill();
} catch {
  // ignore
}
rmSync(sessionDir, { recursive: true, force: true });

if (!result.ok) fail("RPC get_state 失败：" + (result.error ?? "unknown"));

console.log(`PI_SMOKE_OK version=${version} rpc=get_state`);
