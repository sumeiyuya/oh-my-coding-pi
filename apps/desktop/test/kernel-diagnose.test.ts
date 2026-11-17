import test from "node:test";
import assert from "node:assert/strict";

import { diagnoseLaunch, matchMissingPackage } from "../src/main/kernel-diagnose.ts";

/**
 * 内核起不来时说人话（自测报告 §4 P7 / §7.6 P7）。
 *
 * 这组用例锁的是“别把协议问题说成路径问题”：
 * 报告里最有价值的一条信息不是“失败了”，而是“失败在哪一层、下一步动什么”。
 */

const exists = () => true;
const missing = () => false;

test("没配路径：去设置里填，而不是让人猜", () => {
  const d = diagnoseLaunch("python", "", "", exists);
  assert.equal(d?.kind, "no-path");
  assert.match(d!.message, /设置/);
});

test("路径不存在：明确是这条路径的问题", () => {
  const d = diagnoseLaunch("python", "C:/nope/python.exe", "", missing);
  assert.equal(d?.kind, "missing-executable");
  assert.match(d!.message, /不存在/);
});

test("缺 ipykernel：说的是包，不是路径", () => {
  const stderr = "C:\\Python314\\python.exe: No module named ipykernel_launcher";
  const d = diagnoseLaunch("python", "C:\\Python314\\python.exe", stderr, exists);
  assert.equal(d?.kind, "missing-kernel-package");
  assert.equal((d as { packageName: string }).packageName, "ipykernel");
  assert.match(d!.message, /pip install ipykernel/);
});

test("R 缺 IRkernel：给出 install.packages", () => {
  const stderr = "Error in library(IRkernel) : there is no package called 'IRkernel'";
  const d = diagnoseLaunch("r", "C:/R/bin/Rterm.exe", stderr, exists);
  assert.equal(d?.kind, "missing-kernel-package");
  assert.equal((d as { packageName: string }).packageName, "IRkernel");
  assert.match(d!.message, /install\.packages/);
});

test("握手失败：归为协议层，别让人去改路径", () => {
  const stderr = "握手失败：shell=False iopub=False（DAWN 的原话：这时候执行，输出会被 ZMQ 静默丢掉）";
  const d = diagnoseLaunch("python", "C:\\Python314\\python.exe", stderr, exists);
  assert.equal(d?.kind, "protocol");
  assert.match(d!.message, /不是路径问题/);
});

test("握手失败但内核吐了缺包：优先报缺包（可执行动作更具体）", () => {
  const stderr =
    "握手失败：shell=False iopub=False\n[err] python.exe: No module named ipykernel_launcher";
  const d = diagnoseLaunch("python", "C:\\Python314\\python.exe", stderr, exists);
  assert.equal(d?.kind, "missing-kernel-package");
});

test("一点输出都没有：说清楚，并给检查清单", () => {
  const d = diagnoseLaunch("python", "C:\\Python314\\python.exe", "   ", exists);
  assert.equal(d?.kind, "no-output");
  assert.match(d!.message, /没有留下任何 stderr/);
  assert.match(d!.message, /ipykernel/);
});

test("认不出的 stderr：原样给出末尾几行", () => {
  const d = diagnoseLaunch("python", "C:/py.exe", "line1\nboom: something odd\n", exists);
  assert.equal(d?.kind, "unknown");
  assert.equal((d as { evidence: string }).evidence, "line1\nboom: something odd");
});

test("包名映射：模块名 ipykernel_launcher → 包名 ipykernel", () => {
  assert.equal(matchMissingPackage("No module named 'ipykernel_launcher'")?.packageName, "ipykernel");
});
