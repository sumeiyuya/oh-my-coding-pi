import { useCallback, useEffect, useState } from "react";
import type { McpListView, McpSaveResult, McpServerView } from "@oh-my-coding-pi/shared";

/**
 * MCP 服务器设置（P1）。
 *
 * 三条纪律：
 * 1. 列表先给「配了什么、连没连、为什么」，再给动作；
 * 2. 密钥只写不读：填完只显示「已保存」，不回显；
 * 3. 连接检查有副作用（会启动服务器），按钮旁边必须写明。
 */

const STATE_LABEL: Record<McpServerView["state"], string> = {
  unchecked: "未检查",
  checking: "检查中…",
  ready: "已连接",
  failed: "失败",
  "needs-auth": "需要登录",
  disabled: "已停用",
};

function stateClass(state: McpServerView["state"]): string {
  if (state === "ready") return "perm-ok";
  if (state === "failed") return "perm-decision deny";
  if (state === "checking" || state === "needs-auth") return "perm-new";
  return "perm-note";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandLine(server: McpServerView): string {
  if (server.transport === "http") return server.url ?? "";
  return [server.command ?? "", ...server.args].filter(Boolean).join(" ");
}

export default function McpSettings() {
  const [list, setList] = useState<McpListView | null>(null);
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [secretFor, setSecretFor] = useState<{ name: string; key: string } | null>(null);
  const [secretValue, setSecretValue] = useState("");
  const [secretBusy, setSecretBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const res = (await window.api.listMcpServers()) as McpListView;
      setList(res ?? null);
    } catch (err) {
      setError(`读取 MCP 名单失败：${errorText(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = async () => {
    setChecking(true);
    setMsg("");
    setError("");
    try {
      const res = (await window.api.checkMcpServers()) as McpListView;
      setList(res);
      const failed = res.servers.filter((server) => server.state === "failed").length;
      setMsg(
        failed > 0
          ? `检查完成：${failed} 台没连上，原因见下。`
          : "检查完成。",
      );
    } catch (err) {
      setError(`检查失败：${errorText(err)}`);
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!json.trim()) {
      setError("先粘贴一段服务器 JSON");
      return;
    }
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const res = (await window.api.saveMcpServer({
        json,
        ...(name.trim() ? { name: name.trim() } : {}),
      })) as McpSaveResult;
      setList(res.list);
      setJson("");
      setName("");
      setMsg(
        res.needsSecrets.length > 0
          ? `已保存「${res.name}」；还差 ${res.needsSecrets.join("、")}，填上后再检查。`
          : `已保存「${res.name}」。pi 正在重启，下一段会话按新配置连接。`,
      );
    } catch (err) {
      setError(`保存失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (server: McpServerView) => {
    if (
      !window.confirm(
        `删掉 MCP 服务器「${server.name}」？只删全局配置，项目里的 .pi/mcp.json 不动。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const res = (await window.api.removeMcpServer(server.name)) as McpListView;
      setList(res);
      setMsg(`已删掉「${server.name}」。pi 正在重启。`);
    } catch (err) {
      setError(`删除失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (server: McpServerView, flag: "enabled" | "trusted") => {
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const value = flag === "trusted" ? !server.trusted : !server.enabled;
      const res = (await window.api.setMcpFlag(
        server.name,
        flag,
        value,
        server.fingerprint,
      )) as McpListView;
      setList(res);
      if (flag === "trusted") {
        setMsg(value ? `已信任「${server.name}」。` : `已取消信任「${server.name}」。`);
      } else {
        setMsg(value ? `已启用「${server.name}」；pi 正在重启。` : `已停用「${server.name}」；pi 正在重启。`);
      }
    } catch (err) {
      setError(`保存开关失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    if (!secretFor) return;
    setSecretBusy(true);
    setMsg("");
    setError("");
    try {
      const res = (await window.api.setMcpSecret(
        secretFor.name,
        secretFor.key,
        secretValue,
      )) as { ok: boolean; list: McpListView };
      setList(res.list);
      if (!res.ok) {
        setError("密钥没存进去：系统安全存储不可用（不会写明文）。");
      } else {
        setMsg(`「${secretFor.key}」已保存（不会回显）。`);
        setSecretValue("");
        setSecretFor(null);
      }
    } catch (err) {
      setError(`保存密钥失败：${errorText(err)}`);
    } finally {
      setSecretBusy(false);
    }
  };

  const login = async (server: McpServerView) => {
    setLoginBusy(server.name);
    setBusy(true);
    setLoginUrl(null);
    setMsg("");
    setError("");
    try {
      const res = (await window.api.loginMcpServer(server.name)) as {
        ok: boolean;
        url?: string;
        error?: string;
      };
      if (res.url) setLoginUrl(res.url);
      if (res.ok) {
        setMsg(`已登录「${server.name}」。点「检查全部连接」确认工具已经出现。`);
        void refresh();
      } else {
        setError(res.error ?? `登录「${server.name}」失败`);
      }
    } catch (err) {
      setError(`登录失败：${errorText(err)}`);
    } finally {
      setLoginBusy(null);
      setBusy(false);
    }
  };

  const openConfig = async () => {
    setError("");
    try {
      const res = (await window.api.openMcpConfig()) as {
        ok: boolean;
        path: string;
        error?: string;
      };
      if (!res.ok) setError(res.error ?? `打不开配置文件：${res.path}`);
    } catch (err) {
      setError(`打不开配置文件：${errorText(err)}`);
    }
  };

  return (
    <section className="perm-card">
      <div className="perm-head">
        <b>MCP 服务器</b>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => void check()} disabled={checking || busy}>
            {checking ? "检查中…" : "检查全部连接"}
          </button>
          <button onClick={() => void openConfig()}>打开配置</button>
        </div>
      </div>

      <div className="perm-note">
        连接、工具注册与调用都由 pi 内置的 MCP 支持完成；这里只管配置、密钥、状态与信任。
        <b>「检查全部连接」会启动所有已启用的服务器</b>，第一次用 npx / uvx 的服务器可能要下载几十秒。
      </div>

      {!list ? (
        <div className="perm-empty">正在读取 MCP 名单…</div>
      ) : (
        <>
          <div className="perm-row">
            <span>配置</span>
            <code className="perm-path">{list.configPath}</code>
          </div>

          {list.note && <div className="perm-note">{list.note}</div>}

          {list.problems.map((problem, index) => (
            <div key={`${problem}-${index}`} className="perm-error">
              {problem}
            </div>
          ))}

          {list.servers.length === 0 ? (
            <div className="perm-empty">还没有配 MCP 服务器。下面粘贴一段 JSON 就能加一台。</div>
          ) : (
            list.servers.map((server) => (
              <div
                key={server.name}
                style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}
              >
                <div className="perm-head" style={{ marginBottom: 2 }}>
                  <b style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {server.name}
                    <span className={stateClass(server.state)}>{STATE_LABEL[server.state]}</span>
                    <span className="perm-note">
                      {server.from === "project" ? "这个项目带的" : "全局"}
                    </span>
                  </b>
                  <span className="perm-note">
                    {server.tools.length} 个工具 · {server.exposure}
                  </span>
                </div>

                <div className="perm-row">
                  <span>命令</span>
                  <code className="perm-path">{commandLine(server)}</code>
                </div>

                {server.description && <div className="perm-note">{server.description}</div>}
                {server.transport === "http" && (
                  <div className="perm-note">远程服务器：工具入参可能离开本机。</div>
                )}
                {server.error && <div className="perm-error">{server.error}</div>}

                {server.missingSecrets.length > 0 && (
                  <div className="perm-note">
                    还差 {server.missingSecrets.join("、")} 没填，填上才连得起来。
                  </div>
                )}

                {server.tools.length > 0 && (
                  <div className="perm-note">
                    工具：{server.tools.slice(0, 8).map((tool) => tool.name).join(" · ")}
                    {server.tools.length > 8 ? `　还有 ${server.tools.length - 8} 个` : ""}
                  </div>
                )}

                <div className="perm-row" style={{ flexWrap: "wrap", paddingTop: 6 }}>
                  {server.missingSecrets.length > 0 && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setSecretFor({ name: server.name, key: server.missingSecrets[0]! });
                        setSecretValue("");
                      }}
                    >
                      去填 {server.missingSecrets[0]}
                    </button>
                  )}
                  {server.transport === "http" && (
                    <button
                      disabled={busy || loginBusy === server.name}
                      onClick={() => void login(server)}
                    >
                      {loginBusy === server.name ? "等待浏览器…" : "登录（OAuth）"}
                    </button>
                  )}
                  <button disabled={busy} onClick={() => void toggle(server, "trusted")}>
                    {server.trusted ? "取消信任" : "这台我信得过"}
                  </button>
                  <button disabled={busy} onClick={() => void toggle(server, "enabled")}>
                    {server.enabled ? "先别连它" : "启用"}
                  </button>
                  <button disabled={busy} onClick={() => void remove(server)}>
                    删掉
                  </button>
                </div>

                {secretFor?.name === server.name && (
                  <div className="perm-form" style={{ marginTop: 6 }}>
                    <label>
                      {secretFor.key}（只写不读）
                      <input
                        type="password"
                        value={secretValue}
                        autoFocus
                        onChange={(event) => setSecretValue(event.target.value)}
                      />
                    </label>
                    <button disabled={secretBusy || !secretValue} onClick={() => void saveSecret()}>
                      {secretBusy ? "保存中…" : "保存密钥"}
                    </button>
                    <button
                      disabled={secretBusy}
                      onClick={() => {
                        setSecretFor(null);
                        setSecretValue("");
                      }}
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            ))
          )}

          {loginUrl && (
            <div className="perm-note">
              浏览器没自动打开？{" "}
              <a
                href={loginUrl}
                onClick={(event) => {
                  event.preventDefault();
                  void window.api.openExternal(loginUrl);
                }}
              >
                点这里打开授权页
              </a>
            </div>
          )}

          <div className="perm-head" style={{ marginTop: 18 }}>
            <b>加一台</b>
          </div>
          <div className="perm-form">
            <textarea
              className="mcp-json"
              value={json}
              rows={6}
              placeholder={
                '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"],\n      "exposure": "direct"\n    }\n  }\n}'
              }
              onChange={(event) => setJson(event.target.value)}
            />
            <label>
              名字（JSON 里已有就留空）
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="filesystem"
              />
            </label>
            <button onClick={() => void save()} disabled={busy || !json.trim()}>
              {busy ? "保存中…" : "解析并保存"}
            </button>
          </div>

          {msg && <div className="perm-note">{msg}</div>}
          {error && <div className="perm-error">{error}</div>}

          <div className="perm-note" style={{ marginTop: 10 }}>
            本地服务器会以你的用户权限运行任意命令；远程服务器的工具入参可能离开本机。
            审批门只管「工具调用」这一层，不是沙箱。启动时会在后台检查一次连接（不阻塞会话）。
            密钥存在应用的安全存储里，
            <code>mcp.json</code> 只写 <code>{"${OMCP_MCP_…}"}</code> 占位。
          </div>
        </>
      )}
    </section>
  );
}
