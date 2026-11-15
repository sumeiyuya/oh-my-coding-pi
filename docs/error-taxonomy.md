# 错误分类与恢复契约（v1）

- 版本：1.0
- 日期：2026-11-11
- 对应类型：`docs/protocol.ts` 的 `ErrorCode`
- 原则：**可恢复的错误不打断用户；不可恢复的错误必须给出下一步动作；任何错误都不能删用户数据。**

---

## 1. 错误对象

所有错误在 UI 层统一为：

```ts
interface AppError {
  code: ErrorCode;
  severity: "info" | "warning" | "error" | "fatal";
  title: string;       // 一句话，用户能看懂
  detail: string;      // 技术细节，可折叠
  recoverable: boolean;
  action?: "retry" | "restart-pi" | "restart-kernel" | "open-settings" | "open-log" | "none";
  retryAfterMs?: number;
  context?: Record<string, string | number | boolean>;
}
```

---

## 2. 错误码总表

| 代码 | 类别 | 严重度 | 检测方式 | UI 表现 | 恢复动作 | 数据安全 |
|---|---|---|---|---|---|---|
| `E_PI_SPAWN` | 进程 | fatal | `spawn` error / ENOENT | 全屏提示 + “打开设置” | 检查 pi 路径/重装 | 不动工作区 |
| `E_PI_EXIT` | 进程 | error | 子进程非预期退出 | 顶部横幅“pi 已断开” | 自动重启（最多 3 次，指数退避）并恢复会话 | 会话 JSONL 已落盘 |
| `E_PI_TIMEOUT` | 进程 | error | 忙碌状态 120s 无事件 | 横幅 + “停止/重启” | 先 abort，3s 未 settle 则强杀重启 | 保留最后一条 assistant 文本 |
| `E_MODEL_AUTH` | 模型 | error | 401/403 | 系统消息 + “打开设置” | 不重试；引导检查密钥/订阅 | 无 |
| `E_MODEL_RATE` | 模型 | warning | 429 / `retry-after` | 状态栏“限流，等待 Ns” | 按 `retry-after` 重试，最多 2 次 | 无 |
| `E_MODEL_NETWORK` | 模型 | warning | ECONNRESET/ETIMEDOUT/5xx | 状态栏“网络重试中” | 指数退避 1s/2s/4s，最多 3 次 | 无 |
| `E_TOOL_BLOCKED` | 工具 | info | `tool_call` 返回 `{block:true}` | 工具卡片标“已拒绝” | 不重试；模型收到原因 | 不执行任何写操作 |
| `E_TOOL_TIMEOUT` | 工具 | error | 工具执行超时 | 工具卡片标“超时” | 可重试；内核类先 interrupt | 写操作需幂等 |
| `E_TOOL_ERROR` | 工具 | error | `tool_execution_end.isError` | 工具卡片标红，详情可展开 | 由模型决定是否重试 | 写操作先临时文件再原子替换 |
| `E_KERNEL_START` | 内核 | error | sidecar `ready` 超时（90s） | 笔记本区提示 + “重试” | 重试 1 次；仍失败则提示检查解释器 | 无 |
| `E_KERNEL_DEAD` | 内核 | error | sidecar 退出 / kernel 不存活 | 笔记本区标“内核已断开” | 自动重启内核；变量丢失需提示 | 内核状态丢失，磁盘文件不受影响 |
| `E_KERNEL_BUSY` | 内核 | warning | 并发 execute | 输入框禁用 + “排队中” | 排队，不并发执行 | 无 |
| `E_SESSION_MISSING` | 会话 | error | `switch_session` 文件不存在 | 提示“会话文件已移动或删除” | 刷新列表，回到最近可用会话 | 不删除任何文件 |
| `E_SESSION_CORRUPT` | 会话 | error | JSONL 解析失败 | 提示 + “打开日志” | 只读打开，跳过坏行；不自动修复 | 原文件保持只读 |
| `E_EXPORT_FAILED` | 导出 | warning | 路径无权限/磁盘满 | 提示目标路径 | 换路径重试 | 不覆盖已有文件 |
| `E_USER_ABORT` | 用户 | info | 用户点停止 | 状态栏“已停止” | 无 | 保留已生成内容 |
| `E_UNKNOWN` | 其它 | error | 兜底 | 通用错误卡片 | 打开日志 | 无 |

