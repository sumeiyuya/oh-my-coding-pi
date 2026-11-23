/**
 * 服务路由表（修改 3 · P1b1）。
 *
 * 每个 runtime 有一个 48 位 token。子进程里的 policy / kernel / artifact
 * 扩展把 token 放在 `Authorization: Bearer …`，主进程用这张表反查
 * `runtimeId`，再决定用哪个 workspace / 内核 / 审批队列。
 *
 * P1b1 只建表并登记默认 runtime；服务端还没开始用（P1b2）。
 * token 不进日志、不进 UI。
 */
export interface RuntimeBinding {
  runtimeId: string;
  workspace: string;
  session: string | null;
}

export class ServiceHub {
  private readonly byToken = new Map<string, RuntimeBinding>();

  register(runtime: {
    id: string;
    token: string;
    workspace: string;
    sessionFile?: string | null;
  }): void {
    if (this.byToken.has(runtime.token)) {
      throw new Error(`runtime token 重复：${runtime.id}`);
    }
    this.byToken.set(runtime.token, {
      runtimeId: runtime.id,
      workspace: runtime.workspace,
      session: runtime.sessionFile ?? null,
    });
  }

  resolve(token: string): RuntimeBinding | undefined {
    if (!token) return undefined;
    return this.byToken.get(token);
  }

  updateSession(token: string, sessionFile: string | null): void {
    const binding = this.byToken.get(token);
    if (binding) binding.session = sessionFile;
  }

  unregister(token: string): void {
    this.byToken.delete(token);
  }

  list(): RuntimeBinding[] {
    return [...this.byToken.values()];
  }
}
