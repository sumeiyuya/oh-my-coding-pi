import { useCallback, useEffect, useState } from "react";
import type { MemoryItem, MemoryQueue, PluginsResult, PluginView } from "@oh-my-coding-pi/shared";

/**
 * 插件设置（ADR-045/046）。
 *
 * 两件事：
 * 1. 开关：整包 + 分族。关掉的族**不注册**给 pi（注册了就算禁用也占系统提示），
 *    所以改完要重启 pi，下一段新会话生效。
 * 2. 记忆队列：pending 里是模型提议的长期事实，采纳后才进系统提示。
 */
export default function PluginSettings() {
  const [data, setData] = useState<PluginsResult | null>(null);
  const [queue, setQueue] = useState<MemoryQueue>({ pending: [], approved: [] });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [plugins, memory] = await Promise.all([window.api.listPlugins(), window.api.memoryList()]);
      setData((plugins as PluginsResult) ?? null);
      setQueue(((memory as MemoryQueue) ?? { pending: [], approved: [] }) as MemoryQueue);
    } catch {
      setData(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (plugin: PluginView, familyKey: string | null, on: boolean) => {
    setBusy(true);
    try {
      const res = (await window.api.setPluginFlag(plugin.id, familyKey, on)) as PluginsResult;
      setData(res ?? null);
      setMsg("已保存。改动在下一段新会话生效（pi 正在按新工具集重启）。");
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (item: MemoryItem) => {
    const res = (await window.api.memoryAdopt(item.id)) as { ok: boolean; error?: string; queue?: MemoryQueue };
    if (res.queue) setQueue(res.queue);
    setMsg(res.ok ? "已采纳，下一段会话开始生效。" : (res.error ?? "采纳失败"));
  };

  const reject = async (item: MemoryItem) => {
    const res = (await window.api.memoryReject(item.id)) as { ok: boolean; error?: string; queue?: MemoryQueue };
    if (res.queue) setQueue(res.queue);
    setMsg(res.ok ? "已忽略。" : (res.error ?? "忽略失败"));
  };

  if (!data) {
    return (
      <section className="perm-card">
        <div className="perm-head">
          <b>插件</b>
        </div>
        <div className="perm-empty">插件清单读取失败。</div>
      </section>
    );
  }

  return (
    <>
      <section className="perm-card">
        <div className="perm-head">
          <b>插件</b>
          <span className="perm-note">默认全部关闭 · 关掉的族不注册，不占上下文</span>
        </div>
        {data.plugins.length === 0 ? (
          <div className="perm-empty">没有登记任何插件。</div>
        ) : (
          data.plugins.map((plugin) => (
            <div key={plugin.id} className="perm-head" style={{ marginTop: 10 }}>
              <b>
                {plugin.name}
                <span className={plugin.on ? "perm-decision allow" : "perm-decision deny"} style={{ marginLeft: 8 }}>
                  {plugin.on ? "开" : "关"}
                </span>
              </b>
              <button disabled={busy} onClick={() => void toggle(plugin, null, !plugin.on)}>
                {plugin.on ? "关闭整包" : "开启整包"}
              </button>
            </div>
          ))
        )}
        {data.plugins.map((plugin) => (
          <table className="perm-table" key={`${plugin.id}-families`} style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>族</th>
                <th>工具</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plugin.families.map((family) => (
                <tr key={family.key}>
                  <td>{family.name}</td>
                  <td className="perm-summary">
                    {family.tools
                      .map((tool) => (tool.ready === false ? `${tool.name}（未实现）` : tool.name))
                      .join(" · ")}
                  </td>
                  <td className={family.on ? "perm-decision allow" : "perm-decision deny"}>
                    {family.on ? "启用" : "停用"}
                  </td>
                  <td>
                    <button
                      disabled={busy || !plugin.on}
                      onClick={() => void toggle(plugin, family.key, !family.on)}
                    >
                      {family.on ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        <div className="perm-note" style={{ marginTop: 8 }}>
          开关存在 <code>settings.json</code> 的 <code>plugins</code> 里；改动会让 pi 按新工具集重启，
          正在进行的会话不换血。写类工具（<code>skill_propose</code>）仍走审批与审计。
        </div>
        {msg && <div className="perm-note">{msg}</div>}
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>记忆（待确认 {queue.pending.length} · 已采纳 {queue.approved.length}）</b>
          <button onClick={() => void refresh()}>刷新</button>
        </div>
        <div className="perm-note">
          模型只能用 <code>memory_propose</code> 提议，<b>采纳权在你</b>；已采纳条目在下一段会话注入系统提示。
          记忆存在应用数据目录（<code>%APPDATA%\oh-my-coding-pi\memory</code>），不写进工作区。
        </div>
        {queue.pending.length === 0 ? (
          <div className="perm-empty">没有待确认条目。</div>
        ) : (
          <table className="perm-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>内容</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.pending.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.kind === "skill" ? (
                      <code>技能 · {item.name}</code>
                    ) : (
                      <code>{item.target}</code>
                    )}
                  </td>
                  <td className="perm-summary">
                    {item.kind === "skill" ? item.description || item.name : item.content}
                    {item.reason && <div className="perm-note">理由：{item.reason}</div>}
                  </td>
                  <td>
                    <button onClick={() => void adopt(item)}>采纳</button>
                    <button onClick={() => void reject(item)} style={{ marginLeft: 6 }}>
                      忽略
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {queue.approved.length > 0 && (
          <table className="perm-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>已采纳</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {queue.approved.slice(-20).map((item) => (
                <tr key={item.id}>
                  <td>{item.kind === "skill" ? `技能 · ${item.name}` : item.target}</td>
                  <td className="perm-summary">
                    {item.kind === "skill" ? item.description || item.name : item.content}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
