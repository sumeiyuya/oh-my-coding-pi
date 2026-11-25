import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgents } from "../src/index.ts";

/** 修改 4 · M4：子 agent 名册来自 `<工作区>/.omcp/agents/*.md`。 */

function workspace(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "omcp-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = join(dir, ".omcp", "agents");
  mkdirSync(agents, { recursive: true });
  return { dir, agents };
}

test("解析 frontmatter 的 name/description/tools，正文当 system prompt", (t) => {
  const { dir, agents } = workspace(t);
  writeFileSync(
    join(agents, "scout.md"),
    ["---", "name: scout", "description: 只读踏勘", "tools: read, bash", "---", "你是踏勘员。", ""].join(
      "\n",
    ),
    "utf8",
  );
  const list = discoverAgents(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, "scout");
  assert.equal(list[0]!.description, "只读踏勘");
  assert.deepEqual(list[0]!.tools, ["read", "bash"]);
  assert.equal(list[0]!.systemPrompt, "你是踏勘员。");
  assert.equal(list[0]!.source, "project");
});

test(".md.example 不算一个 agent（只是样例）", (t) => {
  const { dir, agents } = workspace(t);
  writeFileSync(join(agents, "scout.md.example"), "---\nname: scout\n---\n样例\n", "utf8");
  assert.deepEqual(discoverAgents(dir), []);
});

test("没有 frontmatter 时用文件名当名字", (t) => {
  const { dir, agents } = workspace(t);
  writeFileSync(join(agents, "writer.md"), "你负责写报告。\n", "utf8");
  const list = discoverAgents(dir);
  assert.equal(list[0]!.name, "writer");
  assert.equal(list[0]!.systemPrompt, "你负责写报告。");
});

test("项目级覆盖用户级同名 agent", (t) => {
  const { dir, agents } = workspace(t);
  const userDir = mkdtempSync(join(tmpdir(), "omcp-useragents-"));
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  writeFileSync(join(userDir, "scout.md"), "---\nname: scout\ndescription: 用户的\n---\nU\n", "utf8");
  writeFileSync(join(agents, "scout.md"), "---\nname: scout\ndescription: 项目的\n---\nP\n", "utf8");

  const list = discoverAgents(dir, userDir);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.description, "项目的");
});

test("坏文件不影响其它条目", (t) => {
  const { dir, agents } = workspace(t);
  writeFileSync(join(agents, "good.md"), "---\nname: good\n---\nok\n", "utf8");
  mkdirSync(join(agents, "broken.md"), { recursive: true }); // 目录冒充文件
  const list = discoverAgents(dir);
  assert.deepEqual(list.map((a) => a.name), ["good"]);
});

/** OMCP_PLUGINS 是主进程下发的 JSON 数组；按逗号切会读不到，工具就不注册。 */
import { readPluginFamilies } from "../src/index.ts";

test("从 JSON 数组读族键（主进程实际下发的形状）", () => {
  assert.deepEqual(readPluginFamilies('["subagent"]'), ["subagent"]);
  assert.deepEqual(readPluginFamilies('["memory.propose","subagent"]'), ["memory.propose", "subagent"]);
});

test("也接受逗号串（人手调试）与空值", () => {
  assert.deepEqual(readPluginFamilies("subagent"), ["subagent"]);
  assert.deepEqual(readPluginFamilies("a, b"), ["a", "b"]);
  assert.deepEqual(readPluginFamilies(""), []);
  assert.deepEqual(readPluginFamilies(undefined), []);
});

/** 0.7.1 · B1：子任务不是绕过审批的后门。 */
import { planTools } from "../src/index.ts";

test("只读档：名册写了 bash/write 也被裁掉，并记下来", () => {
  const plan = planTools(["read", "bash", "write"], "ask-risky");
  assert.deepEqual(plan.tools, ["read"]);
  assert.deepEqual(plan.dropped, ["bash", "write"]);
});

test("只读档：名册没写工具时也要显式收紧（不能沿用 pi 默认全套）", () => {
  const plan = planTools(undefined, "deny-risky");
  assert.deepEqual(plan.tools, ["read", "grep", "find", "ls", "glob"]);
  assert.deepEqual(plan.dropped, []);
});

test("完全访问档：名册要什么给什么；没写就不传（pi 默认）", () => {
  assert.deepEqual(planTools(["read", "bash", "write"], "allow-all"), {
    tools: ["read", "bash", "write"],
    dropped: [],
  });
  assert.deepEqual(planTools(undefined, "allow-all"), { tools: undefined, dropped: [] });
});
