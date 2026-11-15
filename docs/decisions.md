# 架构决策记录（ADR）

> 每条决策写清“背景 / 决定 / 代价 / 状态”。P0 结束时的决策视为 v1 基线，变更需新增条目而不是改写历史。

---

## ADR-001 内核接入方式

- 日期：2026-11-11
- 状态：已采纳
- 背景：需要选择进程内嵌入 pi SDK、RPC 子进程、还是纯 CLI 调用。
- 决定：使用 `pi --mode rpc` 子进程，通过 JSONL 通信；不 fork pi。
- 代价：多一层协议与进程管理；但获得崩溃隔离、pi 可独立升级、UI 技术栈自由。
- 依据：S1 验证通过（流式、工具、abort、20 轮稳定）。

## ADR-002 桌面外壳

- 日期：2026-11-11
- 状态：已采纳
- 决定：Electron + React + TypeScript；Windows 优先，NSIS 按当前用户安装。
- 代价：安装包约 116 MiB；需要处理原生模块与签名。
- 依据：S6 验证通过（构建、安装、运行、卸载）。

## ADR-003 v1 范围

- 日期：2026-11-11
- 状态：已采纳
- 决定：v1 只做“对话 + 笔记本 + 权限”；文献、浏览器、MCP、子 agent、记忆、Office 工具全部延后。
- 依据：`docs/scope.md`。

## ADR-004 执行位置

- 日期：2026-11-11
- 状态：已采纳
- 决定：v1 宿主机直跑（L1），但抽象 `ExecutionBackend`，为 WSL2/Docker 留口。
- 代价：权限只防手滑，不构成安全边界；界面必须明示。
- 依据：P0 风险评估；容器化留到 v1.1。

## ADR-005 内核 sidecar

- 日期：2026-11-11
- 状态：已采纳
- 决定：用 Python `jupyter_client` 写行分隔 JSON sidecar，托管 ipykernel/IRkernel；Node 只做协议代理。
- 代价：多一个 Python 进程；换来 R 内核与中断/重启的原生能力。
- 依据：S5 验证通过；重启必须 `newports=True`，内联后端用 `MPLBACKEND`。

## ADR-006 审批授权粒度

- 日期：2026-11-11
- 状态：已采纳
- 决定：授权按规则 id（如 `rm-rf`）记录，不按完整命令；持久授权存应用数据目录，按工作区绑定，可撤销、可过期。
- 代价：用户选“总是允许”时作用域是“这类命令”，文案必须写清。
- 依据：S3 发现模型会给命令加后缀，按字面量授权会反复弹窗；工作区 grant 文件可被仓库预置，存在绕过风险。

## ADR-007 审批 UI 状态

- 日期：2026-11-11
- 状态：已采纳
- 决定：`tool_execution_start` 到达时显示“待审批”，审批通过后才显示“执行中”。
- 依据：S3 事件顺序为 `tool_execution_start → extension_ui_request → tool_execution_end`。

## ADR-008 审批请求的结构化标题

- 日期：2026-11-11
- 状态：已采纳
- 决定：扩展调用 `ctx.ui.select` 时，标题使用 `omcp-approval:` + JSON（`ApprovalTitlePayload`）。
- 代价：标题不再是纯人类可读文本；UI 负责格式化展示。
- 依据：`select` 只有 title/options，无法携带 toolName/ruleId/summary；避免新增私有 RPC 通道。

## ADR-009 会话列表来源

- 日期：2026-11-11
- 状态：已采纳
- 决定：主进程扫描 `sessionsDir/*.jsonl`，读首行 header 生成 `SessionSummary[]`；不新增 RPC 命令。
- 代价：需要处理坏文件与并发写入；换来零额外协议。
- 依据：RPC 没有“列会话”命令；`SessionManager.list` 只在扩展内可用。

## ADR-010 图片落盘职责

- 日期：2026-11-11
- 状态：已采纳
- 决定：`run_code` 扩展只回传 image block；主进程在 `tool_execution_end` 时保存到 `figures/`。
- 代价：主进程需要解析工具结果；换来扩展与文件系统解耦。
- 依据：S2/S5 图片链路已验证。

## ADR-011 卸载保留用户数据

- 日期：2026-11-11
- 状态：已采纳
- 决定：NSIS `deleteAppDataOnUninstall: false`；卸载保留 `%APPDATA%/oh-my-coding-pi-*`。
- 代价：磁盘残留；换来科研会话/设置不误删。文档需提供清理入口。

## ADR-012 契约冻结与变更

- 日期：2026-11-11
- 状态：已采纳
- 决定：`protocol.ts` 只允许新增可选字段/联合分支；修改已有语义必须新增 ADR 并同步 `scope.md`。
- 依据：P1 起 UI/主进程/扩展并行开发，需要稳定接口。

## ADR-013 P0 Go/No-Go 结论

- 日期：2026-11-11
- 状态：已采纳
- 背景：S0–S8 完成，需要决定是否进入 P1。
- 决定：**GO**。6 项门槛全部通过；两项带非阻塞跟进（远程 CI、预算执行）。
- 代价：P1 第 1 周需补远程 CI 与预算上限。
- 依据：`docs/go-no-go.md`、各 spike 的 `RESULT.md`。

## ADR-014 成本预算策略

- 日期：2026-11-11
- 状态：已采纳（P1 实现）
- 决定：单次 run_code 120s；单会话 $1；单日 $5；80% 提醒；超限拒绝新请求。
- 代价：极端长任务可能被截断；用户可手动调高上限。
- 依据：S1/S2/S3/S5 成本记录；deepseek-v4.1-flash 缓存后单轮约 $0.000023。

## ADR-015 P1 会话目录位置

