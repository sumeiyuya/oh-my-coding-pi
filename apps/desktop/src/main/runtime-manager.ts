/**
 * 运行时管理器（修改 3 · P1 第一步）。
 *
 * P1 的目标是让主进程能同时持有多个 `SessionRuntime`。这一步先把
 * 「注册 / 激活 / 关闭 / 列举」做出来，**不改变服务路由与 UI**：
 *
 * - 默认仍只有一个 `default` runtime，现有 IPC 继续用它；
 * - 新 runtime 可以创建，但不会自动 start（P2 的多标签会按需 start）；
 * - 每个 runtime 注入 `OMCP_RUNTIME_ID` / `OMCP_RUNTIME_TOKEN`，
 *   为下一步把 policy/kernel/artifact 按 token 路由做准备；
 * - `activate` 只改 activeId，不 stop/start 任何人。
 */
import { SessionRuntime, type SessionRuntimeOptions } from "./session-runtime.ts";
import { ServiceHub } from "./service-hub.ts";

export interface RuntimeInfo {
  id: string;
  active: boolean;
  workspace: string;
}

export class RuntimeManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** token → runtimeId；P1b2 的服务路由用 */
  readonly services = new ServiceHub();
  private activeId: string | null = null;

  create(opts: SessionRuntimeOptions): SessionRuntime {
    if (this.runtimes.has(opts.id)) throw new Error(`runtime 已存在：${opts.id}`);
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

  /** 只切 active；不 stop/start，行为由 P2 的标签切换决定 */
  /** 会话切换时同步给 ServiceHub，供 policy/artifact 判定用 */
  updateSession(id: string, sessionFile: string | null): void {
    const runtime = this.require(id);
    runtime.setSessionFile(sessionFile);
    this.services.updateSession(runtime.token, sessionFile);
  }

  activate(id: string): SessionRuntime {
    const runtime = this.require(id);
    this.activeId = id;
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

  closeAll(): void {
    for (const runtime of this.runtimes.values()) {
      this.services.unregister(runtime.token);
      runtime.dispose();
    }
    this.runtimes.clear();
    this.activeId = null;
  }
}
