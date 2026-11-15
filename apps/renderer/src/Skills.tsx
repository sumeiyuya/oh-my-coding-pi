import { useCallback, useEffect, useState } from "react";
import type { AppSettingsDetail, SkillInfo } from "@oh-my-coding-pi/shared";

export default function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [settings, setSettings] = useState<AppSettingsDetail | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [slug, setSlug] = useState("");
  const [desc, setDesc] = useState("");
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([window.api.listSkills(), window.api.getSettingsDetail()]);
      setSkills((list as SkillInfo[]) ?? []);
      setSettings((s as AppSettingsDetail) ?? null);
    } catch {
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (skill: SkillInfo) => {
    await window.api.setSkillEnabled(skill.name, !skill.enabled);
    setMsg(skill.enabled ? "已停用，pi 正在重启" : "已启用，pi 正在重启");
    setTimeout(() => void refresh(), 1500);
  };

  const open = async (skill: SkillInfo) => {
    if (openName === skill.name) {
      setOpenName(null);
      return;
    }
    const text = await window.api.readSkill(skill.name);
    setContent(text ?? "（读取失败）");
    setOpenName(skill.name);
  };

  const create = async () => {
    const created = await window.api.createSkill(slug, desc);
    if (!created) {
      setMsg("创建失败：slug 只能是小写字母/数字/连字符，且不能重名");
      return;
    }
    setSlug("");
    setDesc("");
    setMsg("已创建 " + created);
    await refresh();
  };

  const trustOn = !!settings?.trustProject;

  return (
    <div className="perm">
      <section className="perm-card">
        <div className="perm-head">
          <b>技能（{skills.length}）</b>
          <button onClick={() => void refresh()}>刷新</button>
        </div>
        <div className="perm-note">
          技能放在 <code>.agents/skills/&lt;name&gt;/SKILL.md</code>，由 pi 在启动时读取并注入索引
          （只含 name 与 description）。<b>只读本地目录：不做在线安装，也不校验来源</b>。
        </div>
        {!trustOn && (
          <div className="perm-error">
            当前未信任本项目，pi 不会加载这些技能。到「设置 → 内核与策略」勾选“信任本项目”后保存。
          </div>
        )}
        {skills.length === 0 ? (
          <div className="perm-empty">还没有技能。下面可以新建一个模板。</div>
        ) : (
          <table className="perm-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>描述</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.name}>
                  <td>
                    <code>{s.name}</code>
                    {s.errors.length > 0 && (
                      <div className="perm-error" style={{ marginTop: 4 }}>
                        {s.errors.join("；")}
                      </div>
                    )}
                  </td>
                  <td className="perm-summary" title={s.description}>
                    {s.description || "（缺少 description）"}
                  </td>
                  <td className={s.enabled ? "perm-decision allow" : "perm-decision deny"}>
                    {s.enabled ? "启用" : "停用"}
                  </td>
                  <td>
                    <button onClick={() => void open(s)}>{openName === s.name ? "收起" : "查看"}</button>
                    <button onClick={() => void toggle(s)} style={{ marginLeft: 6 }}>
                      {s.enabled ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {openName && <pre className="perm-notes">{content}</pre>}
      </section>

      <section className="perm-card">
        <div className="perm-head">
          <b>新建技能</b>
        </div>
        <div className="perm-form">
          <label>
            名称（slug）
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="desc-stats" />
          </label>
          <label>
            一句话描述（模型靠它判断何时使用）
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="按分组做描述统计并输出 CSV；用户说“描述统计/分组汇总”时使用"
            />
          </label>
        </div>
        <div className="perm-row">
          <span />
          <button onClick={() => void create()} disabled={!slug.trim()}>
            创建模板
          </button>
        </div>
        {msg && <div className="perm-note">{msg}</div>}
      </section>
    </div>
  );
}
