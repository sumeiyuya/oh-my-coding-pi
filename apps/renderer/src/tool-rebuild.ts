import type { AgentMessage, ContentBlock } from "@oh-my-coding-pi/shared";

/**
 * 从 pi 的会话消息重建聊天记录（修改 4）。
 *
 * 之前的实现只保留 user / assistant 的文本，工具调用被整块丢掉——任何一次
 * `refreshSession()` 都会把「跑了 N 条命令」那一组洗掉。工具调用是**转写的一部分**，
 * 必须能从会话里重建回来。
 *
 * pi 的两种表示都要认：
 * - 助手消息里的工具调用块：`{ type: "toolCall", id, name, arguments }`（也兼容 `tool_use`）
 * - 独立的工具结果消息：`role: "toolResult"` + `toolCallId` / `toolName` / `isError`
 *
 * 纯函数：不碰 DOM、不读文件，便于单测。
 */

export type RebuiltMsg =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      done: boolean;
      result?: string;
      isError?: boolean;
    };

const RESULT_MAX = 600;

function textOf(content: AgentMessage["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

interface ToolResult {
  text: string;
  isError: boolean;
}

/** 工具结果来自独立的 toolResult 消息；内容块形式的也顺带认一下 */
function collectResults(list: AgentMessage[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const m of list) {
    if (m.role === "toolResult" && m.toolCallId) {
      results.set(String(m.toolCallId), {
        text: textOf(m.content).slice(0, RESULT_MAX),
        isError: Boolean(m.isError),
      });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const id = String(block.tool_use_id ?? "");
      if (!id) continue;
      results.set(id, {
        text: textOf(block.content as AgentMessage["content"]).slice(0, RESULT_MAX),
        isError: Boolean(block.isError),
      });
    }
  }
  return results;
}

function asToolCall(block: unknown): { id: string; name: string; args: unknown } | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b.type !== "toolCall" && b.type !== "tool_use") return null;
  const id = String(b.id ?? b.toolCallId ?? "");
  if (!id) return null;
  return { id, name: String(b.name ?? "tool"), args: b.arguments ?? b.input ?? {} };
}

export function messagesFromAgent(list: AgentMessage[]): RebuiltMsg[] {
  const results = collectResults(list);
  const out: RebuiltMsg[] = [];

  for (const m of list) {
    // 工具结果不当成一句话
    if (m.role === "toolResult") continue;

    if (!Array.isArray(m.content)) {
      const text = textOf(m.content);
      if (m.role === "user" && text) out.push({ kind: "user", text });
      else if (m.role === "assistant" && text) out.push({ kind: "assistant", text });
      continue;
    }

    if (m.role === "assistant") {
      let buffer = "";
      const flush = () => {
        if (buffer.trim()) out.push({ kind: "assistant", text: buffer.trim() });
        buffer = "";
      };
      for (const block of m.content) {
        if (block.type === "text") {
          buffer += block.text;
          continue;
        }
        const call = asToolCall(block);
        if (call) {
          flush();
          const done = results.get(call.id);
          out.push({
            kind: "tool",
            id: call.id,
            name: call.name,
            args: JSON.stringify(call.args ?? {}),
            done: Boolean(done),
            ...(done ? { result: done.text } : {}),
            ...(done?.isError ? { isError: true } : {}),
          });
        }
      }
      flush();
      continue;
    }

    const text = textOf(m.content);
    if (text) out.push({ kind: "user", text });
  }

  return out;
}
