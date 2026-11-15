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
export class KernelBroker {
  private server: Server | null = null;
  url = "";
  token = "";

  constructor(
    private readonly services: { python: KernelService; r: KernelService },
    private readonly onImage?: (data: string) => void,
    /** 纯文本模型下把图片转述成文字；返回 null 表示按原样透传图片 */
    private readonly describeImage?: (data: string, mimeType: string) => Promise<string | null>,
  ) {}

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
    if (req.headers.authorization !== `Bearer ${this.token}`) {
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
          python: this.services.python.isReady,
          r: this.services.r.isReady,
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
      body.lang === "r" ? this.services.r : this.services.python;

    if (req.method === "POST" && path === "/execute") {
      if (typeof body.code !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "code is required" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      try {
        const pending: Array<Promise<void>> = [];
        await service.execute(
          body.code,
          (ev) => {
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
      } catch (err) {
        res.write(
          JSON.stringify({
            ev: "error",
            id: body.id,
            ename: "KernelError",
            evalue: (err as Error).message,
            traceback: [],
          }) + "\n",
        );
        res.write(JSON.stringify({ ev: "result", id: body.id, status: "error" }) + "\n");
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
