/**
 * 权限判据（照 DAWN-Science 的 src/policy/permissions.ts 重写，2026-11-14）。
 *
 * 两件事分开：
 * - `assessRisk()`：**纯函数**，回答「这次调用踩到了什么」。可以逐条测。
 * - `decideByMode()`：拿着风险和档位，回答「放行、问一句，还是拒」。
 *
 * 合成一个的话，加一档就要重写所有判据；而判据才是最该被逐条钉死的部分。
 *
 * **这不是沙箱。** 这是应用自己代码里的一道门：模型走包装过的工具时拦得住，绕过去就拦不住。
 * 所以档位名里没有「沙箱」二字，界面上也不该出现——不存在的能力不该看起来存在。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PermissionMode } from "@oh-my-coding-pi/shared";

export type RiskCategory =
  | "raw-data"
  | "outside-workspace"
  | "delete"
  | "install"
  | "network"
  | "publish"
  | "hard-deny";

export interface Risk {
  category: RiskCategory;
  /** 给模型看的话：要能据此改道，不是一句「拒绝」 */
  message: string;
  /**
   * 连问都不问（但不是硬拒：allow-all 仍放）。给「目标看不清」的删除用：
   * 通配符 / 变量 / 多目标 / 管道——人在卡上也判不了它会删掉什么。
   */
  cannotAsk?: boolean;
}

export interface RiskContext {
  /** 这段会话的工作区绝对路径 */
  workspace: string;
  /** 远端机器：拒绝理由要指名这一点（本版未接远端，先留位） */
  remote?: boolean;
}

export type GateDecision =
  | { action: "allow"; ruleId: string; summary: string; reason: string }
  | { action: "ask"; ruleId: string; summary: string; reason: string }
  | { action: "deny"; ruleId: string; summary: string; reason: string };

const HOME = homedir();

/** 统一成 "/" 比较：Windows 的 relative 回反斜杠，盘符统一大写 */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(out)) out = out[0]!.toUpperCase() + out.slice(1);
  return out.replace(/\/+$/, "") || "/";
}

/**
 * realpath **存在的最长前缀**，拼回还不存在的尾段。
 *
 * 写入目标常常还不存在（是「创建」），没法整段 realpath；但要挡符号链接逃逸，
 * 又要让目标和 realpath 后的工作区根用同一套真实路径基准（macOS 的 /var → /private/var）。
 */
