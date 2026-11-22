/**
 * MCP 配置服务（P1）。
 *
 * 这里**不实现 MCP 协议**：连接、工具发现、调用、重连都由 pi 的 `builtin:mcp`
 * 完成。本模块只做五件事：
 *
 * 1. 读写 `<agentDir>/mcp.json`：保留未知字段、原子写、写后读回校验、失败回滚；
 * 2. 密钥：配置文件里只写 `${OMCP_MCP_<SERVER>_<KEY>}`，值进 SecretStore
 *    （键名 `mcp:<server>:<key>`），启动 pi / 跑状态检查时注入环境变量；
 * 3. 状态：调 `pi mcp list --json`，映射成 unchecked / checking / ready /
 *    failed / disabled 五态（pi 自己的 state 原样透传）；
 * 4. 信任：按「服务器名 + 命令/URL 指纹」记录，存在应用自己的文件里，
 *    不写进 mcp.json，也不读项目文件；
 * 5. 指纹：命令或 URL 发生变化 = 另一台服务器，旧信任自动失效。
 *
 * 失败方向：写不进去就回滚；检查失败不抛给 UI，而是落成每台服务器的
 * `failed + error`，并往 problems 里加一条可读原因。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  McpExposure,
  McpListView,
  McpLoginResult,
  McpServerView,
  McpState,
  McpToolView,
} from "@oh-my-coding-pi/shared";

/** pi 的服务器名规则：字母、数字、下划线、连字符；太长会撑坏工具名 */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXPOSURES: readonly McpExposure[] = ["direct", "deferred", "codemode", "hidden"];
const CHECK_TIMEOUT_MS = 90_000;
/** `${VAR}`：用户自己注入的环境变量（不动它） */
const PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface SecretStoreLike {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
}

export interface PiEntry {
  kind: "node" | "bin" | "path";
  entry: string;
}

export interface McpListRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface McpServiceOptions {
  /** `<PI_CODING_AGENT_DIR>` 或 `~/.pi/agent` */
  agentDir: () => string;
  /** pi 的工作区；项目级 `.pi/mcp.json` 的判定基于它 */
  workspaceRoot: () => string;
  secrets: () => SecretStoreLike | null;
  /** 解析 pi 入口；null = 解析失败 */
  piEntry: () => PiEntry | null;
  /** 信任文件（omcp 自己的，不写进 mcp.json） */
  trustFile: () => string;
  /** 配置写成功后回调；宿主决定是否重启 pi */
  onConfigSaved?: () => void;
  /** 状态检查；测试注入，默认 spawn pi */
  runList?: (env: NodeJS.ProcessEnv, cwd: string) => Promise<McpListRun>;
  /** OAuth 登录；测试注入，默认 spawn `pi mcp login` */
  runLogin?: (name: string) => Promise<McpListRun>;
}

interface SecretRef {
  /** env 键名 / header 名 */
  key: string;
  /** 真正注入的环境变量名 */
  envVar: string;
  /** 配置里写的是明文（尚未迁进密钥库） */
  literal: boolean;
}

interface ParsedServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  cwd?: string;
  enabled: boolean;
  exposure: McpExposure;
  description?: string;
  fingerprint: string;
  refs: SecretRef[];
}

type Parsed = { ok: true; server: ParsedServer } | { ok: false; error: string };

interface CachedStatus {
  state: McpState;
  error?: string;
  tools: McpToolView[];
}

/** 密钥在 SecretStore 里的键名：`mcp:<server>:<key>` */
export function mcpSecretKey(server: string, key: string): string {
  return `mcp:${server}:${key}`;
}

/** 密钥注入 pi 进程时用的环境变量名 */
export function mcpSecretEnvName(server: string, key: string): string {
  const s = server.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const k = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `OMCP_MCP_${s}_${k}`;
}

