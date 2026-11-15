#!/usr/bin/env node
/**
 * 策略判定基准：给 P4.0 的 policy-bench 提供数字。
 * 用法：node scripts/policy-bench.mjs
 */
import {
  compileRules,
  evaluatePolicy,
  normalizePolicy,
  validatePolicy,
} from "../packages/shared/src/policy.ts";

const root = process.cwd();
const policy = normalizePolicy(null);
const compiled = {
  deny: compileRules(policy.commands.deny),
  ask: compileRules(policy.commands.ask),
};

const samples = [
  { toolName: "read", input: { path: "data/raw/demo.csv" } },
  { toolName: "write", input: { path: "figures/fig-1.png" } },
  { toolName: "bash", input: { command: "python analysis/scripts/x.py" } },
  { toolName: "bash", input: { command: 'rm -rf "./a3-target"' } },
  { toolName: "run_code", input: { code: "import pandas as pd\ndf=pd.read_csv('x')" } },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function bench(label, iterations, fn) {
  // 预热
  for (let i = 0; i < Math.min(500, iterations); i++) fn(i);
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const result = {
    label,
    iterations,
    meanMs: +(total / times.length).toFixed(4),
    p50Ms: +percentile(times, 50).toFixed(4),
    p95Ms: +percentile(times, 95).toFixed(4),
    maxMs: +times[times.length - 1].toFixed(4),
    opsPerSec: Math.round(1000 / (total / times.length)),
  };
  console.log(
    `${result.label}: ${result.iterations} 次 | 平均 ${result.meanMs}ms | p50 ${result.p50Ms}ms | p95 ${result.p95Ms}ms | max ${result.maxMs}ms | ${result.opsPerSec} ops/s`,
  );
  return result;
}

console.log("== 策略判定 ==");
const decideBench = bench("decide", 10_000, (i) => {
  const sample = samples[i % samples.length];
  evaluatePolicy(policy, { toolName: sample.toolName, input: sample.input, workspaceRoot: root }, compiled);
});

// 1MB 级策略文件：把 ask 规则重复到足够大
const bigAsk = [];
for (let i = 0; i < 20000; i++) bigAsk.push(policy.commands.ask[i % policy.commands.ask.length]);
const bigPolicy = { ...policy, commands: { deny: policy.commands.deny, ask: bigAsk } };
const bigJson = JSON.stringify(bigPolicy);
console.log(`\n== 大策略加载（${(Buffer.byteLength(bigJson) / 1024 / 1024).toFixed(2)} MB，${bigAsk.length} 条 ask 正则）==`);

const t0 = process.hrtime.bigint();
const parsed = JSON.parse(bigJson);
const errors = validatePolicy(parsed);
const normalized = normalizePolicy(parsed);
const compiledBig = {
  deny: compileRules(normalized.commands.deny),
  ask: compileRules(normalized.commands.ask),
};
const t1 = process.hrtime.bigint();
const loadMs = Number(t1 - t0) / 1e6;
console.log(`解析+校验+编译：${loadMs.toFixed(1)}ms（校验错误 ${errors.length} 条）`);

const t2 = process.hrtime.bigint();
evaluatePolicy(normalized, { toolName: "bash", input: { command: "git status" }, workspaceRoot: root }, compiledBig);
const t3 = process.hrtime.bigint();
console.log(`大策略单次判定：${(Number(t3 - t2) / 1e6).toFixed(3)}ms`);

const failed = [];
if (decideBench.p95Ms > 1) failed.push(`decide p95 ${decideBench.p95Ms}ms > 1ms`);
if (loadMs > 200) failed.push(`大策略加载 ${loadMs.toFixed(1)}ms > 200ms`);

if (failed.length) {
  console.error("\n未达标：" + failed.join("；"));
  process.exit(1);
}
console.log("\n基准通过（decide p95 < 1ms，加载 < 200ms）");
