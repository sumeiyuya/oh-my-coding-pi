import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionIndex } from "../src/main/session-index.ts";

/**
 * 修改 5 · C6：会话列表的增量扫描。
 *
 * 这里盯三件事：**首行解出来的 id**、**按 mtime 倒序**、**变了才重读**。
 * 第三条不能直接观测（没有读盘计数器），所以用「改写后能拿到新 id」间接证明
 * 增量分支确实走了——如果缓存永远不失效，这条会红。
 */

const line = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "session", id, timestamp: new Date().toISOString(), ...extra }) + "\n" +
  JSON.stringify({ type: "message", role: "user", content: "hello" }) + "\n";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omcp-session-index-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("列出 .jsonl，读首行拿 sessionId，非 .jsonl 忽略", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.jsonl"), line("id-a"));
    await writeFile(join(dir, "b.jsonl"), line("id-b"));
    await writeFile(join(dir, "notes.txt"), "x");

    const list = await new SessionIndex().list(dir);
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((s) => s.sessionId).sort(),
      ["id-a", "id-b"],
    );
  });
});

test("按 mtime 倒序（最近改过的排前面）", async () => {
  await withDir(async (dir) => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    await writeFile(a, line("id-a"));
    await writeFile(b, line("id-b"));
    await utimes(a, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
    await utimes(b, new Date("2026-11-20T00:00:00Z"), new Date("2026-11-20T00:00:00Z"));

    const list = await new SessionIndex().list(dir);
    assert.deepEqual(list.map((s) => s.sessionId), ["id-b", "id-a"]);
  });
});

test("文件变了（mtime/size 变）：重新解首行，不返回旧 id", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, line("id-old"));
    const index = new SessionIndex();
    assert.equal((await index.list(dir))[0]?.sessionId, "id-old");

    await writeFile(file, line("id-new", { note: "更长了，size 一定变" }));
    assert.equal((await index.list(dir))[0]?.sessionId, "id-new");
  });
});

test("文件没变：第二次照样给同样的结果（缓存不串台）", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.jsonl"), line("id-a"));
    const index = new SessionIndex();
    const first = await index.list(dir);
    const second = await index.list(dir);
    assert.deepEqual(second, first);
  });
});

test("删掉的文件从列表里消失（缓存要跟着清）", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.jsonl"), line("id-a"));
    await writeFile(join(dir, "b.jsonl"), line("id-b"));
    const index = new SessionIndex();
    assert.equal((await index.list(dir)).length, 2);

    await rm(join(dir, "b.jsonl"));
    const after = await index.list(dir);
    assert.deepEqual(after.map((s) => s.sessionId), ["id-a"]);
  });
});

test("首行坏掉：退回文件名当 id，不抛错", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "broken.jsonl"), "{ not json\n");
    const list = await new SessionIndex().list(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.sessionId, "broken.jsonl");
  });
});

test("空文件也算一条（id 退回文件名），列表不崩", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "empty.jsonl"), "");
    const list = await new SessionIndex().list(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.sessionId, "empty.jsonl");
  });
});

test("目录不存在：空列表，不抛错", async () => {
  const index = new SessionIndex();
  const list = await index.list(join(tmpdir(), "omcp-does-not-exist-" + Date.now()));
  assert.deepEqual(list, []);
});

test("invalidate 之后重新扫（外部改了文件也不会读到旧缓存）", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, line("id-a"));
    const index = new SessionIndex();
    assert.equal((await index.list(dir))[0]?.sessionId, "id-a");

    // 同 size、同秒内改写：不动 invalidate 的话可能命中缓存
    await writeFile(file, line("id-z"));
    index.invalidate(dir);
    assert.equal((await index.list(dir))[0]?.sessionId, "id-z");
  });
});

test("summarize：会话数与最近修改时间（工作区行用它）", async () => {
  await withDir(async (dir) => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    await writeFile(a, line("id-a"));
    await writeFile(b, line("id-b"));
    await utimes(a, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
    await utimes(b, new Date("2026-11-20T00:00:00Z"), new Date("2026-11-20T00:00:00Z"));

    const index = new SessionIndex();
    const summary = await index.summarize(dir);
    assert.equal(summary.count, 2);
    assert.equal(new Date(summary.latestMs).toISOString(), "2026-11-20T00:00:00.000Z");
  });
});

test("summarize：空目录 / 不存在 → count 0、latestMs 0", async () => {
  await withDir(async (dir) => {
    const index = new SessionIndex();
    assert.deepEqual(await index.summarize(dir), { count: 0, latestMs: 0 });
    assert.deepEqual(await index.summarize(join(dir, "nope")), { count: 0, latestMs: 0 });
  });
});
