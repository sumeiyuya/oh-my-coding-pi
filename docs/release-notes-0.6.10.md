# 发布说明 0.6.10

- 日期：2026-11-22
- 安装包：`oh my coding pi Setup 0.6.10.exe`
- 平台：Windows 10/11 x64（按当前用户安装，不需要管理员）
- 仓库：`sumeiyuya/oh-my-coding-pi`
- 上一版：0.6.9（2026-11-22）

## 下载

- [oh my coding pi Setup 0.6.10.exe](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.10/oh.my.coding.pi.Setup.0.6.10.exe)
- [SHA256SUMS.txt](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.10/SHA256SUMS.txt)

---

## 1. 多项目 / 多会话并行

这一版把运行时从“全局一份”拆成“每个会话一份”：

- 顶栏新增运行时标签：`默认` / `后台 N`；可新建、切换、关闭（默认不可关）。
- 每个标签有自己的：
  - pi 进程（`SessionRuntime`）
  - 消息列表
  - 输入草稿、未发附件、待发队列
  - busy 状态与未读数
  - 会话列表、统计
  - 审批请求与审计文件
- 切标签只改 active，不打断后台运行；后台标签可以继续发新消息、停止。
- 新建后台 runtime 时自动注入它自己的 kernel / policy / artifact token；这些服务按 runtime 路由。
- 内核按 runtime 懒创建；关闭 runtime 会停对应内核。
- 审计：审批、policy 决策、`run_code` outcome 写各自 `<workspace>/.omcp/logs/audit.jsonl`。
- 模型/推理档：切标签恢复该 runtime 的模型；在后台标签切换只影响它自己。

### 相关修复

- `needs-auth` 不再被误判为已连接。
- 后台 runtime 的 `extension_ui_request` 现在会进入统一审批流，回复发给对应的 pi 进程。

## 2. 对话图片显示

- 用户消息气泡显示发送时的图片（56px 缩略图，多图换行）。
- 点击缩略图打开应用内大图；点背景或按 Escape 关闭。
- 历史恢复保留 `image` block；切会话/重启后图片仍在（模型支持图片时）。
- 纯文本模型显示「当前模型仅文本：图片会先转述再发送」。
- 发送失败时图片仍在，输入框回填文字与附件。

## 3. 权限弹层文字布局

- 权限弹层不再继承顶栏的 `white-space: nowrap`：三档描述与底部说明正常换行。
- 弹层宽度 300 → 320px，加 `max-height` 与纵向滚动。
- 未选择模型时触发器文案改为「选择模型」，减少顶栏挤压。

## 4. 验证

- `scripts/ci.ps1`：install / typecheck / 单测 / 审计 / 诊断 / provider catalog / 契约 / 权限扩展 typecheck / electron build。
- 新增 runtime/MCP 单测：
  - `session-runtime`：容器、env、事件泵
  - `runtime-manager`：注册/激活/关闭
  - `service-hub`：token → runtime
  - `kernel-manager` / `kernel-broker`：按 runtime 的内核路由
  - `artifact-service`：按 runtime 的产物路由
  - `policy-runtime`：policy token 路由
- 对话图片：`tool-rebuild` 新增 image block 恢复用例。
- 说明：多标签 UI 没有自动化，后台发送/审批/审计需要在应用内实际点一次验收。

## 5. 已知限制

- **P3 未做**：活跃 runtime 上限、空闲回收、切回 resume 尚未实现；同时开多个后台 runtime 会各占一个 pi 进程。
- 方案期门 / grants / 审计导出 / 会话树还有部分仍按默认 runtime。
- 后台标签的排队/追加已接 rpc，但 `busy` 之外的提交阶段仍是单份。
- 每个后台 runtime 会各自连接 MCP 服务器；stdio 服务器可能出现多份进程。
- 跨工作区的多项目标签尚未完全打通（当前“新建后台运行时”使用当前工作区）。

## 6. 升级注意

- 需要重启应用：主进程与 runtime 管理代码在启动时装配。
- 默认标签的配置、MCP、模型凭据与 0.6.9 一致。
- 后台 runtime 的会话文件仍在同一会话目录；关闭标签不会删会话文件。
- MCP 配置仍在 `~/.pi/agent/mcp.json`；OAuth 令牌在 `~/.pi/agent/mcp-auth.json`。

## 7. 安装包

| 项 | 值 |
|---|---|
| 文件 | `oh my coding pi Setup 0.6.10.exe` |
| 大小 | **136,807,652 字节**（约 130.5 MiB） |
| 签名 | 未签名（SmartScreen 可能提示“未知发布者”） |
| SHA256 | `E3DAA18CACE1C7C57EFBF48C89E6A0F400A007DDDA3D1AAC23370B5152FDA221` |
