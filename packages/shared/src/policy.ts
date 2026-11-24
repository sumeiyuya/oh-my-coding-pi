import type { PolicyConfig, PolicyMode } from "./protocol";

/**
 * 策略引擎：纯函数、无 Node 依赖。
 *
 * 设计要点
 * - 判定顺序：mode(deny) → tools.deny → mode(readonly) → 命令/路径/run_code → tools.allow → 默认
 * - deny 永远优先于 ask；模式 allow 只跳过 ask，不跳过 deny（调试模式也不能删库）
 * - 输出 decision 带有 ruleId，审批授权按 ruleId 记录（ADR-006）
 */

export const READONLY_TOOLS = ["read", "grep", "find", "ls", "glob"] as const;

export const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  mode: "ask",
  tools: {
    allow: ["read", "grep", "find", "ls", "glob", "edit", "write", "bash", "run_code", "memory_list", "browser_status", "browser_snapshot", "browser_elements", "subagent"],
    deny: [],
  },
  paths: {
    allowWrite: ["<workspace>/**"],
    denyWrite: [".env", "**/.env", "**/.git/**", "**/node_modules/**", "C:/Windows/**"],
    denyRead: ["**/.ssh/**", "**/.aws/**", "**/.gnupg/**"],
  },
  commands: {
    deny: [
      "\\bsudo\\b",
      "curl[^|]*\\|\\s*(sh|bash)",
      "\\brm\\s+[^\\n|;&]*(\\s/|\\s~)(\\s|$)",
      "[Ff]ormat\\s+[a-zA-Z]:",
      "\\b(shutdown|reboot)\\b",
    ],
    ask: [
      "\\brm\\s+[^\\n|;&]*-[a-zA-Z]*([rR][a-zA-Z]*[fF]|[fF][a-zA-Z]*[rR])[a-zA-Z]*",
      "\\brm\\s+[^\\n|;&]*-[a-zA-Z]*[rR][a-zA-Z]*\\s+[^\\n|;&]*-[a-zA-Z]*[fF][a-zA-Z]*",
      "\\brm\\s+[^\\n|;&]*-[a-zA-Z]*[fF][a-zA-Z]*\\s+[^\\n|;&]*-[a-zA-Z]*[rR][a-zA-Z]*",
      "\\brm\\s+[^\\n|;&]*--[a-zA-Z]*recursive[^\\n|;&]*--[a-zA-Z]*force",
      "\\brm\\s+[^\\n|;&]*--[a-zA-Z]*force[^\\n|;&]*--[a-zA-Z]*recursive",
      "\\bRemove-Item\\b[^\\n|;&]*-[a-zA-Z]*([rR]ecurse|[fF]orce)",
      "\\brd\\s+[^\\n|;&]*\\/s\\b",
      "\\brmdir\\s+[^\\n|;&]*\\/s\\b",
      "\\bdel\\s+[^\\n|;&]*\\/s\\b",
      "\\b(shutil\\s*\\.\\s*rmtree|os\\s*\\.\\s*(remove|unlink|rmdir|removedirs))\\b",
      "\\bgit\\s+push\\b",
      "\\bpip\\s+install\\b",
      "\\bconda\\s+install\\b",
    ],
  },
  runCode: {
    requireApproval: true,
    timeoutSec: 120,
    maxOutputChars: 20000,
  },
  audit: {
    enabled: true,
  },
};

/**
 * run_code 里的高危 API。这些不走 policy.json（schema 没有该字段），
 * 是引擎内置的兜底：命中即视为需要审批，只读模式下直接拒绝。
 */
export const DANGEROUS_CODE_PATTERNS: readonly RegExp[] = [
  /\bshutil\s*\.\s*rmtree\b/i,
  /\bos\s*\.\s*(remove|unlink|rmdir|removedirs)\b/i,
  /\bsubprocess\s*\./i,
  /\bos\s*\.\s*(system|popen|execv?[a-z]*)\b/i,
  /\bPath\s*\([^)]*\)\s*\.\s*unlink\b/i,
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\bRemove-Item\b/i,
  /\brd\s+\/s\b/i,
];

export type PolicyAction = "allow" | "deny" | "ask";

export interface PolicyTarget {
  toolName: string;
  input: Record<string, unknown>;
  /** 工作区绝对路径；用于解析相对路径与 <workspace> 占位符 */
  workspaceRoot: string;
  /**
   * 工具元数据里声明了 readOnlyHint（目前只用于 mcp__ 前缀）。
   * 只影响只读模式与方案期门；不改变 deny / ask 的其它判据。
   */
  readOnly?: boolean;
}

