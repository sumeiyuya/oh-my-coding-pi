# 发布说明 0.6.9

- 日期：2026-11-22
- 安装包：`oh my coding pi Setup 0.6.9.exe`
- 平台：Windows 10/11 x64（按当前用户安装，不需要管理员）
- 仓库：`sumeiyuya/oh-my-coding-pi`
- 上一版：0.6.8（2026-11-18）

## 下载

- [oh my coding pi Setup 0.6.9.exe](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.9/oh.my.coding.pi.Setup.0.6.9.exe)
- [SHA256SUMS.txt](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.9/SHA256SUMS.txt)

---

## 1. MCP 服务器接入

设置页新增「MCP 服务器」面板：

- 添加：直接粘贴服务器文档里的 `mcpServers` JSON；也支持只填单台配置 + 名字。
- 列表：名称、来源（全局）、命令 / URL、exposure、工具数、状态、缺失密钥。
- 操作：检查全部连接、打开配置文件、信任 / 取消信任、停用 / 启用、删除。
- 配置写 `<agentDir>/mcp.json`（默认 `~/.pi/agent/mcp.json`，与系统 pi 共享）：
  - 写前备份 `.bak`，临时文件 + rename，写后读回校验；
  - 校验失败写回原文并报错，不覆盖坏文件。
- 密钥：
  - 配置文件里只出现 `${OMCP_MCP_<SERVER>_<KEY>}`；
  - 值存应用安全存储（`secrets.json`），不回显；
  - 粘贴 JSON 里的明文密钥会在保存时自动搬进安全存储；
  - 用户自己的 `${CUSTOM_VAR}` 原样保留。
- 信任按「服务器名 + 命令/URL 指纹」记录，存在 `mcp-trust.json`；命令或地址变了，旧信任自动失效。

## 2. 状态与 OAuth

- 状态六态：`未检查 / 检查中 / 已连接 / 失败 / 需要登录 / 已停用`。
- 失败不再是一句“连接失败”：显示 pi 返回的 `error`，检查超时会说明原因。
- 启动 8 秒后异步检查一次连接：不阻塞会话、不弹窗；没有启用的服务器就不起进程。
- HTTP 服务器行提供「登录（OAuth）」：
  - spawn `pi mcp login <name> --timeout 300`；
  - pi 自己打开浏览器；应用同时抓授权页 URL，浏览器没弹时可点兜底链接；
  - 登录成功后重启 pi，让会话按新令牌重连；
  - 失败/超时把 pi 的原因带回界面。

已用 Sentry 官方 MCP（`https://mcp.sentry.dev/mcp`）做过端到端验收：`needs-auth → 浏览器授权 → connected`，74 个工具；`filesystem` 16 个工具。

## 3. 只读工具与审批

- 只读判定来自 MCP 服务器的 `annotations.readOnlyHint`，由 `permission-ext` 读取并上报；主进程只采信 `mcp__` 前缀。
- 只读 MCP 工具：
  - 普通模式：直接放行（`mcp:readonly`），不弹审批；
  - 方案期 / 只读模式：放行；
  - 写工具：方案期 `plan:readonly`、只读模式 `mode:readonly`、普通模式 `ask`。
- `tools.allow` / `tools.deny` 支持 `*` 通配（如 `mcp__filesystem__read_*`、`mcp__sentry__delete_*`）。
- 未列出的 MCP 工具按**服务器**授权：`tool:unlisted:mcp__<server>`。
- 审批弹窗对服务器级授权给出明确提示：
  > 选「本会话」或「总是允许」会放行该服务器的所有未列出工具，包括写工具；只允许这一个工具，请选「仅本次」。

## 4. 显示

- 工具卡片与工具组把 `mcp__server__tool` 显示为 `server · tool`，原始工具名保留在 `title`。
- HTTP 服务器行固定提示：远程服务器，工具入参可能离开本机。
- 面板底部说明：本地服务器是任意可执行程序，审批门只管工具调用，不是沙箱；密钥只进安全存储。

## 5. 验证

- `scripts/ci.ps1`：CI OK（install / typecheck / 单测 / 审计 / 诊断 / provider catalog / 契约 / 权限扩展 typecheck / electron build）。
- MCP 相关单测：
  - `mcp-service`：19 条（配置、密钥、回滚、信任、状态、登录）；
  - `mcp-policy`：5 条（方案期 / 只读模式 / 普通模式）；
  - `mcp-permission`：7 条（拒绝 block、readOnly 透传）；
  - `policy`：+5 条（glob、服务器级 ruleId、只读放行）；
  - `tool-summary`、`approval-hint`：各 +1 / 4 条。
- 端到端：
  - `mcp__filesystem__read_file`：23 ms，成功读出 `package.json`；
  - `tool_search("sentry whoami")`：16 ms，加载 8 个工具；
  - `mcp__sentry__whoami`：1302 ms，成功返回已授权用户信息。
- 真实 OAuth 验收报告：`results/reports/02-阶段开发报告/MCP-P3/MCP接入_P3_SentryOAuth验收_2026-11-22.md`（仓库外）。

## 6. 已知限制

- **单台检查未做**：`pi mcp list` 没有单台参数，检查会连接全部已启用服务器；自己连单台需要处理 OAuth 令牌存储，暂未实现。
- **启动检查有副作用**：启动 8 秒后会短暂启动所有已启用服务器；设置页文案已说明。
- **Sentry 写权限**：Sentry MCP 的 OAuth scope 包含 `project:write team:write event:write alerts:write`；授权即允许这些写操作。可在策略里用 `tools.deny` 拒绝 `create_* / update_* / delete_*`。
- **项目级 `.pi/mcp.json`** 仍受「信任项目」控制；默认不读。MCP 面板只管理全局配置。
- **旧授权失效**：`tool:unlisted` 改为 `tool:unlisted:mcp__<server>` 后，升级前保存的授权不再匹配，首次调用会重新询问一次。
- **Sentry MCP 为 Beta**：工具清单可能变化。
- MCP 面板暂不显示每个工具是否只读（`pi mcp list --json` 不返回 annotations）。

## 7. 升级注意

- 需要重启应用（或重启 pi）后 MCP 面板与新的审批逻辑才生效。
- MCP 配置在 `~/.pi/agent/mcp.json`，与系统 pi 共享；在 omcp 里改会影响其他 pi 使用方。
- OAuth 令牌在 `~/.pi/agent/mcp-auth.json`；`pi mcp logout <server>` 可删除。
- 原来的 `mcp.json` 会在第一次写入时备份为 `mcp.json.bak`。

## 8. 安装包

| 项 | 值 |
|---|---|
| 文件 | `oh my coding pi Setup 0.6.9.exe` |
| 大小 | **136,804,825 字节**（约 130.5 MiB） |
| 签名 | 未签名（SmartScreen 可能提示“未知发布者”） |
| SHA256 | `635F233B93B9B83ED01C8EA59F4E212F09BA1B150901E2FFE7B20655657F3B6D` |
