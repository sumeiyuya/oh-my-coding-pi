/**
 * 审批弹窗里的「这次授权到底放行什么」。
 *
 * MCP 未列出工具的授权键是服务器级（tool:unlisted:mcp__<server>）：
 * 「本会话」「总是允许」会放行该服务器的**所有**未列出工具，包括写工具。
 * 不写清楚的话，用户会以为只是允许当前这一个工具。
 */
export function approvalScopeHint(ruleId: string): string | null {
  const match = /^tool:unlisted:mcp__(.+)$/.exec(String(ruleId ?? "").trim());
  if (!match) return null;
  const server = match[1]!;
  return `服务器级授权：选「本会话」或「总是允许」会放行服务器「${server}」的所有未列出工具，包括写工具。只允许这一个工具，请选「仅本次」。`;
}
