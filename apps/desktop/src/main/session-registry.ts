/**
 * 会话登记表（修改 4 · M0）。
 *
 * 修改 3 之前，「会话」不是一个对象：它散在 `currentSessionFile` 一个全局变量、
 * 渲染端的一个 messages 数组、以及 pi 进程的 `--session` 参数里。结果是
 * 「标签 = 进程」，进程换了会话标签却不变，内核还跟着进程走（G1 / G8）。
 *
 * 这一层只做一件事：给每个会话文件一条**稳定的记录**，按它记账。
 * 记录本身不含 pi 进程——槽是另一套身份（见 `slot-pool.ts`）：
 *
 *     SessionKey ──0..1──▶ SlotId
 *
 * 纪律：
 *  - **key 是规范化后的绝对路径**；Windows 大小写不敏感，统一小写后再比较，
 *    但记录里保留 `file` 原样，给界面显示用。
 *  - 不在这里起进程、不发 IPC；纯内存表 + 纯函数，便于单测。
 *  - `revision` 先留着（M1 的 TranscriptHub 会写它），M0 不递增也行——
 *    字段存在比事后补迁移便宜。
 */

/** 会话在界面上要区分的那几种状态；`interrupted` 是崩溃/被杀，不是挂起。 */
export type SessionState = "closed" | "suspended" | "idle" | "busy" | "interrupted";

export interface SessionRecord {
  /** 规范化后的绝对路径，用作主键 */
  key: string;
  /** 原始绝对路径（界面显示、传给 pi 用） */
  file: string;
  workspace: string;
  title?: string;
  state: SessionState;
  /** 未读数：M0 仍由渲染端累加，这里先接住，M1 改成权威值 */
  unread: number;
  /** 绑定的槽；null = 没有进程在跑（挂起或从未打开） */
  slotId: string | null;
  lastActiveAt: number;
  /** M1：转录中枢的版本号；M0 保留字段 */
  revision: number;
}

export interface SessionSeed {
  workspace: string;
  file: string;
  title?: string;
  state?: SessionState;
  slotId?: string | null;
  now?: number;
}

/**
 * 会话键：绝对路径 + Windows 下小写。
 *
 * 只做 **路径** 规范化，不做真实路径解析（realpath）——那要摸盘，
 * 而这张表在渲染/单测里也会被构造，不能依赖文件系统。
 */
export function sessionKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = file.replace(/\\/g, "/").replace(/\/+$/, "");
  const isWinAbs = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//");
  const withoutDot = normalized.replace(/\/\.\//g, "/");
  const base = isWinAbs || withoutDot.startsWith("/") ? withoutDot : withoutDot;
  return platform === "win32" ? base.toLowerCase() : base;
}

export class SessionRegistry {
  private readonly byKey = new Map<string, SessionRecord>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** 登记或更新一个会话。已存在时只覆盖显式给出的字段。 */
  upsert(seed: SessionSeed): SessionRecord {
    const key = sessionKey(seed.file);
    const existing = this.byKey.get(key);
    if (existing) {
      if (seed.workspace) existing.workspace = seed.workspace;
      if (seed.title !== undefined) existing.title = seed.title;
      if (seed.state !== undefined) existing.state = seed.state;
      if (seed.slotId !== undefined) existing.slotId = seed.slotId;
      return existing;
    }
    const record: SessionRecord = {
      key,
      file: seed.file,
      workspace: seed.workspace,
      state: seed.state ?? "closed",
      unread: 0,
      slotId: seed.slotId ?? null,
      lastActiveAt: seed.now ?? this.now(),
      revision: 0,
      ...(seed.title !== undefined ? { title: seed.title } : {}),
    };
    this.byKey.set(key, record);
    return record;
  }

  get(file: string): SessionRecord | undefined {
    return this.byKey.get(sessionKey(file));
  }

  require(file: string): SessionRecord {
    const record = this.get(file);
    if (!record) throw new Error(`没有登记过这个会话：${file}`);
    return record;
  }

  list(workspace?: string): SessionRecord[] {
    const all = [...this.byKey.values()];
    const filtered = workspace
      ? all.filter((record) => sessionKey(record.workspace) === sessionKey(workspace))
      : all;
    return filtered.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** 哪个槽此刻绑着这个会话；没有就是 undefined */
  slotOf(file: string): string | null {
    return this.get(file)?.slotId ?? null;
  }

  /** 这个槽绑着哪个会话（槽换绑时据此解绑旧会话） */
  sessionOfSlot(slotId: string): SessionRecord | undefined {
    for (const record of this.byKey.values()) {
      if (record.slotId === slotId) return record;
    }
    return undefined;
  }

  /**
   * 绑定会话与槽。**槽原本绑着别的会话时会先解绑那一条**——
   * 这是「一槽同一时刻只绑一个会话」的唯一执行点。
   */
  bind(file: string, slotId: string): SessionRecord {
    const record = this.require(file);
    const previous = this.sessionOfSlot(slotId);
    if (previous && previous.key !== record.key) {
      previous.slotId = null;
      previous.state = "suspended";
    }
    record.slotId = slotId;
    record.state = record.state === "busy" ? "busy" : "idle";
    record.lastActiveAt = this.now();
    return record;
  }

  unbind(slotId: string, state: SessionState = "suspended"): SessionRecord | undefined {
    const record = this.sessionOfSlot(slotId);
    if (!record) return undefined;
    record.slotId = null;
    record.state = state;
    return record;
  }

  setState(file: string, state: SessionState): void {
    const record = this.get(file);
    if (record) record.state = state;
  }

  markActive(file: string): void {
    const record = this.get(file);
    if (record) record.lastActiveAt = this.now();
  }

  bumpUnread(file: string): number {
    const record = this.get(file);
    if (!record) return 0;
    record.unread += 1;
    return record.unread;
  }

  clearUnread(file: string): void {
    const record = this.get(file);
    if (record) record.unread = 0;
  }

  remove(file: string): void {
    this.byKey.delete(sessionKey(file));
  }

  clear(): void {
    this.byKey.clear();
  }

  get size(): number {
    return this.byKey.size;
  }
}

/**
 * 崩溃之后该把会话标成什么、对用户说什么（修改 4 · M3）。
 *
 * 分开的理由：有回合在飞时被打断，和空闲时进程重启，对用户是两件事——
 * 前者可能丢了一段正在生成的回答，后者只是"它重连了一下"。
 */
export function crashOutcome(wasBusy: boolean): { state: SessionState; note: string } {
  return wasBusy
    ? {
        state: "interrupted",
        note: "pi 进程异常退出，本轮的回复被中断了。可以直接重发这条消息。",
      }
    : {
        state: "idle",
        note: "pi 进程异常退出，已自动重启；这段会话的内容没有丢。",
      };
}
