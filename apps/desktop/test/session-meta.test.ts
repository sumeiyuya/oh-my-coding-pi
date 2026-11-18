import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSessionMeta, patchSessionMeta } from "../src/main/session-meta.ts";

const FILE = "2026-01-01T00-00-00-000Z_abc.jsonl";

test("置顶写入后能读回，取消后删除", () => {
  const root = mkdtempSync(join(tmpdir(), "omcp-meta-"));
  try {
    const a = patchSessionMeta(root, FILE, { pinned: true });
    assert.equal(a.ok, true);
    assert.equal(loadSessionMeta(root).sessions[FILE]?.pinned, true);

    const b = patchSessionMeta(root, FILE, { pinned: false });
    assert.equal(b.ok, true);
    assert.equal(loadSessionMeta(root).sessions[FILE]?.pinned, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("置顶与归档可共存", () => {
  const root = mkdtempSync(join(tmpdir(), "omcp-meta-"));
  try {
    patchSessionMeta(root, FILE, { pinned: true });
    patchSessionMeta(root, FILE, { archived: true });
    const entry = loadSessionMeta(root).sessions[FILE];
    assert.equal(entry?.pinned, true);
    assert.equal(entry?.archived, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