- 日期：2026-11-11
- 状态：已采纳（P2 迁移）
- 决定：P1 会话存 `%APPDATA%/oh-my-coding-pi/sessions`，不写入工作区。
- 代价：换机器/换工作区不会自动带会话；P2 工作区化后迁到 `<workspace>/.omcp/sessions`。
- 依据：P1 尚未实现工作区选择；先保证会话可用。

## ADR-016 P1 无权限门

- 日期：2026-11-11
- 状态：已采纳（P3 接入）
- 决定：P1 不实现审批/策略/沙箱，界面与文档明确“本机直跑，未沙箱化”。
- 代价：不能处理敏感数据；只能用于个人可信环境。
- 依据：`docs/permissions.md`；P3 按 `policy.schema.json` 接入。

## ADR-017 预算账本按会话增量

- 日期：2026-11-11
- 状态：已采纳
- 决定：`state.json` 的 `sessionCosts` 记录每个会话最近成本；每轮按增量累加到 `dailySpent`，切换/恢复不重复计数。
- 代价：旧会话首次切换时以当前成本为基线，不追溯历史。
- 依据：P1.3 首轮“今日 $0”问题；S1/S5 成本数据。

## ADR-018 renderer 独立目录

- 日期：2026-11-11
- 状态：已采纳
- 决定：renderer 放 `apps/renderer`，electron-vite 配置 `renderer.root` 与 `build.rollupOptions.input`。
- 代价：多一处配置；换来 UI 与 desktop 解耦。
- 依据：P1.0 构建报错“index.html not found in /src/renderer”。

## ADR-019 P1 验收结论

- 日期：2026-11-11
- 状态：已采纳
- 决定：P1 通过（带保留项），进入 P2。
- 保留项：AP2 未区分 abort/硬重启；auto_retry 未故障注入；模型切换未实跑；安装包未签名。
- 依据：`docs/p1-acceptance.md`。

## ADR-020 策略引擎放在 shared

- 日期：2026-11-11
- 状态：已采纳（P3 实现）
- 背景：策略判定需要被主进程、测试、未来的设置预览共用。
- 决定：`packages/shared/src/policy.ts` 提供纯函数（加载校验、glob、规则匹配），无 Node 依赖；主进程只负责读文件、HTTP 端点与审计。
- 代价：shared 变成运行时依赖，electron-vite 必须把它打进主进程包（`externalizeDepsPlugin({ exclude })`）。
- 依据：P3.0 实现与 28 条单测。

## ADR-021 危险命令分「审批」与「硬拒绝」两档

- 日期：2026-11-11
- 状态：已采纳
- 背景：A3 要求 `rm -rf ./data` 弹出四选项并由用户拒绝；如果硬拒绝，用户没有“我确实要删”的出口。
- 决定：`rm -rf`/`Remove-Item`/`rd /s` 等删除类进 `commands.ask`；`sudo`、`curl|bash`、清盘（`rm -rf /`、`~`）、`format`、关机 进 `commands.deny`。
- 代价：ask 规则依赖用户判断，误点“总是允许”会放大风险（有授权页可撤销）。
- 依据：`docs/scope.md` 的 A3；`scripts/policy-drill.mjs` 的 23 条演练。

## ADR-022 授权键与存储

- 日期：2026-11-11
- 状态：已采纳（承接 ADR-006）
- 决定：`once` 不记录；`session` 存内存（会话/工作区切换即清）；`always` 写 `%APPDATA%/oh-my-coding-pi/grants.json`，键为 `sha256(规范化工作区路径) + ruleId`，固定 30 天。授权不读工作区文件。
- 代价：规则 id 基于 index，策略文件增删规则会让旧授权失配（需要重新授权）。
- 依据：`docs/p3-acceptance.md` 的 P3_SELFTEST_GRANT。

## ADR-023 审计落位与脱敏

- 日期：2026-11-11
- 状态：已采纳
- 决定：`<ws>/.omcp/logs/audit.jsonl`，一行一条，10MB×3 轮转；摘要截断 200 字；写前脱敏（Bearer、sk-/pk-、key= 赋值、主目录路径）。写失败不阻断主流程。
- 代价：工作区可被删除，审计不是防篡改证据；工作区被删则审计同时消失。
- 依据：`docs/permissions.md` 第 5 节。

## ADR-024 只读模式口径

- 日期：2026-11-11
- 状态：已采纳
- 决定：`readonly` 只放行 `read/grep/find/ls/glob`；`run_code` 直接拒绝，不做代码静态分析；界面常驻横幅。
- 代价：只读下无法用内核做纯计算；笔记本 cell 不受限（见 known-limits）。
- 依据：P3_SELFTEST_READONLY（`{"mode":"readonly","runCode":"deny","read":"allow","banner":true}`）。

## ADR-025 fail-closed 与部分策略

- 日期：2026-11-11
- 状态：已采纳
- 决定：策略文件**可以只写要改的字段**，缺的回落默认值；只有“写了但写错”（非法 JSON、非法正则、非法 mode/类型）才整份作废并切 `mode:"deny"`，同时界面报错。策略服务不可用或扩展调用失败，一律阻止工具调用。
- 代价：一个正则写错就会锁死所有工具，需要用户改文件；这是刻意的安全方向。
- 依据：P3.0 实现；`validatePolicy` 单测。

## ADR-026 脚本内容启发式检查

- 日期：2026-11-12
- 状态：已采纳（P4.0）
- 背景：`bash scripts/clean.sh` 这类命令的删除逻辑在文件里，命令正则看不见（P3 演练的唯一漏判）。
- 决定：命令匹配 `bash/sh/python/node/Rscript + 脚本路径` 时，读脚本前 4KB 检查删除/子进程模式；命中则 ask（`script:danger`）；读不到则 ask（`script:unreadable`）。脚本必须位于工作区内才检查。
- 代价：只读前 4KB、只认固定模式；文案必须写明“启发式，不构成安全保证”（风险 r8）。
- 依据：`packages/shared/src/policy.ts` 的 `inspectScriptHead`；单测 2 条；`P3_SELFTEST_P40` 实测 `ask / script:danger`。