export interface PolicyDecision {
  action: PolicyAction;
  /** 命中的规则 id，例如 cmd:deny:0 / path:denyWrite:1 / mode:readonly */
  ruleId: string;
  /** 原始命令或操作摘要（≤200 字），给审批弹窗与审计 */
  summary: string;
  /** 给模型/用户看的原因 */
  reason: string;
}

const SUMMARY_LIMIT = 200;

function clamp(text: string): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= SUMMARY_LIMIT ? s : s.slice(0, SUMMARY_LIMIT) + "…";
}

/** 统一成 `C:/a/b` 形式；解析 `.`/`..`；去尾斜杠 */
export function normalizePath(input: string): string {
  let p = String(input ?? "").replace(/\\/g, "/");
  if (!p) return p;
  const drive = /^([a-zA-Z]):/.exec(p);
  let prefix = "";
  if (drive) {
    prefix = drive[1].toLowerCase() + ":";
    p = p.slice(2);
  } else if (p.startsWith("//")) {
    prefix = "//";
    p = p.slice(1);
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!prefix) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (prefix === "//") return "//" + joined;
  if (prefix) return prefix + "/" + joined;
  return joined || "/";
}

/** 把策略里的路径（含 `<workspace>` 占位符）解析成绝对路径；以 `**` 开头视为绝对模式 */
export function resolvePolicyPath(pattern: string, workspaceRoot: string): string {
  const root = normalizePath(workspaceRoot);
  let p = String(pattern ?? "").replace(/\\/g, "/");
  if (p.startsWith("<workspace>")) {
    p = root + p.slice("<workspace>".length);
  } else if (!/^([a-zA-Z]:|\/|\*\*)/.test(p)) {
    p = root + "/" + p;
  }
  return normalizePath(p);
}

export type PathPatternScope = "workspace" | "absolute" | "relative";

/**
 * 三种写法：
 * - 以 `<workspace>` 开头：工作区绝对路径
 * - 绝对路径（盘符、根斜杠）或以双星号开头：按绝对路径匹配，双星号表示任意位置
 * - 其他（如 `data/*.csv`、`.env`）：工作区相对路径
 */
export function classifyPathPattern(pattern: string): PathPatternScope {
  const p = String(pattern ?? "").replace(/\\/g, "/").trim();
  if (p.startsWith("<workspace>")) return "workspace";
  if (/^([a-zA-Z]:|\/|\*\*)/.test(p)) return "absolute";
  return "relative";
}

export function relativeToRoot(path: string, workspaceRoot: string): string | null {
  const p = normalizePath(path);
  const root = normalizePath(workspaceRoot);
  if (p.toLowerCase() === root.toLowerCase()) return "";
  const prefix = (root.endsWith("/") ? root : root + "/").toLowerCase();
  if (!p.toLowerCase().startsWith(prefix)) return null;
  return p.slice(prefix.length);
}

/** glob → RegExp（大小写不敏感；`**` 跨目录，`*` 不跨目录） */
export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$", "i");
}

export function matchPathPattern(pattern: string, targetPath: string, workspaceRoot: string): boolean {
  const target = resolvePolicyPath(targetPath, workspaceRoot);
  if (classifyPathPattern(pattern) === "relative") {
    const rel = relativeToRoot(target, workspaceRoot);
    if (rel === null) return false;
    return globToRegExp(String(pattern).replace(/\\/g, "/")).test(rel);
  }
  return globToRegExp(resolvePolicyPath(pattern, workspaceRoot)).test(target);
}

/** 编译策略里的正则；非法正则直接报错，由加载层 fail-closed */
export function compileRules(patterns: readonly string[]): RegExp[] {
  return patterns.map((p, i) => {
    try {
      return new RegExp(p);
    } catch (err) {
      throw new Error(`policy.commands 第 ${i} 条正则非法：${(err as Error).message}`);
    }
  });
}

/**
 * 工具名匹配：不含 `*` 的条目按精确匹配（旧策略含义不变）；
 * 含 `*` 的条目按 glob（如 `mcp__fs__read_*`、`mcp__danger__*`）。
 */
export function toolPatternMatches(pattern: string, tool: string): boolean {
  const p = String(pattern ?? "").trim();
  if (!p) return false;
  if (!p.includes("*")) return p === tool;
  return globToRegExp(p).test(tool);
}

/** `mcp__fs__read` → `fs`；不是 MCP 工具或名字不完整 → null */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const split = rest.indexOf("__");
  if (split <= 0 || split >= rest.length - 2) return null;
  return rest.slice(0, split);
}

