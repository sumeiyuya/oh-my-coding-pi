import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_POLICY,
  compileRules,
  evaluatePolicy,
  inspectScriptHead,
  normalizePolicy,
  resolvePolicyPath,
  scriptPathFromCommand,
  validatePolicy,
  type PolicyConfig,
  type PolicyDecision,
  toPermissionMode,
  type PolicyMode,
} from "@oh-my-coding-pi/shared";
import { sanitize, type AuditEntry } from "./audit.ts";
import { assessRisk, decideByMode } from "./risk.ts";
import type { GrantStore } from "./grants.ts";

export interface PolicyInfo {
  mode: PolicyMode;
  source: "workspace" | "settings" | "default";
  path: string | null;
  errors: string[];
}

export interface PolicyServiceOptions {
  getWorkspaceRoot: () => string;
  /** 当前会话标识（文件路径即可），用于会话级授权 */
  getSessionKey: () => string;
  grants: GrantStore;
  audit: (entry: AuditEntry) => void;
  onError?: (message: string) => void;
  /** 策略重新加载后通知 UI（只读横幅等） */
  onChange?: (info: PolicyInfo) => void;
  /** 设置页指定的策略文件（可选） */
  getSettingsPolicy?: () => string | undefined;
  /** 方案期门：enabled 且未 approved 时只放只读工具 */
  getPlanGate?: () => { enabled: boolean; approved: boolean };
  /** P1b2c2：runtime token → 该 runtime 的 workspace */
  resolveRuntime?: (token: string) => {
    runtimeId: string;
    workspace: string;
    sessionKey?: string;
    audit?: (entry: AuditEntry) => void;
  } | undefined;
  /**
   * 批准后的内容复核：计划文件被改/被删时返回 ok=false，并由调用方撤销批准。
   * 只在已批准且工具非只读时调用，因此不会干扰“看方案”本身。
   */
  revalidatePlan?: () => { ok: boolean; reason?: string };
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > limit) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * 策略服务：策略加载 + 规则判定 + 给权限扩展的本地 HTTP 端点。
 *
 * 失败方向一律 fail-closed：策略解析/校验失败 → mode=deny，并在 UI 报错。
 */
export class PolicyService {
  private server: Server | null = null;
  private policy: PolicyConfig = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  private compiled = { deny: [] as RegExp[], ask: [] as RegExp[] };
  private errors: string[] = [];
  private sourcePath: string | null = null;
  private source: PolicyInfo["source"] = "default";
  private watched: string | null = null;
  /** 运行期覆盖的档位（会话级 / 设置页切换）；null = 用策略文件里的 mode */
  private modeOverride: PolicyMode | null = null;

  url = "";
  token = "";

  private readonly opts: PolicyServiceOptions;

  constructor(opts: PolicyServiceOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.reload();
    this.token = randomBytes(24).toString("hex");
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("policy service listen failed");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (this.watched) {
      unwatchFile(this.watched);
      this.watched = null;
    }
  }

  info(): PolicyInfo {
    // 报生效档，不是策略文件里的档：界面看到的必须就是实际执行的
    return { mode: this.effectiveMode(), source: this.source, path: this.sourcePath, errors: [...this.errors] };
  }

  private candidatePath(): string | null {
    const root = this.opts.getWorkspaceRoot();
    if (root) {
      const file = join(root, ".omcp", "policy.json");
      if (existsSync(file)) return file;
    }
    const fromSettings = this.opts.getSettingsPolicy?.();
    if (fromSettings && existsSync(fromSettings)) return fromSettings;
    return null;
  }