## ADR-027 授权期限可配与超时清理

- 日期：2026-11-12
- 状态：已采纳（P4.0）
- 决定：`always` 授权期限由 `settings.json` 的 `grantTtlDays` 控制（7/30/90/0=永久，默认 30）；权限页提供下拉与“清理过期”；过期在读取时过滤，不做后台定时。
- 代价：用户改期限只影响之后的授权，不改已有条目的 expiresAt。
- 依据：`scripts/p40-checks.mjs` 的永久/7 天/撤销/过期用例。

## ADR-028 只读模式与笔记本

- 日期：2026-11-12
- 状态：已采纳（P4.0，落实 d6）
- 决定：`mode=readonly` 时笔记本 cell 默认拒绝执行（返回 false + 错误横幅）；设置项 `readonlyNotebook` 可放开。
- 代价：只读下纯计算也要先改设置；但默认方向与 run_code 一致，避免“只读还能跑内核写文件”的口径分裂。
- 依据：`P3_SELFTEST_READONLY_NOTEBOOK {"blocked":true,"allowed":true}`。

## ADR-029 卸载残留处理

- 日期：2026-11-12
- 状态：已采纳（P4.0）
- 背景：P3 卸载后 `resources/app.asar` 残留；实测占用者不是残留卸载器，而是**另一个正在索引工作区的程序**（本机是 DAWN Science）。
- 决定：`nsis.include` 加 `customUnInstall`：卸载前 taskkill 本应用 → 重试删除 app.asar 两次 → 仍残留则写 `%TEMP%\oh-my-coding-pi-cleanup.cmd` 并登记 HKCU RunOnce，下次登录清理；清理脚本自带守卫（目录里有 `Uninstall oh my coding pi.exe` 说明重装过，则不删）。`customInstall` 删掉 RunOnce，避免误删新装目录。
- 代价：极端情况下残留要到下次登录才清；RunOnce 需要用户登录一次。
- 依据：锁定 asar 的三场景实测（占用时登记、解除后清理、正常卸载无残留）。

## ADR-030 构建安装包的 Electron 解包绕行

- 日期：2026-11-12
- 状态：已采纳（P4.1）
- 背景：本机 electron-builder 26.18.0 在 `unpack()` 阶段调用 `extractArchive`，会对 `${appOutDir}.tmp`
  用 proper-lockfile 加锁并最多重试 100 次（每次 1–5s）；本机多次复现“停在 downloaded 100%”。
- 决定：`scripts/build-installer.ps1` 先手工把 `electron-v<ver>-win32-x64.zip` 解到
  `D:/build-output/electron-dist`，再用 `-c.electronDist=<dir>` 让 builder 走 `copyDir` 分支（无锁、无解压）。
- 代价：多一步解包与一个缓存目录；`resources/default_app.asar` 会保留（约 80KB）。
- 依据：`release4/release5` 卡死与绕过后成功构建的对比。

## ADR-031 瘦身边界与体积结论

- 日期：2026-11-12
- 状态：已采纳
- 决定：只裁 locale（保留 zh-CN、en-US）+ `compression: maximum`；不动 dxcompiler / swiftshader / ffmpeg 等 GPU 与媒体运行时。
- 结果：121.3 MB → **112.8 MB（-8.5 MB，-7.0%）**；**未达到计划里的 ≤90 MB**。
- 原因：Electron 45 的压缩下限约 105 MB（`oh my coding pi.exe` 未压缩 238 MB，dxcompiler 25 MB、
  resources.pak 13 MB、icudtl 11 MB 均为运行必需）；再往下只能裁 GPU 组件，风险大于收益。
- 依据：`win-unpacked` 体积构成（见 P4.1 报告第 3 节）。

## ADR-032 签名方案落在自签名

- 日期：2026-11-12
- 状态：已采纳
- 决定：`scripts/sign.ps1` 用 `New-SelfSignedCertificate -Type CodeSigningCert` 建 3 年证书，
  `Set-AuthenticodeSignature` 签名（带时间戳，失败则退化）；`-TrustLocal` 可把证书装进当前用户受信任根（默认不做）。
- 结果：签名者显示 `CN=oh-my-coding-pi self-signed`；未装信任时 `Status=UnknownError`（预期）。
- 代价：SmartScreen 仍提示“未知发布者”；要消掉必须买 OV/EV 证书。
- 依据：`Get-AuthenticodeSignature` 实测（UnknownError / TrustLocal 后 Valid）。

## ADR-033 更新检查只做“告知”，不做自动安装

- 日期：2026-11-12
- 状态：已采纳（P4.2，落实 d2）
- 决定：设置页「检查更新」读 GitHub Release latest，比较版本，展示发布页与 SHA256 资产；不下载、不静默安装。
- 代价：用户要自己去发布页下载并核对校验和；无 token 时受 GitHub 60 次/小时限流。
- 依据：`apps/desktop/src/main/updater.ts`；`P3_SELFTEST_P42` 实测对 `electron/electron` 取到 `latest=45.3.1`。

## ADR-034 诊断包格式与脱敏

- 日期：2026-11-12
- 状态：已采纳
- 决定：诊断包为 ZIP（store 模式，自带最小实现，不引第三方依赖），含 `diagnostic.md`、`settings.json`、
  `policy.json`、`audit-tail.jsonl`（最近 100 条）、`app-log-tail.txt`（末 200 行）、`manifest.json`。
  所有文本过脱敏：Bearer、`sk-/pk-`、`key=/token=` 赋值、用户主目录路径；设置里键名含
  token/secret/password/apikey 的直接置 `[redacted]`。
