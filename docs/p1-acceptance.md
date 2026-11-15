# P1 验收记录

- 日期：2026-11-11
- 版本：0.1.0
- 阶段：P1（对话 + 会话 + 安全基线）
- 结论：**通过（带保留项）**

---

## 1. 验收环境

| 项 | 值 |
|---|---|
| 系统 | Windows 11 x64 |
| Electron | 45.3.0 |
| pi | 0.86.1 |
| 模型 | `opencode-go/deepseek-v4.1-flash` |
| 构建 | `pnpm build` / `pnpm dist` |

---

## 2. AP1–AP6

### AP1 对话 + 工具卡片

- 方法：`P1_SELFTEST_MODE=tool`，让 pi 读取 `package.json` 前 3 行。
- 结果：

```json
{"hasRead":true,"hasPackage":true}
```

- 判定：**通过**。流式回复、工具卡片、历史渲染都正常。

### AP2 停止

- 方法：发长文提示，1.2s 后调用 `window.api.abort()`，等 4.5s 读状态。
- 结果：

```json
{"elapsedMs":4513,"ready":true,"hasStopButton":false}
```

- 判定：**通过（有保留）**。UI 立即释放，停止按钮消失，状态回到 READY；但未区分“abort 正常结束”与“3s 硬重启”的具体路径。

### AP3 会话切换

- 方法：`getSessions` → 选另一个会话 → `switchSession` → `getMessages`。
- 结果：

```json
{"sessions":2,"ok":true,"messages":3}
```

- 判定：**通过**。切换成功，历史 3 条消息加载。
- 过程中修复：preload 漏了 `switchSession`，已补。

### AP4 分支并继续

- 方法：`getTree` → 找第一条 user → `fork` → 发 `只回复：forked` → `getMessages`。
- 结果：

```json
{
  "fork": {"text":"只回复：p1-ok","cancelled":false,"persisted":false},
  "messages":3,
  "hasForked":true
}
```

- 判定：**通过**。fork 后继续对话成功；空 fork 标记 `persisted:false`，UI 提示未落盘。

### AP5 恢复

- 方法：`getState` → `restart` → 等 3.5s → `getState` + `getMessages`。
- 结果：

```json
{"before":"…sessions/…jsonl","after":"…同名文件","messages":7,"same":true}
```

- 判定：**通过**。重启前后同一 sessionFile，7 条消息完整。

### AP6 可见窗口与安装

| 项 | 结果 |
|---|---|
| 窗口截图 | `%APPDATA%/oh-my-coding-pi/screenshots/p1-window.png` |
| 安装包 | 121,181,566 字节 |
| 安装 | `/S` → exit 0，`%LOCALAPPDATA%\Programs\oh my coding pi` |
| 安装态自检 | `P1_SELFTEST_OK true` |
| 卸载 | `/S` → exit 0，安装目录删除 |
| 用户数据 | `%APPDATA%\oh-my-coding-pi` 保留 |

- 判定：**通过**。

---

## 3. DoD 对照

| 编号 | 定义 | P1 状态 |
|---|---|---|
| D1 | 可演示 | ✅ AP1–AP6 |
| D2 | 可恢复 | ✅ AP5 |
| D3 | 可拦截 | ⏸ P3（P1 无审批门） |
| D4 | 可导出 | ✅ 导出 HTML 288 KB |
| D5 | 可安装 | ✅ AP6 |
| D6 | 成本可见 | ✅ footer 成本/预算/ctx/token |
| D7 | 文档齐 | ✅ installation / permissions / known-limits |

> D3 是 v1 整体 DoD，P1 阶段不做权限；已在 `docs/permissions.md` 明示。

---

## 4. 里程碑

| 里程碑 | 标准 | 结果 |
|---|---|---|
| M1 骨架可对话 | 启动、prompt、流式 | ✅ |
| M2 对话完整 | 流式/工具/停止/模型/会话列表 | ✅ |
| M3 会话树与恢复 | 树/fork/clone/导出/恢复 | ✅ |
| M4 P1 验收 | AP1–AP6 + 安装 + 文档 | ✅（AP2 有保留） |

---

## 5. 保留项

1. AP2 未区分 abort 正常结束与 3s 硬重启路径；建议 P2 做一次工具执行中杀进程测试。
2. `auto_retry` 映射未做真实 429 故障注入。
3. 模型切换只验证列表与接线，未实际切换跑一轮。
4. 安装包未签名、默认图标、约 115.6 MiB。
5. 会话目录仍在 userData，P2 工作区化后迁移。

---

## 6. 结论

P1 的对话、会话、树、导出、恢复、安装均可用；**可以进入 P2（内核与 run_code）**。

P2 开始前不做权限门，使用范围仍限个人、非敏感数据。
