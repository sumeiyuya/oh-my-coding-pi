import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rendererRoot = fileURLToPath(new URL("../renderer", import.meta.url));

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
    build: {
      rollupOptions: {
        input: resolve(rendererRoot, "index.html"),
      },
    },
    plugins: [react()],
  },
});
