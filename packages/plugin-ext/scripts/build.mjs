/**
 * 把插件扩展打成单文件（打包用）。
 *
 * 为什么需要：pnpm 的 node_modules 是软链，electron-builder 拷 extraResources 时
 * 会带出断裂的软链；把依赖一起 inline 进一个 .mjs 最稳。
 *
 * external 里的包不打进去：
 * - playwright-core：运行时按自己的目录结构找浏览器/注册文件，打包后路径会错
 *   （浏览器那批落地时再单独安排它的运行位置，见 ADR-047）。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** playwright-core 放到 payload/node_modules（electron-builder 跳过被拷目录根部的 node_modules） */
function copyPlaywright() {
  const require = createRequire(import.meta.url);
  let real;
  try {
    real = realpathSync(require.resolve("playwright-core/package.json"));
  } catch {
    console.warn("[build] playwright-core 未安装，浏览器插件将无法在打包版运行");
    return;
  }
  const src = dirname(real);
  const dest = join("dist", "payload", "node_modules", "playwright-core");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (path) => !path.endsWith(".map") });
  console.log(`[build] playwright-core -> ${dest}`);
}

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  external: ["playwright-core"],
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "info",
  banner: {
    js: "// oh my coding pi plugin extension bundle — 由 scripts/build.mjs 生成，不要手改",
  },
});

copyPlaywright();
