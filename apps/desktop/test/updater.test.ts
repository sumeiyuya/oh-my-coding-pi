import test from "node:test";
import assert from "node:assert/strict";

import { checkForUpdate } from "../src/main/updater.ts";

/**
 * 更新检查的错误分层（D2）：
 * 目标是"用户能据此行动"——私有仓、填错地址、超时、断网要说成四件不同的事。
 * 这里全部用 mock fetch，不发真实网络请求。
 */

type Handler = (url: string) => Response | Promise<Response>;

async function run(handler: Handler, repo = "owner/repo", current = "0.5.6") {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) =>
    Promise.resolve(handler(String(input)))) as typeof fetch;
  try {
    return await checkForUpdate(current, repo, 50);
  } finally {
    globalThis.fetch = original;
  }
}

function httpError(status: number): Handler {
  return () => new Response("{}", { status });
}

test("401 / 403：判为 auth（私有仓或权限不足）", async () => {
  for (const status of [401, 403]) {
    const res = await run(httpError(status));
    assert.equal(res.errorKind, "auth", `HTTP ${status} 应为 auth`);
    assert.match(String(res.error), /仓库不可访问/);
    assert.equal(res.latest, undefined);
  }
});

test("404：判为 not_found（仓库或 release 不存在）", async () => {
  const res = await run(httpError(404));
  assert.equal(res.errorKind, "not_found");
  assert.match(String(res.error), /不存在/);
});

test("429：判为 ratelimit", async () => {
  const res = await run(httpError(429));
  assert.equal(res.errorKind, "ratelimit");
  assert.match(String(res.error), /过于频繁/);
});

test("5xx：归入 network，但文案保留状态码", async () => {
  const res = await run(httpError(503));
  assert.equal(res.errorKind, "network");
  assert.match(String(res.error), /503/);
});

test("超时：判为 timeout", async () => {
  const res = await run(() => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  });
  assert.equal(res.errorKind, "timeout");
  assert.match(String(res.error), /请求超时/);
});

test("断网 / DNS 失败：判为 network", async () => {
  const res = await run(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal(res.errorKind, "network");
  assert.match(String(res.error), /网络请求失败/);
});

test("返回体不是 JSON：判为 parse", async () => {
  const res = await run(() => new Response("<html>rate limited</html>", { status: 200 }));
  assert.equal(res.errorKind, "parse");
  assert.match(String(res.error), /不是有效 JSON/);
});

test("缺少 tag_name：判为 parse", async () => {
  const res = await run(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 200 }));
  assert.equal(res.errorKind, "parse");
  assert.match(String(res.error), /tag_name/);
});

test("正常返回：给出 latest / hasUpdate，且不带 errorKind", async () => {
  const res = await run(
    () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.6.0",
          html_url: "https://github.com/owner/repo/releases/tag/v0.6.0",
          body: "修了几个问题",
          published_at: "2026-11-20T00:00:00Z",
        }),
        { status: 200 },
      ),
  );
  assert.equal(res.error, undefined);
  assert.equal(res.errorKind, undefined);
  assert.equal(res.latest, "0.6.0");
  assert.equal(res.hasUpdate, true);
  assert.equal(res.notes, "修了几个问题");
});

test("同版本不算有更新", async () => {
  const res = await run(() => new Response(JSON.stringify({ tag_name: "v0.5.6" }), { status: 200 }));
  assert.equal(res.hasUpdate, false);
  assert.equal(res.errorKind, undefined);
});

test("校验和取不到不影响版本结论", async () => {
  const res = await run((url) => {
    if (url.includes("checksums")) return new Response("", { status: 500 });
    return new Response(
      JSON.stringify({
        tag_name: "v0.6.0",
        assets: [{ name: "SHA256SUMS.txt", browser_download_url: "https://x/checksums.txt" }],
      }),
      { status: 200 },
    );
  });
  assert.equal(res.errorKind, undefined);
  assert.equal(res.latest, "0.6.0");
  assert.equal(res.sha256, null);
});

test("更新源格式错误：给提示，但不是网络分类", async () => {
  const res = await run(() => new Response("{}", { status: 200 }), "not-a-repo");
  assert.match(String(res.error), /owner\/repo/);
  assert.equal(res.errorKind, undefined);
});

test("未配置更新源：直接返回 configured=false，不发请求", async () => {
  let called = false;
  const res = await run(
    () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
    "",
  );
  assert.equal(res.configured, false);
  assert.equal(called, false);
});