- 代价：store 模式不压缩，包体略大（几十 KB 级）；清单里带每个文件的 SHA256。
- 依据：`scripts/p42-checks.mjs` 用系统解压验证 12 项（含 4 项脱敏断言）。

## ADR-035 pi 的工作目录固定为工作区

- 日期：2026-11-13
- 状态：已采纳（P5.0）
- 背景：`supervisor` 启动 pi 时没有传 `cwd`，pi 继承 Electron 的目录。实测会话头写着
  `"cwd":"...\apps\desktop"`，而不是工作区——相对路径、`AGENTS.md`、`.agents/skills` 全部错位。
- 决定：`PiSupervisor.setCwd(workspaceRoot)`，spawn 时显式传 `cwd`；切换工作区时先 `stop()` 再
  `setCwd()` 再 `start()`；启动日志打印 `[pi] spawn cwd=...` 便于核对。
- 代价：切换工作区会重启 pi（约 1 秒），进行中的回合中断。
- 依据：`P3_SELFTEST_P50` 实测：`sessionCwd = workspace`、`cwdCorrect = true`、`agentsLoaded = true`。

## ADR-036 项目级资源默认不信任

- 日期：2026-11-13
- 状态：已采纳（P5.0，落实 P5 v2 的 D1）
- 背景：pi 在 RPC 模式下不弹信任框，行为取决于全局 `defaultProjectTrust`；若用户全局设成
  `always`，打开任何仓库都会加载项目里的 `.pi` 设置、项目扩展与 `.agents/skills`——这是指令注入面。
- 决定：应用显式传 `--no-approve`（默认），只有设置页勾选“信任本项目”后才传 `--approve`。
  开关按应用级保存（`settings.json` 的 `trustProject`），切换后重启 pi 生效。
- 代价：默认状态下项目技能/项目设置不生效，用户需显式授权；每次切换工作区沿用同一开关。
- 依据：`P3_SELFTEST_P50` 的 `trustToggle`：`{on:true, setting:true, off:false}`；spawn 日志同步打印
  `trustProject=true/false`。

## ADR-037 技能复用 pi 原生加载，不另造一套

- 日期：2026-11-13
- 状态：已采纳（P5.1）
- 背景：pi 已实现 Agent Skills 标准：`.agents/skills/<name>/SKILL.md`，启动时注入
  「name + description + 路径」，并暴露 `use_skill`。自己再写一套索引注入会与 pi 的机制打架。
- 决定：
  1. 技能目录用 pi 的标准路径；加载与否由我们的 `trustProject` 开关控制（ADR-036）。
  2. 启停靠重命名 `SKILL.md` ↔ `SKILL.md.disabled`，不删文件、不改 pi。
  3. 索引注入交给 pi；我们只做管理界面、审计标注与边界声明。
  4. **不做在线安装与来源校验**——没有 `.dawn-source.json` 那套供应链机制，就不该开那个口子。
- 代价：技能过多时描述会全部进上下文（pi 决定），我们只能提示“技能数偏多”。
- 依据：`P3_SELFTEST_P51`：`skillInIndex=true, modelReadSkill=true, csv=true, skillAudit=true`；
  实测 pi CLI `--approve` 会注入 name+description+path。

## ADR-038 视觉转述：独立端点 + 安全存储 + broker 拦截

- 日期：2026-11-13
- 状态：已采纳（P5.2）
- 背景：模型是否支持图片由 pi 的 `ModelInfo.input` 决定；一旦选了纯文本模型，粘贴图片与
  `run_code` 回传的图都会变成无法处理的 content block。
- 决定：
  1. 视觉服务**独立配置**（baseUrl / model / key），不复用 pi 的 provider 与凭据；默认关闭。
  2. key 用 `safeStorage` 加密存 `secrets.json`；系统不支持加密时拒绝保存（不写明文）。
  3. 模型支持图片 → 原样发送；不支持 → 先转述成文字再发送，失败要明说，不静默丢图。
  4. `run_code` 的图在 **kernel broker** 层拦截：纯文本模型下把 `display image/png`
     换成 `[图片转述] …` 文本，避免 image block 进入上下文。
- 代价：转述有延迟与成本；图片会发往第三方端点，必须在界面与文档里明示。
- 依据：`P3_SELFTEST_P52`（本地 mock 端点）：`describeOk / transcribedHasMarker /
  brokerTextOnlyPath / restored` 全部 true。

## ADR-039 路线记录与方案期门分开做

- 日期：2026-11-13
- 状态：已采纳（P5.3，落实 P5 v2 的 D6/D7）
- 背景：对比 DAWN 后发现它的 plan-mode 比“路线表”更强——把“先出方案”变成执行约束。
  但完整实现（sha256 指纹 + 每轮核对 + 恢复）成本高。
- 决定：
  1. 路线是**人写的记录**（`.omcp/route.json`，8 字段，evidence 三档，不做自动推断）。
  2. 方案期门是**执行约束**：未批准时只放 read/grep/find/ls/glob；bash/powershell 整件拒。
  3. 批准绑定 `.omcp/plans/` 下的文件；切会话/切工作区回到未批准。
  4. 本轮**不做**指纹存档与每轮核对（留 v3）。
- 代价：批准后方案被改动不会被发现；用户需自觉。
- 依据：`P3_SELFTEST_P53`：`blockedWrite=deny/plan:readonly`、`blockedBash=deny`、
  `badApprove=false`、`goodApprove=true`、`writeAfterApprove=allow`。
