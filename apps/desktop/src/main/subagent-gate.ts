/**
 * 子任务并发闸（修改 4 · M4）。
 *
 * 为什么非要一个**跨进程**的闸：子任务跑在各自独立的 pi 子进程里（扩展进程），
 * 每个扩展进程只能管住自己那 4 个并发；而槽是并行的——
 *
 *     2 个槽 × 每槽 4 个子任务 = 8 个模型请求同时在飞
 *
 * 这个数字会直接把 provider 打到 429，然后**整批一起失败**。那不是"更快的并发"。
 * 所以闸放在主进程，扩展在 spawn 前领一个号、结束后还回来。
 *
 * 口径：
 *  - 名额是**全局**的（不分槽），因为限流的是 provider，不是我们的进程；
 *  - 领不到就排队，队首优先；超时明确拒绝，不做"悄悄超额"；
 *  - 领到号的进程崩了不还？`releaseAll(key)` 由调用方在会话结束时兜底。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export interface LeaseRequest {
  /** 谁领的（槽 id / 会话文件），只用于日志与兜底释放 */
  key: string;
  /** 等多久算超时（毫秒），默认 120 秒 */
  timeoutMs?: number;
}

export interface GateSnapshot {
  capacity: number;
  inUse: number;
  waiting: number;
  holders: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class SubagentGate {
  private readonly capacity: number;
  /** key → 领到的号数（同一段会话可能同时有多个子任务） */
  private readonly held = new Map<string, number>();
  private inUse = 0;
  private readonly waiting: Array<{
    key: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(opts: { capacity: number }) {
    this.capacity = Math.max(1, Math.floor(opts.capacity) || 1);
  }

  get size(): number {
    return this.capacity;
  }

  /**
   * 领一个名额。有就立刻给，没有就排队。
   * 超时返回 `null`——由调用方决定怎么告诉模型（通常是"稍后再试"）。
   */
  acquire(request: LeaseRequest): Promise<boolean> {
    const key = request.key || "unknown";
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      this.held.set(key, (this.held.get(key) ?? 0) + 1);
      return Promise.resolve(true);
    }
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return new Promise<boolean>((resolve, reject) => {
      const waiter = {
        key,
        resolve: () => {
          clearTimeout(waiter.timer);
          this.inUse += 1;
          this.held.set(key, (this.held.get(key) ?? 0) + 1);
          resolve(true);
        },
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve(false);
        }, timeoutMs),
      };
      this.waiting.push(waiter);
    });
  }

  /** 还号：按同一 key 还一个；没有记录也照样把占用减一（宁可少算也不卡死） */
  release(key: string): void {
    const count = this.held.get(key) ?? 0;
    if (count <= 1) this.held.delete(key);
    else this.held.set(key, count - 1);
    if (this.inUse > 0) this.inUse -= 1;
    this.pump();
  }

  /** 某个会话结束/崩溃时兜底：把它名下所有号一次还清 */
  releaseAll(key: string): number {
    const count = this.held.get(key) ?? 0;
    this.held.delete(key);
    const freed = Math.min(count, this.inUse);
    this.inUse -= freed;
    this.pump();
    return freed;
  }

  snapshot(): GateSnapshot {
    return {
      capacity: this.capacity,
      inUse: this.inUse,
      waiting: this.waiting.length,
      holders: [...this.held.keys()],
    };
  }

  /** 队首补位 */
  private pump(): void {
    while (this.inUse < this.capacity && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) break;
      next.resolve();
    }
  }

  /** 进程退出时把还在等的都放掉（拒绝，不静默） */
  dispose(): void {
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("子任务并发闸已关闭"));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 给扩展进程用的本地 HTTP 入口                                        */
/* ------------------------------------------------------------------ */

export interface SubagentGateServer {
  url: string;
  token: string;
  close(): void;
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > limit) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * 起一个只听 127.0.0.1 的闸口。扩展在 spawn 子任务前 POST /subagent/lease，
 * 起来后 POST /subagent/release；领不到会被挡住并拿到可读的原因。
 */
export function startSubagentGateServer(
  gate: SubagentGate,
  opts: {
    onError?: (message: string) => void;
    /** 领号时顺手告诉扩展：这个槽现在的 provider/model（子进程要继承它） */
    modelFor?: (key: string) => { provider?: string; model?: string };
  } = {},
): Promise<SubagentGateServer> {
  const token = randomBytes(24).toString("hex");
  const server = createServer((req, res) => {
    void (async () => {
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/subagent/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...gate.snapshot() }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}") as {
        key?: unknown;
        timeoutMs?: unknown;
      };
      const key = typeof body.key === "string" && body.key ? body.key : "unknown";
      if (path === "/subagent/lease") {
        const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
        const granted = await gate.acquire({ key, ...(timeoutMs ? { timeoutMs } : {}) });
        if (!granted) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `全局子任务名额已满（上限 ${gate.size}），等待超时`,
              ...gate.snapshot(),
            }),
          );
          return;
        }
        const route = opts.modelFor?.(key) ?? {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...gate.snapshot(), ...route }));
        return;
      }
      if (path === "/subagent/release") {
        gate.release(key);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...gate.snapshot() }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    })().catch((error: unknown) => {
      opts.onError?.(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "internal" }));
      }
    });
  });

  return new Promise<SubagentGateServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("子任务闸口监听失败"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        token,
        close: () => server.close(),
      });
    });
  });
}