function normalizeToolName(name: string): string {
  return String(name ?? "").trim();
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const v = input?.[key];
  return typeof v === "string" ? v : "";
}

function firstMatch(rules: RegExp[], text: string): number {
  for (let i = 0; i < rules.length; i++) {
    rules[i].lastIndex = 0;
    if (rules[i].test(text)) return i;
  }
  return -1;
}

/**
 * 核心判定。`policy` 必须已经过 normalizePolicy。
 */
export function evaluatePolicy(
  policy: PolicyConfig,
  target: PolicyTarget,
  compiled?: { deny: RegExp[]; ask: RegExp[] },
): PolicyDecision {
  const mode: PolicyMode = policy.mode;
  const tool = normalizeToolName(target.toolName);
  const root = target.workspaceRoot || processCwd();
  const denyCmds = compiled?.deny ?? compileRules(policy.commands.deny);
  const askCmds = compiled?.ask ?? compileRules(policy.commands.ask);

  if (mode === "deny") {
    return {
      action: "deny",
      ruleId: "mode:deny",
      summary: tool,
      reason: "当前策略模式为 deny，所有工具调用被拒绝。",
    };
  }

  if (policy.tools.deny.some((pattern) => toolPatternMatches(pattern, tool))) {
    return {
      action: "deny",
      ruleId: "tool:deny",
      summary: tool,
      reason: `工具 ${tool} 在策略 tools.deny 中。`,
    };
  }

  const readOnlyMcp = tool.startsWith("mcp__") && target.readOnly === true;
  if (
    mode === "readonly" &&
    !(READONLY_TOOLS as readonly string[]).includes(tool) &&
    !readOnlyMcp
  ) {
    return {
      action: "deny",
      ruleId: "mode:readonly",
      summary: tool,
      reason: `只读模式只允许 ${READONLY_TOOLS.join(" / ")}；${tool} 被拒绝。`,
    };
  }

  if (tool === "bash") {
    const command = stringInput(target.input, "command");
    const summary = clamp(command);
    const denyHit = firstMatch(denyCmds, command);
    if (denyHit >= 0) {
      return {
        action: "deny",
        ruleId: `cmd:deny:${denyHit}`,
        summary,
        reason: `命令命中拒绝规则 #${denyHit}。`,
      };
    }
    const askHit = firstMatch(askCmds, command);
    if (askHit >= 0 && mode !== "allow") {
      return {
        action: "ask",
        ruleId: `cmd:ask:${askHit}`,
        summary,
        reason: `命令命中需确认规则 #${askHit}。`,
      };
    }
  }

  if (tool === "write" || tool === "edit") {
    const rawPath = stringInput(target.input, "path");
    const path = resolvePolicyPath(rawPath, root);
    const summary = clamp(rawPath);
    for (let i = 0; i < policy.paths.denyWrite.length; i++) {
      if (matchPathPattern(policy.paths.denyWrite[i], rawPath, root)) {
        return {
          action: "deny",
          ruleId: `path:denyWrite:${i}`,
          summary,
          reason: `路径命中 denyWrite 规则 #${i}：${policy.paths.denyWrite[i]}`,
        };
      }
    }
    const allowWrite = policy.paths.allowWrite;
    if (allowWrite.length > 0) {
      const hit = allowWrite.some((p) => matchPathPattern(p, rawPath, root));
      if (!hit && mode !== "allow") {
        return {
          action: "ask",
          ruleId: "path:allowWrite",
          summary,
          reason: "路径不在 allowWrite 白名单内。",
        };
      }
    }
  }

  if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls" || tool === "glob") {
    const rawPath = stringInput(target.input, "path") || stringInput(target.input, "pattern");
    if (rawPath) {
      const path = resolvePolicyPath(rawPath, root);
      for (let i = 0; i < policy.paths.denyRead.length; i++) {
        if (matchPathPattern(policy.paths.denyRead[i], rawPath, root)) {
          return {
            action: "deny",
            ruleId: `path:denyRead:${i}`,
            summary: clamp(rawPath),
            reason: `路径命中 denyRead 规则 #${i}。`,
          };
        }
      }
    }
  }

  if (tool === "run_code") {
    const code = stringInput(target.input, "code");
    const summary = clamp(code);
    if (mode === "readonly") {
      return {
        action: "deny",
        ruleId: "mode:readonly",
        summary,
        reason: "只读模式下 run_code 直接拒绝（不做代码静态分析）。",
      };
    }
    const danger = DANGEROUS_CODE_PATTERNS.findIndex((r) => r.test(code));
    if (danger >= 0) {
      return {
        action: "ask",
        ruleId: `runCode:danger:${danger}`,
        summary,
        reason: "代码包含删除文件、启动子进程或执行系统命令的调用。",
      };
    }
    if (policy.runCode.requireApproval && mode !== "allow") {
      return {
        action: "ask",
        ruleId: "runCode:requireApproval",
        summary,
        reason: "策略要求 run_code 执行前确认。",
      };
    }
  }

  /**
   * 服务器声明只读的 MCP 工具：不占「未列出工具」的审批。
   * tools.deny 已在前面生效，显式拒绝仍然优先。
   * readOnlyHint 是服务器自报的，不构成安全保证；信任服务器时已经接受这一点。
   */
  if (
    tool.startsWith("mcp__") &&
    target.readOnly === true &&
    policy.tools.allow.length > 0 &&
    !policy.tools.allow.some((pattern) => toolPatternMatches(pattern, tool))
  ) {
    return {
      action: "allow",
      ruleId: "mcp:readonly",
      summary: tool,
      reason: "MCP 服务器声明该工具只读，放行。",
    };
  }

  if (
    policy.tools.allow.length > 0 &&
    !policy.tools.allow.some((pattern) => toolPatternMatches(pattern, tool)) &&
    mode !== "allow"
  ) {
    const server = mcpServerOf(tool);
    return {
      action: "ask",
      ruleId: server ? `tool:unlisted:mcp__${server}` : "tool:unlisted",
      summary: tool,
      reason: `工具 ${tool} 不在 tools.allow 白名单内。`,
    };
  }

  const fallbackSummary =
    tool === "bash"
      ? stringInput(target.input, "command")
      : tool === "run_code"
        ? stringInput(target.input, "code")
        : stringInput(target.input, "path") || tool;

  return {
    action: "allow",
    ruleId: "default",
    summary: clamp(fallbackSummary || tool),
    reason: "未命中任何限制规则。",
  };
}