- **修订（2026-11-15，P1-01）**：第 4 条作废。已实现 sha256 内容绑定 + 每次非只读操作前复核：
  批准时记录计划文件摘要，文件被修改/删除/读不出来即撤销批准并 deny（`plan:drift`）。
  仍**不做**“被改后恢复成批准时的版本”（需备份与写回，未在范围内）。
  依据：`apps/desktop/src/main/plan-approval.ts`、`policy-service.decide` 的 `revalidatePlan` 分支、
  `apps/desktop/test/plan-approval.test.ts`（9 条）。

## ADR-040 内置 pi 的依赖策略

- 日期：2026-11-14
- 状态：已采纳（P6.0）
- 背景：准备把 pi 打进安装包。需要先钉死“内置哪个版本、从哪来、许可怎么处理”。
- 决定：
  1. **版本锁 1.5.2**（spike 已验证 RPC/扩展/审批/技能/方案门/笔记本全通过）；版本号写在根
     `package.json` 的 `piVersion`，脚本与文档都以它为准。
  2. **vendor/pi 不入库**（`.gitignore`），由 `node scripts/fetch-pi.mjs` 安装；
     已安装且版本一致时跳过，`--force` 强制重装。
  3. **许可用脚本扫描**：`node scripts/license-scan.mjs --write` 生成 `vendor/pi/NOTICE.generated.md`；
     缺失许可时退出码非 0。
  4. 安装时使用 `--omit=dev --prefer-offline`；不启用 npm 的第三方 install 脚本（当前 npm 配置已拦截）。
- 结果：122 个依赖包，许可分布 MIT 60 / Apache-2.0 37 / BSD 14 / ISC 6 / BlueOak 4 / Unlicense 1；
  **无 GPL/AGPL/LGPL**，无缺失许可。
- 代价：仓库外多一个 110 MB 的 vendor 目录；CI 首次构建要下载。

## ADR-041 内置 pi 的运行时行为

- 日期：2026-11-14
- 状态：已采纳（P6.1）
- 背景：内置 pi 后，需要明确“用哪个、怎么算坏了、版本不对怎么办、配置放哪”。
- 决定：
  1. **解析顺序**：`OMCP_PI_PATH` → 安装包 `resources/pi` → 开发态 `vendor/pi` → PATH。
     但一旦指定了来源却不可用，**直接报错，不静默回落 PATH**（ADR 明确：不存在的能力不该看起来存在）。
  2. **版本护栏**：启动后异步跑一次 `--version`，与 `.pi-version`（由 fetch 脚本写入）比对；
     不一致时报告警告并写日志，不阻塞使用。
  3. **配置目录**：默认共享 `~/.pi/agent`（保留登录）；设置项 `piConfigDir` 非空时传
     `PI_CODING_AGENT_DIR`，切换后重启 pi，需要重新登录。
  4. **诊断**：诊断包同时记录内置 pi 的来源/版本/入口/配置目录，以及系统 `where pi` 的版本。
- 代价：版本护栏是“警告”而不是“硬拦”，因为 1.5.x 的兼容性已验证、硬拦会把小版本差异变成不可用。
- 依据：p50（bundled 启动）、piinfo（假版本 9.9.9 被识别）、piiso（隔离目录开关）、p42（诊断包含 pi 段）。

## ADR-042 内置 pi 的打包布局与裁剪

- 日期：2026-11-14
- 状态：已采纳（P6.2）
- 背景：把 vendor/pi 放进 extraResources 时，electron-builder 会**硬编码排除源根的 `node_modules`**
  （`filter.js`：`relative === "node_modules"` 直接返回 false），导致只拷了 4 个顶层文件。
- 决定：
  1. 打包布局改为 `resources/pi/payload/node_modules/...`——`payload/` 这一层让 node_modules 不再是源根，
     从而绕过排除规则；解析器同时兼容 `resources/pi/node_modules`（旧布局）与 dev 的 `vendor/pi`。
  2. 打包前跑 `scripts/prepare-pi-bundle.mjs` 裁剪：只在**包根**删 `docs/doc/examples/test/tests`，
     任意位置删 `*.map` 与非许可类 `*.md`。**不在 dist 内部按目录名删**（踩过：`yaml/dist/doc/directives.js`
     是运行期代码，删了直接崩）。
  3. 安装路径长度 > 200 字符时安装器拒绝（静默安装退出码 2）。
- 结果：110 MB → 72.7 MB（跳过 37.2 MB）；安装包 129,857,843 字节；安装后 406 MB；
  安装耗时 68.9 s（目标 60 s，略超）。
- 代价：安装比之前慢（1.1 万个小文件）；构建多约 4 分钟压缩时间。

## ADR-043 内置 pi 的许可结论

- 日期：2026-11-14
- 状态：已采纳（P6.3）
- 背景：内置 pi 会把 122 个依赖一起分发，必须给出可交付的许可说明。
- 结论：
  - 许可分布：MIT 60、Apache-2.0 37、BSD 14、ISC 6、BlueOak-1.0.0 4、Unlicense 1。
  - **无 GPL / AGPL / LGPL**（按原文正则复查，避免 “MIT OR GPL” 被分类掩盖）。
  - 122 个包里 108 个自带 LICENSE/COPYING 文本；**14 个只有 package.json 的 license 字段**
    （含 pi 自身的 npm 包）。
- 决定：
  1. `scripts/license-scan.mjs --write` 生成两份交付文件：
     `build/NOTICE.pi.md`（包/版本/许可表）与 `build/LICENSES.pi.md`（按文本去重的许可全文，
     并列出 14 个无文本的包）。
  2. 两者进安装包：`resources/NOTICE-pi.md`、`resources/LICENSES-pi.md`。
  3. 构建安装包时自动重跑扫描，扫描发现缺失字段或 copyleft 时构建失败。