/** 指纹：命令或 URL 变了就是另一台，信任不继承 */
export function mcpFingerprint(raw: {
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        raw.command ?? "",
        raw.args ?? [],
        raw.url ?? "",
        raw.cwd ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** 从 pi 的登录输出里抓第一个 http(s) 地址（浏览器没自动弹时给用户点） */
export function firstHttpUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s"'<>]+/i.exec(String(text ?? ""));
  return match?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseServer(name: string, value: unknown): Parsed {
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: `「${name}」名字不合法：只能用字母、数字、下划线、连字符（1–64 个字符）`,
    };
  }
  if (!isRecord(value)) return { ok: false, error: `「${name}」的配置必须是对象` };

  const command = typeof value.command === "string" ? value.command.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (command && url) {
    return { ok: false, error: `「${name}」同时给了 command 和 url：只能二选一` };
  }
  if (!command && !url) {
    return { ok: false, error: `「${name}」需要 command（本地）或 url（远程）` };
  }

  const type = value.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
    return { ok: false, error: `「${name}」的 type 只能是 stdio、http 或 streamable-http` };
  }
  if (type === "stdio" && !command) return { ok: false, error: `「${name}」type=stdio 但没有 command` };
  if ((type === "http" || type === "streamable-http") && !url) {
    return { ok: false, error: `「${name}」type=${String(type)} 但没有 url` };
  }

  const args: string[] = [];
  if (value.args !== undefined) {
    if (!Array.isArray(value.args)) return { ok: false, error: `「${name}」的 args 必须是字符串数组` };
    for (const arg of value.args) {
      if (typeof arg !== "string") return { ok: false, error: `「${name}」的 args 里只能放字符串` };
      args.push(arg);
    }
  }

  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined;

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { ok: false, error: `「${name}」的 enabled 必须是 true / false` };
  }
  const enabled = value.enabled !== false;

  const exposureRaw = value.exposure;
  if (exposureRaw !== undefined && !EXPOSURES.includes(exposureRaw as McpExposure)) {
    return {
      ok: false,
      error: `「${name}」的 exposure 只能是 ${EXPOSURES.join(" / ")}`,
    };
  }
  // 读取时保持 pi 的默认值；新建保存时在 save() 里默认 direct
  const exposure = (exposureRaw ?? "codemode") as McpExposure;

  if (value.timeout !== undefined) {
    if (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0) {
      return { ok: false, error: `「${name}」的 timeout 必须是正数（秒）` };
    }
  }

  const description =
    typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : undefined;

  const refs: SecretRef[] = [];
  for (const field of ["env", "headers"] as const) {
    const group = value[field];
    if (group === undefined) continue;
    if (!isRecord(group)) return { ok: false, error: `「${name}」的 ${field} 必须是对象` };
    for (const [key, rawValue] of Object.entries(group)) {
      if (typeof rawValue !== "string") {
        return { ok: false, error: `「${name}」的 ${field}.${key} 必须是字符串` };
      }
      const trimmed = rawValue.trim();
      if (!trimmed) continue;
      const match = PLACEHOLDER_RE.exec(trimmed);
      refs.push({
        key,
        envVar: match?.[1] ?? mcpSecretEnvName(name, key),
        literal: !match,
      });
    }
  }

  return {
    ok: true,
    server: {
      name,
      transport: command ? "stdio" : "http",
      ...(command ? { command } : {}),
      args,
      ...(url ? { url } : {}),
      ...(cwd ? { cwd } : {}),
      enabled,
      exposure,
      ...(description ? { description } : {}),
      fingerprint: mcpFingerprint({ command, args, url, cwd }),
      refs,
    },
  };
}

function parsePiList(stdout: string): {
  servers: Record<string, unknown>[];
  errors: string[];
  note?: string;
} {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("pi mcp list 没有返回 JSON");
  const data: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (!isRecord(data) || !Array.isArray(data.servers)) {
    throw new Error("pi mcp list 的输出缺少 servers 数组");
  }
  return {
    servers: data.servers.filter(isRecord),
    errors: Array.isArray(data.errors) ? data.errors.map(String) : [],
    ...(typeof data.note === "string" ? { note: data.note } : {}),
  };
}