  reload(): void {
    const file = this.candidatePath();
    const previous = this.watched;
    this.watched = file;
    if (file) {
      watchFile(file, { interval: 1000 }, () => this.reload());
    }
    if (previous && previous !== file) unwatchFile(previous);

    if (!file) {
      this.policy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
      this.compiled = {
        deny: compileRules(this.policy.commands.deny),
        ask: compileRules(this.policy.commands.ask),
      };
      this.errors = [];
      this.source = "default";
      this.sourcePath = null;
      this.opts.onChange?.(this.info());
      return;
    }

    this.sourcePath = file;
    this.source = /[\\/]\.omcp[\\/]policy\.json$/i.test(file) ? "workspace" : "settings";
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const errors = validatePolicy(raw);
      if (errors.length > 0) {
        this.failClosed(errors, file);
        this.opts.onChange?.(this.info());
        return;
      }
      const policy = normalizePolicy(raw);
      if (policy.mode === "deny") {
        this.policy = policy;
        this.compiled = { deny: [], ask: [] };
        this.errors = [];
        return;
      }
      this.policy = policy;
      this.compiled = {
        deny: compileRules(policy.commands.deny),
        ask: compileRules(policy.commands.ask),
      };
      this.errors = [];
      this.opts.onChange?.(this.info());
    } catch (err) {
      this.failClosed([(err as Error).message], file);
    }
  }

  private failClosed(errors: string[], file: string): void {
    this.policy = { ...JSON.parse(JSON.stringify(DEFAULT_POLICY)), mode: "deny" };
    this.compiled = { deny: [], ask: [] };
    this.errors = errors;
    this.opts.onError?.(
      sanitize(`权限策略不可用，已切换到 fail-closed（全部拒绝）：${file} — ${errors.join("；")}`),
    );
  }

  /** 判定一次工具调用；ask 是否已被授权在此处理 */
  /** 档位现取，不缓存：改完档下一次工具调用就生效，不用重建任何东西 */
  private effectiveMode(): PolicyMode {
    return this.modeOverride ?? this.policy.mode;
  }

  /** 切档（会话级覆盖）；传 null 表示回到策略文件里的 mode */
  setMode(mode: PolicyMode | null): PolicyInfo {
    this.modeOverride = mode;
    const info = this.info();
    this.opts.onChange?.(info);
    return info;
  }

  decide(
    toolName: string,
    input: Record<string, unknown>,
    opts?: { readOnly?: boolean },
    ctx?: {
      runtimeId?: string;
      workspaceRoot?: string;
      sessionKey?: string;
      audit?: (entry: AuditEntry) => void;
    },
  ): PolicyDecision {
    const root = ctx?.workspaceRoot ?? this.opts.getWorkspaceRoot();

    // 方案期：默认拒一切非只读操作（fail-closed 的同族规则）
    const gate = this.opts.getPlanGate?.();
    if (gate?.enabled) {
      const readonly = ["read", "grep", "find", "ls", "glob"];
      // 只信 mcp__ 前缀的 readOnlyHint：其它工具不能自称只读来绕过方案期
      const readOnlyMcp = toolName.startsWith("mcp__") && opts?.readOnly === true;
      if (!readonly.includes(toolName) && !readOnlyMcp) {
        const summary = String(
          input.code ?? input.command ?? input.path ?? toolName,
        ).slice(0, 200);
        if (!gate.approved) {
          const decision: PolicyDecision = {
            action: "deny",
            ruleId: "plan:readonly",
            summary,
            reason: "方案期只读：先写方案（.omcp/plans/），批准后再执行写操作。",
          };
          this.auditDecision(decision, "deny", "plan", toolName, ctx?.audit);
          return decision;
        }
        // 已批准：确认批准的仍是“这份内容”（P1-01）
        const drift = this.opts.revalidatePlan?.();
        if (drift && !drift.ok) {
          const decision: PolicyDecision = {
            action: "deny",
            ruleId: "plan:drift",
            summary,
            reason: `方案内容已变更（${drift.reason ?? "与批准时不一致"}），批准已撤销；重新批准后再执行写操作。`,
          };
          this.auditDecision(decision, "deny", "plan", toolName, ctx?.audit);
          return decision;
        }
      }
    }
    /**
     * 风险层（照 DAWN 的 看风险 / 照这一档）：
     * - 硬拒任何档都拒（包括旧档），放在策略引擎之前；
     * - 三档下，风险命中 ask 时走既有授权流程，命中 deny 时直接拒；
     * - 旧档（ask/allow/readonly/deny）保持原行为，不被风险层改写。
     */
    const effective = this.effectiveMode();
    const riskMode = toPermissionMode(effective);
    const risk = assessRisk(toolName, input ?? {}, { workspace: root });
    if (risk?.category === "hard-deny") {
      const denied: PolicyDecision = {
        action: "deny",
        ruleId: "risk:hard-deny",
        summary: risk.message,
        reason: risk.message,
      };
      this.auditDecision(denied, "deny", "risk", toolName, ctx?.audit);
      return denied;
    }
    const riskGate = riskMode ? decideByMode(riskMode, risk) : null;

    let decision: PolicyDecision;
    if (riskGate?.action === "deny") {
      const denied: PolicyDecision = {
        action: "deny",
        ruleId: riskGate.ruleId,
        summary: riskGate.summary,
        reason: riskGate.reason,
      };
      this.auditDecision(denied, "deny", "risk", toolName, ctx?.audit);
      return denied;
    }
    if (riskGate?.action === "ask") {
      decision = {
        action: "ask",
        ruleId: riskGate.ruleId,
        summary: riskGate.summary,
        reason: riskGate.reason,
      };
    } else try {
      const engineMode = riskMode === "allow-all" ? "allow" : riskMode ? "ask" : effective;
      decision = evaluatePolicy(
        { ...this.policy, mode: engineMode },
        {
          toolName,
          input,
          workspaceRoot: root,
          ...(opts?.readOnly ? { readOnly: true } : {}),
        },
        this.compiled,
      );
    } catch (err) {
      decision = {
        action: "deny",
        ruleId: "engine:error",
        summary: String(toolName),
        reason: `策略引擎异常，按 fail-closed 拒绝：${(err as Error).message}`,
      };
    }

    if (decision.action === "allow" && toolName === "bash") {
      const script = this.inspectScript(String(input.command ?? ""), root);
      if (script) return script;
    }

    if (decision.action === "ask") {
      const sessionKey = ctx?.sessionKey ?? this.opts.getSessionKey();
      if (root && this.opts.grants.has(root, decision.ruleId, sessionKey)) {
        const granted: PolicyDecision = {
          ...decision,
          action: "allow",
          reason: `命中已授权规则 ${decision.ruleId}。`,
        };
        this.auditDecision(decision, "allow", "grant", toolName, ctx?.audit);
        return granted;
      }
      return decision;
    }

    // 技能使用标注：读 SKILL.md 或调用 use_skill 时，审计摘要带上技能名
    const skill = skillFromCall(toolName, input);
    const annotated = skill
      ? { ...decision, summary: `skill:${skill} · ${decision.summary}` }
      : decision;
    const kind: "allow" | "deny" = annotated.action === "deny" ? "deny" : "allow";

    this.auditDecision(annotated, kind, "policy", toolName, ctx?.audit);
    return annotated;
  }

  /**
   * 脚本内删除的启发式提示：命令只写了 `bash x.sh`，删除逻辑在文件里。
   * 只读前 4KB、只认几种模式；读不到就明说“无法检查”。不是安全保证（r8）。
   */
  private inspectScript(command: string, root: string): PolicyDecision | null {
    const raw = scriptPathFromCommand(command);
    if (!raw) return null;
    const abs = resolvePolicyPath(raw, root);
    const rootPosix = root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    if (rootPosix && !abs.toLowerCase().startsWith(rootPosix + "/") && abs.toLowerCase() !== rootPosix) {
      return null;
    }
    let head = "";
    try {
      head = readFileSync(abs, "utf8").slice(0, 4096);
    } catch {
      return {
        action: "ask",
        ruleId: "script:unreadable",
        summary: raw,
        reason: "命令要执行的脚本读不到，无法检查内容；按需要确认处理。",
      };
    }
    const label = inspectScriptHead(head);
    if (!label) return null;
    return {
      action: "ask",
      ruleId: "script:danger",
      summary: `脚本 ${raw}`,
      reason: `脚本内容命中「${label}」。这是启发式检查（只读前 4KB），不构成安全保证。`,
    };
  }

  auditDecision(
    decision: PolicyDecision,
    kind: "allow" | "deny" | "timeout",
    scope: string,
    toolName: string,
    audit?: (entry: AuditEntry) => void,
  ): void {
    (audit ?? this.opts.audit)({
      ts: new Date().toISOString(),
      toolName,
      ruleId: decision.ruleId,
      decision: kind,
      scope,
      summary: decision.summary || decision.reason,
      source: this.source,
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorization = req.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const runtime = this.opts.resolveRuntime?.(token);
    const legacy = token !== "" && token === this.token;
    if (!runtime && !legacy) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const path = (req.url || "/").split("?")[0];

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...this.info() }));
      return;
    }

    if (req.method === "POST" && path === "/reload") {
      this.reload();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...this.info() }));
      return;
    }

    if (req.method === "POST" && path === "/decide") {
      const raw = await readBody(req);
      const body = (raw ? JSON.parse(raw) : {}) as {
        toolName?: unknown;
        input?: unknown;
        readOnly?: unknown;
      };
      if (typeof body.toolName !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "toolName is required" }));
        return;
      }
      const input =
        body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
      const decision = this.decide(
        body.toolName,
        input,
        body.readOnly === true ? { readOnly: true } : undefined,
        runtime ? { runtimeId: runtime.runtimeId, workspaceRoot: runtime.workspace } : undefined,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, decision, policy: this.info() }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }
}

/** 从工具调用里识别“正在使用哪个技能”；识别不到返回空串 */
export function skillFromCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "use_skill") {
    const direct = input?.name ?? input?.skill ?? input?.id;
    return typeof direct === "string" ? direct : "";
  }
  const raw = typeof input?.path === "string" ? input.path : "";
  const norm = raw.split(String.fromCharCode(92)).join("/");
  const m = /\/\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(norm);
  return m ? m[1] : "";
}