- 代价：14 个包无法逐字复现版权人；已在 `LICENSES.pi.md` 中单列，属于可接受的残留风险
  （如需对外发布，建议逐个补作者信息）。
- 依据：`scripts/license-scan.mjs` 输出；`node scripts/license-scan.mjs --write` 退出码 0。

## ADR-044 插件分期开放，先框架 + 记忆，过门再扩

- 日期：2026-11-14
- 状态：已采纳（0.5.4 方案期）
- 背景：`scope.md` §4 原本明确排除浏览器自动化、记忆系统、Office/PDF。实施方案的“修改 3”
  要做 3 插件 / 12 族 / 32 工具（19 天），属越界功能；按 §1 变更规则，范围变更必须先落在
  `scope.md` 与本文，否则不进入迭代。
- 核实（决定前的两个事实）：
  1. 内置 pi 1.5.2 **不含**同名工具：在 `vendor/pi` 搜 `memory_propose` / `skill_propose` /
     `xlsx_read` / `browser_open` 均无命中；pi 自带工具只有 read/write/edit/bash/grep/find/ls/glob 等。
  2. oh my coding pi 主进程**未接入任何 MCP server**（`apps/desktop/src/main` 搜 `mcp` 无命中）。
     故方案里“与 MCP 同名工具二选一”的风险当前不成立，只保留让位规则（将来接 MCP 时由我们让位）。
- 决定：
  1. 范围扩为二期，但**只先做 P1+P2（框架 + 记忆，3 工具）**，其余留门。
  2. Office（14 工具）与浏览器（15 工具）不排期，等 P1+P2 决策门结论；不通过就不做（省 15 天）。
  3. 插件一律**默认关闭**：整包与分族开关的初始值都是“关”，不让越界能力靠默认值稀释。
  4. 决策门判据：开关能真的关掉工具（新会话工具列表里消失）、记忆 3 工具可写可读、
     记忆被实际使用（暂以“采纳后的记忆能进系统提示”为可用性判据）。
- 代价：v1.0 的范围冻结被打破；`scope.md` 要维护一张分期表；决策门前记忆是“半成品”。
- 依据：`docs/scope.md` §4.1；实施方案“修改 3”的风险表与分步表。

## ADR-045 插件装配：注册即启用，开关走重启代际

- 日期：2026-11-14
- 状态：已采纳（0.5.4，P1）
- 背景：族开关要求“改动对下一段新会话生效，不影响正在进行的会话”。
  pi 的扩展在**进程启动时**加载（`--extension`），而 oh my coding pi 是**一个 pi 进程服务多个会话**
  （supervisor 单进程 + `--session` 切换），所以不能靠“新会话自动重读设置”来切换。
- pi 的能力（`vendor/pi/.../docs/extensions.md`）：`registerTool()` 可在加载时或 `session_start`
  里调用，新工具立即刷新；`setActiveTools()` 可运行期增删。
- 决定：
  1. **插件册单一来源**：`packages/plugin-ext/src/registry.ts`，纯数据 + 纯函数、零 import。
     主进程构建期内联它（打包后不依赖运行期路径），扩展侧用相对路径导入同一个文件——不做两份定义。
  2. **开关经环境变量下发**：主进程按 `settings.plugins` 算出启用的族键，写进 `OMCP_PLUGINS`；
     扩展在工厂函数里读一次，**只注册开启的族**。
  3. **不注册优于注册后禁用**：工具描述、`promptSnippet`、`promptGuidelines` 都会进系统提示，
     注册了就算关掉也占上下文。
  4. 改开关 → 落 `settings.json` → 重启 pi（与 `trustProject` / `piConfigDir` 同一代际做法）；
     正在跑的会话被打断，恢复后沿用旧会话内容，新工具集在下一段运行生效。
  5. 工具名保持方案表格里的逐字写法（`memory_propose` / `memory_list` / `skill_propose`），不改名。
- 代价：改一次开关要重启 pi（丢当前流式输出）；族越多，重启成本越明显。
- 依据：`docs/extensions.md` 的 `pi.registerTool` / `pi.setActiveTools` 段；supervisor 单进程模型。

## ADR-046 插件工具的审批、落盘与记忆位置

- 日期：2026-11-14
- 状态：已采纳（0.5.4，P1/P2）
- 背景：`permission-ext` 在 `tool_call` 钩子上对**所有**工具问策略服务，而策略引擎对不在
  `tools.allow` 里的工具默认 `ask`（`packages/shared/src/policy.ts`）。插件工具若全走 ask，
  弹窗会淹没用户；全进白名单又会绕过“路径不出工作区”。
- 决定：
  1. **写类工具一律 ask**：`skill_propose` 会写工作区技能目录，保持审批，不进白名单。
     只读类（`memory_list`）可进白名单；`memory_propose` 写的是应用数据目录、不碰工作区，
     按 ask 处理（用户能看到模型在尝试记住什么，这正是要审的东西）。
  2. **记忆不落工作区**：`<userData>/memory/pending.jsonl`（待确认）与 `approved.jsonl`（已采纳）。
     不落工作区是为了不随 git 泄漏、不被 `AGENTS.md` 的权力面污染；也不被任何项目设置改写。
  3. **技能提议复用既有技能体系**（ADR-037）：提案先入 pending 队列，用户采纳后才写
     `.agents/skills/<name>/SKILL.md`，不另造一套技能加载。
  4. **记忆注入**：已采纳条目在 `before_agent_start` 里以独立 system 段注入，
     不追加历史消息（避免污染会话记录、也避免每轮重复计费）。
- 代价：写类工具多一层弹窗；记忆要用户手动采纳才生效（自动化程度低，但可控）。
- 依据：`policy.ts` 的 `tools.allow` 越界即 ask；`docs/extensions.md` 的 `before_agent_start`
  与 `systemPromptOptions.sections`。