function normalizeTools(value: unknown): McpToolView[] {
  if (!Array.isArray(value)) return [];
  const out: McpToolView[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ name: item });
      continue;
    }
    if (isRecord(item) && typeof item.name === "string") {
      out.push({
        name: item.name,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      });
    }
  }
  return out;
}

export class McpService {
  private readonly opts: McpServiceOptions;
  private readonly status = new Map<string, CachedStatus>();
  private checking = false;
  private checkingPromise: Promise<McpListView> | null = null;
  private lastNote: string | undefined;

  constructor(opts: McpServiceOptions) {
    this.opts = opts;
  }

  configPath(): string {
    return join(this.opts.agentDir(), "mcp.json");
  }

  /** 列表：只读配置，不启动服务器，不发网络请求 */
  list(): McpListView {
    const { raw, problems } = this.readRaw();
    const servers = this.readAllServers(raw, problems);
    return {
      configPath: this.configPath(),
      servers: servers.map((server) => this.toView(server)),
      problems,
      ...(this.lastNote ? { note: this.lastNote } : {}),
    };
  }

  /**
   * 检查状态。**有副作用**：`pi mcp list` 会启动所有已启用服务器。
   *
   * 同一时刻只跑一个子进程；重复调用复用同一个 promise。
   */
  async check(name?: string): Promise<McpListView> {
    void name; // P1 的检查是全量的；单台过滤留给 UI
    if (this.checkingPromise) return this.checkingPromise;
    this.checking = true;
    this.checkingPromise = this.runCheck().finally(() => {
      this.checking = false;
      this.checkingPromise = null;
    });
    return this.checkingPromise;
  }

