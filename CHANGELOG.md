# CHANGELOG

## 0.6.11 — 2026-11-23

### 修改 3 · P3a：runtime 上限与空闲回收

- `RuntimeManager` 默认最多 2 个 runtime（`OMCP_MAX_RUNTIMES` 可设 1–4）；新建超限直接拒绝。
- `SessionRuntime` 记录 `busy` / `lastActiveAt`；`RuntimeManager.reapIdle` 停掉非 active、非 busy、空闲超过阈值的 runtime（默认 30 分钟，`OMCP_RUNTIME_IDLE_MINUTES`）。
- 被回收的 runtime 保留标签与会话，切回时 `activate` 重新 start（resume）。

### 修改 3 · P3b：挂起状态与回收通知

- `runtime:list` 带 `running` / `busy`；标签显示“挂起”、运行点。
- 回收后主进程推送 `runtime:changed`，renderer 更新标签。
- 切回挂起 runtime 时自动 resume；消息加载失败会重试一次。

### 修改 3 · P3c：设置页多会话参数

- 设置 → 多会话：最多活跃 runtime（1–4）、空闲回收分钟（1–1440），保存即时生效。
- 默认值仍可由 `OMCP_MAX_RUNTIMES` / `OMCP_RUNTIME_IDLE_MINUTES` 提供。

### 修改 3 · P3d：挂起提示与运行计数

- 标签栏显示“N 运行 / M 标签”。
- runtime 被回收/恢复时给出 toast 提示。

### 修改 3 · P4a：审批来源与审计导出收尾

- 审批弹窗显示“来源：默认/后台 N”。
- `audit:export` 按 active runtime 导出；后台 runtime 文件名带 runtime id 后缀。
- 尚无分屏/多窗口、跨工作区、进程/内存提示。
- 已验收：`OMCP_RUNTIME_IDLE_MINUTES=1` 真机创建后台 runtime，约 140s 后 `running=false`；点回标签后 `running=true` 并恢复消息（空会话 0 条）。

## 0.6.10 — 2026-11-22

### 修改 1：权限弹层文字布局

- 权限弹层不再继承顶栏的 `white-space: nowrap`：三档描述与底部说明正常换行，不再向右溢出。
- 弹层宽度 300 → 320px，加 `max-height` 与纵向滚动；长词/路径可断行。
- 未选择模型时，触发器文案由「（未选择模型）」改为「选择模型」，减少顶栏挤压。

### 修改 2：对话图片显示

- 用户消息气泡显示发送时的图片（56px 缩略图，多图换行）；点击应用内大图，Escape / 点背景关闭。
- 发送时 attachments 进入消息；历史恢复保留 image block。
- 纯文本模型显示“图片会先转述再发送”提示；失败时图片仍在，并回填输入框。

### 修改 3 · P0：会话运行时容器

- 新增 `SessionRuntime`：id / token / env / supervisor / rpc / eventPump 收在一个对象里。
- 主进程默认 runtime 接入；`supervisor`、`rpc`、`eventPump` 从 runtime 取，单会话行为不变。
- 为 P1 的多 runtime、per-runtime token 路由留基础；尚未改变 IPC/事件协议。

### 修改 3 · P1a：RuntimeManager

- 新增 `RuntimeManager`：`Map<runtimeId, SessionRuntime>`，提供 create / get / activate / close / list。
- 默认 runtime 由 manager 创建；`activate` 只切 active，不 stop/start 其他 runtime。
- 创建时注入 `OMCP_RUNTIME_ID` / `OMCP_RUNTIME_TOKEN`（P1b 的服务路由备用，当前未消费）。
- 单会话行为不变；尚无多标签 UI、服务 token 路由、KernelManager。

### 修改 3 · P1b1：事件 runtimeId 与 ServiceHub

- `pi:event` 负载带 `runtimeId`（renderer 暂忽略，P2 按 runtime 分流）。
- 新增 `ServiceHub`：`token → runtimeId`；`RuntimeManager` 创建/关闭时登记/注销。
- 服务端仍未消费 token；policy/kernel/artifact 仍是全局路由（P1b2）。

### 修改 3 · P1b2a：KernelManager

- 新增 `KernelManager`：一对内核按 `runtimeId` 懒创建；`setWorkspace` / `dispose` 只影响该 runtime。
- 默认 runtime 的内核改由 manager 提供；单会话行为不变。
- 尚未把 `KernelBroker` 按 token 路由（P1b2b）。

### 修改 3 · P1b2b：KernelBroker 按 runtime token 路由

- `KernelBroker` 接受 `ServiceHub.resolve`：runtime token → 该 runtime 的内核；legacy 全局 token 仍兼容。
- 默认 runtime 的 `OMCP_KERNEL_TOKEN` 改为 runtime token；broker 通过 ServiceHub 找 default 内核。
- policy / artifact / browser 仍是全局 token（P1b2c）。

