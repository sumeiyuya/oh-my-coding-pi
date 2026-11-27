/**
 * 运行时管理器（修改 3 · P1 第一步）。
 *
 * P1 的目标是让主进程能同时持有多个 `SessionRuntime`。这一步先把
 * 「注册 / 激活 / 关闭 / 列举」做出来，**不改变服务路由与 UI**：
 *
 * - 默认仍只有一个 `default` runtime，现有 IPC 继续用它；
 * - 新 runtime 由调用方决定何时 start；切回标签时 `activate` 会在
 *   已停（空闲回收）的情况下重新 start；
 * - 每个 runtime 注入 `OMCP_RUNTIME_ID` / `OMCP_RUNTIME_TOKEN`，
 *   为 policy/kernel/artifact 按 token 路由；
 * - `activate` 切 active、记活动时间，并在需要时 resume。
 */
import { SessionRuntime, type SessionRuntimeOptions } from "./session-runtime.ts";
import { ServiceHub } from "./service-hub.ts";

export interface RuntimeInfo {
  id: string;
  active: boolean;
  workspace: string;
  /** 是否还在跑（空闲回收后会停） */
  running: boolean;
  /** 是否正在跑一轮 */
  busy: boolean;
}

export class RuntimeManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** token → runtimeId；P1b2 的服务路由用 */
  readonly services = new ServiceHub();
  private activeId: string | null = null;
  private maxRuntimes: number;

  constructor(options: { maxRuntimes?: number } = {}) {
    this.maxRuntimes = Math.max(1, options.maxRuntimes ?? 3);
  }

  setMaxRuntimes(value: number): void {
    this.maxRuntimes = Math.max(1, Math.min(4, Math.floor(value)));
  }

  create(opts: SessionRuntimeOptions): SessionRuntime {
    if (this.runtimes.has(opts.id)) throw new Error(`runtime 已存在：${opts.id}`);
    if (this.runtimes.size >= this.maxRuntimes) {
      throw new Error(`活跃 runtime 已达上限（${this.maxRuntimes}）；先关闭一个后台标签`);
    }
    const runtime = new SessionRuntime(opts);
    // P1 的 side-channel 路由会用；当前服务仍读全局 token。
    runtime.setEnv("OMCP_RUNTIME_ID", runtime.id);
    runtime.setEnv("OMCP_RUNTIME_TOKEN", runtime.token);
    this.services.register(runtime);
    this.runtimes.set(runtime.id, runtime);
    if (this.activeId === null) this.activeId = runtime.id;
    return runtime;
  }

  get(id: string): SessionRuntime | undefined {
    return this.runtimes.get(id);
  }

  require(id: string): SessionRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`没有这个 runtime：${id}`);
    return runtime;
  }

  /** 会话切换时同步给 ServiceHub，供 policy/artifact 判定用 */
  updateSession(id: string, sessionFile: string | null): void {
    const runtime = this.require(id);
    runtime.setSessionFile(sessionFile);
    this.services.updateSession(runtime.token, sessionFile);
  }

  /** 切 active；若目标已被空闲回收，重新 start 以 resume */
  activate(id: string): SessionRuntime {
    const runtime = this.require(id);
    this.activeId = id;
    runtime.markActive();
    if (!runtime.isRunning) runtime.start();
    return runtime;
  }

  get active(): SessionRuntime | null {
    return this.activeId ? this.runtimes.get(this.activeId) ?? null : null;
  }

  list(): RuntimeInfo[] {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.id,
      active: runtime.id === this.activeId,
      workspace: runtime.workspace,
      running: runtime.isRunning,
      busy: runtime.busy,
    }));
  }

  /** 关闭一个 runtime：停 pi、冲事件泵；active 顺延到下一个 */
  close(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.services.unregister(runtime.token);
    runtime.dispose();
    this.runtimes.delete(id);
    if (this.activeId === id) {
      this.activeId = this.runtimes.keys().next().value ?? null;
    }
  }

  /**
   * P3：停掉“非 active、非 busy、空闲超过 idleMs”的 runtime。
   * 不删除 runtime（标签还在），切回时 activate 会重新 start。
   */
  reapIdle(idleMs: number, now = Date.now()): string[] {
    const stopped: string[] = [];
    for (const [id, runtime] of this.runtimes) {
      if (id === "default" || id === this.activeId) continue;
      if (runtime.busy || !runtime.isRunning) continue;
      if (now - runtime.lastActiveAt < idleMs) continue;
      runtime.stop();
      stopped.push(id);
    }
    return stopped;
  }


  /** 修改 4 · M0：池子接管后，槽对象由 SlotPool 持有，这里只做登记表 */
  forget(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.services.unregister(runtime.token);
    this.runtimes.delete(id);
    if (this.activeId === id) this.activeId = this.runtimes.keys().next().value ?? null;
  }

  /** 修改 4 · M0：激活状态由槽池决定，这里只跟着记 */
  setActive(id: string | null): void {
    if (id === null) {
      this.activeId = null;
      return;
    }
    if (this.runtimes.has(id)) this.activeId = id;
  }

  closeAll(): void {
    for (const runtime of this.runtimes.values()) {
      this.services.unregister(runtime.token);
      runtime.dispose();
    }
    this.runtimes.clear();
    this.activeId = null;
  }
}
