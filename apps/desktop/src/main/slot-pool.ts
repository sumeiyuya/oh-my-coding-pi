/**
 * 槽池与准入（修改 4 · M0）。
 *
 * 「槽」= 一个 pi 子进程。它与会话是两套身份：
 *
 *     SessionKey ──0..1──▶ SlotId        （一个会话最多占一个槽）
 *     SlotId ──同一时刻只绑一个──▶ SessionKey
 *
 * 槽属于工作区：pi 的 cwd 建进程那一刻焊死（ADR-035），跨工作区的会话
 * 不能共用一个槽。
 *
 * ## 额度算的是「同时在跑的槽」
 *
 * 槽对象本身很便宜（一个 RPC 句柄），贵的是它背后的 pi 进程
 * （100–250 MB）。所以 `maxSlots` 限制的是 **running** 的槽数，
 * 挂起的槽（进程已停、会话保留）不占额度——这正是修改 3 缺的那一档
 * 「保留但不占资源」。
 *
 * ## 准入（替掉原来满员直接抛错，G6）
 *
 *   ① 会话已绑槽            → 激活（没在跑就 start + 等 ready）
 *   ② 同工作区有未绑定的槽   → 绑定
 *   ③ 同工作区有已挂起的槽   → 换绑复用（最久未用的先）
 *   ④ 运行数未达上限        → 新建
 *   ⑤ 有可停的槽            → 停掉最久未用的那个，腾出运行额度 → 新建
 *   ⑥ 否则                  → 入队（给位次），有额度时自动出队
 *
 * 可停 = 不 busy、不是当前可见、不在等审批（后者由调用方用 `isBlocked` 注入）。
 * 等审批的槽被停掉，那张审批卡就成了孤儿——这不是资源问题，是数据一致性问题。
 */
import { SessionRegistry, sessionKey } from "./session-registry.ts";

/** 槽对池子的最小契约；`SessionRuntime` 结构上满足它，测试里用假实现。 */
export interface SlotRuntime {
  readonly id: string;
  readonly workspace: string;
  readonly sessionFile: string | null;
  readonly isRunning: boolean;
  readonly busy: boolean;
  readonly ready: boolean;
  readonly lastActiveAt: number;
  start(): void;
  stop(): void;
  dispose(): void;
  setSessionFile(file: string | null): void;
  waitReady(timeoutMs: number): Promise<void>;
}

export type SlotState = "free" | "starting" | "idle" | "busy" | "suspended";

export interface SlotInfo {
  id: string;
  workspace: string;
  sessionFile: string | null;
  state: SlotState;
  running: boolean;
  ready: boolean;
  busy: boolean;
  /** 是否就是当前激活的那个槽 */
  active: boolean;
}

export type OpenOutcome =
  | { kind: "activated"; slotId: string }
  | { kind: "bound"; slotId: string }
  | { kind: "resumed"; slotId: string; reused: string }
  | { kind: "created"; slotId: string }
  | { kind: "preempted"; slotId: string; suspended: string }
  | { kind: "queued"; position: number; queued: number };

export interface SlotPoolOptions<T extends SlotRuntime = SlotRuntime> {
  registry: SessionRegistry;
  /** 同时运行的槽上限（挂起的不算） */
  maxSlots: number;
  /** 建一个新槽；由 index.ts 注入（它知道 emit / env / 扩展路径） */
  createSlot(input: { id: string; workspace: string; sessionFile: string | null }): T;
  /** 摘掉一个槽时清理外部登记（RuntimeManager / ServiceHub）；默认只 dispose */
  disposeSlot?: (slot: T) => void;
  now?: () => number;
  /** 这个槽此刻不能停（例如它挂着一张待审批卡） */
  isBlocked?: (slotId: string) => boolean;
  /** 槽被换绑到另一个会话（同步 ServiceHub / supervisor 的 --session） */
  onBind?: (slotId: string, sessionFile: string | null) => void;
  /** 排队中的请求被放行了 */
  onDequeued?: (slotId: string, sessionFile: string) => void;
  /** 槽集合/状态变化（界面刷新用） */
  onChanged?: () => void;
  /**
   * 不能真的销毁的槽（默认槽由外部持有引用：`defaultRuntime` / `supervisor` / `rpc`）。
   * 关它时只挂起，不 dispose。
   */
  pinnedSlots?: Iterable<string>;
}

interface PendingOpen {
  file: string;
  workspace: string;
}

const DEFAULT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_QUEUE_LIMIT = 8;
/** 槽对象上限：挂起的不占运行额度，但也不该无限攒 */
const HARD_CAP_FACTOR = 4;

