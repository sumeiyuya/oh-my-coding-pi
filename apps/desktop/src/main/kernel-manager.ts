/**
 * 内核管理器（修改 4 · M2：键从 runtime 改成**会话**）。
 *
 * 修改 3 的实现是按 runtime 记一对内核（`get(runtimeId)`）。这件事在
 * 「一槽一会话」时看不出问题，但只要同一个槽换过会话，就会串台：
 *
 *     会话 A 里 df = pd.read_csv(...)  →  switch_session  →  会话 B
 *     B 的变量面板里还躺着 df，run_code 能直接用它算出结果——
 *     而 B 的分析里从来没有读过那个文件。
 *
 * 所以键改成会话：`session:<规范化后的会话文件>`。新会话还没有文件时
 * 用 `runtime:<槽 id>` 兜底（pi 一落盘就换键）。
 *
 * 另一条口径也跟着变：**关闭标签不再销毁内核**。变量归会话，会话还在，
 * 变量就该还在；真正回收交给空闲定时器，回收时明确告诉用户"变量没了"。
 */
import { KernelService } from "./kernel-service.ts";
import { sessionKey } from "./session-registry.ts";

export interface KernelPair {
  python: KernelService;
  r: KernelService;
}

export interface KernelEntryView {
  key: string;
  workspace: string;
  lastUsedAt: number;
  pythonReady: boolean;
  rReady: boolean;
}

/** 会话 → 内核键；没有会话文件时退回按槽记 */
export function kernelKeyFor(sessionFile: string | null | undefined, runtimeId: string): string {
  return sessionFile ? `session:${sessionKey(sessionFile)}` : `runtime:${runtimeId}`;
}

interface Entry {
  pair: KernelPair;
  workspace: string;
  lastUsedAt: number;
}

export class KernelManager {
  private readonly entries = new Map<string, Entry>();

  private readonly sidecarPath: string;
  private readonly userData: string;
  private readonly specDir: string;
  private readonly now: () => number;

  constructor(
    sidecarPath: string,
    userData: string,
    specDir: string,
    opts: { now?: () => number } = {},
  ) {
    this.sidecarPath = sidecarPath;
    this.userData = userData;
    this.specDir = specDir;
    this.now = opts.now ?? Date.now;
  }

  /** 懒创建；同一个会话永远拿到同一对。已经不在的键会重建。 */
  get(key: string, workspace = ""): KernelPair {
    const existing = this.entries.get(key);
    if (existing) {
      // 同一会话的 workspace 不该变；真变了（换目录）就重来一对，避免内核在旧 cwd 里跑
      if (workspace && existing.workspace && workspace !== existing.workspace) {
        this.closeEntry(existing);
        this.entries.delete(key);
      } else {
        existing.lastUsedAt = this.now();
        return existing.pair;
      }
    }
    const python = new KernelService(this.sidecarPath, this.userData, "python");
    python.setSpecDir(this.specDir);
    const r = new KernelService(this.sidecarPath, this.userData, "r");
    r.setSpecDir(this.specDir);
    if (workspace) {
      python.setWorkspace(workspace);
      r.setWorkspace(workspace);
    }
    const pair = { python, r };
    this.entries.set(key, { pair, workspace, lastUsedAt: this.now() });
    return pair;
  }

  /** 这个会话有没有内核（不创建） */
  peek(key: string): KernelPair | undefined {
    this.entries.get(key)?.lastUsedAt;
    return this.entries.get(key)?.pair;
  }

  list(): KernelEntryView[] {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      workspace: entry.workspace,
      lastUsedAt: entry.lastUsedAt,
      pythonReady: entry.pair.python.isReady,
      rReady: entry.pair.r.isReady,
    }));
  }

  setWorkspace(key: string, root: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      this.get(key, root);
      return;
    }
    entry.workspace = root;
    entry.pair.python.setWorkspace(root);
    entry.pair.r.setWorkspace(root);
  }

  setPythonPath(path: string): void {
    for (const entry of this.entries.values()) entry.pair.python.setPythonPath(path);
  }

  setRPath(path: string): void {
    for (const entry of this.entries.values()) entry.pair.r.setRPath(path);
  }

  dispose(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.closeEntry(entry);
    this.entries.delete(key);
  }

  disposeAll(): void {
    for (const key of [...this.entries.keys()]) this.dispose(key);
  }

  /**
   * 空闲回收：超过 `idleMs` 没被用过的一对内核关掉并忘掉。
   *
   * 返回被回收的会话（带"当时有没有真在跑"），由调用方去告诉用户：
   * **内核一关，变量就没了**——这句话不说，用户会以为代码还能接着用。
   */
  reapIdle(idleMs: number): Array<{ key: string; workspace: string; wasRunning: boolean }> {
    const reaped: Array<{ key: string; workspace: string; wasRunning: boolean }> = [];
    const cutoff = this.now() - idleMs;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.lastUsedAt > cutoff) continue;
      const wasRunning = entry.pair.python.isReady || entry.pair.r.isReady;
      this.closeEntry(entry);
      this.entries.delete(key);
      reaped.push({ key, workspace: entry.workspace, wasRunning });
    }
    return reaped;
  }

  private closeEntry(entry: Entry): void {
    try {
      entry.pair.python.shutdown();
    } catch {
      // 一个关不掉不该拖住另一个
    }
    try {
      entry.pair.r.shutdown();
    } catch {
      // ignore
    }
  }
}
