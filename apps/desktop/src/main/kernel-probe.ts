/**
 * 本机解释器探测（仿 DAWN 的 src/kernel/probe.ts）。
 *
 * 只回答三件事：这台机器上有哪些 Python / R、各自什么版本、内核包在不在。
 * 不装东西、不改配置。
 *
 * 全是纯函数：文件系统、PATH 查找、进程执行都由调用方注入，单测不碰真机。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { posix, win32 } from "node:path";

export type KernelLanguage = "python" | "r";

export interface ProbeCandidate {
  /** 绝对路径（或 PATH 上的名字） */
  path: string;
  source: "settings" | "kernelspec" | "PATH" | "common";
  version?: string;
  kernelPackage: "present" | "missing" | "unknown";
  /** 起不来时它自己说的末尾几行 */
  problem?: string;
}

export interface ProbeDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): boolean;
  /** 只用于带 `*` 的常见目录 */
  glob(pattern: string): string[];
  /** PATH 上所有同名可执行文件 */
  pathLookup(name: string): string[];
  settings: { python?: string; r?: string };
  /** 已有 kernelspec 的 argv[0]，作为候选来源之一 */
  kernelspecs: { language?: string; executable?: string }[];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

/** 探测超时（与 DAWN 一致） */
export const PROBE_TIMEOUT_MS = 8_000;
/** 并发数 */
const CONCURRENCY = 4;

/** Windows 路径用 win32 规则算 basename / dirname，在别的平台跑单测也要对 */
function pathApi(p: string) {
  return /^[A-Za-z]:[\\/]|\\/.test(p) ? win32 : posix;
}

/** 同目录的 Rscript（探测用它跑；设置里存的是 R 本尊） */
export function rscriptOf(rPath: string): string {
  const P = pathApi(rPath);
  const exe = P.basename(rPath).toLowerCase().endsWith(".exe") ? ".exe" : "";
  return P.join(P.dirname(rPath), `Rscript${exe}`);
}

/** PATH 上查到的是 Rscript，换回 R */
function rOfRscript(rscriptPath: string): string {
  const P = pathApi(rscriptPath);
  const exe = P.basename(rscriptPath).toLowerCase().endsWith(".exe") ? ".exe" : "";
  return P.join(P.dirname(rscriptPath), `R${exe}`);
}

function commonDirs(language: KernelLanguage, d: ProbeDeps): string[] {
  const h = d.home;
  if (d.platform === "win32") {
    const local = win32.join(h, "AppData", "Local");
    if (language === "python") {
      return [
        ...d.glob(win32.join(local, "Programs", "Python", "Python3*", "python.exe")),
        ...["miniconda3", "anaconda3", "miniforge3"]
          .map((c) => win32.join(h, c, "python.exe"))
          .filter((p) => d.exists(p)),
      ];
    }
    return [
      ...d.glob(win32.join("C:\\Program Files", "R", "R-*", "bin", "R.exe")),
      ...d.glob(win32.join(local, "Programs", "R", "R-*", "bin", "R.exe")),
    ];
  }
  if (language === "python") {
    return ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].filter((p) =>
      d.exists(p),
    );
  }
  return ["/opt/homebrew/bin/R", "/usr/local/bin/R", "/usr/bin/R"].filter((p) => d.exists(p));
}

/**
 * 枚举候选：设置 > kernelspec > PATH > 常见目录；同一路径只留首次来源。
 * kernelspec 指向的环境可能已经删了——死路径不列；设置里那条例外，人得看见自己配的没了。
 */
export function enumerateCandidates(
  language: KernelLanguage,
  d: ProbeDeps,
): { path: string; source: ProbeCandidate["source"] }[] {
  const out: { path: string; source: ProbeCandidate["source"] }[] = [];
  const seen = new Set<string>();
  // 同一文件可能以 D:/x 与 D:\x 两种写法出现；Windows 上大小写也不敏感
  const key = (p: string) =>
    d.platform === "win32" ? p.split("/").join("\\").toLowerCase() : p;
  const add = (path: string | undefined, source: ProbeCandidate["source"]) => {
    if (!path) return;
    const k = key(path.trim());
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ path, source });
  };

  add(language === "python" ? d.settings.python : d.settings.r, "settings");

  for (const k of d.kernelspecs) {
    if (!k.executable) continue;
    const lang = (k.language ?? "").toLowerCase();
    const match = language === "python" ? lang === "python" : lang === "r";
    if (match && d.exists(k.executable)) add(k.executable, "kernelspec");
  }

  if (language === "python") {
    for (const n of ["python3", "python"]) for (const p of d.pathLookup(n)) add(p, "PATH");
  } else {
    for (const p of d.pathLookup("Rscript")) add(rOfRscript(p), "PATH");
  }

  for (const p of commonDirs(language, d)) add(p, "common");
  return out;
}

