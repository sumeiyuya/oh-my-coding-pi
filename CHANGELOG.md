# CHANGELOG

## 0.6.3 — 2026-11-17

### 内核

- **启动竞态修复**：建通道前等内核把 shell/iopub 端口 bind 完（可调 `OMCP_KERNEL_PORT_WAIT_S`），
  修掉 Windows + pyzmq 27 上「先 connect 后 bind」导致的随机哑通道；重启路径同样处理。
- 握手失败时重建通道重试一次；内核在端口就绪前退出会立刻报出真实原因。
- 诊断同时保留 sidecar 的 `evalue`（含 `shell=/iopub=`）与内核 stderr，不再出现“原因认不出”。
- 验收脚本新增「冷启动 ×N」（`--coldstarts`），记录 ready 中位数与等端口耗时。

### 工具组

- 工具调用组**默认收起**，运行中展开、跑完收起；组头只留条数 / 失败数 / 总耗时。
- 工具调用改为从会话内容块重建：切会话、翻历史、下一段对话后不再消失。

## 0.6.2 — 2026-11-17

### 界面交互

- **产物就地预览**：点产物不再跳到文件页签，改在产物面板内预览（图片 / 表格 / Markdown / 文本），
  `← 列表` 或 `Esc` 返回并保留滚动位置；「在文件页签打开」变成主动入口。
- **待发队列**：运行中 `Enter` 排队、`Ctrl/Cmd+Enter` 立刻转向；每条可调整方向 / 新增会话 / 取回。
  队列以 pi 的 `queue_update` 为准，取回走 `clear_queue`。
- **会话标题**：由首条消息派生（≤24 字，路径与 URL 折叠），老会话懒回填；手动改名后不再被覆盖；
  列表右侧改显示相对时间（2m / 1d）。

### 工程

- 新增 `session-title.ts`、`artifact-preview.ts`、`queue.ts` 与对应单测（+17）。

## 0.6.1 — 2026-11-17

### 内核

- **启动握手重写**：不再用 `jupyter_client.wait_for_ready`。先订阅 iopub，再每 250 ms 换一个新
  `msg_id` 重发 `kernel_info`；shell 回复与 iopub 第一声都到才算就绪（20 s 预算）。
  修掉“第一次 run_code 必超时”的问题；`重启`走同一条路径。
- **执行收口**：只认 parent 等于本轮 `execute` 的 `status:idle`；`shell` 已答而 iopub 2 s 无回音时
  收口并输出 `[警告] 输出通道(iopub)未响应…`，不再静默拖到 120 s。
- **R**：argv 按启动器选（Rterm 必须带 `--args`，Rscript 必须不带——两者规则相反）；
  启动后预载 stats/graphics/grDevices/datasets/methods。
- **失败即回收**：启动失败先杀内核进程再关通道，连续失败不再堆积孤儿内核（旧版会泄漏）；
  `restart` 先等启动完成；启动串行化。
- **可诊断**：内核 stderr 进环形缓冲，错误时带出末尾 20 行；诊断新增“协议超时”“零输出”两类；
  没配路径时说明回退到了哪个 `python`（settings / OMCP_PYTHON / .venv / PATH）。
- **审计补 outcome**：`run_code` 每次执行记 `ok / 耗时 / status / errorClass / kernelPid`，
  与“放行”记录区分。
- **变量面板**：改用 `user_expressions`（silent、不进历史、不占输出）；R 侧有回落。
- **编码**：子进程补 `PYTHONUTF8=1`。

### 界面

- **移除布局模式**：顶栏的「对话为主 / 分析为主 / 专注 / 笔记本优先」下拉删除，改为两个开合按钮；
  右坞收起时右侧留 40px 图标条（文件 / 笔记本 / 产物 / 运行），点哪个面板就以它展开。
- 右坞开/合状态落盘（`omcp.global.dock-open`）；旧 `layout-mode` 一次性迁移后删除。
- `Ctrl+1–4` 空出（不再切布局）；`Ctrl+B` / `Ctrl+J` / `Ctrl+Alt+1–4` 保留。

### 产物

- 产物面板接入：账本（工具调用产出）+ `figures/`、`results/` 目录扫描；
  `bash` / `run_code` 的产出记为「未知」并显式计数；已删除文件显示「已不存在」。
  `write` / `edit` 精确到路径，面板按目录分组、类型徽标、可过滤、可点开预览。

### 工程

- 新增 `scripts/kernel-acceptance.mjs`：一条命令重跑 F0–F12 内核验收（失败非零退出），CI 里可选执行。
- 新增 `apps/desktop/test/artifact-ledger.test.ts`（7 条）、`kernel-diagnose.test.ts`（9 条）；
  `ui-state.test.ts` 改写为 10 条（含旧布局键迁移）。
- 文档：`known-limits` 补内核启动/输出口径与产物账本；`r-kernel.md` 补 argv 矩阵。

## 0.6.0 — 2026-11-15（改名 oh my coding pi，新仓库第一个版本）

这是项目的第一次提交，也是一次彻底改名：**旧名字不进历史**。

### 改名范围

| 项 | 新值 |
|---|---|
| 显示名 / 安装包 | `oh my coding pi` |
| npm 根包 / 作用域 | `oh-my-coding-pi` / `@oh-my-coding-pi/*` |
| 可执行文件 | `omcp.exe` |
| appId | `com.omcp.desktop` |
| 用户数据目录 | `%APPDATA%\oh-my-coding-pi` |
| 环境变量前缀 | `OMCP_*`（含 `OMCP_KEY_<ID>`） |
| 本地存储前缀 | `omcp.*` |
| 审批协议前缀 | `omcp-approval:` |
| 工作区元数据目录 | `.omcp/` |
| 仓库 | `sumeiyuya/oh-my-coding-pi` |

**不保留任何旧标识**：旧工作区元数据目录、旧前缀的密钥引用、旧 localStorage 一律不兼容。

### 本版包含的能力

- **对话与工具**：pi 工具循环、工具调用成组折叠（≥2 条相邻，默认收起，组头计数 + 失败数 + 总时长）
- **工作区**：左栏/右坞可拖可折叠、右坞四面板（文件/笔记本/产物/运行）、底部状态栏、会话搜索与分组、四种布局模式
- **内核**：Python / R 常驻内核、串行执行队列、解释器切换事前确认
- **模型服务**：内置服务商按官方环境变量注入凭据、发送前预检、连接信息确认对话框
- **权限**：三档权限、方案期门（批准绑定内容）、审计与持久授权
- **扩展**：科学计算扩展、浏览器插件（复用系统 Edge/Chrome）、记忆

### 已知问题

见 `docs/known-limits.md`。要点：安装包未签名；更新检查只支持公开仓库；旧工作区目录与新目录不互通。