/* ------------------------------------------------------------------ */
/* 脚本内容检查（启发式，不是安全保证）                                */
/* ------------------------------------------------------------------ */

/** 从 bash 命令里取出要执行的脚本路径；取不到返回 null */
export function scriptPathFromCommand(command: string): string | null {
  const m =
    /(?:^|[|;&]\s*)(?:bash|sh|zsh|python3?|node|Rscript)\s+(?:"([^"]+)"|'([^']+)'|(\S+\.(?:sh|py|R|r|js|mjs)))/i.exec(
      String(command ?? ""),
    );
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

export const SCRIPT_DANGER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF]/i, "递归删除"],
  [/\bshutil\s*\.\s*rmtree\b/i, "shutil.rmtree"],
  [/\bos\s*\.\s*(remove|unlink|rmdir|removedirs)\b/i, "os.remove 系列"],
  [/\bRemove-Item\b[^\n]*-[a-zA-Z]*(recurse|force)/i, "PowerShell 删除"],
  [/\bfs\s*\.\s*(rm|unlink)(Sync)?\b/i, "Node fs 删除"],
  [/\bunlinkSync\b/, "unlinkSync"],
  [/\bsubprocess\s*\./i, "subprocess"],
  [/\bos\s*\.\s*system\b/i, "os.system"],
];

/** 只检查脚本开头（4KB 以内）；返回命中的说明，未命中返回 null */
export function inspectScriptHead(head: string): string | null {
  for (const [re, label] of SCRIPT_DANGER_PATTERNS) {
    if (re.test(head)) return label;
  }
  return null;
}

function processCwd(): string {
  const g = globalThis as { process?: { cwd?: () => string } };
  return g.process?.cwd?.() ?? "/";
}

/**
 * 校验策略。缺字段不算错误（由 normalizePolicy 回落默认值）；
 * 只有“写了但写错”的字段才报错，由加载层 fail-closed。
 */
