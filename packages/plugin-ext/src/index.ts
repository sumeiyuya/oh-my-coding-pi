/**
 * 插件扩展（ADR-045/046）：按 OMCP_PLUGINS 只注册开启的族。
 *
 * 记忆落位：`<userData>/memory/pending.jsonl` 与 `approved.jsonl`，
 * 由主进程经 OMCP_MEMORY_DIR 下发；不落工作区（不随 git 泄漏、不被项目设置改写）。
 *
 * 采纳动作在主进程（设置页的「采纳」按钮），本扩展只负责提议、查看与注入。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS, type PluginDef } from "./registry";
import { officeTools } from "./office/tools";
import { browserTools } from "./browser/tools";

declare const process: { env: Record<string, string | undefined> };

type ContentBlock =
  | { type: "text"; text: string };

interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
}

interface ExtensionAPI {
  registerTool(definition: Record<string, unknown>): void;
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent) => unknown,
  ): void;
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
  messageType?: "user" | "custom";
}

export interface MemoryEntry {
  id: string;
  ts: string;
  kind: "memory" | "skill";
  target?: "user" | "memory" | "key";
  content?: string;
  reason?: string;
  branches?: string[];
  name?: string;
  description?: string;
  body?: string;
  adoptedAt?: string;
}

const MEMORY_TARGETS = ["user", "memory", "key"] as const;
const MAX_INJECT_ENTRIES = 120;
const MAX_INJECT_CHARS = 4000;

function memoryDir(): string {
  const dir = process.env.OMCP_MEMORY_DIR;
  if (!dir) throw new Error("记忆目录未配置（OMCP_MEMORY_DIR）");
  return dir;
}

function pendingFile(): string {
  return join(memoryDir(), "pending.jsonl");
}

function approvedFile(): string {
  return join(memoryDir(), "approved.jsonl");
}

function readJsonl(file: string): MemoryEntry[] {
  if (!existsSync(file)) return [];
  const out: MemoryEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as MemoryEntry;
      if (parsed && typeof parsed.id === "string" && typeof parsed.ts === "string") out.push(parsed);
    } catch {
      // 坏行跳过：记忆是辅助信息，不能因为一行坏了就整份失效
    }
  }
  return out;
}

function newId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function appendEntry(file: string, entry: MemoryEntry): void {
  mkdirSync(memoryDir(), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

function describe(entry: MemoryEntry): string {
  if (entry.kind === "skill") {
    return `- ${entry.id} · 技能 ${entry.name ?? "?"} · ${clip(entry.description ?? "", 60)}`;
  }
  return `- ${entry.id} · ${entry.target ?? "memory"} · ${clip(entry.content ?? "", 100)}`;
}

function memoryTools(plugin: PluginDef, families: Set<string>) {
  const tools: Array<Record<string, unknown>> = [];

  if (families.has("memory.propose")) {
    tools.push({
      name: "memory_propose",
      label: "提议记忆",
      description:
        "Propose a long-lived fact for the user to confirm (project conventions,口径 decisions, architecture,踩坑结论). It lands in a pending queue and only takes effect after the user adopts it in settings. Do not use for progress notes.",
      promptSnippet: "memory_propose: propose a long-lived memory for the user to confirm",
      promptGuidelines: [
        "Use memory_propose when the user confirms a long-lasting fact worth remembering across sessions; never for one-off task progress.",
      ],
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [...MEMORY_TARGETS],
            description: "user=用户档案 / memory=全局事实 / key=本项目关键记忆",
          },
          content: { type: "string", description: "要记住的内容（长期有效，不写时间戳）" },
          reason: { type: "string", description: "为什么值得长期记住" },
          branches: {
            type: "array",
            items: { type: "string" },
            description: "target=key 时限定生效分支（可选）",
          },
        },
        required: ["target", "content"],
        additionalProperties: false,
      },
      async execute(_toolCallId: string, params: {
        target: "user" | "memory" | "key";
        content: string;
        reason?: string;
        branches?: string[];
      }): Promise<ToolResult> {
        const content = String(params.content ?? "").trim();
        if (!content) throw new Error("content 不能为空");
        if (!MEMORY_TARGETS.includes(params.target)) throw new Error(`未知 target：${params.target}`);
        const entry: MemoryEntry = {
          id: newId(),
          ts: new Date().toISOString(),
          kind: "memory",
          target: params.target,
          content,
          ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
          ...(params.target === "key" && params.branches?.length
            ? { branches: params.branches.map(String) }
            : {}),
        };
        appendEntry(pendingFile(), entry);
        return {
          content: [
            {
              type: "text",
              text: `已提交待确认记忆（${entry.id}，${entry.target}）。用户采纳后才会进入后续会话。`,
            },
          ],
          details: { id: entry.id, pending: true },
        };
      },
    });
  }

  if (families.has("memory.list")) {
    tools.push({
      name: "memory_list",
      label: "查看记忆",
      description:
        "List proposed and adopted memories (optionally filtered by target or text). Use it before proposing something that may already be recorded.",
      promptSnippet: "memory_list: list pending and adopted memories",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: [...MEMORY_TARGETS] },
          filter: { type: "string", description: "子串筛选（大小写不敏感）" },
          limit: { type: "number", description: "最多几条（默认 30）" },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId: string, params: { target?: string; filter?: string; limit?: number }): Promise<ToolResult> {
        const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 30)));
        const needle = (params.filter ?? "").trim().toLowerCase();
        const keep = (e: MemoryEntry) => {
          if (params.target && e.target !== params.target) return false;
          if (!needle) return true;
          return [e.content, e.name, e.description, e.reason]
            .filter(Boolean)
            .some((t) => String(t).toLowerCase().includes(needle));
        };
        const pending = readJsonl(pendingFile()).filter(keep);
        const approved = readJsonl(approvedFile()).filter(keep);
        const lines = [
          `待确认 ${pending.length} 条，已采纳 ${approved.length} 条` +
            (params.target ? `（target=${params.target}）` : ""),
        ];
        if (pending.length) {
          lines.push("", "## 待确认（尚未生效）", ...pending.slice(-limit).map(describe));
        }
        if (approved.length) {
          lines.push("", "## 已采纳（已生效）", ...approved.slice(-limit).map(describe));
        }
        if (!pending.length && !approved.length) lines.push("", "（没有符合条件的记忆）");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { pending: pending.length, approved: approved.length } };
      },
    });
  }

  if (families.has("memory.skill")) {
    tools.push({
      name: "skill_propose",
      label: "沉淀技能",
      description:
        "Propose a reusable workflow as an Agent Skill (name + SKILL.md body). The user must adopt it before anything is written to .agents/skills/. Only for procedures that will be repeated.",
      promptSnippet: "skill_propose: propose a reusable SKILL.md for the user to adopt",
      promptGuidelines: [
        "Use skill_propose only after a multi-step workflow has actually been run and is likely to repeat; one-off tasks do not need a skill.",
      ],
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "kebab-case，如 otu-network" },
          description: { type: "string", description: "一句话说明什么时候用这个技能" },
          body: { type: "string", description: "完整 SKILL.md 正文（含 frontmatter）" },
        },
        required: ["name", "description", "body"],
        additionalProperties: false,
      },
      async execute(_toolCallId: string, params: { name: string; description: string; body: string }): Promise<ToolResult> {
        const name = String(params.name ?? "").trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
          throw new Error("技能名必须是 kebab-case（小写字母、数字、连字符）");
        }
        const body = String(params.body ?? "");
        if (!body.startsWith("---")) throw new Error("SKILL.md 正文必须以 frontmatter（---）开头");
        if (!new RegExp(`^name:\\s*${name}\\s*$`, "m").test(body)) {
          throw new Error(`frontmatter 里的 name 必须等于 ${name}`);
        }
        if (body.length > 20000) throw new Error("SKILL.md 太长（上限 20000 字符）");
        const entry: MemoryEntry = {
          id: newId(),
          ts: new Date().toISOString(),
          kind: "skill",
          name,
          description: String(params.description ?? "").trim(),
          body,
        };
        appendEntry(pendingFile(), entry);
        return {
          content: [
            {
              type: "text",
              text: `已提交技能提案 ${name}（${entry.id}）。用户采纳后会写入 .agents/skills/${name}/SKILL.md。`,
            },
          ],
          details: { id: entry.id, name, pending: true },
        };
      },
    });
  }

  void plugin;
  return tools;
}

/** 已采纳的记忆拼成一段系统提示；没有就返回 null（不发空段）。 */
function memorySection(): string | null {
  const approved = readJsonl(approvedFile());
  if (!approved.length) return null;
  const lines: string[] = [];
  let budget = MAX_INJECT_CHARS;
  for (const entry of approved.slice(-MAX_INJECT_ENTRIES)) {
    const text = entry.kind === "skill" ? `[技能] ${entry.name}` : `[${entry.target ?? "memory"}] ${entry.content ?? ""}`;
    if (text.length + 1 > budget) break;
    budget -= text.length + 1;
    lines.push(`- ${text}`);
  }
  if (!lines.length) return null;
  return [
    "<记忆>",
    `以下 ${lines.length} 条是用户确认过的长期事实（应用数据目录，用户手动采纳），直接照着用，不要再问。`,
    "与当前对话或显式指示冲突时，以用户当前的显式指示为准。",
    ...lines,
    "</记忆>",
  ].join("\n");
}

