import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PiOrigin = "env" | "bundled" | "path";

export interface PiResolution {
  kind: "node" | "bin" | "path" | "error";
  /** node/bin 的实际入口；path 时为 "pi" */
  entry: string;
  origin: PiOrigin;
  /** kind=error 时的可读原因 */
  error?: string;
}

const PKG_TAIL = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"];
/** 打包布局是 resources/pi/payload/node_modules/…（绕过 electron-builder 对源根 node_modules 的排除） */
const PKG = ["payload", ...PKG_TAIL];
const PKG_LEGACY = PKG_TAIL;

function bundledEntry(resourcesPath: string): string {
  const payload = join(resourcesPath, "pi", ...PKG);
  if (existsSync(payload)) return payload;
  return join(resourcesPath, "pi", ...PKG_LEGACY);
}

function devEntry(): string {
  // 开发态：仓库根 vendor/pi
  return join(process.cwd(), "vendor", "pi", ...PKG);
}

/**
 * 解析顺序：OMCP_PI_PATH → 安装包内 resources/pi → 开发态 vendor/pi → PATH。
 * 与旧实现不同：指定了来源但不可用时返回 error，不再静默回落 PATH。
 */
export function resolvePi(
  envPath: string | undefined,
  resourcesPath: string | undefined,
  devRoot?: string,
): PiResolution {
  const candidate = envPath?.trim();
  if (candidate) {
    if (/\.(c|m)?js$/i.test(candidate)) {
      if (existsSync(candidate)) return { kind: "node", entry: candidate, origin: "env" };
      return { kind: "error", entry: candidate, origin: "env", error: `OMCP_PI_PATH 指向的文件不存在：${candidate}` };
    }
    const asPackage = join(candidate, "dist", "cli.js");
    if (existsSync(asPackage)) return { kind: "node", entry: asPackage, origin: "env" };
    const asPayload = join(candidate, ...PKG);
    if (existsSync(asPayload)) return { kind: "node", entry: asPayload, origin: "env" };
    const asRoot = join(candidate, ...PKG_LEGACY);
    if (existsSync(asRoot)) return { kind: "node", entry: asRoot, origin: "env" };
    if (existsSync(candidate)) return { kind: "bin", entry: candidate, origin: "env" };
    return {
      kind: "error",
      entry: candidate,
      origin: "env",
      error: `OMCP_PI_PATH 无法解析为 pi 入口：${candidate}（既不是 .js 文件，也不是包含 dist/cli.js 的目录）`,
    };
  }

  if (resourcesPath) {
    const dir = join(resourcesPath, "pi");
    const entry = bundledEntry(resourcesPath);
    if (existsSync(entry)) return { kind: "node", entry, origin: "bundled" };
    if (existsSync(dir)) {
      return {
        kind: "error",
        entry,
        origin: "bundled",
        error: `内置 pi 目录存在但不完整（缺少 dist/cli.js）：${dir}`,
      };
    }
  }

  const devCandidates = devRoot
    ? [join(devRoot, "vendor", "pi-bundle", ...PKG), join(devRoot, "vendor", "pi", ...PKG_LEGACY)]
    : [devEntry()];
  const dev = devCandidates.find((p) => existsSync(p));
  if (dev) return { kind: "node", entry: dev, origin: "bundled" };

  return { kind: "path", entry: "pi", origin: "path" };
}

function versionFile(
  resourcesPath: string | undefined,
  entry: string,
  devRoot?: string,
): string | null {
  const candidates: string[] = [];
  if (resourcesPath) {
    candidates.push(join(resourcesPath, "pi", "payload", ".pi-version"));
    candidates.push(join(resourcesPath, "pi", ".pi-version"));
  }
  if (devRoot) candidates.push(join(devRoot, "vendor", "pi", ".pi-version"));
  candidates.push(join(process.cwd(), "vendor", "pi", ".pi-version"));
  // 入口在 .../node_modules/@earendil-works/pi-coding-agent/dist/cli.js 时，版本文件在 pi 根
  const marker = join("node_modules", "@earendil-works", "pi-coding-agent");
  const index = entry.replace(/\\/g, "/").indexOf(marker.replace(/\\/g, "/"));
  if (index > 0) {
    const root = entry.slice(0, index).replace(/[\\/]+$/, "");
    candidates.push(join(root, ".pi-version"));
  }
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const text = readFileSync(file, "utf8").trim();
        if (text) return text;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** 期望版本：优先 vendor/安装包里的 .pi-version，其次 package.json 的 piVersion（仅开发态可读） */
export function expectedVersion(
  resourcesPath: string | undefined,
  entry: string,
  devRoot?: string,
): string | null {
  const fromFile = versionFile(resourcesPath, entry, devRoot);
  if (fromFile) return fromFile;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      piVersion?: string;
    };
    return pkg.piVersion ?? null;
  } catch {
    return null;
  }
}

export function runVersion(entry: string, kind: "node" | "bin" | "path", timeoutMs = 8000): Promise<string | null> {
  const args = kind === "node" ? [entry, "--version"] : ["--version"];
  const file = kind === "node" ? process.execPath : entry;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        env: kind === "node" ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
        windowsHide: true,
      },
      (err, stdout) => {
        const text = err ? "" : (String(stdout).trim().split(/\r?\n/).pop() ?? "");
        if (text) return resolve(text);
        // 打包后的 Electron 是 GUI 子系统，ELECTRON_RUN_AS_NODE 下 stdout 可能拿不到；
        // 回落到读 pi 包自己的 package.json 版本（仍是安装包的元数据，不是猜）。
        try {
          const pkgFile = join(entry, "..", "..", "package.json");
          const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { version?: string };
          resolve(pkg.version ?? null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** 系统 PATH 上的 pi（用于诊断，不影响运行时） */
export async function probeSystemPi(): Promise<{ path: string | null; version: string | null }> {
  return new Promise((resolve) => {
    execFile("where", ["pi"], { timeout: 4000, windowsHide: true }, async (err, stdout) => {
      if (err) {
        resolve({ path: null, version: null });
        return;
      }
      const first = String(stdout).trim().split(/\r?\n/)[0] ?? null;
      if (!first) {
        resolve({ path: null, version: null });
        return;
      }
      const version = await new Promise<string | null>((res) => {
        const useCmd = process.platform === "win32";
        const cmd = useCmd ? "cmd.exe" : "pi";
        const args = useCmd ? ["/d", "/c", "pi", "--version"] : ["--version"];
        execFile(cmd, args, { timeout: 5000, windowsHide: true }, (e, out) => {
          res(e ? null : (String(out).trim().split(/\r?\n/).pop() ?? null));
        });
      });
      resolve({ path: first, version });
    });
  });
}