## ADR-047 Office / 浏览器插件的实现位置与打包方式

- 日期：2026-11-14
- 状态：已采纳（0.6.0 起）
- 背景：过门后决定 Office 与浏览器都做。两个问题必须先定：工具跑在哪、依赖怎么进安装包。
  1. pi 扩展跑在 pi 的 Node 进程里；Office 库（exceljs / pdf-lib / docx / pptxgenjs）与浏览器库
     都会把体积带进来。
  2. pnpm 的 `node_modules` 是软链，electron-builder 拷 `extraResources` 会带出断裂的软链。
- 决定：
  1. **工具实现在扩展进程内**，不另起 sidecar、也不加 HTTP broker：pi 已是 Node，
     `permission-ext` 已经在 `tool_call` 上做了审批与审计，再加一层进程只增延迟。
  2. 工作区根取 `process.cwd()`（ADR-035：pi 的工作目录就是工作区），所有路径经
     `resolveInside()` 守卫，越界直接抛错。
  3. **打包用 esbuild 打单文件**：`packages/plugin-ext/dist/index.mjs`（约 6.6 MB），
     `extraResources` 只拷 `dist`；pnpm 软链不进安装包。构建顺序写进 `apps/desktop` 的 `dist` 脚本：
     先 `bundle`，再 `electron-vite build`，最后 `electron-builder`。
  4. `playwright-core` 标为 external：它运行时按自己的目录结构找浏览器注册文件，打包后路径会错。
     浏览器这批落地时单独安排（随包放它的运行目录，或改走 CDP 连系统 Edge/Chrome）；
     在落地前，浏览器 15 个工具在插件册里 `ready: false`。
  5. **未实现的工具标 `ready: false`**：设置页显示「未实现」，扩展不注册它们——
     避免“开关打开了但工具是空的”。
  6. **PDF 中文字体**：Deng.ttf → SimsunExtG.ttf → Arial 依次探测；找不到中文字体时
     退到 Helvetica，并在返回文本里明说用了哪个字体（不许静默出豆腐块）。
- 代价：安装包多约 6.6 MB（bundle）+ 依赖源码不单独存在（调试要看 bundle 时得重新 build）；
  `pdf_read` 在 pdfjs legacy 下会打印一条 `Warning: TT: undefined function: 3`（无害，不影响取文）。
- 依据：`loadExtensions` 加载 bundle 实测返回 15 个工具、`errors: []`；
  Office 12 工具功能测试（xlsx 读/写/改、docx 读/写、pptx 读/写/改、pdf 生成/读/合并/拆分、
  工作区越界拒绝）全部通过。

## ADR-048 xlsx 公式：自研最小引擎，边界写在返回里

- 日期：2026-11-14
- 状态：已采纳（0.6.0）
- 背景：`xlsx_recalc` 需要把工作簿里的公式算一遍并报出错误值。首选是成熟引擎，
  但 `hyperformula` 在 pi 的 jiti 加载下会因 CJS 循环引用直接崩（`_Cell.ErrorType` 未定义；
  同一个包用裸 Node `require` 正常）。一个“加载即崩”的依赖不能进扩展。
- 决定：
  1. 自己写最小求值器（`office/xlsx-formula.ts`）：四则/乘方/百分号/比较、区域与跨表引用、
     递归求值带循环检测；函数覆盖 SUM/AVERAGE/COUNT/COUNTA/MIN/MAX/PRODUCT/ABS/ROUND*/
     INT/MOD/POWER/SQRT/IF/IFERROR/AND/OR/NOT/文本函数与 IS* 系列。
  2. **不支持的东西明说**：查找引用（VLOOKUP/XLOOKUP/INDEX/MATCH）、日期与数组函数、
     动态数组一律返回 `#NAME?` 并进 `warnings`，不猜、不静默算错。
  3. `xlsx_recalc` 只读：算完报错误位置（`数据!B4 = B2/B3`），**不回写文件**；
     错误会沿依赖传播（B4 出错 → D4 也报错）。
  4. `xlsx_audit` 只做静态结构检查（字面量除零、自引用、`SUM(IF(...))` 陷阱、
     聚合区域漏行、同列公式不一致、公式列里夹常量），全部标为“启发式怀疑项”。
- 代价：与 Excel 的语义仍有差距（日期序列、隐式类型转换、易变函数）；误报需要人工看。
- 依据：`修改3-xlsx-checks-测试日志.txt`（13 项：运行时除零 / 字面量除零 / 循环引用 /
  未知函数 / 错误传播 / 六类审计 / 干净文件不误报）。

## ADR-049 三档权限：自动拦截 / 请求批准 / 完全访问

- 日期：2026-11-15
- 状态：已采纳（未发版）
- 背景：0.5.x 的权限只有一个藏在策略文件里的 `mode`，界面上只读显示；用户没法按场景切换，
  「自动拦截」这种“不问、直接拒”的档也不存在。参考 DAWN-Science 的三档（`deny-risky` /
  `ask-risky` / `allow-all`）后落地。
