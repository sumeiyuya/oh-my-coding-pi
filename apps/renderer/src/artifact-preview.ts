import type { FileReadKind } from "@oh-my-coding-pi/shared";

/**
 * 产物预览用哪种渲染器（P8）。
 *
 * 只做判断，不读文件：读取仍走 window.api.readFile（它有 too-large / binary 分支）。
 * 纯函数，可单测。
 */
export type PreviewKind = "markdown" | "table" | "image" | "text" | "none";

const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const TABLE = new Set(["csv", "tsv"]);

export function extOf(path: string): string {
  const name = String(path ?? "").split("/").pop() ?? "";
  const cut = name.lastIndexOf(".");
  return cut > 0 ? name.slice(cut + 1).toLowerCase() : "";
}

export function pickPreviewKind(path: string, readKind: FileReadKind): PreviewKind {
  if (readKind === "image") return "image";
  if (readKind !== "text") return "none";
  const ext = extOf(path);
  if (MARKDOWN.has(ext)) return "markdown";
  if (TABLE.has(ext)) return "table";
  return "text";
}
