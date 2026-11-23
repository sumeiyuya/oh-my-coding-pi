# 发布说明 0.6.11

- 日期：2026-11-23
- 安装包：`oh my coding pi Setup 0.6.11.exe`
- 平台：Windows 10/11 x64（按当前用户安装，不需要管理员）
- 仓库：`sumeiyuya/oh-my-coding-pi`
- 上一版：0.6.10（2026-11-22）

## 下载

- [oh my coding pi Setup 0.6.11.exe](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.11/oh.my.coding.pi.Setup.0.6.11.exe)
- [SHA256SUMS.txt](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.11/SHA256SUMS.txt)

---

## 1. 后台 runtime 空闲回收

0.6.10 已经能让多个会话各跑一个 runtime，但后台 runtime 会一直占着 pi 进程。0.6.11 补上资源策略：

- 默认最多 **2 个活跃 runtime**（默认标签 + 1 个后台）；超过上限时新建会被拒绝，并提示先关一个后台标签。
- 后台 runtime 连续 **30 分钟**没有活动，自动停掉它的 pi 进程；**标签和会话文件保留**。
- 默认标签与当前 active 标签**永不回收**；正在跑一轮的 runtime（`busy=true`）也不会被回收。
- 切回挂起的标签时自动 `start` 恢复，消息区重新加载；标签不会消失。

对应的环境变量 / 设置：

| 方式 | 名称 | 默认 | 范围 |
|---|---|---|---|
| 设置页 | 多会话 → 最多活跃 runtime | 2 | 1–4 |
| 设置页 | 多会话 → 空闲回收（分钟） | 30 | 1–1440 |
| 环境变量 | `OMCP_MAX_RUNTIMES` | 2 | 1–4 |
| 环境变量 | `OMCP_RUNTIME_IDLE_MINUTES` | 30 | 1–1440 |

设置页保存后即时生效；环境变量只作为未保存时的默认值。

### 挂起状态

- 标签栏显示 `N 运行 / M 标签`。
- 被回收的后台标签显示“挂起”，运行点变成空心。
- 回收/恢复时给出 toast 提示；切回挂起标签会短暂显示恢复中。

回收器每 60 秒检查一次，因此实际回收时间约为“空闲阈值 ~ 阈值 + 1 分钟”。默认 30 分钟档的误差可忽略；把阈值调到 1 分钟做验收时，最长约 2 分钟。

## 2. 设置页「多会话」

设置 → 多会话新增一张卡：

- 最多活跃 runtime（1–4）
- 空闲回收分钟（1–1440）

说明文字明确“默认标签与当前标签不会被回收；切回时自动恢复”。

## 3. 审批来源与审计导出（P4a）

- 审批弹窗的 meta 行新增“来源：默认 / 后台 N”，后台标签的审批不再只能靠工具名猜。
- 审计导出（`audit:export`）改为导出**当前 active runtime** 的审计；后台 runtime 的导出文件名追加 `-<runtimeId>`，避免与默认运行时混淆。
- 审计读取/查询此前已按 active runtime，这次导出行为与它们一致。

## 4. 验收

### 真机 1 分钟回收

用构建后的应用、`OMCP_RUNTIME_IDLE_MINUTES=1` 跑：

1. 创建第二个 runtime，切回默认标签；
2. 等待 140 秒；
3. 后台 `running` 由 `true` 变为 `false`；
4. 点回后台标签，`running` 恢复为 `true`，active 切到该标签；
5. 消息读取返回空数组（本次是新空会话，0 条）。

### 进程级复核

另用真实 `SessionRuntime`（真实 pi 子进程）验证：

```text
reapIdle(0) → stopped=["bg"]，bg running=false
activate(bg) → bg running=true，active=true
```

### 回归

- `scripts/ci.ps1`：install / typecheck / 单测 / 审计 / 诊断 / provider catalog / 契约 / 权限扩展 typecheck / electron build。
- runtime/MCP 相关单测 19 条全部通过。

## 5. 已知限制

- 本次回收验收是**空会话**；带消息的会话在挂起后恢复历史，还需要再点验一次。
- 后台 runtime 正在跑一轮时不会被回收，但这条（busy 保护）只有单测/逻辑覆盖，未做计时验收。
- 分屏 / 多窗口、跨工作区标签、进程与内存占用提示仍未实现。
- 跨工作区多标签尚未完全打通；新建后台 runtime 仍使用当前工作区。
- 每个后台 runtime 会各自连接 MCP 服务器；stdio 服务器可能出现多份进程。
- 审计页仍只有一个导入/导出按钮；会话树、planGate、grants 仍有部分按默认 runtime。

## 6. 升级注意

- 需要重启应用：runtime 管理与回收器在启动时装配。
- 默认标签的配置、MCP、模型凭据与 0.6.10 一致。
- 已有后台标签在升级后会按新策略管理；若同时开着多个，可能先被上限挡住新建，需关闭不用的标签。
- 后台 runtime 的会话文件仍在同一会话目录；关闭标签不会删会话文件。
- MCP 配置仍在 `~/.pi/agent/mcp.json`；OAuth 令牌在 `~/.pi/agent/mcp-auth.json`。

## 7. 安装包

| 项 | 值 |
|---|---|
| 文件 | `oh my coding pi Setup 0.6.11.exe` |
| 大小 | **136,892,574 字节**（约 130.6 MiB） |
| 签名 | 未签名（SmartScreen 可能提示“未知发布者”） |
| SHA256 | `DCE5CFF4D26CF10880DA4965D73BB37A05833B28396AECA3FA7248AE01F0D7CF` |