### 修改 3 · P1b2c1：ArtifactService 按 runtime token 路由

- `ArtifactService` 接受 `ServiceHub.resolve`：runtime token → 该 runtime 的 workspace；legacy 全局 token 仍兼容。
- 默认 runtime 的 `OMCP_ARTIFACTS_TOKEN` 改为 runtime token。
- policy / 审批仍是全局 token（P1b2c2）。

### 修改 3 · P1b2c2：PolicyService 按 runtime token 路由

- `PolicyService` 接受 `ServiceHub.resolve`：runtime token → 该 runtime 的 workspace；legacy 全局 token 仍兼容。
- 默认 runtime 的 `OMCP_POLICY_TOKEN` 改为 runtime token。
- `ApprovalRequest` 增加可选 `runtimeId`；审批队列本身仍是全局 Map（P1b2c3）。
- 方案期 / grants / audit 仍按全局 workspace，未按 runtime 隔离。

### 修改 3 · P1b2c3：审批按 runtime 标记与会话绑定

- `PendingApproval` / `ApprovalRequest` 带 `runtimeId`；`cancelPendingApprovals(runtimeId?)` 可按 runtime 取消。
- `ServiceHub` binding 带 `session`；`RuntimeManager.updateSession` 在切会话时同步；PolicyService 的 grants 用 runtime sessionKey。
- 审批仍是单个 Map、UI 未按 runtime 分组；grants/plan/audit 仍全局（P2）。

### 修改 3 · P2a：运行时接口

- 新增 `runtime:list / create / activate / close` IPC；新 runtime 自动接 spawn/event，并注入自己的 kernel/policy/artifact token。
- renderer 暂时丢弃非 `default` runtime 的事件，避免串流；P2b 再按 activeRuntimeId 分流。
- 尚无多标签 UI；messages/busy/queue 仍是单份。

### 修改 3 · P2b1：多运行时标签与消息切换

- 顶栏新增运行时标签：默认 / 后台 N；可新建、切换、关闭（默认不可关）。
- renderer 按 runtimeId 存 messages；切换只改 active，后台 runtime 的事件暂不混入当前列表。
- 新增 `runtime:messages` IPC：按 runtime 读取历史消息。
- 后台标签的发送接口仍关闭（P2b2）；队列/附件/审批分组未拆。

### 修改 3 · P2b2：后台标签发送与事件分流

- `pi:prompt` / `pi:abort` 增加可选 runtimeId；后台标签也能发新消息与停止。
- 非 active runtime 的事件进入轻量转写槽位，标签显示未读；切回时用 `get_messages` 校正。
- 后台标签仍不支持排队/追加；输入草稿、附件、队列仍全局。

### 修改 3 · P2b3a：每 runtime busy、审批回程与关闭清理

- `busy` 按 runtime 存；标签用运行点显示。
- 新 runtime 的 `extension_ui_request` 接到统一审批流；回复发回对应 `rpc`，不再只回默认进程。
- `runtime:close` 取消该 runtime 审批并停对应内核。
- 输入/附件/队列/统计仍全局（P2b4）。

### 修改 3 · P2b4a：每 runtime 输入/附件/队列

- 输入草稿、未发附件、待发队列按 runtime 存；切标签各自保留。
- 后台标签的 `queue_update` 也写入自己的槽位。
- 关闭 runtime 时清理本地 messages/未读/busy/输入/附件/队列。
- 审批的 sessionKey / grants 改用该 runtime 的 session/workspace。
- stats/model/thinking 仍默认（P2b5）。

### 修改 3 · P2b5a：每 runtime 模型/队列/统计

- `setModel` / `setThinkingLevel` / `getThinkingLevels` / `steer` / `followUp` / `clearQueue` 支持 runtimeId。
- 切标签时读该 runtime 的 `state` / `stats`，恢复模型与推理档。
- 默认 runtime 的模型/推理档仍写应用设置；后台 runtime 只改自己的进程。
- 审计仍写默认 workspace（P2b6）。

### 修改 3 · P2b6a：会话操作按 runtime

- `new-session` / `switch-session` / `fork` / `clone` 支持 runtimeId；后台 runtime 的会话切换不再误操作默认进程。
- 默认 runtime 仍维护 workspace state / 权限档；后台只更新自己的 session 绑定。
- 会话列表、审计、后台事件结束后的 stats 仍是默认（P2b6b）。

### 修改 3 · P2b6b：审计按 runtime

- 审批、policy 决策、run_code outcome 的审计写入各自 runtime 的 `<workspace>/.omcp/logs/audit.jsonl`。
- `runtime:close` 清掉该 runtime 的审计缓存。
- 会话列表 / 审计查看页 / 后台 stats 仍默认（P2b6c）。