- 决定：
  1. **档位与判据分开**：`assessRisk()` 是纯函数（回答“踩到了什么”），`decideByMode()` 回答
     “放行 / 问 / 拒”。加档只改后者，不改判据。
  2. **三种风险处置**：`deny-risky` 直接拒并把理由回给模型；`ask-risky` 弹既有四选项；
     `allow-all` 只拦硬拒清单。旧档（`ask` / `allow` / `deny` / `readonly`）保持原行为，
     硬拒对它们同样生效。
  3. **「不可问」**：删除目标含通配符/变量/管道/多目标时，任何档都拒——人在卡上也判不了会删什么。
  4. **硬拒清单**：提权（sudo/su）、强推、凭据形状+出网、动系统盘、
     从根/主目录 `find -delete`、受保护路径（系统目录、家目录顶层点文件、凭据目录）的写入与删除。
  5. **档位现取**：`policy-service` 每次判定读当前档（会话覆盖 > 应用默认 > 策略文件），
     改档无需重建会话。
  6. **入口**：顶栏 pill（三项 + 说明 + 「也作为以后新会话的默认」 + 边界灰字）；
     设置页「权限」用同一套三档控件并显示来源（会话覆盖 / 应用默认 / 策略文件）。
  7. **命名纪律**：这是工具门，不是沙箱；界面上不出现「沙箱」，中间档不叫「帮我批准」。
- 代价：多了一档后，风险判据需要持续维护；`allow-all` 下的误操作只剩审计可查。
- 依据：`apps/desktop/src/main/risk.ts`；`apps/desktop/test/risk.test.ts`（31 条）、
  `policy-risk.test.ts`（8 条，含方案期门优先级）。

## ADR-050 浏览器插件：复用系统浏览器，产物只落工作区

- 日期：2026-11-15
- 状态：已采纳（未发版）
- 背景：插件注册表里 browser 插件占 4 族 15 个工具位，一直 `ready:false`。补它要回答三件事：
  浏览器从哪来、跑在哪、产物落哪。
- 决定：
  1. **不打包 Chromium**：`playwright-core`（14 MB、零运行时依赖）只做驱动，实际浏览器按
     `msedge → chrome → 自装 chromium` 探测；安装包净增约 14 MB，对照打包 Chromium 要加约 100 MB。
  2. **页面逻辑跑在主进程**（BrowserService，127.0.0.1 + token，与内核/策略同一 broker 模式），
     扩展侧只保留参数表与描述。原因：pi 扩展由 jiti 加载，jiti 转译 playwright-core 的 CJS 会让
     graceful-fs 二次初始化（`Cannot redefine property: Symbol(graceful-fs.queue)`），浏览器在扩展进程里起不来；
     先 `import()` 再 `require()` 也会二次初始化。主进程不是 jiti，直接 require 即可。
     `playwright-core` 的真实目录由构建脚本拷到 `dist/payload/node_modules`（electron-builder 会跳过
     被拷目录根部的 `node_modules`，同 ADR-042），随 `extraResources` 进安装包。
  3. **共享一台浏览器**：单 profile、headless、全局标签表；工具描述写明「多段对话共享」。
     不做按会话隔离（工具调用里拿不到 oh my coding pi 会话 id）。
  4. **产物只落工作区**：截图到 `.omcp/screenshots/`（7 天 / 200 张自动清理），
     下载默认落工作区根；`../` 与绝对路径由 `resolveInWorkspace()` 拒绝；单文件上限 200 MB。
  5. **审批**：只读类（`browser_status` / `browser_snapshot` / `browser_elements`）进 `tools.allow`；
     导航、点击、输入、eval、下载、截图保持 ask（eval 返回值限 64 KB）。
  6. **失败要说人话**：没探测到浏览器时列出各 channel 的原因并给安装指引；
     `goto` 失败要关掉刚开的空白标签，避免下一次操作落在 `about:blank`。
- 代价：共享浏览器意味着一段对话关掉会影响其它对话；无头模式会被部分站点拦截；不做绕过。
- 依据：`packages/plugin-ext/src/browser/{session,tools,paths}.ts`；
  实机 24 项验收（`results/reports/13-浏览器插件/验证日志-浏览器.txt`）；
  参考 DAWN `src/tools/browser/*`。

## ADR-051 模型服务：凭据按 provider 的官方环境变量注入

- 日期：2026-11-15
- 状态：已采纳（0.5.8 未发布，随模型服务重构落地）
- 背景：用户选 `deepseek/deepseek-flash` 发送，pi 报
  `No API key found for deepseek`。实测本机 `model-registry.json` 为空、
  `~/.pi/agent/models.json` 不存在。用 pi 自带的 `auth check` 做了三组对照：

  ```
  无环境变量                → {"status":"not_ready","reason":"credentials_not_configured"}
  DEEPSEEK_API_KEY=sk-fake → {"status":"ready","authType":"api_key"}
  只有 OMCP_KEY_DEEPSEEK     → {"status":"not_ready", ...}
  ```

  结论：内置 provider 只认 pi-ai 规定的官方变量名（`env-api-keys.js` 的 `envMap`），
  我们过去统一注入 `OMCP_KEY_<ID>`，对内置 provider 从未生效；且注册表为空时根本不生成
  `models.json`，两条凭据路径同时落空。
- 决定：
  1. **按 provider 注入官方名**：`provider-catalog.json` 在生成时用 `findEnvKeys` + 探针 env
     从 pi-ai 源码取变量名，**不手写映射表**；运行时同时注入官方名与 `OMCP_KEY_<ID>`。
  2. `supervisor.setExtraEnv` 改为**合并语义**（原来是整表替换，一次新调用就会清掉凭据）。
  3. `models.json` 只写 `$OMCP_KEY_<ID>` 引用；元数据（input/cost/contextWindow）从目录继承，
     避免"pi 不回填内置条目"导致的 400。
  4. 发送前预检（缺凭据 / 地址 / 模型），失败给出可行动作；补密钥对话框先确认连接信息再存。
- 代价：环境变量里的密钥对同用户进程可见（与 pi 自身的行为一致）；不接管 `/login`。
- 依据：`apps/desktop/src/main/model-env.ts`、`model-preflight.ts`、`scripts/build-provider-catalog.mjs`、
  `apps/desktop/test/model-{env,preflight,registry-sync}.test.ts`；`pi auth check` 三组实测。
