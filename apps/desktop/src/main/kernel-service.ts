import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { diagnoseLaunch } from "./kernel-diagnose";
import { SerialQueue } from "./serial-queue";

export interface KernelRuntimeEvent {
  ev: string;
  id?: string;
  name?: string;
  text?: string;
  mime?: string;
  data?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  status?: string;
  kernel?: string;
  pid?: number | null;
  restarted?: boolean;
  alive?: boolean;
}

export function resolvePython(workspaceRoot: string, override?: string): string {
  const candidates = [
    override,
    process.env.OMCP_PYTHON,
    join(workspaceRoot, ".venv", "Scripts", "python.exe"),
    join(workspaceRoot, ".venv", "bin", "python"),
    "python",
  ].filter(Boolean) as string[];
  return candidates.find((p) => p === "python" || existsSync(p)) ?? "python";
}

/**
 * Owns one Python sidecar kernel for the current workspace.
 * Emits: "ready", "exit", "status".
 */
export class KernelService extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private kernelPid: number | null = null;
  private workspaceRoot: string;
  private pending = new Map<
    string,
    { onEvent: (ev: KernelRuntimeEvent) => void; resolve: () => void; reject: (e: Error) => void }
  >();
  private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private variableWaiters: Array<{
    resolve: (names: string[]) => void;
    reject: (e: Error) => void;
  }> = [];
  private seq = 0;

  private readonly sidecarPath: string;
  private readonly language: "python" | "r";
  private pythonOverride = "";
  private readyMs = 0;

  constructor(
    sidecarPath: string,
    workspaceRoot: string,
    language: "python" | "r" = "python",
  ) {
    super();
    this.sidecarPath = sidecarPath;
    this.workspaceRoot = workspaceRoot;
    this.language = language;
  }

  /** 生成的 kernelspec 放哪（应用私有目录）；空 = 退回机器上的注册项 */
  private specDir = "";

  /** 设置页指定的 R 解释器；空 = 退回机器上的 sci-ir */
  private rPathOverride = "";

  setSpecDir(dir: string): void {
    this.specDir = dir;
  }

  /** 设置页指定的 R 解释器；空 = 沿用 sci-ir */
  setRPath(path: string): void {
    this.rPathOverride = path;
  }

  /** 用户显式填写的解释器；空 = 用机器注册项 */
  get explicitInterpreter(): string {
    return this.language === "r" ? this.rPathOverride.trim() : this.pythonOverride.trim();
  }

  /** 设置页指定的 Python 解释器；空字符串 = 自动探测 */
  setPythonPath(path: string): void {
    this.pythonOverride = path;
  }

  get pythonPath(): string {
    return resolvePython(this.workspaceRoot, this.pythonOverride || undefined);
  }

  /** 最近一次内核启动耗时（ms） */
  get startMs(): number {
    return this.readyMs;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get pid(): number | null {
    return this.kernelPid;
  }

  setWorkspace(root: string): void {
    if (root === this.workspaceRoot) return;
    this.shutdown();
    this.workspaceRoot = root;
    this.ready = false;
    this.starting = null;
  }

  private waitReady(timeoutMs = 90_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error("kernel start timeout"));
      }, timeoutMs);
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async ensureStarted(): Promise<void> {
    if (this.ready && this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    const startedAt = Date.now();
    const python = resolvePython(this.workspaceRoot, this.pythonOverride || undefined);
    const proc = spawn(python, [this.sidecarPath], {
      cwd: this.workspaceRoot,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        MPLBACKEND:
          process.env.OMCP_MPLBACKEND || "module://matplotlib_inline.backend_inline",
        ...(this.specDir ? { OMCP_KERNEL_SPEC_DIR: this.specDir } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;
    this.ready = false;
    this.reader = createInterface({ input: proc.stdout });
    this.reader.on("line", (line) => this.onLine(line));
    proc.stderr.on("data", (d) => process.stderr.write("[kernel] " + d.toString()));
    proc.on("exit", () => {
      this.proc = null;
      this.ready = false;
      for (const [, p] of this.pending) p.reject(new Error("kernel exited"));
      this.pending.clear();
      for (const w of this.readyWaiters) w.reject(new Error("kernel exited"));
      this.readyWaiters = [];
      this.emit("exit");
    });

    const ready = this.waitReady();
    // 显式配了路径就按它起内核；否则沿用机器注册项
    this.send({ op: "start", lang: this.language, interpreter: this.explicitInterpreter });
    await ready;
    this.ready = true;
    this.readyMs = Date.now() - startedAt;
    this.emit("ready");
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let ev: KernelRuntimeEvent;
    try {
      ev = JSON.parse(line) as KernelRuntimeEvent;
    } catch {
      return;
    }
    if (ev.ev === "ready") {
      if (typeof ev.pid === "number") this.kernelPid = ev.pid;
      for (const w of this.readyWaiters) w.resolve();
      this.readyWaiters = [];
      this.emit("ready", ev);
      return;
    }
    // 内核起不来时把 sidecar 的原话回给等待者，别让人干等到超时；
    // 能认出原因就翻成人话（缺包 / 程序不在 / 未配置）
    if (ev.ev === "error") {
      const raw = String((ev as { evalue?: unknown }).evalue ?? "内核启动失败");
      const diagnosis = diagnoseLaunch(this.language, this.explicitInterpreter, raw, existsSync);
      const message = diagnosis?.message ?? raw;
      for (const w of this.readyWaiters) w.reject(new Error(message));
      this.readyWaiters = [];
      return;
    }
    if (ev.ev === "variables") {
      const names = Array.isArray((ev as any).names) ? ((ev as any).names as string[]) : [];
      for (const w of this.variableWaiters) w.resolve(names);
      this.variableWaiters = [];
      return;
    }
    if (ev.id && this.pending.has(ev.id)) {
      const p = this.pending.get(ev.id)!;
      p.onEvent(ev);
      if (ev.ev === "result") {
        this.pending.delete(ev.id);
        p.resolve();
      }
    }
  }

  private send(obj: unknown): void {
    if (!this.proc) throw new Error("kernel is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** 串行队列：同一个内核同一时刻只跑一段代码（sidecar 抢锁 0.05s，抢不到直接 busy） */
  private queue = new SerialQueue(4);

  async execute(
    code: string,
    onEvent: (ev: KernelRuntimeEvent) => void,
    timeoutMs = 120_000,
  ): Promise<void> {
    await this.ensureStarted();
    if (!this.proc) throw new Error("kernel is not running");
    return this.queue.run(() => this.runOnce(code, onEvent, timeoutMs));
  }

  private async runOnce(
    code: string,
    onEvent: (ev: KernelRuntimeEvent) => void,
    timeoutMs: number,
  ): Promise<void> {
    // 排队期间可能被 restart 过，执行前再确认一次内核在跑
    await this.ensureStarted();
    if (!this.proc) throw new Error("kernel is not running");
    const id = `k${++this.seq}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.interrupt().catch(() => undefined);
        reject(new Error(`kernel execute timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        onEvent,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ op: "execute", id, code });
    });
  }

  async variables(timeoutMs = 15_000): Promise<string[]> {
    await this.ensureStarted();
    if (!this.proc) throw new Error("kernel is not running");
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.variableWaiters = this.variableWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error("variables timeout"));
      }, timeoutMs);
      this.variableWaiters.push({
        resolve: (names) => {
          clearTimeout(timer);
          resolve(names);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ op: "variables", lang: this.language });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.proc) return;
    this.send({ op: "interrupt" });
  }

  async restart(): Promise<void> {
    if (!this.proc) {
      await this.ensureStarted();
      return;
    }
    this.ready = false;
    const ready = this.waitReady();
    this.send({ op: "restart" });
    await ready;
    this.ready = true;
    this.emit("ready");
  }

  shutdown(): void {
    const proc = this.proc;
    const sidecarPid = proc?.pid ?? null;
    this.proc = null;
    this.ready = false;
    this.starting = null;
    if (!proc) return;
    try {
      proc.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
    } catch {
      // ignore
    }
    if (this.kernelPid) {
      try {
        spawn("taskkill", ["/pid", String(this.kernelPid), "/T", "/F"], {
          stdio: "ignore",
          detached: true,
        }).unref();
      } catch {
        // ignore
      }
      this.kernelPid = null;
    }
    setTimeout(() => {
      // 优雅关闭可能没来得及跑完（Electron 已经在退出了）；按 sidecar 进程树兜底强杀，
      // 否则 IRkernel 的 Rterm 会留在后台。
      if (sidecarPid) {
        try {
          spawn("taskkill", ["/pid", String(sidecarPid), "/T", "/F"], {
            stdio: "ignore",
            detached: true,
          }).unref();
        } catch {
          // ignore
        }
      }
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, 600);
  }
}