export default function pluginExt(pi: ExtensionAPI): void {
  // 主进程下发的是「启用的族键」数组（ADR-045）：只有数组里的族才注册。
  // 兼容传对象的形式（{键: "0"/"1"}），便于手工调试。
  let enabledKeys = new Set<string>();
  try {
    const raw = process.env.OMCP_PLUGINS;
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        enabledKeys = new Set(parsed.map(String));
      } else if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (value !== "1") enabledKeys.add(key);
        }
      }
    }
  } catch {
    enabledKeys = new Set();
  }

  const active = PLUGINS.filter((plugin) => plugin.families.some((f) => enabledKeys.has(f.key)));
  for (const plugin of active) {
    const families = new Set(
      plugin.families
        .filter((f) => enabledKeys.has(f.key))
        // 族里全是“未实现”工具时不要注册空族（开关里会看得出区别）
        .filter((f) => f.tools.some((t) => t.ready !== false))
        .map((f) => f.key),
    );
    if (!families.size) continue;
    if (plugin.id === "office") {
      for (const tool of officeTools(families)) pi.registerTool(tool);
      continue;
    }
    if (plugin.id === "browser") {
      for (const tool of browserTools(families)) pi.registerTool(tool);
      continue;
    }
    for (const tool of memoryTools(plugin, families)) pi.registerTool(tool);
  }

  // 记忆注入只跟记忆插件走：Office/浏览器的开关不该触发记忆注入
  if (active.some((plugin) => plugin.id === "memory")) {
    pi.on("before_agent_start", (event) => {
      const section = memorySection();
      if (!section) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    });
  }
}
