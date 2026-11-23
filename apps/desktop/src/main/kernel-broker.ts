import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { KernelService } from "./kernel-service";

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
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
 * Localhost HTTP broker for both kernels. The pi extension and the
 * renderer go through this single broker, so chat and notebook share kernels.
 */
export interface KernelOutcome {
  lang: "python" | "r";
  /** P2b6b：这次执行属于哪个 runtime；默认 runtime 可缺 */
  runtimeId?: string;
  ok: boolean;
  status: string;
  durationMs: number;
  errorClass?: string;
  kernelPid?: number;
}

export class KernelBroker {
  private server: Server | null = null;
  url = "";
  token = "";

  private readonly services: { python: KernelService; r: KernelService };
  private readonly onImage?: (data: string) => void;
  private readonly describeImage?: (data: string, mimeType: string) => Promise<string | null>;
  private readonly onOutcome?: (outcome: KernelOutcome) => void;
  private readonly resolve?: (
    token: string,
  ) => { runtimeId: string; services: { python: KernelService; r: KernelService } } | undefined;

  constructor(
    services: { python: KernelService; r: KernelService },
    onImage?: (data: string) => void,
    /** 纯文本模型下把图片转述成文字；返回 null 表示按原样透传图片 */
    describeImage?: (data: string, mimeType: string) => Promise<string | null>,
    /** 每次 run_code 结束后报一次结果，供审计落盘（报告 P4） */
    onOutcome?: (outcome: KernelOutcome) => void,
    /**
     * P1b2b：runtime token → 该 runtime 的内核。
     * 返回 undefined 时回落到 legacy 全局 token（默认 runtime 兼容）。
     */
    resolve?: (
      token: string,
    ) => { runtimeId: string; services: { python: KernelService; r: KernelService } } | undefined,
  ) {
    this.services = services;
    this.onImage = onImage;
    this.describeImage = describeImage;
    this.onOutcome = onOutcome;
    this.resolve = resolve;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token = randomBytes(24).toString("hex");
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("broker listen failed");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorization = req.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const resolved = this.resolve?.(token);
    const services = resolved?.services ?? (token && token === this.token ? this.services : undefined);
    if (!services) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const path = (req.url || "/").split("?")[0];

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          python: services.python.isReady,
          r: services.r.isReady,
        }),
      );
      return;
    }

    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    }
    const service: KernelService =
      body.lang === "r" ? services.r : services.python;

    if (req.method === "POST" && path === "/execute") {
      if (typeof body.code !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "code is required" }));
        return;
      }
      const lang: "python" | "r" = body.lang === "r" ? "r" : "python";
      const startedAt = Date.now();
      let status = "unknown";
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      try {
        const pending: Array<Promise<void>> = [];
        await service.execute(
          body.code,
          (ev) => {
            if (ev.ev === "result" && typeof ev.status === "string") status = ev.status;
            if (ev.ev === "display" && ev.mime === "image/png" && ev.data) {
              this.onImage?.(ev.data);
              if (this.describeImage) {
                const data = ev.data;
                pending.push(
                  this.describeImage(data, "image/png").then((text) => {
                    if (text) {
                      res.write(
                        JSON.stringify({
                          ev: "stream",
                          id: body.id,
                          name: "stdout",
                          text: "\n[图片转述] " + text + "\n",
                        }) + "\n",
                      );
                    } else {
                      res.write(JSON.stringify(ev) + "\n");
                    }
                  }),
                );
                return;
              }
            }
            res.write(JSON.stringify(ev) + "\n");
          },
          typeof body.timeoutMs === "number" ? body.timeoutMs : 120_000,
        );
        if (pending.length) await Promise.all(pending);
        this.onOutcome?.({
          lang,
          ...(resolved ? { runtimeId: resolved.runtimeId } : {}),
          ok: true,
          status,
          durationMs: Date.now() - startedAt,
          kernelPid: service.pid ?? undefined,
        });
      } catch (err) {
        const message = (err as Error).message || String(err);
        const errorClass = /timeout/i.test(message)
          ? "Timeout"
          : /kernel exited/i.test(message)
            ? "KernelExited"
            : "KernelError";
        res.write(
          JSON.stringify({
            ev: "error",
            id: body.id,
            ename: "KernelError",
            evalue: message,
            traceback: [],
          }) + "\n",
        );
        res.write(JSON.stringify({ ev: "result", id: body.id, status: "error" }) + "\n");
        this.onOutcome?.({
          lang,
          ...(resolved ? { runtimeId: resolved.runtimeId } : {}),
          ok: false,
          status: "error",
          durationMs: Date.now() - startedAt,
          errorClass,
          kernelPid: service.pid ?? undefined,
        });
      }
      res.end();
      return;
    }

    if (req.method === "POST" && path === "/interrupt") {
      await service.interrupt();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && path === "/restart") {
      await service.restart();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && path === "/variables") {
      const names = await service.variables();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, names }));
      return;
    }

    if (req.method === "POST" && path === "/shutdown") {
      this.services.python.shutdown();
      this.services.r.shutdown();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }
}
