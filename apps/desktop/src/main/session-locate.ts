/**
 * 会话 → 工作区的反查（修改 5 · C1）。
 *
 * 修改 5 之前，`session:open` 一律拿「当前工作区」当参数，于是别的工作区的
 * 会话根本打不开；反过来，全局的 workspaceRoot 又把「看哪儿」和「能在哪儿干活」
 * 绑成了同一件事。这两个函数只回答一个问题：**这段会话住在哪个工作区**。
 *
 * 判据是目录，不是文件名：会话文件一定在 `<工作区>/.omcp/sessions` 下。
 * 这是 layout 的硬约束；猜不到就返回 null，由调用方决定回落策略。
 *
 * 纯函数、不摸盘：这样它能在 node 里直接测，也不会因为一次反查把主线程卡住。
 */
import { dirname, join } from "node:path";

import { sessionKey } from "./session-registry.ts";

/** 工作区的会话目录（与 openWorkspace 建目录、pi 的 --session-dir 同一套） */
export function sessionsDirOf(root: string): string {
  const trimmed = String(root ?? "").trim().replace(/[\\/]+$/, "");
  return join(trimmed, ".omcp", "sessions");
}

/**
 * 会话文件属于哪个工作区。
 *
 * `roots` 只该是**已知工作区**（当前 + 最近打开）：从任意路径反推工作区，
 * 等于把一个没登记过的目录当成工作区，后续文件树、策略、内核全会跟着错。
 *
 * Windows 大小写不敏感由 `sessionKey` 统一处理；返回的是 `roots` 里的原样值
 * （大小写、盘符风格都保留给界面显示）。
 */
export function workspaceOfSession(file: string | null | undefined, roots: string[]): string | null {
  if (!file) return null;
  const dir = sessionKey(dirname(String(file)));
  for (const root of roots) {
    if (!root) continue;
    if (sessionKey(sessionsDirOf(root)) === dir) return root;
  }
  return null;
}
