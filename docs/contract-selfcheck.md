# 契约自检：能否直接进入 P1

- 日期：2026-11-11
- 输入：`docs/scope.md`、`docs/protocol.ts`、`docs/policy.schema.json`、`docs/error-taxonomy.md`
- 方法：按契约试写三个 P1 模块的数据流；只允许使用契约里的类型与字段，发现缺口就补契约，不靠“实现时再说”。
- 校验：`tsc --strict` 通过；JSON Schema 通过 Draft 2020-12 校验，示例策略校验通过。

---

## 1. 模块 A：会话面板

### 数据流

```ts
const state = await api.getState();            // SessionState
const tree = await api.getTree();              // SessionTreeResult
const entries = await api.getEntries();        // SessionEntriesResult
render(tree.tree, tree.leafId);
on("agent_settled", () => api.getEntries(lastEntryId)); // 增量
const r = await api.switchSession(absPath);    // SessionSwitchResult
if (r.cancelled) showToast("切换被扩展取消");
```

### 试写时发现的缺口（已补）

| 缺口 | 原契约 | 修正 |
|---|---|---|
| `get_tree` 返回 `{tree, leafId}`，原 API 只返回数组 | 丢失 leafId | 新增 `SessionTreeResult` |
| `get_entries` 返回 `{entries, leafId}` | 丢失游标 | 新增 `SessionEntriesResult` |
| `switch_session` 可能被扩展取消 | `Promise<boolean>` 无法表达 | 新增 `SessionSwitchResult` |
| `fork` 返回 `{cancelled, text}` | `Promise<boolean>` 丢失 fork 文本 | 新增 `ForkResult` |
| 会话列表没有 RPC 命令 | — | 主进程扫描 `sessionsDir/*.jsonl`，读首行 header；用 `SessionSummary` 表达 |

### 实现约束（不再需要设计）

1. `get_state.sessionFile` 可能是相对路径，**进入 UI 前统一 `resolve()` 成绝对路径**。
2. 会话列表由主进程扫描目录生成 `SessionSummary[]`，不新增 RPC 命令。
3. 消息计数用 `SessionStats.userMessages/assistantMessages`，不用 `messageCount`（含 system）。

---

## 2. 模块 B：审批中心

### 数据流

```ts
// 扩展侧：发 select，标题带结构化前缀
const payload: ApprovalTitlePayload = { v: 1, toolName, ruleId, summary };
const choice = await ctx.ui.select(
  APPROVAL_TITLE_PREFIX + JSON.stringify(payload),
  APPROVAL_OPTIONS.map(o => o.label),
  { timeout: 60_000 },
);

// UI 侧：解析标题 -> ApprovalRequest -> 用户选择 -> ApprovalDecision
const req = parseApproval(uiRequest);          // ApprovalRequest
api.respondApproval({ requestId: req.id, scope: "session", decidedAt: now });
```

### 试写时发现的缺口（已补）

| 缺口 | 原契约 | 修正 |
|---|---|---|
| `select` 只带 title/options，没有 toolName/ruleId/summary | 无法建 `ApprovalRequest` | 新增 `APPROVAL_TITLE_PREFIX` 与 `ApprovalTitlePayload` |
| 超时返回 `undefined`，不是 `ApprovalScope` | 无法统一记录 | `ApprovalRequest.timeoutMs` + 主进程定时器合成 `scope:"timeout"` |
| 审批请求与 `tool_execution_start` 的顺序 | 契约未写 | 在 UI 约束中写明：先“待审批”，批准后才“执行中” |

### 实现约束

1. 标题前缀固定为 `omcp-approval:`，后面必须是合法 JSON；解析失败则按普通 `select` 处理。
2. 主进程负责超时：`timeoutMs` 到点未收到 `ApprovalDecision`，写 `scope:"timeout"` 并回 `cancelled`。
3. 授权按 `ruleId` 记录，不按完整命令；持久授权存应用数据，按 `workspaceId` 绑定。
4. UI 在审批决定前显示“待审批”，不显示“执行中”。

---

## 3. 模块 C：run_code 工具

### 数据流

```ts
const handle = await backend.startKernel("python", workspace.root); // KernelHandle
const events: KernelEvent[] = [];
await handle.execute(code, (ev) => {
  if (ev.ev === "stream") pushText(ev.text);
  if (ev.ev === "display" && ev.mime === "image/png") pushImage(ev.data);
  if (ev.ev === "error") pushError(ev);
});
return { content: [text, ...images], details: { status } } satisfies ToolResult;
```

### 试写时发现的缺口（已补/已定）

| 缺口 | 处理 |
|---|---|
| `KernelHandle.execute` 的完成信号 | Promise resolve 即完成；事件只负责增量 |
| 图片落盘到 `figures/` 由谁做 | **主进程**在 `tool_execution_end` 收到 image block 时保存，扩展只回传图片 |
| `run_code` 的审批 | 审批扩展把 `toolName === "run_code"` 纳入规则；策略字段 `runCode.requireApproval` |
| 输出过大 | 策略 `runCode.maxOutputChars` 截断，完整输出写日志 |
| 内核语言切换 | `KernelRequest.start` 带 `lang`；R 用 `ir` kernelspec（P2） |

### 实现约束

1. 一个工作区一个内核；懒启动；`session_shutdown` 关闭。
2. 重启用 `newports=True` 并重建 client（S5 结论）。
3. 内联后端用 `MPLBACKEND` 环境变量（S5 结论）。
4. 图片同时返回给模型并保存到 `figures/`，文件名带时间戳，不覆盖旧图。

---

## 4. 契约完整性检查

| 检查 | 结果 |
|---|---|
| `protocol.ts` 严格类型检查 | ✅ `tsc --strict` 通过 |
| `policy.schema.json` 元模式校验 | ✅ Draft 2020-12 通过 |
| 示例策略校验 | ✅ `policy.example.json` 通过 |
| 错误码与 UI 映射 | ✅ `ErrorCode` 与 `error-taxonomy.md` 一一对应 |
| 范围与非目标 | ✅ `scope.md` 冻结 |
| 验收用例可判定 | ✅ 5 条均有步骤与期望 |

---

## 5. 结论

**可以进入 P1。** 三个代表性模块都能只依赖契约写出数据流，不需要再补设计。

进入 P1 时只需遵守四条实现约束：

1. 会话路径统一绝对化；列表由主进程扫描目录。
2. 审批标题用 `omcp-approval:` + JSON；超时由主进程合成。
3. `run_code` 图片由主进程落盘；扩展只回传 image block。
4. 内核重启必须换端口、内联后端用 `MPLBACKEND`。

如果 P1 出现契约未覆盖的新需求，先改 `protocol.ts` 与 `decisions.md`，再写实现。
