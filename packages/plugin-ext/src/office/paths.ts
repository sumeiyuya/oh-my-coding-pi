/**
 * 路径守卫（ADR-046）：插件工具只允许在工作区内读写。
 *
 * pi 的工作目录就是工作区（ADR-035），所以 process.cwd() 即根。
 * 这里不是安全边界（本机直跑、未沙箱化），只防“手滑写到工作区外”。
 */
import { isAbsolute, relative, resolve } from "node:path";

export class WorkspacePathError extends Error {}

export function workspaceRoot(): string {
  return process.cwd();
}

export function resolveInside(input: string): string {
  const root = workspaceRoot();
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkspacePathError(`拒绝：路径在工作区之外（${input}）`);
  }
  return target;
}

export function displayPath(abs: string): string {
  const rel = relative(workspaceRoot(), abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}
