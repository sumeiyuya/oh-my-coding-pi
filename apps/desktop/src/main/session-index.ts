/**
 * 会话列表的异步扫描 + 增量缓存（修改 5 · C6）。
 *
 * 旧实现（`listSessions`）在主线程上 `readdirSync + statSync + readFileSync`，
 * 每个会话文件都要读一次、还要读第一行解 JSON。会话一多，这一段会和
 * 所有 IPC 抢主线程——切换变慢、界面卡顿都能追到它。
 *
 * 这里做三件事：
 *  1. **异步**：`readdir/stat/open` 全部 await，主线程在文件系统空转时能接别的活；
 *  2. **增量**：按 `mtime + size` 判断，没变过的文件不重读（只 stat）；
 *  3. **只读头部**：用 `open/read` 取前 4 KB 解首行，不再整文件读进内存。
 *
 * 缓存键是会话目录（`<工作区>/.omcp/sessions`），随进程生命周期存在；
 * 调用方需要"立刻重新算"时用 `invalidate(dir)`。
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SessionSummary } from "@oh-my-coding-pi/shared";

interface CachedEntry {
  mtimeMs: number;
  size: number;
  sessionId: string;
  updatedAt: string;
}

const HEADER_BYTES = 4096;

/** 只取首行那点字节：会话文件的 header 在第一行 */
async function readHeader(file: string, fallbackId: string): Promise<Pick<CachedEntry, "sessionId">> {
  try {
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
      const first = buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
      const header = JSON.parse(first) as { id?: string };
      if (header?.id) return { sessionId: header.id };
    } finally {
      await fh.close();
    }
  } catch {
    // 坏文件/半截文件：退回文件名，不影响列表
  }
  return { sessionId: fallbackId };
}

export class SessionIndex {
  private readonly dirs = new Map<string, Map<string, CachedEntry>>();

  /** 丢掉某个目录（或全部）的缓存 */
  invalidate(dir?: string): void {
    if (dir) this.dirs.delete(dir);
    else this.dirs.clear();
  }

  /**
   * 列一个目录里的会话，按修改时间倒序。
   *
   * **不抛错**：目录不存在/读不了就是空列表——列表是界面的一屏，不该因为
   * 一个权限问题把整个侧栏打空。
   */
  async list(dir: string): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      this.dirs.delete(dir);
      return [];
    }

    const cache = this.dirs.get(dir) ?? new Map<string, CachedEntry>();
    const seen = new Set<string>();
    const out: SessionSummary[] = [];

    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      seen.add(name);
      const file = join(dir, name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await stat(file);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue; // 正好被删/被移走
      }

      let entry = cache.get(name);
      if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
        const { sessionId } = await readHeader(file, name);
        entry = { mtimeMs, size, sessionId, updatedAt: new Date(mtimeMs).toISOString() };
        cache.set(name, entry);
      }
      out.push({ sessionId: entry.sessionId, sessionFile: file, updatedAt: entry.updatedAt });
    }

    for (const key of [...cache.keys()]) {
      if (!seen.has(key)) cache.delete(key);
    }
    this.dirs.set(dir, cache);
    out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return out;
  }

  /**
   * 一个目录的概览（侧栏的工作区行用它）：会话数与最近修改时间。
   *
   * 复用 `list` 的缓存——有会话文件变过才重读，其余只 stat；
   * 工作区列表本来 30 秒缓存一次，这里不会成为新热点。
   */
  async summarize(dir: string): Promise<{ count: number; latestMs: number }> {
    const list = await this.list(dir);
    let latestMs = 0;
    for (const item of list) {
      const at = item.updatedAt ? Date.parse(item.updatedAt) : 0;
      if (at > latestMs) latestMs = at;
    }
    return { count: list.length, latestMs };
  }
}
