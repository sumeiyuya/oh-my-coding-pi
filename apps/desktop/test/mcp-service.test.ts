import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  McpService,
  firstHttpUrl,
  mcpFingerprint,
  mcpSecretEnvName,
  type McpListRun,
  type SecretStoreLike,
} from "../src/main/mcp-service.ts";

class FakeSecrets implements SecretStoreLike {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): boolean {
    if (!value) this.map.delete(key);
    else this.map.set(key, value);
    return true;
  }
}

function setup(
  runList?: (env: NodeJS.ProcessEnv, cwd: string) => Promise<McpListRun>,
  runLogin?: (name: string) => Promise<McpListRun>,
) {
  const dir = mkdtempSync(join(tmpdir(), "omcp-mcp-"));
  const secrets = new FakeSecrets();
  let saved = 0;
  let calls = 0;
  const service = new McpService({
    agentDir: () => dir,
    workspaceRoot: () => dir,
    secrets: () => secrets,
    piEntry: () => ({ kind: "node", entry: "pi.js" }),
    trustFile: () => join(dir, "mcp-trust.json"),
    onConfigSaved: () => {
      saved += 1;
    },
    runList: async (env, cwd) => {
      calls += 1;
      if (runList) return runList(env, cwd);
      return { code: 0, stdout: '{"servers":[],"errors":[]}', stderr: "" };
    },
    runLogin,
  });
  return {
    dir,
    secrets,
    service,
    file: join(dir, "mcp.json"),
    saved: () => saved,
    calls: () => calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("空配置：list 不报错，状态 unchecked", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const list = ctx.service.list();
  assert.equal(list.configPath, ctx.file);
  assert.deepEqual(list.servers, []);
  assert.deepEqual(list.problems, []);
});

test("save：明文密钥搬到 SecretStore，配置里只留占位", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const result = ctx.service.save({
    json: JSON.stringify({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "server-filesystem", "."],
          env: { API_KEY: "super-secret" },
        },
      },
    }),
  });

  assert.equal(result.name, "fs");
  assert.deepEqual(result.needsSecrets, []);
  assert.equal(ctx.secrets.get("mcp:fs:API_KEY"), "super-secret");

  const text = readFileSync(ctx.file, "utf8");
  assert.match(text, /\$\{OMCP_MCP_FS_API_KEY\}/);
  assert.doesNotMatch(text, /super-secret/);

  const view = result.list.servers[0]!;
  assert.equal(view.transport, "stdio");
  assert.equal(view.exposure, "direct");
  assert.equal(view.enabled, true);
  assert.deepEqual(view.secrets, ["API_KEY"]);
  assert.deepEqual(view.missingSecrets, []);
  assert.equal(view.state, "unchecked");
  assert.equal(ctx.saved(), 1);
});

test("save：HTTP 服务器 + headers 明文也迁进密钥库", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const result = ctx.service.save({
    name: "docs",
    json: JSON.stringify({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc123" },
      exposure: "deferred",
    }),
  });
  assert.equal(result.name, "docs");
  assert.equal(ctx.secrets.get("mcp:docs:Authorization"), "Bearer abc123");
  const text = readFileSync(ctx.file, "utf8");
  assert.match(text, /\$\{OMCP_MCP_DOCS_AUTHORIZATION\}/);
  assert.doesNotMatch(text, /abc123/);
  assert.equal(result.list.servers[0]!.transport, "http");
  assert.equal(result.list.servers[0]!.exposure, "deferred");
});

test("save：用户自己的 ${VAR} 保留，缺值时如实体现在 missingSecrets", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const result = ctx.service.save({
    name: "custom",
    json: JSON.stringify({
      command: "node",
      env: { TOKEN: "${OMCP_TEST_MISSING_TOKEN_XYZ}" },
    }),
  });
  assert.deepEqual(result.needsSecrets, ["TOKEN"]);
  assert.deepEqual(result.list.servers[0]!.missingSecrets, ["TOKEN"]);
  const text = readFileSync(ctx.file, "utf8");
  assert.match(text, /\$\{OMCP_TEST_MISSING_TOKEN_XYZ\}/);
});

test("save：非法名字拒绝，文件不被创建", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  assert.throws(
    () => ctx.service.save({ name: "中文 名字", json: '{"command":"node"}' }),
    /名字/,
  );
  assert.equal(existsSync(ctx.file), false);
});

test("save：坏 JSON 拒绝，已有配置原样保留", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.service.save({ name: "ok", json: '{"command":"node"}' });
  const before = readFileSync(ctx.file, "utf8");
  assert.throws(() => ctx.service.save({ name: "bad", json: "{oops" }), /JSON/);
  assert.equal(readFileSync(ctx.file, "utf8"), before);
});

test("save：第二次写入前备份 .bak", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.service.save({ name: "a", json: '{"command":"node"}' });
  ctx.service.save({ name: "b", json: '{"command":"node"}' });
  assert.ok(existsSync(`${ctx.file}.bak`));
  const backup = JSON.parse(readFileSync(`${ctx.file}.bak`, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(backup.mcpServers.a);
  assert.equal(backup.mcpServers.b, undefined);
});

test("remove：只删指定的一台", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.service.save({ name: "a", json: '{"command":"node"}' });
  ctx.service.save({ name: "b", json: '{"command":"node"}' });
  const list = ctx.service.remove("a");
  assert.deepEqual(list.servers.map((server) => server.name), ["b"]);
});