export function validatePolicy(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return ["策略必须是 JSON 对象"];
  const obj = raw as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) errors.push("version 必须是 1");
  const modes = ["ask", "allow", "deny", "readonly"];
  if (obj.mode !== undefined && (typeof obj.mode !== "string" || !modes.includes(obj.mode))) {
    errors.push(`mode 必须是 ${modes.join(" / ")} 之一`);
  }
  const tools = obj.tools as Record<string, unknown> | undefined;
  if (tools !== undefined) {
    if (!tools || typeof tools !== "object") {
      errors.push("tools 必须是对象");
    } else {
      for (const key of ["allow", "deny"]) {
        if (tools[key] !== undefined && !Array.isArray(tools[key])) {
          errors.push(`tools.${key} 必须是字符串数组`);
        }
      }
    }
  }
  const paths = obj.paths as Record<string, unknown> | undefined;
  if (paths !== undefined) {
    if (!paths || typeof paths !== "object") {
      errors.push("paths 必须是对象");
    } else {
      for (const key of ["allowWrite", "denyWrite", "denyRead"]) {
        if (paths[key] !== undefined && !Array.isArray(paths[key])) {
          errors.push(`paths.${key} 必须是字符串数组`);
        }
      }
    }
  }
  const commands = obj.commands as Record<string, unknown> | undefined;
  if (commands !== undefined) {
    if (!commands || typeof commands !== "object") {
      errors.push("commands 必须是对象");
    } else {
      for (const key of ["deny", "ask"]) {
        const list = commands[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          errors.push(`commands.${key} 必须是字符串数组`);
          continue;
        }
        list.forEach((pattern, i) => {
          if (typeof pattern !== "string") {
            errors.push(`commands.${key}[${i}] 必须是字符串`);
            return;
          }
          try {
            new RegExp(pattern);
          } catch (err) {
            errors.push(`commands.${key}[${i}] 正则非法：${(err as Error).message}`);
          }
        });
      }
    }
  }
  const runCode = obj.runCode as Record<string, unknown> | undefined;
  if (runCode !== undefined) {
    if (!runCode || typeof runCode !== "object") {
      errors.push("runCode 必须是对象");
    } else {
      if (
        runCode.requireApproval !== undefined &&
        typeof runCode.requireApproval !== "boolean"
      ) {
        errors.push("runCode.requireApproval 必须是布尔");
      }
      if (runCode.timeoutSec !== undefined) {
        const timeout = Number(runCode.timeoutSec);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
          errors.push("runCode.timeoutSec 必须是 1–600 的整数");
        }
      }
      if (runCode.maxOutputChars !== undefined) {
        const maxOut = Number(runCode.maxOutputChars);
        if (!Number.isInteger(maxOut) || maxOut < 1000 || maxOut > 1_000_000) {
          errors.push("runCode.maxOutputChars 必须是 1000–1000000 的整数");
        }
      }
    }
  }
  const audit = obj.audit as Record<string, unknown> | undefined;
  if (audit !== undefined) {
    if (!audit || typeof audit !== "object") errors.push("audit 必须是对象");
    else if (audit.enabled !== undefined && typeof audit.enabled !== "boolean") {
      errors.push("audit.enabled 必须是布尔");
    }
  }
  return errors;
}

/**
 * 以 DEFAULT_POLICY 为底，把用户策略的每个已知字段覆盖上去。
 * 校验由 validatePolicy 负责；这里不抛错（非法字段已在校验阶段拦下）。
 */
export function normalizePolicy(raw: unknown): PolicyConfig {
  const base: PolicyConfig = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (obj.version === 1) base.version = 1;
  if (typeof obj.mode === "string") base.mode = obj.mode as PolicyMode;
  const tools = obj.tools as Record<string, unknown> | undefined;
  if (tools && typeof tools === "object") {
    if (Array.isArray(tools.allow)) base.tools.allow = tools.allow.map(String);
    if (Array.isArray(tools.deny)) base.tools.deny = tools.deny.map(String);
  }
  const paths = obj.paths as Record<string, unknown> | undefined;
  if (paths && typeof paths === "object") {
    for (const key of ["allowWrite", "denyWrite", "denyRead"] as const) {
      if (Array.isArray(paths[key])) base.paths[key] = (paths[key] as unknown[]).map(String);
    }
  }
  const commands = obj.commands as Record<string, unknown> | undefined;
  if (commands && typeof commands === "object") {
    if (Array.isArray(commands.deny)) base.commands.deny = commands.deny.map(String);
    if (Array.isArray(commands.ask)) base.commands.ask = commands.ask.map(String);
  }
  const runCode = obj.runCode as Record<string, unknown> | undefined;
  if (runCode && typeof runCode === "object") {
    if (typeof runCode.requireApproval === "boolean") {
      base.runCode.requireApproval = runCode.requireApproval;
    }
    if (Number.isInteger(Number(runCode.timeoutSec))) {
      base.runCode.timeoutSec = Number(runCode.timeoutSec);
    }
    if (Number.isInteger(Number(runCode.maxOutputChars))) {
      base.runCode.maxOutputChars = Number(runCode.maxOutputChars);
    }
  }
  const audit = obj.audit as Record<string, unknown> | undefined;
  if (audit && typeof audit === "object" && typeof audit.enabled === "boolean") {
    base.audit.enabled = audit.enabled;
  }
  return base;
}
