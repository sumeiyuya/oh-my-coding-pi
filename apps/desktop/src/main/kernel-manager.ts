/**
 * 内核管理器（修改 3 · P1b2a）。
 *
 * 现在 `pythonKernel` / `rKernel` 是两个全局单例，切工作区会停掉内核。
 * 这一层先把「一个 runtime 一对内核」收进 Map；P1b2b 再让 KernelBroker
 * 按 runtime token 取对应的一对。
 *
 * 单 runtime 行为不变：默认仍只创建 `default` 这一对。
 */
import { KernelService } from "./kernel-service.ts";

export interface KernelPair {
  python: KernelService;
  r: KernelService;
}

export class KernelManager {
  private readonly pairs = new Map<string, KernelPair>();

  private readonly sidecarPath: string;
  private readonly userData: string;
  private readonly specDir: string;

  constructor(sidecarPath: string, userData: string, specDir: string) {
    this.sidecarPath = sidecarPath;
    this.userData = userData;
    this.specDir = specDir;
  }

  /** 懒创建；同一个 runtime 永远拿到同一对 */
  get(runtimeId: string): KernelPair {
    const existing = this.pairs.get(runtimeId);
    if (existing) return existing;
    const python = new KernelService(this.sidecarPath, this.userData, "python");
    python.setSpecDir(this.specDir);
    const r = new KernelService(this.sidecarPath, this.userData, "r");
    r.setSpecDir(this.specDir);
    const pair = { python, r };
    this.pairs.set(runtimeId, pair);
    return pair;
  }

  /** 只影响这个 runtime 的内核；其他 runtime 的变量不被停掉 */
  setWorkspace(runtimeId: string, root: string): void {
    const pair = this.get(runtimeId);
    pair.python.setWorkspace(root);
    pair.r.setWorkspace(root);
  }

  setPythonPath(path: string): void {
    for (const pair of this.pairs.values()) pair.python.setPythonPath(path);
  }

  setRPath(path: string): void {
    for (const pair of this.pairs.values()) pair.r.setRPath(path);
  }

  dispose(runtimeId: string): void {
    const pair = this.pairs.get(runtimeId);
    if (!pair) return;
    pair.python.shutdown();
    pair.r.shutdown();
    this.pairs.delete(runtimeId);
  }

  disposeAll(): void {
    for (const id of [...this.pairs.keys()]) this.dispose(id);
  }
}