/**
 * 探测命令。
 * Python：先 print 版本再 import —— 缺包时版本仍拿得到。
 * R：退出码 3 专门表示「IRkernel 没装」。
 */
export function probeCommand(
  language: KernelLanguage,
  path: string,
): { cmd: string; args: string[] } {
  if (language === "python") {
    return { cmd: path, args: ["-c", "import sys;print(sys.version.split()[0]);import ipykernel"] };
  }
  return {
    cmd: rscriptOf(path),
    args: [
      "-e",
      "cat(paste(R.version$major,R.version$minor,sep='.'));quit(status=if(requireNamespace('IRkernel',quietly=TRUE))0 else 3)",
    ],
  };
}

export function parseProbe(
  language: KernelLanguage,
  r: ExecResult,
): Pick<ProbeCandidate, "version" | "kernelPackage" | "problem"> {
  if (r.timedOut) return { kernelPackage: "unknown", problem: `${PROBE_TIMEOUT_MS / 1000} 秒没应答` };
  const version = r.stdout.trim().split("\n")[0]?.trim() || undefined;
  const withVersion = (
    x: Pick<ProbeCandidate, "kernelPackage" | "problem">,
  ): Pick<ProbeCandidate, "version" | "kernelPackage" | "problem"> =>
    version ? { version, ...x } : x;

  if (r.code === 0) return withVersion({ kernelPackage: "present" });
  if (language === "python" && /No module named ['"]?ipykernel/.test(r.stderr)) {
    return withVersion({ kernelPackage: "missing" });
  }
  if (language === "r" && r.code === 3) return withVersion({ kernelPackage: "missing" });
  const tail = r.stderr.trim().split("\n").slice(-5).join("\n");
  return withVersion({ kernelPackage: "unknown", problem: tail || `退出码 ${r.code}` });
}

/** 每个候选起一次，并发 4；结果按“内核包在的在前面”稳定排序 */
export async function probeInterpreters(
  language: KernelLanguage,
  d: ProbeDeps,
  run: Exec,
): Promise<ProbeCandidate[]> {
  const list = enumerateCandidates(language, d);
  const out: ProbeCandidate[] = new Array(list.length);
  let i = 0;

  const worker = async () => {
    for (;;) {
      const n = i++;
      if (n >= list.length) return;
      const c = list[n]!;
      const { cmd, args } = probeCommand(language, c.path);
      let r: ExecResult;
      try {
        r = await run(cmd, args);
      } catch (err) {
        r = { code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
      }
      out[n] = { ...c, ...parseProbe(language, r) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  const rank = { present: 0, missing: 1, unknown: 2 } as const;
  return out.slice().sort((a, b) => rank[a.kernelPackage] - rank[b.kernelPackage]);
}

/** 默认依赖：把真实文件系统接到上面的纯函数上 */
export function realDeps(settings: { python?: string; r?: string }, kernelspecs: ProbeDeps["kernelspecs"]): ProbeDeps {
  const env = process.env;
  return {
    platform: process.platform,
    home: os.homedir(),
    env,
    exists: (p) => fs.existsSync(p),
    glob: (pattern) => {
      // 只支持 `.../Python3*` 这种末段通配，够用且不引依赖
      const P = path.win32;
      const dir = P.dirname(pattern);
      const mask = P.basename(pattern);
      if (!mask.includes("*")) return fs.existsSync(pattern) ? [pattern] : [];
      if (!fs.existsSync(dir)) return [];
      const re = new RegExp("^" + mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
      return fs
        .readdirSync(dir)
        .filter((n) => re.test(n))
        .map((n) => P.join(dir, n));
    },
    pathLookup: (name) => {
      const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";") : [""];
      const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
      const found: string[] = [];
      for (const dir of dirs) {
        for (const ext of exts) {
          const p = path.join(dir, name + ext);
          if (fs.existsSync(p)) found.push(p);
        }
      }
      return [...new Set(found)];
    },
    settings,
    kernelspecs,
  };
}
