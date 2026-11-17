/**
 * 内核起不来时说人话（仿 DAWN 的 diagnoseLaunch / diagnoseInterpreter）。
 *
 * 三种实情必须分开，因为「人该做什么」不同：
 *   1. 还没配置路径        → 去设置里填
 *   2. 路径存在但程序没了   → 改路径 / 重装
 *   3. 程序在、内核包没装   → 装包（不是修路径）
 *
 * 另外一条坑：`No module named 'ipykernel_launcher'` 报的是**模块名**，
 * 要装的包叫 `ipykernel`。照模块名给建议，人会去装一个不存在的包。
 */

export type LaunchDiagnosis =
  | { kind: "no-path"; message: string }
  | { kind: "missing-executable"; message: string; executable: string }
  | { kind: "missing-kernel-package"; message: string; packageName: string; evidence: string }
  /** 进程起来了但一个字都没说：没证据可依，只能给检查清单 */
  | { kind: "no-output"; message: string; evidence: string }
  /** 进程活着，但 shell/iopub 至少一条没回音：这是协议层，不是路径层 */
  | { kind: "protocol"; message: string; evidence: string }
  | { kind: "unknown"; message: string; evidence: string };

const MODULE_TO_PACKAGE: Record<string, string> = {
  ipykernel_launcher: "ipykernel",
};

const tail = (s: string): string => s.trim().split("\n").slice(-5).join("\n");

/** 从 stderr 认出“语言侧的包没装”；认不出返回 undefined，不编原因 */
export function matchMissingPackage(
  stderr: string,
): { packageName: string; how: string; line: string } | undefined {
  for (const line of stderr.split("\n")) {
    // R: there is no package called 'IRkernel'
    const r = /there is no package called ['"\u2018]([^'"\u2019]+)['"\u2019]/i.exec(line);
    if (r?.[1]) {
      return { packageName: r[1], how: `在 R 里执行 install.packages("${r[1]}")`, line: line.trim() };
    }
    // Python: 带引号与不带引号两种都要认
    const p = /No module named ['"]?([A-Za-z0-9_.]+)['"]?/i.exec(line);
    if (p?.[1]) {
      const mod = p[1];
      const pkg = MODULE_TO_PACKAGE[mod] ?? mod;
      return { packageName: pkg, how: `执行 python -m pip install ${pkg}`, line: line.trim() };
    }
  }
  return undefined;
}

/**
 * @param language 语言
 * @param path 用户配置的解释器路径（空 = 未配置）
 * @param stderr 内核进程真吐出来的东西；只在真失败时用
 * @param exists 注入以便单测
 */
export function diagnoseLaunch(
  language: "python" | "r",
  path: string,
  stderr = "",
  exists: (p: string) => boolean = () => true,
): LaunchDiagnosis | undefined {
  const label = language === "python" ? "Python" : "R";

  if (!path.trim()) {
    return {
      kind: "no-path",
      message: `还没有配置 ${label} 解释器路径——到「设置 → 内核」填一个。`,
    };
  }
  // 只有绝对路径才判存在性；`python` 这种要靠 PATH 找，这里判不了
  if (/^[A-Za-z]:[\\/]|^\//.test(path) && !exists(path)) {
    return {
      kind: "missing-executable",
      executable: path,
      message: `${path} 不存在。这条路径是你自己填的，到「设置 → 内核」改一下。`,
    };
  }

  const missing = matchMissingPackage(stderr);
  if (missing) {
    return {
      kind: "missing-kernel-package",
      packageName: missing.packageName,
      evidence: missing.line,
      message: `${path} 在，但它的内核包「${missing.packageName}」没装——路径没问题，要装的是包（${missing.how}）。`,
    };
  }

  if (stderr.trim()) {
    // 协议层：sidecar 的握手失败带 shell=/iopub= 两个布尔值。
    // 这类问题改路径、重装包都没用（自测报告 §7.3），别把人往错误方向引。
    if (/握手失败|handshake failed|等 iopub 的第一声/i.test(stderr)) {
      return {
        kind: "protocol",
        evidence: tail(stderr),
        message: `${label} 进程起来了，但握手没通（shell / iopub 至少一条没回音）。这不是路径问题：先看下面两个布尔值，iopub 那条负责的是输出通道。`,
      };
    }
    return {
      kind: "unknown",
      evidence: tail(stderr),
      message: `${label} 内核没能起来，原因认不出。它自己说的是（末尾几行）：`,
    };
  }
  // 进程没留下任何 stderr：至少要说清楚“它什么都没输出”，并给出可执行的下一步，
  // 而不是给一个空冒号让人干瞪眼（报告 P7）。
  return {
    kind: "no-output",
    evidence: "",
    message: `${label} 内核没起来，而且没有留下任何 stderr。先查这两件事：① 这个解释器自己能不能装内核包（${path || "解释器"} -m pip show ipykernel / Rscript -e "requireNamespace('IRkernel')"）；② 换成绝对路径再试一次。`,
  };
}
