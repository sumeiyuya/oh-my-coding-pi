/** `@` 路径补全的纯函数部分，方便单独测。 */

export interface MentionHit {
  /** `@` 在文本里的下标 */
  start: number;
  /** `@` 后面已经敲的字，可以带目录 */
  query: string;
}

/** 只看光标之前的文本：`@` 前面必须是行首或空白，后面不能有空白或第二个 `@`。 */
export function parseMention(value: string, caret: number): MentionHit | null {
  const before = value.slice(0, Math.max(0, caret));
  const hit = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!hit) return null;
  const query = hit[2];
  return { start: caret - query.length - 1, query };
}

export function mentionQueryParts(query: string): { dir: string; prefix: string } {
  const cut = query.lastIndexOf("/");
  return cut >= 0
    ? { dir: query.slice(0, cut), prefix: query.slice(cut + 1).toLowerCase() }
    : { dir: "", prefix: query.toLowerCase() };
}

/** 目录补一个斜杠好继续往下敲；文件补一个空格好接着写。 */
export function mentionInsert(entry: { path: string; type: "file" | "dir" }): string {
  return "@" + entry.path + (entry.type === "dir" ? "/" : " ");
}

/** 用插入文本替换 `@query`。若后面本来就有空格，就不再多补一个。 */
export function applyMention(
  value: string,
  caret: number,
  hit: MentionHit,
  insert: string,
): { value: string; caret: number } {
  const follow = value[caret];
  const text = insert.endsWith(" ") && follow === " " ? insert.slice(0, -1) : insert;
  return {
    value: value.slice(0, hit.start) + text + value.slice(caret),
    caret: hit.start + text.length,
  };
}