export function realpathExistingPrefix(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length > 0 ? join(realpathSync(cur), ...tail) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

const CLOUD_CREDENTIAL_DIRS = [".ssh", ".aws", ".gnupg", ".kube"];

/** 受保护的路径：写入或删除这些地方，任何档都拒 */
export function protectedPathReason(absolute: string, home: string = HOME): string | undefined {
  const p = normalizePath(resolve(absolute));
  const homePosix = normalizePath(home);

  // 盘根 / 根目录
  if (/^[A-Za-z]:\/$/.test(p) || p === "/") return `${p} 是根目录，不碰。`;

  // Windows 系统目录
  const winRoot = normalizePath(process.env.SystemRoot ?? "C:/Windows");
  const winProtected = [
    winRoot,
    "C:/Program Files",
    "C:/Program Files (x86)",
    "C:/ProgramData",
  ];
  if (/^[A-Za-z]:\//.test(p)) {
    for (const root of winProtected) {
      if (p === root || p.startsWith(`${root}/`)) return `${p} 在系统目录里，不碰。`;
    }
  } else {
    // POSIX 系统目录（oh my coding pi 只在 Windows 发布，但判据保持可测）
    const posixRoots = [
      "/etc", "/usr", "/bin", "/sbin", "/boot", "/sys", "/proc", "/dev", "/lib", "/lib64",
      "/var/lib", "/var/spool", "/System", "/Library", "/Applications", "/private/etc",
    ];
    for (const root of posixRoots) {
      if (p === root || p.startsWith(`${root}/`)) return `${p} 在系统目录里，不碰。`;
    }
  }

  // 家目录本身
  if (p === homePosix) return `${p} 是你的主目录，不碰。`;

  // 家目录顶层的点文件（shell / 工具配置）
  if (p.startsWith(`${homePosix}/`)) {
    const rest = p.slice(homePosix.length + 1);
    if (!rest.includes("/") && rest.startsWith(".")) return `${p} 是主目录顶层的配置文件，不碰。`;
  }

  // 凭据目录
  for (const dir of CLOUD_CREDENTIAL_DIRS) {
    const base = normalizePath(join(homePosix, dir));
    if (p === base || p.startsWith(`${base}/`)) return `${p} 在凭据目录里，不碰。`;
  }
  return undefined;
}

/** 是否在工作区里（realpath 后比较）；返回相对路径（"/" 分隔） */
export function workspaceRelative(target: string, workspace: string): { inside: boolean; rel: string } {
  const root = normalizePath(realpathExistingPrefix(workspace));
  const abs = normalizePath(realpathExistingPrefix(target));
  const rel = relative(root, abs).split(sep).join("/");
  const inside = !(rel.startsWith("..") || isAbsolute(rel));
  return { inside, rel };
}

const INSTALL_RE =
  /\b(pip3?|uv|conda|mamba|npm|pnpm|yarn|apt|apt-get|brew)\s+(install|add|remove|uninstall)\b|\bR\s+-e\s+.*install\.packages|\binstall\.packages\s*\(|\brenv::(install|restore)\b/;
const NETWORK_RE = /\b(curl|wget|scp|rsync|(?<!\.)ssh|nc|ftp|sftp|telnet)\b/;
const DELETE_RE = /\brm\s|\brmdir\b|\bshred\b|\bmv\s|\btruncate\b|\bfind\b.*-delete\b|\bxargs\b.*\brm\b/;
const PUBLISH_RE = /\bgit\s+push\b/;
const CREDENTIAL_SHAPE_RE =
  /(BEGIN (RSA |OPENSSH )?PRIVATE KEY|\b(sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+/-]{8,}|\.ssh\/(id_|config)|\.aws\/credentials|\$\{?[A-Z_]*(TOKEN|SECRET|API_KEY|PASSWORD)[A-Z_]*\}?)/i;

/** bash 命令里的写入目标：重定向、tee、cp/mv/install/rsync 目的地、dd of= */
export function writeTargets(rawCommand: string): string[] {
  const cmd = rawCommand.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  const clean = (t: string) => t.replace(/^["']|["']$/g, "");
  const literal = (t: string) => Boolean(t) && !/[|`$*?{}[\]]/.test(t) && !t.startsWith("-") && !/^\/dev\//.test(t);

  for (const m of cmd.matchAll(/(?:^|[\s;&|(])(?:\d*|&)>>?\s*("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g)) {
    const t = clean(m[1]!);
    if (literal(t) && t !== "&1" && t !== "&2") out.push(t);
  }
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g)) {
    const t = clean(m[1]!);
    if (literal(t)) out.push(t);
  }
  const segments = cmd.split(/&&|\|\||;|\n|\|/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segments) {
    const dd = seg.match(/\bdd\b[^\n]*\bof=("[^"]+"|'[^']+'|[^\s;&|()]+)/);
    if (dd) {
      const t = clean(dd[1]!);
      if (literal(t)) out.push(t);
    }
    if (/\b(cp|mv|install|rsync)\b/.test(seg)) {
      if (/[|`$*?{}[\]]/.test(seg)) continue;
      const words = seg.split(/\s+/).filter(Boolean);
      const i = words.findIndex((w) => /^(cp|mv|install|rsync)$/.test(w));
      if (i < 0) continue;
      const args = words.slice(i + 1).filter((w) => !w.startsWith("-"));
      if (args.length >= 2) {
        const t = clean(args[args.length - 1]!);
        if (literal(t)) out.push(t);
      }
    }
  }
  return out;
}

/** 按空白切词，但尊重单/双引号（路径里有空格时用户会加引号） */
function splitArgs(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 一条 rm/rmdir/shred/mv/truncate 的目标；「看不清」= 含通配符/变量/管道/多目标 */
export function deletionTargets(rawCommand: string): string[] | "unclear" {
  const cmd = rawCommand.replace(/\\\r?\n/g, " ");
  if (/\bfind\b.*-delete\b|\bxargs\b/.test(cmd)) return "unclear";
  const segments = cmd.split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean);
  const deleteSegments = segments.filter((x) => /^(rm|rmdir|shred|mv|truncate)\b/.test(x) || /\s(rm|rmdir|shred|mv|truncate)\s/.test(x));
  if (deleteSegments.length !== 1) return "unclear";
  const seg = deleteSegments[0]!;
  if (/[|`$*?{}[\]]/.test(seg) || /\bxargs\b|\bfind\b/.test(seg)) return "unclear";
  const words = splitArgs(seg);
  const i = words.findIndex((w) => /^(rm|rmdir|shred|mv|truncate)$/.test(w));
  if (i < 0) return "unclear";
  const targets = words.slice(i + 1).filter((w) => !w.startsWith("-"));
  if (targets.length === 0) return "unclear";
  if (words[i] === "mv") return targets.length === 2 ? [targets[0]!] : "unclear";
  if (targets.length > 1) return "unclear";
  return targets;
}

/** 命令里的 cd 基准（cd ~ / cd /abs） */
function cdBase(cmd: string): string | undefined {
  const m = cmd.match(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|()]+)/);
  if (!m) return undefined;
  const d = m[1]!.replace(/^["']|["']$/g, "");
  if (d === "~" || d === "$HOME" || d === "${HOME}") return HOME;
  if (d.startsWith("~/")) return join(HOME, d.slice(2));
  if (isAbsolute(d)) return resolve(d);
  return undefined;
}

function resolveCommandPath(token: string, cmd: string, workspace: string): string {
  if (token === "~") return HOME;
  if (token.startsWith("~/")) return join(HOME, token.slice(2));
  if (isAbsolute(token)) return resolve(token);
  return resolve(cdBase(cmd) ?? workspace, token);
}

/** 硬拒：任何档都不放 */
export function hardDenyReason(rawCommand: string, home: string = HOME): string | undefined {
  const cmd = rawCommand.replace(/\\\r?\n/g, " ");
  if (/(^|[\s;&|(])(sudo|doas|su)(\s|$)/.test(cmd)) return `拒绝执行 \`${cmd}\`：提权（sudo / su）任何档都不放。`;
  if (/\bgit\b.*\bpush\b.*(--force\b|\s-f\b)/.test(cmd)) return `拒绝执行 \`${cmd}\`：强推会覆盖远端历史，任何档都不放。`;
  if (NETWORK_RE.test(cmd) && CREDENTIAL_SHAPE_RE.test(cmd)) {
    return `拒绝执行 \`${cmd}\`：命令里带着私钥 / token 形状的东西还要出网，这是凭据外传的形状，任何档都不放。`;
  }
  if (/\b(mkfs|diskutil\s+erase|dd\s+if=.*of=\/dev\/|shutdown|reboot|chmod\s+-R\s+777\s+\/)/.test(cmd)) {
    return `拒绝执行 \`${cmd}\`：它会动系统或整块盘，任何档都不放。`;
  }
  if (/\bfind\s+(\/(\s|$)|\/(Users|home|etc|usr|var|bin|System|Library)\b|\$\{?HOME\}?|~(\/|\s|$))[^\n]*-delete\b/.test(cmd)) {
    return `拒绝执行 \`${cmd}\`：从根或主目录起 find -delete，任何档都不放。`;
  }
  if (DELETE_RE.test(cmd)) {
    const targets = deletionTargets(cmd);
    if (targets !== "unclear") {
      for (const t of targets) {
        const abs = resolveCommandPath(t, cmd, HM(home));
        const reason = protectedPathReason(abs, home);
        if (reason) return `拒绝执行 \`${cmd}\`：${reason}`;
      }
    } else if (/\b(rm|rmdir|shred)\b.*(\$\{?HOME\}?|~(\/|\s|$)|\s\/(\s|$|\*)|\s\/(Users|home|etc|usr|var|bin|System|Library)(\/|\s|$)|\$\([^)]*\/[^)]*\))/.test(cmd)) {
      return `拒绝执行 \`${cmd}\`：删除的目标指向主目录、根或系统目录，任何档都不放。`;
    }
  }
  return undefined;
}

function HM(home: string): string {
  return home || HOME;
}

/** 只看了一次 `write`/`edit` 的路径 */
function assessWritePath(path: string, ctx: RiskContext): Risk | undefined {
  const abs = resolve(path);
  const hard = protectedPathReason(abs);
  if (hard) return { category: "hard-deny", message: `拒绝写入 ${path}：${hard}` };
  const { inside, rel } = workspaceRelative(abs, ctx.workspace);
  if (!inside) {
    return {
      category: "outside-workspace",
      message: `拒绝写入 ${path}：它在这段会话的工作区（${ctx.workspace}）之外。请把产出写到工作区里面。`,
    };
  }
  if (rel === "data/raw" || rel.startsWith("data/raw/")) {
    return {
      category: "raw-data",
      message: `拒绝写入 ${rel}：\`data/raw/\` 是原始输入，按本项目目录约定不修改；衍生数据请写到 \`data/processed/\`。`,
    };
  }
  return undefined;
}

/** bash 命令里写入 / 删除目标的路径风险 */
function assessCommandPaths(cmd: string, ctx: RiskContext): Risk | undefined {
  const writes = writeTargets(cmd);
  const dels = deletionTargets(cmd);
  const deleteList = dels === "unclear" ? [] : dels;

  // 受保护 → 硬拒（写与删都算）
  for (const t of [...writes, ...deleteList]) {
    const abs = resolveCommandPath(t, cmd, ctx.workspace);
    const hard = protectedPathReason(abs);
    if (hard) return { category: "hard-deny", message: `拒绝执行 \`${cmd}\`：${hard}` };
  }
  // 明确写到工作区之外 → 可问
  for (const t of writes) {
    const abs = resolveCommandPath(t, cmd, ctx.workspace);
    const { inside } = workspaceRelative(abs, ctx.workspace);
    if (!inside) {
      return {
        category: "outside-workspace",
        message: `拒绝执行 \`${cmd}\`：它写到 ${t}，在这段会话的工作区（${ctx.workspace}）之外。请写到工作区里面。`,
      };
    }
  }
  return undefined;
}

/**
 * 这次调用踩到了什么。没踩到就是 undefined。
 *
 * 只认 `bash` / `write` / `edit`；`read` 不改东西，不拦（拦它只会让人以为门在干活）。
 * 不认识的工具一律放行——这是刻意的缺口，写在这里而不是藏起来。
 */
export function assessRisk(
  toolName: string,
  input: Record<string, unknown>,
  ctx: RiskContext,
): Risk | undefined {
  const tool = String(toolName || "").toLowerCase();

  if (tool === "write" || tool === "edit") {
    const path = typeof input.path === "string" ? input.path : undefined;
    return path ? assessWritePath(path, ctx) : undefined;
  }

  if (tool !== "bash") return undefined;
  const cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd.trim()) return undefined;

  // 1) 硬拒优先：任何档都不放
  const hard = hardDenyReason(cmd);
  if (hard) return { category: "hard-deny", message: hard };

  // 2) 路径风险（写/删目标）
  const pathRisk = assessCommandPaths(cmd, ctx);
  if (pathRisk) return pathRisk;

  // 3) 按「最要紧的那个」报，理由才能指向该改哪里
  if (PUBLISH_RE.test(cmd)) {
    return { category: "publish", message: `拒绝执行 \`${cmd}\`：推送到远端仓库是对外可见的动作，需要人来决定。` };
  }
  if (INSTALL_RE.test(cmd)) {
    return {
      category: "install",
      message: `拒绝执行 \`${cmd}\`：装包会改变这段会话运行的环境，已经记下的运行会因此变得不可复现。需要装的话请让人来装。`,
    };
  }
  if (DELETE_RE.test(cmd)) {
    const targets = deletionTargets(cmd);
    if (targets === "unclear") {
      return {
        category: "delete",
        cannotAsk: true,
        message: `拒绝执行 \`${cmd}\`：删除的目标里有通配符、变量、管道或多个目标，看不清会删掉什么。请改成每次一个可见的字面目标再试。`,
      };
    }
    return {
      category: "delete",
      message: `拒绝执行 \`${cmd}\`：它会删除或覆盖会话之前就有的文件，而那不可撤销。能移动到 .trash/ 或用 git rm 就别直接删。`,
    };
  }
  if (NETWORK_RE.test(cmd)) {
    return { category: "network", message: `拒绝执行 \`${cmd}\`：它要访问网络。需要的话请人来确认。` };
  }
  return undefined;
}

/**
 * 三档：硬拒任何档都拒；全放行只拦硬拒；拦下档直接拒；问一句档交给人，
 * 但「目标看不清」的删除连问都不问。
 */
export function decideByMode(mode: PermissionMode, risk: Risk | undefined): GateDecision {
  if (!risk) {
    return { action: "allow", ruleId: "risk:none", summary: "", reason: "没有命中风险判据。" };
  }
  const ruleId = `risk:${risk.category}`;
  if (risk.category === "hard-deny") {
    return { action: "deny", ruleId, summary: risk.message, reason: risk.message };
  }
  if (mode === "allow-all") {
    return { action: "allow", ruleId, summary: risk.message, reason: "完全访问：只拦硬拒清单。" };
  }
  if (mode === "deny-risky" || risk.cannotAsk) {
    return { action: "deny", ruleId, summary: risk.message, reason: risk.message };
  }
  return { action: "ask", ruleId, summary: risk.message, reason: risk.message };
}
