import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PiCommand, PiResponse, PiStreamItem } from "@oh-my-coding-pi/shared";

interface Pending {
  resolve: (r: PiResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  command: PiCommand["type"];
}

/**
 * Typed JSONL RPC client. Emits:
 *  - "event" (PiEvent)
 *  - "response" (PiResponse)
 */
export class RpcClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();

  get attached(): boolean {
    return this.proc !== null;
  }

  attach(proc: ChildProcessWithoutNullStreams): void {
    this.detach();
    this.proc = proc;
    this.reader = createInterface({ input: proc.stdout });
    this.reader.on("line", (line) => this.onLine(line));
    proc.stderr.on("data", (chunk) => {
      process.stderr.write("[pi] " + chunk.toString());
    });
  }

  detach(): void {
    this.reader?.close();
    this.reader = null;
    this.proc = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("pi disconnected"));
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let item: PiStreamItem;
    try {
      item = JSON.parse(line) as PiStreamItem;
    } catch {
      return;
    }
    if (item.type === "response") {
      const p = this.pending.get(item.id);
      if (p) {
        this.pending.delete(item.id);
        clearTimeout(p.timer);
        p.resolve(item);
      }
      this.emit("response", item);
      return;
    }
    this.emit("event", item);
  }

  send(cmd: PiCommand): void {
    if (!this.proc) throw new Error("pi is not running");
    const id = `r${++this.seq}`;
    this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  }

  /** 发送不遵循命令信封的原始消息（例如 extension_ui_response） */
  sendRaw(payload: Record<string, unknown>): void {
    if (!this.proc) throw new Error("pi is not running");
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  request(cmd: PiCommand, timeoutMs = 30_000): Promise<PiResponse> {
    if (!this.proc) return Promise.reject(new Error("pi is not running"));
    const id = `r${++this.seq}`;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${cmd.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: cmd.type });
      this.proc!.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }
}