export class SlotPool<T extends SlotRuntime = SlotRuntime> {
  private readonly registry: SessionRegistry;
  private readonly createSlot: SlotPoolOptions<T>["createSlot"];
  private readonly disposeSlot: (slot: T) => void;
  private readonly now: () => number;
  private readonly isBlocked: (slotId: string) => boolean;
  private readonly pinned: Set<string>;
  private readonly onBind: ((slotId: string, sessionFile: string | null) => void) | undefined;
  private readonly onDequeued: ((slotId: string, sessionFile: string) => void) | undefined;
  private readonly onChanged: () => void;
  private maxSlots: number;
  private activeId: string | null = null;
  private readonly slots = new Map<string, T>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly queue: PendingOpen[] = [];
  private seq = 0;

  constructor(opts: SlotPoolOptions<T>) {
    this.registry = opts.registry;
    this.createSlot = opts.createSlot;
    this.disposeSlot = opts.disposeSlot ?? ((slot) => slot.dispose());
    this.now = opts.now ?? Date.now;
    this.isBlocked = opts.isBlocked ?? (() => false);
    this.pinned = new Set(opts.pinnedSlots ?? []);
    this.onBind = opts.onBind;
    this.onDequeued = opts.onDequeued;
    this.onChanged = opts.onChanged ?? (() => {});
    this.maxSlots = Math.max(1, opts.maxSlots);
  }

  setMaxSlots(value: number): void {
    this.maxSlots = Math.max(1, Math.min(8, Math.floor(value) || 1));
    this.drain();
  }

  get max(): number {
    return this.maxSlots;
  }

  get active(): T | null {
    return this.activeId ? this.slots.get(this.activeId) ?? null : null;
  }

  get activeSlotId(): string | null {
    return this.activeId;
  }

  get(id: string): T | undefined {
    return this.slots.get(id);
  }

