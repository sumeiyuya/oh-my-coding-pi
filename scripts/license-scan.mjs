#!/usr/bin/env node
/**
 * 扫描 vendor/pi 的依赖许可，生成 NOTICE 草稿并给出分类统计。
 *
 * 用法：node scripts/license-scan.mjs [--write]
 *   --write  写 vendor/pi/NOTICE.generated.md
 *
 * 退出码：0 正常；1 有缺失许可（需人工补齐）；2 vendor 未安装
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const vendorModules = process.env.PI_VENDOR_DIR
  ? resolve(process.env.PI_VENDOR_DIR)
  : join(root, "vendor", "pi", "node_modules");

if (!existsSync(vendorModules)) {
  console.error(`找不到 ${vendorModules}，先跑 node scripts/fetch-pi.mjs`);
  process.exit(2);
}

const packages = new Map();

function readLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return String(pkg.license.type);
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean).join(" OR ");
  }
  return "";
}

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (name.startsWith("@")) {
      walk(full, depth + 1);
      continue;
    }
    const pkgFile = join(full, "package.json");
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
        if (pkg.name && pkg.version) {
          const key = `${pkg.name}@${pkg.version}`;
          packages.set(key, {
            name: pkg.name,
            version: pkg.version,
            license: readLicense(pkg),
            dir: relative(root, full),
          });
        }
      } catch {
        // 坏 package.json 跳过
      }
    }
    const nested = join(full, "node_modules");
    if (existsSync(nested)) walk(nested, depth + 1);
  }
}

walk(vendorModules);

function normalize(license) {
  if (!license) return "MISSING";
  const lower = license.toLowerCase();
  if (lower.includes("mit")) return "MIT";
  if (lower.includes("apache")) return "Apache-2.0";
  if (lower.includes("bsd")) return "BSD";
  if (lower.includes("isc")) return "ISC";
  if (lower.includes("mpl")) return "MPL";
  if (lower.includes("lgpl")) return "LGPL";
  if (lower.includes("agpl")) return "AGPL";
  if (lower.includes("gpl")) return "GPL";
  if (lower.includes("unlicense")) return "Unlicense";
  if (lower.includes("cc0")) return "CC0";
  return license;
}

const all = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
/** 许可全文去重：sha1(text) → { text, packages } */
const licenseTexts = new Map();
const counts = new Map();
const copyleft = [];
const missing = [];
const noText = [];
const KEEP = /^(license|licence|copying|notice|copyright)/i;
for (const item of all) {
  const type = normalize(item.license);
  counts.set(type, (counts.get(type) ?? 0) + 1);
  if (type === "MISSING") missing.push(item);
  // 按原文判断 copyleft：避免 "MIT OR GPL-3.0" 被当成 MIT
  if (/\b(a?gpl|lgpl)\b/i.test(item.license || "")) copyleft.push({ ...item, type });
  let hasText = false;
  try {
    for (const f of readdirSync(join(root, item.dir))) {
      if (KEEP.test(f)) {
        hasText = true;
        break;
      }
    }
  } catch {
    // ignore
  }
  if (!hasText) noText.push(item);
  if (hasText) {
    try {
      const dir = join(root, item.dir);
      const file = readdirSync(dir).find((f) => KEEP.test(f));
      if (file) {
        const text = readFileSync(join(dir, file), "utf8").slice(0, 60000).trim();
        if (text) {
          const key = createHash("sha1").update(text).digest("hex");
          const entry = licenseTexts.get(key) ?? { text, packages: [] };
          entry.packages.push(`${item.name}@${item.version}`);
          licenseTexts.set(key, entry);
        }
      }
    } catch {
      // ignore
    }
  }
}

console.log(`依赖包：${all.length}`);
console.log("许可分布：");
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${type}`);
}
if (copyleft.length) {
  console.log("\nCopyleft 依赖（需评估）：");
  for (const item of copyleft) console.log(`  ${item.type}  ${item.name}@${item.version}  ${item.license}`);
} else {
  console.log("\nCopyleft（GPL/AGPL/LGPL）：无");
}
if (missing.length) {
  console.log("\n缺少 license 字段（需人工确认）：");
  for (const item of missing) console.log(`  ${item.name}@${item.version}  ${item.dir}`);
}
console.log(`\n含许可文本的包：${all.length - noText.length}/${all.length}`);
if (noText.length) {
  console.log("没有 LICENSE/COPYING 文本（字段有值，仅抽查参考）：");
  for (const item of noText.slice(0, 10)) console.log(`  ${item.name}@${item.version}  ${item.license || "（无）"}`);
  if (noText.length > 10) console.log(`  … 另有 ${noText.length - 10} 个`);
}

const lines = [
  "# 内置 pi 的第三方组件",
  "",
  `- 生成时间：${new Date().toISOString()}`,
  `- 来源：vendor/pi/node_modules`,
  `- 包数：${all.length}`,
  "",
  "| 包 | 版本 | 许可 |",
  "|---|---|---|",
  ...all.map((p) => `| ${p.name} | ${p.version} | ${p.license || "（缺失）"} |`),
  "",
  "> 本文件由 `node scripts/license-scan.mjs --write` 生成；手工改动会被覆盖。",
  "",
];

if (process.argv.includes("--write")) {
  const out = join(root, "vendor", "pi", "NOTICE.generated.md");
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\n已写 ${out}`);
  const delivery = join(root, "apps", "desktop", "build", "NOTICE.pi.md");
  mkdirSync(join(root, "apps", "desktop", "build"), { recursive: true });
  writeFileSync(delivery, lines.join("\n"), "utf8");
  console.log(`已写 ${delivery}`);

  // 许可全文（按文本去重）；没有文本的包只列在 NOTICE 表里
  const texts = ["# 内置 pi 的依赖许可全文", "", `- 生成时间：${new Date().toISOString()}`, ""];
  let index = 0;
  for (const entry of licenseTexts.values()) {
    index += 1;
    texts.push(`## 许可文本 ${index}`, "", "适用包：", "");
    for (const pkg of [...entry.packages].sort()) texts.push(`- ${pkg}`);
    texts.push("", "```text", entry.text, "```", "");
  }
  if (noText.length) {
    texts.push("## 未附带许可文本的包", "", "以下包在 package.json 中声明了许可，但包内没有 LICENSE/COPYING 文件：", "");
    for (const item of [...noText].sort((a, b) => a.name.localeCompare(b.name))) {
      texts.push(`- ${item.name}@${item.version} — ${item.license || "未声明"}`);
    }
    texts.push("");
  }
  const licensesFile = join(root, "apps", "desktop", "build", "LICENSES.pi.md");
  writeFileSync(licensesFile, texts.join("\n"), "utf8");
  console.log(`已写 ${licensesFile}（${licenseTexts.size} 段去重文本，${noText.length} 个包无文本）`);
}

process.exit(missing.length || copyleft.length ? 1 : 0);
