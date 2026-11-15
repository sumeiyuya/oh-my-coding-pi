import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { BridgeStatus } from "@oh-my-coding-pi/shared";
import { expectedVersion, resolvePi, runVersion } from "./pi-runtime";

export interface PiExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const RESTART_DELAYS = [1000, 2000, 4000];

export class PiSupervisor extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private restarts = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private sessionDir: string | null = null;
  private sessionFile: string | null = null;

  private provider: string;
  private model: string;
  private extraEnv: Record<string, string> = {};
  private extensionPaths: string[] = [];
  /** pi 的工作目录：必须是工作区，否则相对路径、AGENTS.md、.agents/skills 全部错位 */
  private cwd: string | null = null;
  /** 是否信任项目级资源（.pi/ 设置、项目扩展、.agents/skills） */
  private trustProject = false;
  private lastVersion: string | null = null;

  constructor(
    provider = process.env.PI_PROVIDER || "",
    model = process.env.PI_MODEL || "",
  ) {
    super();
    this.provider = provider;
    this.model = model;
  }

  getProvider(): string {
    return this.provider;
  }

  getModel(): string {
    return this.model;
  }

  setModel(provider: string, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  /**
   * 批量设置额外环境变量。
   *
   * **合并语义**（2026-11-15 改）：以前是整表替换，结果一个后来新增的
   * setExtraEnv 调用就会把之前注入的 OMCP_KEY_* 全部清掉。现在改成合并；
   * 需要清空时显式调 resetExtraEnv()。
   */
  setExtraEnv(env: Record<string, string>): void {
    Object.assign(this.extraEnv, env);
  }

  /** 整表清空（只给测试/退出清理用） */
  resetExtraEnv(): void {
    this.extraEnv = {};
  }

  /** 合并单个环境变量（空字符串表示删除） */
  setEnv(key: string, value: string): void {
    if (value) this.extraEnv[key] = value;
    else delete this.extraEnv[key];
  }

  setCwd(dir: string | null): void {
    this.cwd = dir;
  }

  getCwd(): string | null {
    return this.cwd;
  }

  setTrustProject(trust: boolean): void {
    this.trustProject = trust;
  }

  getTrustProject(): boolean {
    return this.trustProject;
  }

  getVersion(): string | null {
    return this.lastVersion;
  }

  setExtension(path: string | null): void {
    this.extensionPaths = path ? [path] : [];
  }

  /** 多个扩展按顺序加载（pi 的 --extension 可重复） */
  setExtensions(paths: string[]): void {
    this.extensionPaths = paths.filter(Boolean);
  }

  get current(): ChildProcessWithoutNullStreams | null {
    return this.proc;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  setSessionDir(dir: string): void {
    this.sessionDir = dir;
  }

  setSessionFile(file: string | null): void {
    this.sessionFile = file;
  }

  start(): void {
    if (this.proc) return;
    this.stopping = false;

    // 默认不带模型：由用户在界面里配置；显式指定时才传给 pi
    const args = ["--mode", "rpc"];
    if (this.provider) args.push("--provider", this.provider);
    if (this.model) args.push("--model", this.model);
    if (this.sessionDir) args.push("--session-dir", this.sessionDir);
    if (this.sessionFile) args.push("--session", this.sessionFile);
    for (const ext of this.extensionPaths) args.push("--extension", ext);
    // RPC 模式不会弹信任对话框：显式表态，避免依赖本机全局 defaultProjectTrust
    args.push(this.trustProject ? "--approve" : "--no-approve");

    const resolved = resolvePi(
      process.env.OMCP_PI_PATH,
      (process as unknown as { resourcesPath?: string }).resourcesPath,
      process.env.OMCP_PI_DEV_ROOT,
    );

    if (resolved.kind === "error") {
      console.error("[pi] " + resolved.error);
      this.emit("error", new Error(resolved.error ?? "pi 入口不可用"));
      this.emit("status", "error" satisfies BridgeStatus);
      return;
    }

    let proc: ChildProcessWithoutNullStreams;
    if (resolved.kind === "node") {
      proc = spawn(process.execPath, [resolved.entry, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd ?? undefined,
        env: { ...process.env, ...this.extraEnv, ELECTRON_RUN_AS_NODE: "1" },
      }) as ChildProcessWithoutNullStreams;
    } else if (resolved?.kind === "bin") {
      proc = spawn(resolved.entry, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd ?? undefined,
        env: { ...process.env, ...this.extraEnv },
      }) as ChildProcessWithoutNullStreams;
    } else {
      proc = spawn("cmd.exe", ["/d", "/c", "pi", ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd ?? undefined,
        env: { ...process.env, ...this.extraEnv },
      }) as ChildProcessWithoutNullStreams;
    }

    console.log(
      "[pi] spawn cwd=" +
        (this.cwd ?? process.cwd()) +
        " trustProject=" +
        this.trustProject +
        " origin=" +
        resolved.origin +
        " configIsolated=" +
        (this.extraEnv.PI_CODING_AGENT_DIR ? "yes" : "no") +
        " entry=" +
        resolved.kind +
        ":" +
        resolved.entry,
    );

    // 版本护栏：不阻塞启动，启动后异步比对并广播结果
    const expected = expectedVersion(
      (process as unknown as { resourcesPath?: string }).resourcesPath,
      resolved.entry,
      process.env.OMCP_PI_DEV_ROOT,
    );
    void runVersion(resolved.entry, resolved.kind === "path" ? "path" : resolved.kind === "bin" ? "bin" : "node")
      .then((actual) => {
        this.lastVersion = actual;
        const ok = !expected || !actual || actual === expected;
        if (!ok) {
          console.error(`[pi] 版本不匹配：实际 ${actual}，期望 ${expected}`);
        }
        this.emit("version", { actual, expected, ok, origin: resolved.origin });
      })
      .catch(() => undefined);

    this.proc = proc;
    this.emit("status", "starting" satisfies BridgeStatus);

    proc.once("spawn", () => {
      this.emit("spawn", proc);
      this.emit("status", "ready" satisfies BridgeStatus);
    });

    proc.on("error", (err) => {
      this.emit("error", err);
      this.emit("status", "error" satisfies BridgeStatus);
    });

    proc.on("exit", (code, signal) => {
      this.proc = null;
      this.emit("exit", { code, signal } satisfies PiExit);
      if (this.stopping) {
        this.emit("status", "stopped" satisfies BridgeStatus);
        return;
      }
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    const index = this.restarts++;
    if (index >= RESTART_DELAYS.length) {
      this.emit("status", "error" satisfies BridgeStatus);
      return;
    }
    this.emit("status", "restarting" satisfies BridgeStatus);
    this.restartTimer = setTimeout(() => this.start(), RESTART_DELAYS[index]);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (!proc?.pid) {
      this.emit("status", "stopped" satisfies BridgeStatus);
      return;
    }
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      // ignore
    }
    this.emit("status", "stopped" satisfies BridgeStatus);
  }
}
