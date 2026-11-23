/**
 * 会话运行时容器（修改 3 · P0）。
 *
 * 这一层的目的只有一个：把「一个会话需要的东西」收在一个对象里，而不是
 * 继续散在 index.ts 的全局变量上。P0 只建容器，不改变单会话行为：
 *
 * - supervisor / rpc / eventPump 仍由 index.ts 接事件、仍由现有 IPC 驱动；
 * - token / env 先记在 runtime 上，供 P1 把 policy/kernel/artifact 的
 *   side-channel 路由按 runtime 拆开时使用；
 * - `workspaceRoot` / `sessionFile` 提供 setter，P1 再把全局引用逐个搬过来。
 *
 * 不在这一层做生命周期编排（谁 spawn、谁 detach）：那会改变单会话的时序，
 * 留到 P1 的 RuntimeManager。
 */
import { randomBytes } from "node:crypto";
import type { PiEvent } from "@oh-my-coding-pi/shared";
import { EventPump } from "./event-pump.ts";
import { PiSupervisor } from "./supervisor.ts";
import { RpcClient } from "./rpc-client.ts";

export interface SessionRuntimeOptions {
  /** 稳定标识；P1 用它做 `runtimeId` */
  id: string;
  provider?: string;
  model?: string;
  /** 事件出口：P0/P1 由 index.ts 发给 renderer；带上 runtimeId 供 P2 分流 */
  emit: (ev: PiEvent, runtimeId: string) => void;
  /** 事件合并开关，默认开 */
  pumpEnabled?: boolean;
  /** 初始环境变量；不含 token（token 自动生成） */
  env?: Record<string, string>;
  workspaceRoot?: string;
  sessionFile?: string | null;
  /** 非默认 runtime 需要自己接 spawn/exit/event；默认 runtime 仍由 index.ts 接 */
  autoAttach?: boolean;
  /** 非默认 runtime 的审批请求；由 index.ts 接到统一的审批流 */
  onExtensionUi?: (ev: PiEvent) => void;
}

export class SessionRuntime {
  readonly id: string;
  readonly supervisor: PiSupervisor;
  readonly rpc: RpcClient;
  readonly pump: EventPump;
  /** P1 的服务路由令牌：policy/kernel/artifact 用 token → runtimeId */
  readonly token: string;

  private env: Record<string, string> = {};
  private workspaceRoot: string;
  private currentSessionFile: string | null;
  private currentSessionDir: string | null = null;
  private activeAt = Date.now();
  private busyFlag = false;

  constructor(opts: SessionRuntimeOptions) {
    this.id = opts.id;
    this.token = randomBytes(24).toString("hex");
    this.workspaceRoot = opts.workspaceRoot ?? "";
    this.currentSessionFile = opts.sessionFile ?? null;
    this.supervisor = new PiSupervisor(opts.provider ?? "", opts.model ?? "");
    this.rpc = new RpcClient();
    this.pump = new EventPump({
      emit: (ev) => {
        this.touch(ev);
        opts.emit(ev, this.id);
      },
      enabled: opts.pumpEnabled ?? true,
    });
    if (opts.autoAttach) {
      this.supervisor.on("spawn", (proc) => this.rpc.attach(proc));
      this.supervisor.on("exit", () => this.rpc.detach());
      this.rpc.on("event", (ev) => {
        if (ev.type === "extension_ui_request" && opts.onExtensionUi) {
          opts.onExtensionUi(ev as PiEvent);
          return;
        }
        this.pump.push(ev as PiEvent);
      });
    }
    for (const [key, value] of Object.entries(opts.env ?? {})) this.setEnv(key, value);
  }

  get workspace(): string {
    return this.workspaceRoot;
  }

  /** 最近一次活动 / 是否在跑：P3 的空闲回收用 */
  get lastActiveAt(): number { return this.activeAt; }
  get busy(): boolean { return this.busyFlag; }
  get isRunning(): boolean { return this.supervisor.current !== null; }

  markActive(): void { this.activeAt = Date.now(); }

  private touch(ev: PiEvent): void {
    this.activeAt = Date.now();
    if (ev.type === "agent_start") this.busyFlag = true;
    else if (ev.type === "agent_settled") this.busyFlag = false;
  }

  /** 当前 runtime 的环境变量快照（P1 注入子进程时用） */
  environment(): Record<string, string> {
    return { ...this.env };
  }

  /**
   * 合并一个环境变量；空值表示删除。
   * 同时写到 supervisor，保持 P0 与现有 spawn 行为一致。
   */
  setEnv(key: string, value: string): void {
    if (value) {
      this.env[key] = value;
      this.supervisor.setEnv(key, value);
    } else {
      delete this.env[key];
      this.supervisor.setEnv(key, "");
    }
  }

  /** 批量合并；空值删除 */
  setEnvs(env: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(env)) this.setEnv(key, value ?? "");
  }

  resetEnv(): void {
    this.env = {};
    this.supervisor.resetExtraEnv();
  }

  setWorkspace(root: string): void {
    this.workspaceRoot = root;
    this.supervisor.setCwd(root);
  }

  setSessionFile(file: string | null): void {
    this.currentSessionFile = file;
    this.supervisor.setSessionFile(file);
  }

  get sessionFile(): string | null {
    return this.currentSessionFile;
  }

  setSessionDir(dir: string): void {
    this.currentSessionDir = dir;
    this.supervisor.setSessionDir(dir);
  }

  get sessionDir(): string | null {
    return this.currentSessionDir;
  }

  setExtensions(paths: string[]): void {
    this.supervisor.setExtensions(paths);
  }

  setTrustProject(trust: boolean): void {
    this.supervisor.setTrustProject(trust);
  }

  setModel(provider: string, model: string): void {
    this.supervisor.setModel(provider, model);
  }

  setThinkingLevel(level: Parameters<PiSupervisor["setThinkingLevel"]>[0]): void {
    this.supervisor.setThinkingLevel(level);
  }

  start(): void {
    this.supervisor.start();
  }

  stop(): void {
    this.supervisor.stop();
  }

  /** 退出/切换前把事件泵里最后一段文本冲出来 */
  dispose(): void {
    this.pump.dispose();
    this.supervisor.stop();
  }
}
