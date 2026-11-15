#!/usr/bin/env node
/**
 * 把内置的 pi 安装到 vendor/pi（不入库）。
 *
 * 用法：
 *   node scripts/fetch-pi.mjs             # 已安装且版本一致则跳过
 *   node scripts/fetch-pi.mjs --force     # 强制重装
 *
 * 版本来源：根 package.json 的 piVersion。
 * 目标路径：vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.piVersion;
if (!version) {
  console.error("package.json 缺少 piVersion 字段");
  process.exit(1);
}

const vendor = join(root, "vendor", "pi");
const cli = join(vendor, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const installedPkg = join(vendor, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const force = process.argv.includes("--force");

function installedVersion() {
  try {
    return JSON.parse(readFileSync(installedPkg, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

if (!force && existsSync(cli)) {
  const current = installedVersion();
  if (current === version) {
    writeFileSync(join(vendor, ".pi-version"), `${version}
`, "utf8");
    console.log(`已存在 pi ${version}：${cli}`);
    process.exit(0);
  }
  console.log(`已存在 pi ${current ?? "未知"}，需要 ${version}，重新安装…`);
}

mkdirSync(dirname(vendor), { recursive: true });

// npm install --prefix 会在目标目录建 node_modules；用 --no-save 避免生成 package.json 之外的锁文件噪音
const args = [
  "install",
  "--prefix",
  vendor,
  "--omit=dev",
  "--no-audit",
  "--no-fund",
  "--no-progress",
  "--prefer-offline",
  `@earendil-works/pi-coding-agent@${version}`,
];

console.log(`安装 pi ${version} → ${vendor}`);
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
try {
  execSync(["npm", ...args.map(quote)].join(" "), {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
} catch (err) {
  const code = err?.status ?? "unknown";
  console.error(`npm install 失败（exit ${code}）`);
  if (err?.stderr) console.error(String(err.stderr).slice(-800));
  console.error(
    `常见原因：\n` +
      `  1) 网络不可达或 registry 被代理拦截（可先 npm ping）\n` +
      `  2) @earendil-works/pi-coding-agent@${version} 不存在（npm view 确认版本）\n` +
      `  3) 磁盘/权限问题（vendor 目录是否可写）`,
  );
  process.exit(1);
}

if (!existsSync(cli)) {
  console.error(`安装完成但找不到入口：${cli}`);
  process.exit(1);
}

writeFileSync(join(vendor, ".pi-version"), `${installedVersion() ?? version}
`, "utf8");

console.log(`OK  pi ${installedVersion() ?? version}`);
console.log(`    ${cli}`);
