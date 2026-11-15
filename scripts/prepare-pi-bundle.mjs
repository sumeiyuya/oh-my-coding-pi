#!/usr/bin/env node
/**
 * 为打包准备裁剪过的 pi：vendor/pi → vendor/pi-bundle。
 *
 * 裁剪规则（只在“包根”裁目录，避免误删 dist/doc 这类运行期代码）：
 *   - 包根下的 docs/ doc/ examples/ test/ tests/ __tests__/ 整目录跳过
 *   - 任意位置：*.map、*.md（保留 LICENSE / NOTICE / COPYING / AUTHORS 开头）
 *
 * 保留：package.json、dist/*、.js/.cjs/.mjs/.node、类型声明、许可文件。
 * 用法：node scripts/prepare-pi-bundle.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "vendor", "pi");
const dest = join(root, "vendor", "pi-bundle");

if (!existsSync(join(src, "node_modules"))) {
  console.error(`找不到 ${src}/node_modules，先跑 node scripts/fetch-pi.mjs`);
  process.exit(2);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

let kept = 0;
let skipped = 0;
let keptBytes = 0;
let skippedBytes = 0;

const ROOT_DROP_DIRS = new Set(["docs", "doc", "examples", "example", "test", "tests", "__tests__", "__mocks__"]);
const KEEP_MD = /^(license|licence|notice|copying|authors|copyright)/i;

const sizeOf = (p) => {
  const st = statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) total += sizeOf(join(p, e.name));
  return total;
};

function shouldDropFile(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".map")) return true;
  if (lower.endsWith(".md") && !KEEP_MD.test(lower)) return true;
  return false;
}

/** 复制一个包目录；atRoot 时额外裁掉 docs/test 等目录 */
function copyDir(from, to, atRoot) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, entry.name);
    const d = join(to, entry.name);
    if (entry.isDirectory()) {
      if (atRoot && ROOT_DROP_DIRS.has(entry.name.toLowerCase())) {
        skipped += 1;
        skippedBytes += sizeOf(s);
        continue;
      }
      copyDir(s, d, false);
      continue;
    }
    if (shouldDropFile(entry.name)) {
      skipped += 1;
      skippedBytes += statSync(s).size;
      continue;
    }
    cpSync(s, d, { preserveTimestamps: true });
    kept += 1;
    keptBytes += statSync(s).size;
  }
}

const modulesDir = join(src, "node_modules");
const payload = join(dest, "payload");
const outModules = join(payload, "node_modules");
mkdirSync(outModules, { recursive: true });

for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
  const from = join(modulesDir, entry.name);
  const to = join(outModules, entry.name);
  if (!entry.isDirectory()) {
    // 顶层文件（.package-lock.json 等）原样保留
    cpSync(from, to);
    continue;
  }
  if (entry.name.startsWith("@")) {
    mkdirSync(to, { recursive: true });
    for (const sub of readdirSync(from, { withFileTypes: true })) {
      copyDir(join(from, sub.name), join(to, sub.name), true);
    }
  } else {
    copyDir(from, to, true);
  }
}

for (const name of [".pi-version", "NOTICE.generated.md", "package.json", "package-lock.json"]) {
  const from = join(src, name);
  if (existsSync(from)) cpSync(from, join(payload, name));
}

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`裁剪完成：${dest}`);
console.log(`  保留 ${kept} 个文件，${mb(keptBytes)} MB`);
console.log(`  跳过 ${skipped} 个目录/文件，${mb(skippedBytes)} MB`);
const cli = join(payload, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error(`⚠ 没有找到 cli.js：${cli}`);
  process.exit(1);
}
console.log(`  cli.js: ${cli}`);