---

## 3. 重试策略

| 场景 | 重试次数 | 退避 | 备注 |
|---|---:|---|---|
| 网络 / 5xx | 3 | 1s / 2s / 4s | pi 自身可能已重试，避免叠加 |
| 429 限流 | 2 | 取 `retry-after`，无则 5s | 超过则提示 |
| 401/403 | 0 | — | 直接引导设置 |
| pi 退出 | 3 | 1s / 2s / 4s | 第 4 次失败进 fatal |
| 内核启动 | 1 | 3s | 仍失败提示解释器路径 |
| 工具超时 | 0（交给模型） | — | 用户可手动重试 |
| 审批拒绝/超时 | 0 | — | 不自动重试 |

---

## 4. 边界与数据安全

1. **写操作**：先写 `<target>.tmp`，`fsync` 后原子替换；失败清理临时文件。
2. **会话**：pi 的 JSONL 是 append-only；应用不重写历史。
3. **内核重启**：明确提示“变量将丢失”，不自动重启正在执行的代码。
4. **强杀 pi**：先 `abort`，3s 未 settle 再 `taskkill /T /F`；重启后用 `--session` 恢复。
5. **导出**：不覆盖已存在文件，默认加时间戳后缀。
6. **日志脱敏**：不记录密钥、完整 prompt、用户文件内容；命令只记哈希与规则 id。

---

## 5. 日志字段

每条错误至少记录：

```json
{
  "ts": "2026-11-11T07:00:00.000Z",
  "level": "error",
  "code": "E_PI_EXIT",
  "sessionId": "…",
  "toolCallId": "…",
  "durationMs": 1234,
  "action": "restart-pi",
  "appVersion": "1.0.0",
  "piVersion": "0.86.1",
  "detail": "exit code 1"
}
```

**禁止记录**：API key、Authorization 头、完整文件内容、完整 prompt。

---

## 6. 与 pi 事件的映射

| pi 事件/字段 | 用途 |
|---|---|
| `agent_end.willRetry` | 判断是否还有自动重试，避免 UI 提前报错 |
| `auto_retry_start` / `auto_retry_end` | 显示“重试中”，成功后清除错误 |
| `extension_error` | 归入 `E_TOOL_ERROR` 或 `E_UNKNOWN` |
| `tool_execution_end.isError` | `E_TOOL_ERROR` / `E_TOOL_BLOCKED` |
| `response.success === false` | 命令级错误，按 command 映射 |
| 子进程 `exit` | `E_PI_EXIT` |
| sidecar `exit` / `ready` 超时 | `E_KERNEL_DEAD` / `E_KERNEL_START` |

---

## 7. 用户文案示例

- **E_PI_EXIT**：`pi 进程已断开，正在恢复会话…`（自动恢复失败后）`恢复失败，请点击“重启 pi”。`
- **E_MODEL_AUTH**：`模型认证失败。请到设置检查 API key 或订阅状态。`
- **E_KERNEL_DEAD**：`内核已断开。重启后变量会丢失，磁盘文件不受影响。`
- **E_TOOL_BLOCKED**：`已拒绝执行：rm -rf ./data（规则 rm-rf）。`
- **E_TOOL_TIMEOUT**：`工具执行超过 120 秒，已请求中断。`

---

## 8. 升级与兼容

- 新增错误码只能追加，不复用旧码。
- 未知错误码一律落到 `E_UNKNOWN`，保留原始 `detail`。
- pi 升级后若事件字段变化，优先在适配层映射，不在 UI 层散落判断。
