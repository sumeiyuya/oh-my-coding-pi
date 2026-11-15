/**
 * 串行队列：同一个内核同一时刻只能跑一段代码。
 *
 * 背景：sidecar 用 0.05s 超时抢锁，抢不到直接返回 KernelBusy。
 * 在主进程先把调用排好，用户连续点两次“运行”就不会看到莫名的 busy 报错。
 *
 * 约定：
 * - 队列不因单次失败而断掉（失败照样把位置让给下一个）；
 * - 排队超过上限直接拒，而不是让消息无限期挂着；
 * - depth 包含正在跑的那一个，便于给出“已有 N 段在等”的准确说法。
 */
export class SerialQueue {
  private readonly max: number;
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  // 注意：不用 TS 参数属性（constructor(private x)）——Node 的 type-stripping 模式不支持，
  // 单测用 node --test 直接跑 .ts 会报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  constructor(max = 4) {
    this.max = max;
  }

  /** 当前排队数（含正在执行的） */
  get size(): number {
    return this.depth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.depth >= this.max) {
      return Promise.reject(
        new Error(`KernelBusy：已有 ${this.depth} 段代码在等这个内核，先等当前任务结束再试`),
      );
    }
    this.depth += 1;
    const started = this.tail.then(async () => {
      try {
        return await task();
      } finally {
        // 在任务结算内递减：await run() 返回时 size 已经准确
        this.depth -= 1;
      }
    });
    // 队列只关心“什么时候轮到我结束”，不关心成功失败
    this.tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}
