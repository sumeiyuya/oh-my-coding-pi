import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { pathsFromToolResult, type ArtifactLedger, type ArtifactListResult } from "./artifact-ledger.ts";

/**
 * 产物账本的本地 HTTP 端点：pi 扩展在每次 tool_result 后把「工具 + 入参」送过来。
 *
 * 为什么走 HTTP：扩展跑在 pi 的子进程里，拿不到主进程的 workspaceRoot 与当前会话；
 * 与权限扩展（policy-service）同一套路，失败方向也一样——记账失败绝不影响工具结果。
 */
export class ArtifactService {
  private server: Server | null = null;
  url = "";
  token = "";

  private readonly ledger: ArtifactLedger;
  private readonly workspace: () => string | null;
  private readonly session: () => string;
  /** P1b2c：runtime token → 该 runtime 的 workspace */
  private readonly resolve?: (token: string) => { runtimeId: string; workspace: string } | undefined;

  constructor(
    ledger: ArtifactLedger,
    workspace: () => string | null,
    session: () => string,
    resolve?: (token: string) => { runtimeId: string; workspace: string } | undefined,
  ) {
    this.ledger = ledger;
    this.workspace = workspace;
    this.session = session;
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
    if (!address || typeof address === "string") throw new Error("artifact service listen failed");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  list(): ArtifactListResult {
    return this.ledger.list({ session: this.session() });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorization = req.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const resolved = this.resolve?.(token);
    const legacy = token !== "" && token === this.token;
    if (!resolved && !legacy) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const path = (req.url || "/").split("?")[0];

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && path === "/tool-result") {
      const raw = await readBody(req);
      let body: { toolName?: unknown; toolCallId?: unknown; input?: unknown } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad json" }));
        return;
      }
      const tool = typeof body.toolName === "string" ? body.toolName : "";
      const root = resolved?.workspace ?? this.workspace();
      if (!tool || !root) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "toolName/workspace missing" }));
        return;
      }
      const input =
        body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
      const { paths, unknown } = pathsFromToolResult(root, tool, input);
      this.ledger.append({
        ts: new Date().toISOString(),
        session: this.session(),
        tool,
        toolCallId: typeof body.toolCallId === "string" ? body.toolCallId : "",
        paths,
        unknown,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, recorded: paths.length, unknown }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }
}

function readBody(req: IncomingMessage, limit = 200_000): Promise<string> {
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