### 修改 3 · P2b6c：会话列表/审计视图/统计按 runtime

- `getSessions` 支持 runtimeId；切标签刷新该 runtime 的会话列表。
- `audit:read` / `audit:query` 读 active runtime 的审计文件。
- `refreshStats` 用 active runtime；后台 `agent_settled` 刷新并缓存各自 stats。
- 审计导出、方案门/grants 仍全局（P3）。

## 0.6.9 — 2026-11-22

### MCP 接入

- 设置页新增「MCP 服务器」：添加/停用/删除/信任/密钥/检查/打开配置。
- 配置写 `<agentDir>/mcp.json`：备份、原子写、读回校验、失败回滚；密钥只写 `${OMCP_MCP_…}` 占位，值进安全存储。
- 状态：未检查 / 检查中 / 已连接 / 失败 / 需要登录 / 已停用；失败带原因。
- OAuth：HTTP 服务器可登录（spawn `pi mcp login`），授权页 URL 兜底，登录后重启 pi。
- 启动 8 秒后异步检查一次连接，不阻塞会话。
- 只读 MCP 工具贯通方案期 / 只读模式；`tools.allow/deny` 支持 `*`；未列出工具按服务器授权。
- 审批弹窗提示服务器级授权范围；工具卡片显示 `server · tool`。
- 修复 `needs-auth` 被误判为已连接。

### 工程

- 新增 `mcp-service.ts`、`McpSettings.tsx`、`approval-hint.ts`；MCP 相关单测 32 条。
- `.dawn/`、`.omcp/` 加入 `.gitignore`（本地会话与方案元数据）。

## 0.6.8 — 2026-11-18

### 对话区排版

- 助手回答占满会话区；用户消息与回答按内容自适应宽度（用户 ≤820px，回答 ≤会话区）。
- 助手回答去气泡（透明背景、无边框、无内边距）；工具组/工具卡片去气泡。
- 删除用户消息的「你」标签。
- π 徽标 24×24 + 17px 加粗 `pi`；用户与回答统一 15px（行高 1.5），h2 17 / h3 16 / h4 15，行内代码 13px。
- 段落/列表/标题更紧凑；消息间距 18 / 22px。

### 语言徽标

- `run_code` 行显示 `Py` / `R` 徽标（工具卡片、组头、笔记本 cell、运行面板）。
- 缺省按 Python；参数截断不显示；bash 不显示。

### 错误提示

- 主行只留结论 + 一句原因；技术原文进「查看原始错误」折叠，地址替换为「（地址已隐藏）」。
- 重试进度不显示原文；系统消息不再拼原文。
- 完整原文仍写 `app.jsonl`。

### 深色浮层

- 设置/权限/审批/路线/技能/模型注册表/用量/内核设置跟随主题，不再写死浅色。
- 新增 `--ok-text / --danger-text / --warn-text`；输入框补文字色。
- 对比度扫描：深色设置 220 / 权限 199 / 路线 32 / 技能 15，0 条低于 4.5:1。

### 工程

- 新增 `ErrorBanner`、`error-view`、`LangBadge`；`AppError.raw`；`toolLanguage()` 与 4 条单测；`error-view` 6 条单测。

## 0.6.7 — 2026-11-18

### 文件区（右坞「文件」页）

- 改为树形折叠：逐级展开 / 收起、缩进 16px/级、根节点显示工作区名。
- 点文件在下方预览，文件树不消失；选中行高亮，预览可关闭。
- 按目录懒加载并缓存；展开状态按工作区持久化（切页签、重启保留，换工作区重置）。
- 键盘导航：↑/↓、Home/End、→/←、Enter/Space。
- 产物面板「在文件中显示」改为逐级展开父目录后选中；空目录/读不到/超 1000 条有提示。

### 顶栏

- 控件栏（请求批准 / 上下文 / 模型 / 推理 / READY）贴会话区左缘。
- 面板按钮真正固定在窗口最右：顶栏横跨主区与右坞、右坞下移 48px；开合两态按钮距窗口右缘均为 16px。

### 工程

- 新增 `FileTree.tsx`；`App.tsx` 删除单层目录状态与面包屑，新增展开/选中与持久化；`index.css` 新增树样式与两行网格。

## 0.6.6 — 2026-11-18

### 顶栏与外观

- 「面板：X」移入独立固定区：控件换行时仍贴主区右缘，不被挤到第二行。
- 顶栏「深色/浅色」按钮移入设置 → 新增「外观」卡（分段控件），切换立即生效并落 `localStorage`。
- 侧栏标题旁徽章由写死的 `P2` 改为构建期注入的 `v0.6.6`（来源 `apps/desktop/package.json`）。

### 推理强度

