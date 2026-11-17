/**
 * 会话标题派生（参考 DAWN 的 brief + unique）。
 *
 * DAWN 的规则（从它的 system 提示读出来的）：中文一般 6–16 字、最多 24 字；动宾短语，
 * 不用疑问句；不加引号 / 解释 / Markdown；同批标题要去重；模型失败就回落到首条消息截断。
 *
 * 这里实现的是那一支“回落”：**只做截断和归一化，不改写句子**。
 * 纯函数，不碰文件系统，便于单测。
 */

export const TITLE_MAX = 24;

/** 长路径只留最后两段，避免标题全是盘符和目录 */
function shortenPath(raw: string): string {
  const cleaned = raw.replace(/^["'“”]+|["'“”]+$/g, "").replace(/[),.;:，。；：]+$/, "");
  if (cleaned.length <= 26) return cleaned;
  const parts = cleaned.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return cleaned.slice(0, 26) + "…";
  return "…" + "\\" + parts.slice(-2).join("\\");
}

/** 把一段用户输入压成“适合做标题”的单行 */
export function normalizeTitleSource(text: string): string {
  let s = String(text ?? "");
  // 代码块整段不算标题
  s = s.replace(/```[\s\S]*?```/g, " ");
  // @ 引用：路径折叠
  s = s.replace(/@(\S+)/g, (_m, p: string) => "@" + shortenPath(p));
  // URL 只留域名
  s = s.replace(/https?:\/\/([^\s/]+)[^\s]*/gi, (_m, host: string) => host);
  // Markdown 标记与多余空白
  s = s.replace(/^#+[ 	]*/gm, " ");
  s = s.replace(/[`*>]+/g, " ");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** 按字符截断（英文按词边界退让），去尾部标点后加省略号 */
export function briefTitle(text: string, max = TITLE_MAX): string | null {
  const s = normalizeTitleSource(text);
  if (!s) return null;
  // 纯斜杠命令（/skill:xxx、/template）不是一句话，不做标题
  if (/^\/[^\s]*$/.test(s)) return null;
  const chars = Array.from(s);
  if (chars.length <= max) return chars.join("").replace(/[，,。.；;：:\s]+$/, "");
  let cut = chars.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // 英文长句：尽量在词边界断，但不要把标题砍到一半以下
  if (lastSpace > Math.floor(max * 0.6)) cut = cut.slice(0, lastSpace);
  const head = cut.join("").replace(/[，,。.；;：:\s]+$/, "");
  return head ? head + "…" : null;
}

/** 同工作区里重名时加后缀，保证列表里不出现两条一模一样 */
export function uniqueTitle(base: string, siblings: Iterable<string>): string {
  const taken = new Set(Array.from(siblings, (s) => s.trim()).filter(Boolean));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const next = `${base} · ${n}`;
    if (!taken.has(next)) return next;
  }
  return `${base} · ${Date.now()}`;
}

/** 从 pi 的 jsonl 条目里取用户文本；认不出就返回 null（不猜） */
export function extractUserText(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const message = (obj.message ?? obj) as Record<string, unknown>;
  const role = message.role ?? obj.role;
  if (role !== "user") return null;
  const content = message.content ?? obj.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}
