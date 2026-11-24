/**
 * 子任务扩展（修改 4 · M4）。
 *
 * 每次调用 spawn 一个独立的 pi 子进程（`--mode json --no-session`），
 * 于是子任务有**自己的上下文窗口**，不占主对话的 token——这是它存在的理由。
 *
 * 三条硬上限（与 DAWN 同一组数字，来自 pi 自带的 subagent 示例）：
 *   - 一次最多 8 个任务、同时最多 4 个；
 *   - 单个任务墙钟 10 分钟（卡死的子进程不能永远占着名额）；
 *   - 单任务输出 50 KB 截断。
 *
 * 另有一条**跨进程**的上限：主进程的子任务并发闸。只看本条对话的 4 个并发是不够的，
 * 两个槽同时跑就是 8 个请求，provider 会直接 429。领不到名额就明确拒绝，
 * 不偷偷超额。
 *
 * 开关：`OMCP_PLUGINS` 里要有 `subagent`（ADR-045 同一套族开关，默认关）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare const process: {
  env: Record<string, string | undefined>;
  execPath: string;
  argv: string[];
  cwd(): string;
};

type ContentBlock = { type: "text"; text: string };

interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
}

interface ExtensionAPI {
  registerTool(definition: Record<string, unknown>): void;
}

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const WALL_CLOCK_MS = 10 * 60_000;
const OUTPUT_CAP = 50 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

/* ------------------------------------------------------------------ */
/* 子 agent 定义                                                       */
/* ------------------------------------------------------------------ */

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: string;
}

/** 极简 frontmatter：`---` 之间的 key: value。不引 yaml 依赖。 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: text };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    if (value) data[match[1]!] = value;
  }
  return { data, body };
}

function readAgentsFrom(dir: string, source: string): AgentConfig[] {
  if (!dir || !existsSync(dir)) return [];
  const out: AgentConfig[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    if (name.endsWith(".md.example")) continue;
    try {
      const { data, body } = parseFrontmatter(readFileSync(join(dir, name), "utf8"));
      const agentName = (data.name ?? name.replace(/\.md$/, "")).trim();
      if (!agentName) continue;
      out.push({
        name: agentName,
        description: (data.description ?? "").trim(),
        ...(data.tools ? { tools: data.tools.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
        ...(data.model ? { model: data.model } : {}),
        systemPrompt: body.trim(),
        source,
      });
    } catch {
      // 单个文件坏了不该让整张名册消失
    }
  }
  return out;
}

export function discoverAgents(cwd: string, agentsDir?: string): AgentConfig[] {
  const project = readAgentsFrom(join(cwd, ".omcp", "agents"), "project");
  const user = agentsDir ? readAgentsFrom(agentsDir, "user") : [];
  // 项目级优先：同名时项目覆盖用户
  const byName = new Map<string, AgentConfig>();
  for (const agent of user) byName.set(agent.name, agent);
  for (const agent of project) byName.set(agent.name, agent);
  return [...byName.values()];
}

/* ------------------------------------------------------------------ */
/* 子进程                                                              */
/* ------------------------------------------------------------------ */

interface ChildOutcome {
  ok: boolean;
  text: string;
  usage: { turns: number; input: number; output: number; cost: number };
  error?: string;
}

/** 找到"再来一个 pi"的命令：当前解释器 + 当前入口（Electron 内置 node 也适用） */
function piInvocation(args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const script = process.argv[1];
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args], env };
  return { command: process.execPath, args, env };
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

