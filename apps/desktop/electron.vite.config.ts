import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rendererRoot = fileURLToPath(new URL("../renderer", import.meta.url));
/** 侧栏版本号徽章的唯一来源：apps/desktop/package.json（不手写，避免过期） */
const appVersion = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }
).version;

export default defineConfig({
  main: {
    // @oh-my-coding-pi/shared 是 TS 源码包，必须打包进来，否则运行时会去找 src/index.ts
    plugins: [externalizeDepsPlugin({ exclude: ["@oh-my-coding-pi/shared"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@oh-my-coding-pi/shared"] })],
  },
  renderer: {
    root: rendererRoot,
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    build: {
      rollupOptions: {
        input: resolve(rendererRoot, "index.html"),
      },
    },
    plugins: [react()],
  },
});