  /**
   * 保存一台服务器。`json` 可以是完整的 `{ mcpServers: { name: {...} } }`，
   * 也可以是单台配置（此时必须给 name）。
   */
  save(input: { json: string; name?: string }): {
    name: string;
    needsSecrets: string[];
    list: McpListView;
  } {
    const text = String(input?.json ?? "").trim();
    if (!text) throw new Error("配置 JSON 不能为空");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`JSON 解析失败：${message(error)}`);
    }
    if (!isRecord(parsed)) throw new Error("配置必须是一个对象");

    let name = String(input?.name ?? "").trim();
    let entry: unknown;
    if (isRecord(parsed.mcpServers)) {
      const entries = Object.entries(parsed.mcpServers);
      if (entries.length !== 1) {
        throw new Error("一次只能添加一台服务器：mcpServers 里恰好一个条目");
      }
      const [entryName, entryValue] = entries[0]!;
      name = name || entryName;
      entry = entryValue;
    } else {
      entry = parsed;
    }
    if (!name) throw new Error("缺少服务器名字");
    if (!NAME_RE.test(name)) {
      throw new Error("名字只能用字母、数字、下划线、连字符（1–64 个字符）");
    }
    if (!isRecord(entry)) throw new Error("服务器配置必须是对象");

    // 产品默认：新建时 direct（pi 自己的默认是 codemode）
    const withDefaults: Record<string, unknown> = { ...entry };
    if (withDefaults.exposure === undefined) withDefaults.exposure = "direct";
    if (withDefaults.enabled === undefined) withDefaults.enabled = true;

    const normalized = this.extractSecrets(name, withDefaults);
    const check = parseServer(name, normalized);
    if (!check.ok) throw new Error(check.error);

    const { original, raw, problems } = this.readRaw();
    if (problems.length > 0) {
      throw new Error(`${problems[0]}；先修好配置再保存，避免覆盖坏文件`);
    }
    const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    servers[name] = normalized;
    raw.mcpServers = servers;
    this.writeAtomic(raw, original);
    this.status.delete(name);
    this.opts.onConfigSaved?.();
    return { name, needsSecrets: this.missingFor(name), list: this.list() };
  }

  remove(name: string): McpListView {
    const { original, raw, problems } = this.readRaw();
    if (problems.length > 0) throw new Error(problems[0]);
    const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    if (!Object.prototype.hasOwnProperty.call(servers, name)) {
      throw new Error(`配置里没有叫「${name}」的服务器`);
    }
    delete servers[name];
    raw.mcpServers = servers;
    this.writeAtomic(raw, original);
    this.status.delete(name);
    this.opts.onConfigSaved?.();
    return this.list();
  }

  /**
   * enabled 写 mcp.json（要重启 pi 才生效）；
   * trusted 写 omcp 自己的信任文件（只影响审批层，不重启 pi）。
   */
  setFlag(
    name: string,
    flag: "enabled" | "trusted",
    value: boolean,
    fingerprint?: string,
  ): McpListView {
    if (flag === "trusted") {
      const view = this.list().servers.find((server) => server.name === name);
      if (!view) throw new Error(`配置里没有叫「${name}」的服务器`);
      if (value && fingerprint && fingerprint !== view.fingerprint) {
        throw new Error("配置已经变化（命令或地址不同），请刷新后再信任");
      }
      const trust = this.readTrust();
      if (value) trust[name] = view.fingerprint;
      else delete trust[name];
      this.writeTrust(trust);
      return this.list();
    }

    const { original, raw, problems } = this.readRaw();
    if (problems.length > 0) throw new Error(problems[0]);
    const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    const entry = servers[name];
    if (!isRecord(entry)) throw new Error(`配置里没有叫「${name}」的服务器`);
    servers[name] = { ...entry, enabled: Boolean(value) };
    raw.mcpServers = servers;
    this.writeAtomic(raw, original);
    this.status.delete(name);
    this.opts.onConfigSaved?.();
    return this.list();
  }

  /** 只写 SecretStore；不回显、不重启 pi（下一次检查/重启时生效） */
  setSecret(name: string, key: string, value: string): { ok: boolean; list: McpListView } {
    if (!NAME_RE.test(name) || !key.trim()) throw new Error("服务器名或密钥名不合法");
    const store = this.opts.secrets();
    if (!store) return { ok: false, list: this.list() };
    const ok = store.set(mcpSecretKey(name, key), value);
    if (ok) this.status.delete(name);
    return { ok, list: this.list() };
  }

  /**
   * OAuth 登录：spawn `pi mcp login <name>`。
   * pi 会自己打开浏览器；我们只把输出里的 URL 留下来，浏览器没弹时给用户点。
   */
  async login(name: string): Promise<McpLoginResult> {
    const { raw, problems } = this.readRaw();
    if (problems.length > 0) throw new Error(problems[0]);
    const server = this.readAllServers(raw, problems).find((item) => item.name === name);
    if (!server) throw new Error(`配置里没有叫「${name}」的服务器`);
    if (server.transport !== "http") throw new Error("只有远程（HTTP）服务器需要 OAuth 登录");

    const result = this.opts.runLogin
      ? await this.opts.runLogin(name)
      : await this.runPiCommand(
          ["mcp", "login", name, "--timeout", "300"],
          320_000,
          { ...process.env },
          this.opts.workspaceRoot(),
        );
    const output = `${result.stdout}\n${result.stderr}`;
    const url = firstHttpUrl(output);
    if (result.timedOut) {
      return {
        ok: false,
        ...(url ? { url } : {}),
        error: "登录超时（300 秒）。如果浏览器没弹出来，点下面的链接手动打开。",
      };
    }
    if (result.code === 0) return { ok: true, ...(url ? { url } : {}) };
    const detail = output.trim().slice(-1500);
    return {
      ok: false,
      ...(url ? { url } : {}),
      error: detail || "登录失败（pi 没有给出原因）",
    };
  }

  // ---------------------------------------------------------------- 内部

  private readRaw(): {
    original: string | null;
    raw: Record<string, unknown>;
    problems: string[];
  } {
    const file = this.configPath();
    if (!existsSync(file)) {
      return { original: null, raw: { mcpServers: {} }, problems: [] };
    }
    let original: string;
    try {
      original = readFileSync(file, "utf8");
    } catch (error) {
      return {
        original: null,
        raw: { mcpServers: {} },
        problems: [`${file} 读不出来：${message(error)}`],
      };
    }
    try {
      const parsed: unknown = JSON.parse(stripBom(original));
      if (!isRecord(parsed)) throw new Error("顶层必须是对象");
      return { original, raw: parsed, problems: [] };
    } catch (error) {
      return {
        original,
        raw: { mcpServers: {} },
        problems: [`${file} 解析失败：${message(error)}`],
      };
    }
  }

  private readAllServers(raw: Record<string, unknown>, problems: string[]): ParsedServer[] {
    if (raw.mcpServers !== undefined && !isRecord(raw.mcpServers)) {
      problems.push("mcpServers 必须是对象");
      return [];
    }
    const map = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    const out: ParsedServer[] = [];
    for (const [name, value] of Object.entries(map)) {
      const parsed = parseServer(name, value);
      if (parsed.ok) out.push(parsed.server);
      else problems.push(parsed.error);
    }
    return out;
  }

  private toView(server: ParsedServer): McpServerView {
    const cached = this.status.get(server.name);
    const state: McpState = !server.enabled
      ? "disabled"
      : (cached?.state ?? (this.checking ? "checking" : "unchecked"));
    const missingSecrets = server.refs
      .filter((ref) => !this.hasSecret(server.name, ref))
      .map((ref) => ref.key);
    const uniqueSecrets = [...new Set(server.refs.map((ref) => ref.key))];
    return {
      name: server.name,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      args: server.args,
      ...(server.url ? { url: server.url } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      secrets: uniqueSecrets,
      missingSecrets,
      enabled: server.enabled,
      exposure: server.exposure,
      ...(server.description ? { description: server.description } : {}),
      from: "global",
      fingerprint: server.fingerprint,
      trusted: this.isTrusted(server.name, server.fingerprint),
      state,
      ...(cached?.error ? { error: cached.error } : {}),
      tools: cached?.tools ?? [],
    };
  }

  private hasSecret(name: string, ref: SecretRef): boolean {
    if (ref.literal) return true; // 明文就写在配置里，算“有值”
    const stored = this.opts.secrets()?.get(mcpSecretKey(name, ref.key));
    if (stored) return true;
    return Boolean(process.env[ref.envVar]);
  }

  private missingFor(name: string): string[] {
    const view = this.list().servers.find((server) => server.name === name);
    return view?.missingSecrets ?? [];
  }

  /** 把明文密钥搬进 SecretStore，配置里换成 `${OMCP_MCP_…}` */
  private extractSecrets(name: string, entry: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...entry };
    for (const field of ["env", "headers"] as const) {
      const group = out[field];
      if (group === undefined) continue;
      if (!isRecord(group)) throw new Error(`${field} 必须是对象`);
      const next: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(group)) {
        if (typeof rawValue !== "string") throw new Error(`${field}.${key} 必须是字符串`);
        const trimmed = rawValue.trim();
        if (!trimmed) continue;
        next[key] = trimmed;
        if (PLACEHOLDER_RE.test(trimmed)) continue;
        const store = this.opts.secrets();
        if (!store || !store.set(mcpSecretKey(name, key), trimmed)) {
          throw new Error(
            `密钥「${key}」存不进安全存储（系统加密不可用），本次未保存`,
          );
        }
        next[key] = `\${${mcpSecretEnvName(name, key)}}`;
      }
      out[field] = next;
    }
    return out;
  }

  private async runCheck(): Promise<McpListView> {
    const { raw, problems } = this.readRaw();
    const servers = this.readAllServers(raw, problems);
    const enabled = servers.filter((server) => server.enabled);
    if (enabled.length === 0) return this.list();

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const server of enabled) {
      for (const ref of server.refs) {
        if (ref.literal) continue; // 明文由 pi 直接读配置
        const value =
          this.opts.secrets()?.get(mcpSecretKey(server.name, ref.key)) ??
          process.env[ref.envVar];
        if (value) env[ref.envVar] = value;
      }
    }

    try {
      const result = await this.listCommand(env, this.opts.workspaceRoot());
      if (result.timedOut) {
        throw new Error(
          `检查超时（${Math.round(CHECK_TIMEOUT_MS / 1000)} 秒）。如果服务器是用 npx / uvx 起的，第一次要先下载包，可能要多等一会儿。`,
        );
      }
      const parsed = parsePiList(result.stdout);
      this.lastNote = parsed.note;
      for (const server of servers) {
        const found = parsed.servers.find((item) => item.name === server.name);
        if (!found) {
          this.status.set(server.name, {
            state: server.enabled ? "failed" : "disabled",
            ...(server.enabled
              ? { error: "pi 没有返回这台服务器（配置可能被忽略，或项目未信任）" }
              : {}),
            tools: [],
          });
          continue;
        }
        const piState = found.state;
        const state: McpState = !server.enabled || piState === "disabled"
          ? "disabled"
          : piState === "needs-auth"
            ? "needs-auth"
            : piState === "failed"
              ? "failed"
              : "ready";
        this.status.set(server.name, {
          state,
          ...(typeof found.error === "string" && found.error ? { error: found.error } : {}),
          tools: normalizeTools(found.tools),
        });
      }
      const out = this.list();
      for (const error of parsed.errors) out.problems.push(`pi: ${error}`);
      if (result.stderr.trim() && parsed.servers.length === 0) {
        out.problems.push(`pi 的 stderr：${result.stderr.trim().slice(-1500)}`);
      }
      return out;
    } catch (error) {
      const reason = message(error);
      for (const server of servers) {
        if (!server.enabled) continue;
        this.status.set(server.name, { state: "failed", error: reason, tools: [] });
      }
      const out = this.list();
      out.problems.push(`检查失败：${reason}`);
      return out;
    }
  }

  /** 默认实现：spawn `pi mcp list --json`（独立进程，不碰当前会话） */
  private async listCommand(env: NodeJS.ProcessEnv, cwd: string): Promise<McpListRun> {
    if (this.opts.runList) return this.opts.runList(env, cwd);
    return this.runPiCommand(["mcp", "list", "--json"], CHECK_TIMEOUT_MS, env, cwd);
  }

  /**
   * spawn 一个 pi 子命令。stdin 关闭（非交互），stdout/stderr 全收；
   * 超时 kill，返回 timedOut 让调用方说清原因。
   */
  private async runPiCommand(
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ): Promise<McpListRun> {
    const pi = this.opts.piEntry();
    if (!pi) throw new Error("找不到 pi 入口");
    const child = pi.kind === "node"
      ? spawn(process.execPath, [pi.entry, ...args], {
          cwd,
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : pi.kind === "bin"
        ? spawn(pi.entry, args, {
            cwd,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("cmd.exe", ["/d", "/c", "pi", ...args], {
            cwd,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });

    return new Promise<McpListRun>((resolve) => {
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (code: number | null, timedOut = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };
      const timer = setTimeout(() => {
        if (done) return;
        child.kill();
        finish(null, true);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        stderr += `${stderr ? "\n" : ""}${message(error)}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }

  private writeAtomic(raw: Record<string, unknown>, original: string | null): void {
    const file = this.configPath();
    mkdirSync(dirname(file), { recursive: true });
    if (original !== null) {
      try {
        copyFileSync(file, `${file}.bak`);
      } catch (error) {
        throw new Error(`备份原配置失败，未写入：${message(error)}`);
      }
    }
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, "utf8");
    try {
      renameSync(tmp, file);
    } catch {
      // Windows 上目标存在时 rename 可能失败；退化成直接写
      writeFileSync(file, text, "utf8");
      rmSync(tmp, { force: true });
    }
    const check = this.readRaw();
    if (check.problems.length > 0) {
      if (original !== null) writeFileSync(file, original, "utf8");
      else rmSync(file, { force: true });
      throw new Error(`写入后读不回来，已回滚：${check.problems[0]}`);
    }
  }

  private readTrust(): Record<string, string> {
    try {
      const file = this.opts.trustFile();
      if (!existsSync(file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[name] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeTrust(trust: Record<string, string>): void {
    const file = this.opts.trustFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(trust, null, 2)}\n`, "utf8");
  }

  private isTrusted(name: string, fingerprint: string): boolean {
    return this.readTrust()[name] === fingerprint;
  }
}