function runChild(agent: AgentConfig, task: string, signal: AbortSignal): Promise<ChildOutcome> {
  const promptDir = mkdtempSync(join(tmpdir(), "omcp-subagent-"));
  const promptPath = join(promptDir, "system.md");
  const args = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (agent.systemPrompt.trim()) {
    writeFileSync(promptPath, agent.systemPrompt, "utf8");
    args.push("--append-system-prompt", promptPath);
  }
  args.push(`Task: ${task}`);

  const { command, args: argv, env } = piInvocation(args);
  const usage = { turns: 0, input: 0, output: 0, cost: 0 };

  return new Promise<ChildOutcome>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    } catch (error) {
      rmSync(promptDir, { recursive: true, force: true });
      resolve({ ok: false, text: "", usage, error: `子进程起不来：${String(error)}` });
      return;
    }

    let buffer = "";
    let result = "";
    let stderr = "";
    let finished = false;
    const finish = (outcome: ChildOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      rmSync(promptDir, { recursive: true, force: true });
      resolve(outcome);
    };
    const abort = () => {
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!finished) proc.kill("SIGKILL");
        }, 3000).unref?.();
      } catch {
        // 已经没了
      }
      finish({ ok: false, text: result, usage, error: "已中止" });
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({ ok: false, text: result, usage, error: "超时（10 分钟）" });
    }, WALL_CLOCK_MS);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { type?: string; message?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "message_end") continue;
        const message = event.message ?? {};
        if (message.role === "assistant") {
          const text = textOfContent(message.content);
          if (text) result = text;
          usage.turns += 1;
          const u = (message.usage ?? {}) as Record<string, number | { total?: number }>;
          const cost = u.cost as { total?: number } | number | undefined;
          usage.input += Number(u.input ?? 0);
          usage.output += Number(u.output ?? 0);
          usage.cost += typeof cost === "number" ? cost : Number(cost?.total ?? 0);
          if (typeof message.errorMessage === "string" && message.errorMessage) {
            result = `${result}\n[错误] ${message.errorMessage}`.trim();
          }
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => finish({ ok: false, text: result, usage, error: String(error) }));
    proc.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as { type?: string; message?: Record<string, unknown> };
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const text = textOfContent(event.message.content);
            if (text) result = text;
          }
        } catch {
          // 尾行不是完整 JSON，忽略
        }
      }
      const failed = code !== 0;
      finish({
        ok: !failed && Boolean(result),
        text: result,
        usage,
        ...(failed
          ? { error: `子进程退出码 ${code}${stderr.trim() ? "：" + stderr.trim().slice(-400) : ""}` }
          : {}),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 主进程的并发闸                                                      */
/* ------------------------------------------------------------------ */

async function leaseGate(key: string): Promise<{ ok: boolean; reason?: string; release: () => void }> {
  const url = process.env.OMCP_GATE_URL;
  const token = process.env.OMCP_GATE_TOKEN;
  if (!url || !token) {
    // 没有闸（单机裸跑/测试）：靠本进程的 4 并发兜底
    return { ok: true, release: () => {} };
  }
  try {
    const response = await fetch(`${url}/subagent/lease`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ key }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        reason: `全局子任务名额已满（${response.status}）${detail ? "：" + detail.slice(0, 200) : ""}`,
        release: () => {},
      };
    }
    return {
      ok: true,
      release: () => {
        void fetch(`${url}/subagent/release`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ key }),
        }).catch(() => undefined);
      },
    };
  } catch (error) {
    return { ok: false, reason: `并发闸不可用：${String(error)}`, release: () => {} };
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function cap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP) return text;
  return text.slice(0, OUTPUT_CAP) + "\n\n…（已截断）";
}

interface TaskInput {
  agent: string;
  task: string;
}

function line(name: string, outcome: ChildOutcome): string {
  const head = outcome.ok ? "✓" : "✗";
  const usage = outcome.usage.turns
    ? `（${outcome.usage.turns} 轮 · $${outcome.usage.cost.toFixed(4)}）`
    : "";
  if (outcome.ok) return `${head} ${name}${usage}\n${cap(outcome.text)}`;
  return `${head} ${name}${usage}\n${outcome.error ?? "未产出结果"}${
    outcome.text ? "\n" + cap(outcome.text) : ""
  }`;
}