  require(id: string): T {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`没有这个槽：${id}`);
    return slot;
  }

  /** 会话现在绑在哪个槽上（进程死活不管） */
  slotOfSession(file: string): T | undefined {
    const slotId = this.registry.slotOf(file);
    return slotId ? this.slots.get(slotId) : undefined;
  }

  runningCount(): number {
    return [...this.slots.values()].filter((slot) => slot.isRunning).length;
  }

  list(): SlotInfo[] {
    return [...this.slots.values()].map((slot) => ({
      id: slot.id,
      workspace: slot.workspace,
      sessionFile: slot.sessionFile,
      state: this.stateOf(slot),
      running: slot.isRunning,
      ready: slot.ready,
      busy: slot.busy,
      active: slot.id === this.activeId,
    }));
  }

  stateOf(slot: T): SlotState {
    if (this.starting.has(slot.id)) return "starting";
    if (!slot.isRunning) return "suspended";
    if (slot.busy) return "busy";
    if (!slot.sessionFile) return "free";
    return "idle";
  }

  /**
   * 打开一个会话：把它绑到一个槽上并激活。
   *
   * `visibleSlotId` 是「用户此刻正看着的那个槽」——停/抢时跳过它，
   * 否则会出现「刚打开的那格把自己挤掉」。
   */
  async open(
    file: string,
    workspace: string,
    opts: { visibleSlotId?: string | null; readyTimeoutMs?: number } = {},
  ): Promise<OpenOutcome> {
    const visible = opts.visibleSlotId ?? this.activeId;
    const timeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const sameWorkspace = (slot: SlotRuntime): boolean =>
      sessionKey(slot.workspace) === sessionKey(workspace);

    const record = this.registry.upsert({ workspace, file });
    record.lastActiveAt = this.now();

    // ① 已绑槽
    const boundId = record.slotId;
    if (boundId) {
      const slot = this.slots.get(boundId);
      if (slot && sameWorkspace(slot)) {
        this.activeId = slot.id;
        await this.ensureRunning(slot, timeout);
        this.onChanged();
        return { kind: "activated", slotId: slot.id };
      }
      record.slotId = null;
    }

    // ② 同工作区里还没绑会话的槽
    const free = [...this.slots.values()].find(
      (slot) => !slot.sessionFile && sameWorkspace(slot) && slot.id !== visible,
    );
    if (free) {
      this.bind(free, file);
      this.activeId = free.id;
      await this.ensureRunning(free, timeout);
      this.onChanged();
      return { kind: "bound", slotId: free.id };
    }

    // ③ 同工作区里已挂起的槽 → 换绑复用（最久未用先）
    const suspended = [...this.slots.values()]
      .filter((slot) => !slot.isRunning && sameWorkspace(slot) && slot.id !== visible && !this.isBlocked(slot.id))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (suspended) {
      this.bind(suspended, file);
      this.activeId = suspended.id;
      await this.ensureRunning(suspended, timeout);
      this.onChanged();
      return { kind: "resumed", slotId: suspended.id, reused: suspended.id };
    }

    // ④ 运行数未达上限，且槽对象还有余量
    if (this.runningCount() < this.maxSlots && this.slots.size < this.hardCap()) {
      const slot = this.spawn(workspace, file);
      this.activeId = slot.id;
      await this.ensureRunning(slot, timeout);
      this.onChanged();
      return { kind: "created", slotId: slot.id };
    }

    // ⑤ 停掉最久未用的可停槽，腾出运行额度
    const victim = this.stoppable(visible);
    if (victim) {
      if (!this.stopSlot(victim.id)) {
        this.closeSlot(victim.id);
      }
      const slot = this.spawn(workspace, file);
      this.activeId = slot.id;
      await this.ensureRunning(slot, timeout);
      this.onChanged();
      return { kind: "preempted", slotId: slot.id, suspended: victim.id };
    }

    // ⑥ 排队
    if (!this.queue.some((item) => sessionKey(item.file) === sessionKey(file))) {
      if (this.queue.length >= DEFAULT_QUEUE_LIMIT) {
        throw new Error(`槽位已满且队列也满了（${this.maxSlots} 个运行槽 / ${DEFAULT_QUEUE_LIMIT} 个等待）`);
      }
      this.queue.push({ file, workspace });
    }
    const position = this.queue.findIndex((item) => sessionKey(item.file) === sessionKey(file)) + 1;
    this.onChanged();
    return { kind: "queued", position, queued: this.queue.length };
  }

  /** 切到某个槽（不新建、不绑定）。挂起的槽会被拉起。 */
  async activate(slotId: string, timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    const slot = this.require(slotId);
    this.activeId = slot.id;
    if (slot.sessionFile) this.registry.markActive(slot.sessionFile);
    await this.ensureRunning(slot, timeoutMs);
    this.onChanged();
  }

  /** 关闭一个槽：停 pi、解绑会话、腾出额度，然后尝试出队。会话保留（suspended）。 */
  closeSlot(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    // 外部还持有引用的槽（默认槽）只挂起，不销毁
    if (this.pinned.has(slotId)) {
      this.registry.unbind(slotId, "suspended");
      this.stopSlot(slotId);
      this.onChanged();
      return;
    }
    this.registry.unbind(slotId, "suspended");
    this.starting.delete(slotId);
    this.slots.delete(slotId);
    try {
      this.disposeSlot(slot);
    } catch {
      // 停不下来不该拖住别的槽
    }
    if (this.activeId === slotId) {
      this.activeId = this.slots.keys().next().value ?? null;
    }
    this.onChanged();
    this.drain();
  }

  /**
   * 停掉 pi 但保留槽与会话（腾运行额度 / 空闲回收用）。
   * 切回来时 `activate` 会重新 start，pi 从 `--session` 续上。
   */
  stopSlot(slotId: string): boolean {
    const slot = this.slots.get(slotId);
    if (!slot || !slot.isRunning || slot.busy) return false;
    slot.stop();
    if (slot.sessionFile) this.registry.setState(slot.sessionFile, "suspended");
    this.starting.delete(slotId);
    this.onChanged();
    this.drain();
    return true;
  }

  /** 回收：非 active、不 busy、不在等审批、空闲超过 idleMs 的那些停 pi。槽保留。 */
  reapIdle(idleMs: number): string[] {
    const touched: string[] = [];
    const candidates = [...this.slots.values()]
      .filter((slot) => slot.id !== this.activeId)
      .filter((slot) => slot.isRunning && !slot.busy && !this.isBlocked(slot.id))
      .filter((slot) => this.now() - slot.lastActiveAt >= idleMs)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const slot of candidates) {
      if (this.stopSlot(slot.id)) touched.push(slot.id);
    }
    return touched;
  }

  closeAll(): void {
    for (const slot of [...this.slots.values()]) {
      this.registry.unbind(slot.id, "suspended");
      try {
        this.disposeSlot(slot);
      } catch {
        // ignore
      }
    }
    this.slots.clear();
    this.starting.clear();
    this.queue.length = 0;
    this.activeId = null;
    this.onChanged();
  }

  queueLength(): number {
    return this.queue.length;
  }

  /** 排队位次（给界面显示"排队第 N 位"）；按入队顺序 */
  queuePositions(): Array<{ file: string; position: number }> {
    return this.queue.map((item, index) => ({ file: item.file, position: index + 1 }));
  }

  /** 丢掉整条队列（换工作区时旧队列没意义了） */
  dropQueue(): string[] {
    const dropped = this.queue.map((item) => item.file);
    this.queue.length = 0;
    if (dropped.length > 0) this.onChanged();
    return dropped;
  }

  /** 有额度时把队首放进来（尽力而为：失败就留在队里） */
  drain(): void {
    while (this.queue.length > 0) {
      const canRun = this.runningCount() < this.maxSlots && this.slots.size < this.hardCap();
      const canSuspended = this.reusableSuspended() !== undefined;
      const canStop = this.stoppable(this.activeId) !== undefined;
      if (!canRun && !canSuspended && !canStop) return;
      const next = this.queue.shift();
      if (!next) return;
      void this.open(next.file, next.workspace, { visibleSlotId: this.activeId })
        .then((outcome) => {
          if (outcome.kind === "queued") return;
          this.onDequeued?.(outcome.slotId, next.file);
          this.onChanged();
        })
        .catch(() => {
          this.queue.unshift(next);
          this.onChanged();
        });
    }
  }

  private hardCap(): number {
    return Math.max(this.maxSlots, this.maxSlots * HARD_CAP_FACTOR);
  }

  private reusableSuspended(): T | undefined {
    return [...this.slots.values()]
      .filter((slot) => !slot.isRunning && slot.id !== this.activeId && !this.isBlocked(slot.id))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
  }

  /** 可停的槽：运行中、空闲、非可见、不在等审批；最久未用先 */
  private stoppable(visibleSlotId: string | null): T | undefined {
    return [...this.slots.values()]
      .filter((slot) => slot.isRunning && slot.id !== visibleSlotId && !slot.busy && !this.isBlocked(slot.id))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
  }

  private spawn(workspace: string, sessionFile: string): T {
    this.seq += 1;
    const id = `slot-${this.seq}-${Math.random().toString(36).slice(2, 6)}`;
    const slot = this.createSlot({ id, workspace, sessionFile });
    this.slots.set(slot.id, slot);
    this.bind(slot, sessionFile);
    return slot;
  }

  private bind(slot: T, file: string): void {
    slot.setSessionFile(file);
    const record = this.registry.bind(file, slot.id);
    record.state = !slot.isRunning ? "suspended" : slot.busy ? "busy" : "idle";
    this.onBind?.(slot.id, file);
  }

  /**
   * 接管一个**已经存在**的槽（默认 runtime 在模块加载时就建好了）。
   * 不绑定会话——绑不绑由调用方随后 `bindSession` 决定。
   */
  adopt(slot: T): void {
    this.slots.set(slot.id, slot);
    if (this.activeId === null) this.activeId = slot.id;
    this.onChanged();
  }

  /** 外部改绑（打开工作区时同步上次会话、pi:fork / pi:clone 换文件） */
  bindSession(slotId: string, file: string | null): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    if (file) {
      // 外部传来的会话文件可能是 pi 刚建的（`pi:state` 第一次报上来）：
      // 先登记再绑定，否则 registry.bind 会以"没有登记过"拒绝。
      this.registry.upsert({ file, workspace: slot.workspace });
      this.bind(slot, file);
    } else {
      this.registry.unbind(slotId, "suspended");
      slot.setSessionFile(null);
      this.onBind?.(slotId, null);
    }
    this.onChanged();
  }

  /**
   * 建一个还没绑会话的空槽（旧的「后台 +」入口）。
   * 满员时先停最久未用的那个腾额度；实在腾不出来就报可读的错。
   */
  spawnFree(workspace: string, opts: { visibleSlotId?: string | null } = {}): T {
    const visible = opts.visibleSlotId ?? this.activeId;
    if (this.runningCount() >= this.maxSlots || this.slots.size >= this.hardCap()) {
      const victim = this.stoppable(visible);
      if (!victim) {
        throw new Error(`同时运行的会话已达上限（${this.maxSlots}），先关掉一个标签`);
      }
      if (!this.stopSlot(victim.id)) this.closeSlot(victim.id);
    }
    this.seq += 1;
    const id = `slot-${this.seq}-${Math.random().toString(36).slice(2, 6)}`;
    const slot = this.createSlot({ id, workspace, sessionFile: null });
    this.slots.set(slot.id, slot);
    this.activeId = slot.id;
    this.onChanged();
    return slot;
  }

  /** 挂起的槽拉起来；并发调用合并成同一个等待 */
  private async ensureRunning(slot: T, timeoutMs: number): Promise<void> {
    if (slot.isRunning && slot.ready) {
      if (slot.sessionFile) this.registry.setState(slot.sessionFile, slot.busy ? "busy" : "idle");
      return;
    }
    const inFlight = this.starting.get(slot.id);
    if (inFlight) return inFlight;

    const starting = (async () => {
      if (!slot.isRunning) slot.start();
      await slot.waitReady(timeoutMs);
      if (slot.sessionFile) this.registry.setState(slot.sessionFile, "idle");
    })()
      .catch((err) => {
        if (slot.sessionFile) this.registry.setState(slot.sessionFile, "interrupted");
        throw err;
      })
      .finally(() => {
        this.starting.delete(slot.id);
      });

    this.starting.set(slot.id, starting);
    await starting;
  }
}
