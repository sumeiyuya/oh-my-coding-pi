import test from "node:test";
import assert from "node:assert/strict";

import { briefTitle, extractUserText, normalizeTitleSource, uniqueTitle } from "../src/main/session-title.ts";

/** 会话标题派生（修改 3）：只做截断和归一化，不改写句子。 */

test("长路径只留最后两段", () => {
  const sep = String.fromCharCode(92);
  const out = normalizeTitleSource("@D:" + sep + "desktop" + sep + "coding" + sep + "实机测试" + sep + "pi_capability_test_report.md 看下");
  assert.ok(out.startsWith("@…" + sep + "实机测试" + sep + "pi_capability_test_report.md"), out);
  assert.ok(!out.includes("desktop" + sep + "coding"), out);
});

test("URL 只留域名", () => {
  assert.equal(normalizeTitleSource("接上一段 https://github.com/foo/bar 继续"), "接上一段 github.com 继续");
});

test("去 Markdown 标记与多余空白", () => {
  assert.equal(normalizeTitleSource("# 标题\n\n**加粗**   结束"), "标题 加粗 结束");
});

test("短句原样保留，去尾部标点", () => {
  assert.equal(briefTitle("把报告看一遍。"), "把报告看一遍");
});

test("超长中文截到 24 字并带省略号", () => {
  const t = briefTitle("把所有的开发报告看一遍然后生成一份总结报告给我看一遍");
  assert.ok(t);
  assert.ok(Array.from(t!).length <= 25, t!);
  assert.ok(t!.endsWith("…"));
});

test("纯斜杠命令不做标题", () => {
  assert.equal(briefTitle("/skill:literature-sharing"), null);
  assert.equal(briefTitle("   "), null);
});

test("重名加后缀", () => {
  assert.equal(uniqueTitle("写报告", ["写报告"]), "写报告 · 2");
  assert.equal(uniqueTitle("写报告", ["写报告", "写报告 · 2"]), "写报告 · 3");
  assert.equal(uniqueTitle("写报告", []), "写报告");
});

test("从 pi 的 jsonl 条目里取用户文本", () => {
  assert.equal(extractUserText({ message: { role: "user", content: [{ type: "text", text: "hi" }] } }), "hi");
  assert.equal(extractUserText({ role: "user", content: "plain" }), "plain");
  assert.equal(extractUserText({ message: { role: "assistant", content: "no" } }), null);
});
