/**
 * kernelspec 发现（仿 DAWN 的 src/kernel/specs.ts）。
 *
 * 搜索顺序照 Jupyter 自己：JUPYTER_PATH → 用户目录 → 系统目录，先到先得。
 * 同名被挡的记 shadowed，读不出来的记 problems —— **都显示，不静默跳过**：
 * 「为什么我改了配置没生效」全靠这两个字段回答。
 *
 * 注意：应用自己生成的 omcp-* spec 在 <userData>/kernels，不在这些根里，
 * 所以不会出现在参考列表中——这是刻意的，避免“配置项”和“机器注册项”混在一起。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface KernelSpec {
  name: string;
  displayName: string;
  language?: string;
  argv: string[];
  dir: string;
  executable?: string;
  interruptMode: "signal" | "message";
}

export interface SpecProblem {
  dir: string;
  reason: string;
}

export interface Discovery {
  specs: KernelSpec[];
  problems: SpecProblem[];
  shadowed: KernelSpec[];
}

export interface DiscoverOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：完全替换搜索根 */
  roots?: string[];
}

export function kernelSpecRoots(o: DiscoverOptions = {}): string[] {
  if (o.roots) return o.roots;
  const env = o.env ?? process.env;
  const plat = o.platform ?? process.platform;
  const home = o.home ?? "";

  const fromEnv = (env.JUPYTER_PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((p) => join(p, "kernels"));

  const user =
    plat === "win32"
      ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "jupyter", "kernels")
      : join(home, ".local", "share", "jupyter", "kernels");

  const system =
    plat === "win32"
      ? [join(env.PROGRAMDATA ?? "C:\\ProgramData", "jupyter", "kernels")]
      : ["/usr/local/share/jupyter/kernels", "/usr/share/jupyter/kernels"];

  return [...fromEnv, user, ...system];
}

export function discoverKernelSpecs(o: DiscoverOptions = {}): Discovery {
  const specs: KernelSpec[] = [];
  const problems: SpecProblem[] = [];
  const shadowed: KernelSpec[] = [];
  const seen = new Set<string>();

  for (const root of kernelSpecRoots(o)) {
    let entries: string[];
    try {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      entries = readdirSync(root);
    } catch {
      problems.push({ dir: root, reason: "目录读不了（权限？）" });
      continue;
    }
    for (const name of entries.sort()) {
      const dir = join(root, name);
      const file = join(dir, "kernel.json");
      if (!existsSync(file)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        problems.push({ dir, reason: `kernel.json 解析不了：${(err as Error).message}` });
        continue;
      }
      const j = parsed as { argv?: unknown; display_name?: unknown; language?: unknown };
      if (!Array.isArray(j.argv) || j.argv.length === 0 || typeof j.argv[0] !== "string") {
        problems.push({ dir, reason: "kernel.json 里没有可用的 argv" });
        continue;
      }
      const spec: KernelSpec = {
        name,
        displayName: typeof j.display_name === "string" ? j.display_name : name,
        ...(typeof j.language === "string" ? { language: j.language } : {}),
        argv: j.argv as string[],
        dir,
        executable: j.argv[0],
        // 只认 message，其余一律 signal（Jupyter 的默认）
        interruptMode:
          (j as { interrupt_mode?: unknown }).interrupt_mode === "message" ? "message" : "signal",
      };
      if (seen.has(name)) shadowed.push(spec);
      else {
        seen.add(name);
        specs.push(spec);
      }
    }
  }
  return { specs, problems, shadowed };
}

/** 供探测模块使用：把 spec 压成 {language, executable} */
export function specCandidates(d: Discovery): { language?: string; executable?: string }[] {
  return d.specs.map((s) => ({ language: s.language, executable: s.executable }));
}