export default function subagentExt(api: ExtensionAPI): void {
  const families = new Set(
    String(process.env.OMCP_PLUGINS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  if (!families.has("subagent")) return;

  api.registerTool({
    name: "subagent",
    label: "子任务",
    description:
      "Delegate tasks to a specialized subagent. Each task runs in its own pi process with an isolated context window. " +
      "Modes: single (agent+task), parallel (tasks array, max 8, 4 at a time), chain (sequential, {previous} refers to the last result).",
    promptSnippet: "subagent: delegate a task to a subagent (single/parallel/chain)",
    promptGuidelines: [
      "用 subagent 把「读很多文件后只要结论」这类活儿分出去，主对话的上下文只留要点。",
      "parallel 最多 8 个任务、同时 4 个；chain 里用 {previous} 引上一步的输出。",
      "子任务拿不到主对话的历史：任务描述要自带输入、期望产物与验收口径。",
      "子任务的结论未经你核对之前，不要当成已核实的事实。",
    ],
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "子 agent 名（模式 single）" },
        task: { type: "string", description: "任务描述（模式 single）" },
        tasks: {
          type: "array",
          description: "并行任务（模式 parallel，最多 8 个）",
          items: {
            type: "object",
            properties: { agent: { type: "string" }, task: { type: "string" } },
            required: ["agent", "task"],
          },
        },
        chain: {
          type: "array",
          description: "顺序任务（模式 chain，可用 {previous}）",
          items: {
            type: "object",
            properties: { agent: { type: "string" }, task: { type: "string" } },
            required: ["agent", "task"],
          },
        },
        mode: { type: "string", enum: ["single", "parallel", "chain"] },
      },
      additionalProperties: false,
    },
    async execute(params: {
      agent?: string;
      task?: string;
      tasks?: TaskInput[];
      chain?: TaskInput[];
      mode?: string;
    }): Promise<ToolResult> {
      const cwd = process.env.OMCP_CWD || process.cwd();
      const agents = discoverAgents(cwd, process.env.OMCP_AGENTS_DIR);
      const byName = new Map(agents.map((a) => [a.name, a]));
      const names = agents.map((a) => a.name).join(" / ") || "（一个都没有：在 <工作区>/.omcp/agents/*.md 里定义）";

      const mode = params.mode ?? (params.chain ? "chain" : params.tasks ? "parallel" : "single");
      const tasks: TaskInput[] = params.chain ?? params.tasks ?? [];
      if (mode === "single") {
        if (!params.agent || !params.task) throw new Error("single 模式需要 agent 与 task");
        tasks.push({ agent: params.agent, task: params.task });
      }
      if (tasks.length === 0) throw new Error("没有任务");
      if (tasks.length > MAX_TASKS) {
        throw new Error(`一次最多 ${MAX_TASKS} 个任务（这次 ${tasks.length} 个）；请拆成几批，一个都没跑`);
      }
      for (const task of tasks) {
        if (!byName.has(task.agent)) throw new Error(`没有名为 "${task.agent}" 的子 agent。已有：${names}`);
      }

      const abort = new AbortController();
      const sessionKey = process.env.OMCP_RUNTIME_ID ?? "subagent";
      const gate = await leaseGate(sessionKey);
      if (!gate.ok) {
        return {
          content: [{ type: "text", text: `子任务没有启动：${gate.reason ?? "名额不可用"}` }],
          details: { gate: "denied", mode },
        };
      }

      try {
        if (mode === "chain") {
          const results: string[] = [];
          let previous = "";
          for (const [index, task] of tasks.entries()) {
            const text = task.task.split("{previous}").join(previous);
            const outcome = await runChild(byName.get(task.agent)!, text, abort.signal);
            results.push(line(task.agent, outcome));
            if (!outcome.ok) {
              return {
                content: [{ type: "text", text: results.join("\n\n") }],
                details: { mode, stoppedAt: index + 1 },
              };
            }
            previous = outcome.text;
          }
          return { content: [{ type: "text", text: results.join("\n\n") }], details: { mode } };
        }

        const results: string[] = new Array(tasks.length).fill("");
        let next = 0;
        const worker = async () => {
          for (;;) {
            const index = next++;
            if (index >= tasks.length) return;
            const task = tasks[index]!;
            const outcome = await runChild(byName.get(task.agent)!, task.task, abort.signal);
            results[index] = line(task.agent, outcome);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENCY, tasks.length) }, () => worker()),
        );
        return { content: [{ type: "text", text: results.join("\n\n") }], details: { mode } };
      } finally {
        gate.release();
      }
    },
  });
}

export { THINKING_LEVELS };