- 模型按钮右侧新增推理强度下拉 `ThinkingPicker`；档位来自 pi 的 `get_available_thinking_levels`，不硬编码。
- 改档立即生效并写入设置作为默认：新会话沿用，旧会话保留自己的档位记录；不支持推理的模型隐藏按钮。
- 空态区分：pi 未响应（可重试）与模型无可用档位（建议换模型）；空态下不再渲染“点了没反应”的当前档。

### 工程

- 协议新增 `get_available_thinking_levels` 命令、`SessionState.thinkingLevel`、`ThinkingLevel` 校验常量；主进程新增 `pi:thinking-levels` / `pi:set-thinking-level`。
- `supervisor` 仅在无旧会话可恢复时传 `--thinking`，避免覆盖会话记录。
- 验证：`pnpm typecheck` / `pnpm build` / `layoutcheck` / 真机 CDP（推理菜单、切档回读、空态两分支、外观切换）。

## 0.6.5 — 2026-11-18

### 输入与上传

- 输入框左侧新增「＋ 添加内容」：上传文件 / 图片 / 数据。
- 工作区内文件插入 `@` 引用；工作区外复制到 `.omcp/uploads/<日期>/`，原文件保留。
- 文件/数据不设应用层限额；复制前检查磁盘空间，流式进度、可取消；超过 1 GB 二次确认。
- 图片最多 4 张、单张 ≤ 4 MB、总计 ≤ 12 MB（base64 安全上限）。
- 审计写 `.omcp/logs/audit.jsonl`：只记数量、路径、引用/复制方式；不记内容、不记大小。
- 拖拽普通文件走同一落位；图片仍走附件管线。

### 工作区侧栏

- 顶部主按钮「＋ 新建任务」；工作区改为可折叠树，最近工作区显示会话数（只读目录，30 秒缓存）。
- 会话行 `⋯`：重命名 / 置顶 / 归档 / 克隆 / 导出 / 在树中查看 / 删除（移到 `.omcp/trash/sessions`）。
- 「树」从行内菜单打开；已归档独立入口；搜索同时过滤工作区名与会话标题。
- 按确认**不做多选 / 批量归档**。

### 布局

- 删除「收起左栏」，左栏常驻、宽度仍可拖（240–420）。
- 删除「收起右坞」，改为顶栏「面板：X」+ 坞内 `×`/`⋯`；关闭后不保留 40px 图标条。
- `Ctrl+B` 失效；`Ctrl+J` / `Ctrl+Alt+1–4` 保留。

### 工程

- 新增 `upload-service`、`UploadMenu` 与 8 项单测；单测总数 **233**。
- 自检新增 `uploadcheck` / `layoutcheck` / `sidebarcheck`。

## 0.6.4 — 2026-11-17

### 对话响应

- **回合遥测**：`.omcp/logs/perf.jsonl` 记录 accepted / preparing / started / 首 token / 工具 / 回合末，
  只写时间、长度与工具名；`OMCP_PERF_TRACE=0` 可关闭写盘。
- **事件合并**：主进程把 text/thinking 增量按 16 ms 合并后发给界面，非增量事件前强制 flush；
  `OMCP_EVENT_PUMP=0` 可退回逐条转发。
- **统计去重**：回合末 `get_session_stats` 改为单飞 + 250 ms 缓存 + 失效代数，
  footer / 预算 / 上下文仪表共享同一份；发送前的预算门仍强制取权威值。
- **提交状态机**：点击后立即显示“正在发送 / 检查预算 / 准备上下文 / 模型处理中”，
  提交期间锁定发送；失败消息标“未送达”并回填文字与附件；准备阶段提供停止入口。
- **渲染**：Markdown 与工具卡片 memo 化，长回复按 40/60/90 ms 降频；
  工具运行中显示尾部输出（150 ms 节流）。

### 启动期

- **就绪门控**：以首次 RPC 响应作为 pi 就绪，而不是 `spawn` 成功。未就绪时
  `prompt` / `steer` / `follow-up` 立即返回“pi 正在启动，请稍候再发送”，
  启动期读取超时从 30 s 缩短到 3 s；界面禁用发送并显示启动状态。
- 修掉首次启动第一条消息可能先等 30 秒（预算查询超时）的问题。

### 工具

- 笔记本每格执行后的变量查询改为 **300 ms 防抖**；50 格 `execute` 从约 3.3 s 降到 2.3 s。
- 内核预热仍为可选项（`OMCP_KERNEL_PREWARM=python|r`），默认关闭。

### 工程

- 新增 `turn-trace.ts` / `event-pump.ts` 与 10 项单测；自检新增
  `perflong` / `ready` / `kernelbench` 模式。
- 本机实测：稳定状态首 token p50 2.6–3.9 s；回合末统计查询 2 次/回合；
  50 次 execute 2.3 s；长回复流式 0 长任务、平均帧间隔 6.2 ms。

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