test("trusted：按指纹记；指纹变了旧信任失效", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const saved = ctx.service.save({ name: "a", json: '{"command":"node","args":["one"]}' });
  const before = saved.list.servers[0]!;

  const trusted = ctx.service.setFlag("a", "trusted", true, before.fingerprint);
  assert.equal(trusted.servers[0]!.trusted, true);

  // 指纹变了 = 另一台：直接信任会拒绝
  ctx.service.save({ name: "a", json: '{"command":"node","args":["two"]}' });
  const changed = ctx.service.list().servers[0]!;
  assert.notEqual(changed.fingerprint, before.fingerprint);
  assert.equal(changed.trusted, false);
  assert.throws(() => ctx.service.setFlag("a", "trusted", true, before.fingerprint), /变化/);
});

test("check：状态映射 + tools 解析 + note/errors 透传", async (t) => {
  const ctx = setup(async () => ({
    code: 0,
    stdout: JSON.stringify({
      servers: [
        { name: "a", state: "connected", tools: ["read_file", { name: "list", description: "列目录" }] },
        { name: "b", state: "failed", tools: [], error: "ECONNREFUSED" },
        { name: "c", state: "needs-auth", tools: [] },
      ],
      errors: ["某个配置被跳过"],
      note: "项目未信任",
    }),
    stderr: "",
  }));
  t.after(ctx.cleanup);
  ctx.service.save({ name: "a", json: '{"command":"node"}' });
  ctx.service.save({ name: "b", json: '{"url":"http://127.0.0.1:9/mcp"}' });
  ctx.service.save({ name: "c", json: '{"url":"https://example.com/mcp"}' });

  const list = await ctx.service.check();
  const a = list.servers.find((server) => server.name === "a")!;
  const b = list.servers.find((server) => server.name === "b")!;
  const c = list.servers.find((server) => server.name === "c")!;
  assert.equal(a.state, "ready");
  assert.equal(c.state, "needs-auth");
  assert.deepEqual(a.tools.map((tool) => tool.name), ["read_file", "list"]);
  assert.equal(b.state, "failed");
  assert.equal(b.error, "ECONNREFUSED");
  assert.equal(list.note, "项目未信任");
  assert.ok(list.problems.some((problem) => problem.includes("某个配置被跳过")));
});

test("check：超时 → 所有启用的服务器 failed，并说明原因", async (t) => {
  const ctx = setup(async () => ({ code: null, stdout: "", stderr: "", timedOut: true }));
  t.after(ctx.cleanup);
  ctx.service.save({ name: "a", json: '{"command":"node"}' });
  const list = await ctx.service.check();
  assert.equal(list.servers[0]!.state, "failed");
  assert.match(list.servers[0]!.error ?? "", /超时/);
});

test("check：没有启用的服务器时不起子进程", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.service.save({ name: "a", json: '{"command":"node","enabled":false}' });
  const list = await ctx.service.check();
  assert.equal(ctx.calls(), 0);
  assert.equal(list.servers[0]!.state, "disabled");
});

test("setSecret：填上后 missing 消失；空值删除", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.service.save({ name: "a", json: '{"command":"node","env":{"TOKEN":"${OMCP_TEST_TOKEN_ABC}"}}' });
  assert.deepEqual(ctx.service.list().servers[0]!.missingSecrets, ["TOKEN"]);

  const filled = ctx.service.setSecret("a", "TOKEN", "value");
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.list.servers[0]!.missingSecrets, []);

  const cleared = ctx.service.setSecret("a", "TOKEN", "");
  assert.deepEqual(cleared.list.servers[0]!.missingSecrets, ["TOKEN"]);
});

test("指纹：同配置稳定，参数变化就不同", () => {
  const a = mcpFingerprint({ command: "npx", args: ["-y", "x"] });
  const b = mcpFingerprint({ command: "npx", args: ["-y", "x"] });
  const c = mcpFingerprint({ command: "npx", args: ["-y", "y"] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(mcpSecretEnvName("my-server", "api-key"), "OMCP_MCP_MY_SERVER_API_KEY");
});

test("配置里字段非法：list 报 problem，不静默丢", (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  writeFileSync(
    ctx.file,
    JSON.stringify({
      mcpServers: {
        bad: { command: "node", url: "https://example.com/mcp" },
        ok: { command: "node" },
      },
    }),
    "utf8",
  );
  const list = ctx.service.list();
  assert.deepEqual(list.servers.map((server) => server.name), ["ok"]);
  assert.ok(list.problems.some((problem) => problem.includes("只能二选一")));
});

test("login：成功时返回授权页 URL", async (t) => {
  const ctx = setup(undefined, async () => ({
    code: 0,
    stdout: 'Sign in to MCP server "docs" in your browser:\nhttps://example.com/auth?state=abc',
    stderr: "",
  }));
  t.after(ctx.cleanup);
  ctx.service.save({ name: "docs", json: '{"url":"https://example.com/mcp"}' });
  const result = await ctx.service.login("docs");
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/auth?state=abc");
});

test("login：失败时把 pi 的原因带回来", async (t) => {
  const ctx = setup(undefined, async () => ({ code: 1, stdout: "", stderr: "boom" }));
  t.after(ctx.cleanup);
  ctx.service.save({ name: "docs", json: '{"url":"https://example.com/mcp"}' });
  const result = await ctx.service.login("docs");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /boom/);
});

test("login：stdio 服务器不需要 OAuth", async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  ctx.service.save({ name: "fs", json: '{"command":"node"}' });
  await assert.rejects(() => ctx.service.login("fs"), /远程/);
});

test("firstHttpUrl：只取第一个 http(s) 地址", () => {
  assert.equal(firstHttpUrl("see https://a.example/x?y=1 and http://b.example"), "https://a.example/x?y=1");
  assert.equal(firstHttpUrl("no url here"), undefined);
});
