# oh-my-coding-pi

Windows 桌面科研分析工具：**pi** 负责模型、工具循环、会话与压缩；本项目提供 Electron 外壳、Python/R 常驻内核、笔记本、权限门与审计。

> ### 开始之前必读
>
> 1. **权限不是安全边界。** 应用与 pi 以你的用户权限在本机直跑，没有沙箱；审批门用于防误操作，挡不住恶意程序，也能被同用户进程绕过（ADR-004）。
> 2. **数据会离开本机。** 对话内容、工具读取到的文件内容、`run_code` 的代码与输出都会发送给你配置的模型 provider。不要用它处理未发表数据，除非你接受这一点。
> 3. **pi 已内置，只需配好凭据。** 安装包自带 pi 1.5.2，不需要预装 `pi` 或 Node；模型凭据仍要你自己提供（`~/.pi/agent/auth.json`，与系统 pi 共用）。
>
> 完整边界见 [`docs/known-limits.md`](docs/known-limits.md)；安全问题见 [`SECURITY.md`](SECURITY.md)。

## 版本

- 当前版本：**0.6.4**（2026-11-17）
- 发布说明：[`docs/release-notes-0.6.4.md`](docs/release-notes-0.6.4.md) · 变更日志：[`CHANGELOG.md`](CHANGELOG.md)
- 安装包：[GitHub Release v0.6.4](https://github.com/sumeiyuya/oh-my-coding-pi/releases/tag/v0.6.4)
- 平台：Windows 10/11 x64（按当前用户安装，不需要管理员）

## 能做什么

| 方面 | 能力 |
|---|---|
| 对话 | pi 工具循环、流式输出、工具调用分组折叠、运行中排队/立刻转向、会话树与 fork、技能、分析路线、方案期只读门 |
| 内核 | Python / R 常驻内核、串行执行队列、变量面板、图片自动落 `figures/`、表格由分析代码写 `results/tables/` |
| 笔记本 | cell 执行与输出、语言切换、只读模式下可配置是否允许执行 |
| 权限 | 三档权限（自动拦截 / 请求批准 / 完全访问）、只读模式、方案期门、审批超时按拒绝、持久授权、审计 JSONL |
| 模型 | 模型注册表、发送前预检、连接信息确认、纯文本模型的图片转述（可选视觉端点） |
| 工作区 | 左栏会话、右坞四面板（文件 / 笔记本 / 产物 / 运行）、产物就地预览、可拖宽与折叠 |
| 诊断 | 回合级 `perf.jsonl`、错误分类、诊断包导出、内部自检模式 |

0.6.4 的重点是**等待可见、启动不空等、每回合少做重复功**：提交阶段状态、启动期就绪门控、会话统计去重、事件合并与渲染 memo。细节见发布说明。

## 安装

1. 从 [Release v0.6.4](https://github.com/sumeiyuya/oh-my-coding-pi/releases/tag/v0.6.4) 下载 `oh.my.coding.pi.Setup.0.6.4.exe` 与 `SHA256SUMS.txt`。
2. 双击安装；默认装到 `%LOCALAPPDATA%\Programs\oh my coding pi\`。
3. 静默安装（PowerShell）：

```powershell
Start-Process "oh my coding pi Setup 0.6.4.exe" -ArgumentList "/S" -Wait
# 指定目录：/D 必须放最后，且不能加引号
Start-Process "oh my coding pi Setup 0.6.4.exe" -ArgumentList '/S', '/D=C:\Tools\oh my coding pi' -Wait
```

> 不要在 Git Bash 里直接传 `/S`，MSYS 会把它当路径。用 PowerShell。
> 安装包未签名，SmartScreen 可能提示“未知发布者”。

## 首次使用

1. **准备凭据**：应用与系统 pi 默认共用 `~/.pi/agent/auth.json`。也可以在应用里打开「设置 → 模型注册表」添加 provider 与密钥（密钥进本机安全存储，不落明文）。
2. **启动应用**：首次启动 pi 要加载扩展，界面会显示“pi 正在启动…”并禁用发送；就绪后自动恢复。首次可能需要几十秒，之后通常 1 秒内。
3. **打开工作区**：应用会创建标准科研目录（`data/raw`、`data/processed`、`analysis/scripts`、`results/`、`figures/`）与 `.omcp/` 元数据目录。
4. **选模型并发送**：右上角选择模型；发送前会做本地预检（凭据 / 地址 / 模型是否存在），不联网验证密钥有效性。

可选环境变量（开发/诊断用）：

| 变量 | 作用 |
|---|---|
| `PI_PROVIDER` / `PI_MODEL` | 覆盖默认 provider / 模型 |
| `OMCP_PERF_TRACE=0` | 关闭回合时序写盘（事件仍发给界面） |
| `OMCP_EVENT_PUMP=0` | 关闭事件合并，退回逐条转发 |
| `OMCP_KERNEL_PREWARM=python\|r` | 打开工作区后预热对应内核（默认关闭） |
| `P1_SELFTEST=1` | 内部自检，正常使用不要设置 |

## 权限与安全

三档权限（界面右下角可切换）：

| 档 | 行为 |
|---|---|
| 自动拦截 `deny-risky` | 风险操作直接拒，理由回给模型让它改道 |
| 请求批准 `ask-risky` | 风险操作弹审批（仅本次 / 本会话 / 总是 / 拒绝），**默认** |
| 完全访问 `allow-all` | 只拦硬拒清单 |

另外还有一层**只读**策略（`.omcp/policy.json`）：只允许 read / grep / find / ls / glob；`run_code` 直接拒绝；笔记本默认阻断，可在权限页放开。方案期（`.omcp/plans/` 未批准）非只读工具一律拒绝。

- 审批超时（默认 120 秒）按拒绝处理。
- 审计写工作区 `.omcp/logs/audit.jsonl`；应用错误写 `%APPDATA%\oh-my-coding-pi\logs\app.jsonl`。
- **再次强调**：这些门用于防误操作，不构成安全边界；没有容器/沙箱。详见 [`docs/permissions.md`](docs/permissions.md) 与 [`docs/p3-bypass-drill.md`](docs/p3-bypass-drill.md)。

## 数据出站

应用联网只发生在调用模型、检查更新（可选）与图片转述（可选）时。发送的内容是：

| 会发送 | 不会发送 |
|---|---|
| 你的对话消息 | `auth.json` 里的密钥（pi 自己用） |
| 模型主动通过工具读取的文件内容 | 授权文件 `grants.json`、审计日志 |
| `run_code` 的代码、stdout/stderr 与图片（作为上下文回传） | 工作区里未被工具读取的文件 |
| 图片转述开启时，图片会发往你配置的视觉端点 | 应用没有遥测、没有账号体系 |

除此之外只有三个出网点：**检查更新**（仅当你在设置里填了公开仓库）、**你的模型 provider**、以及**可选的视觉端点**（仅在开启图片转述时）。

## 性能与诊断

每个回合会在工作区写一行 `.omcp/logs/perf.jsonl`（5 MB 轮转，只含时间、长度、工具名与结果码）：

```json
{"v":1,"turnId":"...","kind":"prompt","outcome":"ok","totalMs":22196,
 "meta":{"textLen":47,"images":0},
 "notes":{"budgetMs":0.6,"promptAckMs":2.7,"ipcEvents":455,"ipcSent":404,
          "statsQueriesSinceLastPrompt":2},
 "spans":[{"phase":"accepted","elapsedMs":1},{"phase":"preparing","elapsedMs":1},
          {"phase":"started","elapsedMs":5},{"phase":"first_token","elapsedMs":5238},
          {"phase":"settled","elapsedMs":22196}]}
```

读法：

- `budgetMs`：发送前预算检查；`promptAckMs`：pi 接受 prompt；
- `started - preparing`：pi 的 `_prepareRun`（含自动压缩与扩展钩子）；
- `first_token - started`：模型首 token；
- `ipcEvents` / `ipcSent`：收到 / 实际发给界面的 pi 事件数，用来判断合并率；
- `statsQueriesSinceLastPrompt`：上一回合之后扫了几次会话账本（正常为 2）。

本机 0.6.4 实测（`opencode-go/deepseek-v4.1-flash`）：首 token p50 2.6–3.9 s、预算 0.4–0.6 ms、pi 接受 1–3 ms、50 次 execute 2.3 s、长回复流式 0 长任务。

内部自检模式（需要桌面环境与可用模型）：

```powershell
$env:P1_SELFTEST=1
$env:P1_SELFTEST_MODE="perf"        # 5 轮“只回复 ok” + 内核基准
$env:P1_SELFTEST_MODE="perflong"    # 长回复 + 客户端帧/长任务采样
$env:P1_SELFTEST_MODE="ready"       # 启动期就绪门控
$env:P1_SELFTEST_MODE="kernelbench" # 页面内 50 次 runCell
pnpm --filter @oh-my-coding-pi/desktop exec electron .
```

## 目录

```
apps/
  desktop/          # Electron 主进程（pi 监督、权限、审计、内核、打包）
  renderer/         # React UI（对话 / 笔记本 / 产物 / 权限 / 设置）
packages/
  shared/           # 协议、类型、策略引擎（纯函数）
  science-ext/      # run_code 扩展
  permission-ext/   # 工具调用审批钩子
  plugin-ext/       # 插件：浏览器、记忆等
  kernel-sidecar/   # Python/R 内核桥（jupyter_client + ZMQ）
vendor/             # 内置 pi 与打包产物（不入库，pnpm fetch:pi 生成）
docs/               # 范围、权限、内核、验收、决策、发布说明
scripts/            # CI、安装包、演练与验收脚本
sandbox/            # 测试工作区（假数据）
```

## 开发

```bash
pnpm install
pnpm approve-builds --all   # 首次安装若提示 ERR_PNPM_IGNORED_BUILDS
pnpm typecheck
pnpm build
pnpm dev
```

测试与 CI：

```powershell
# 全量：install → typecheck → 223 项单测 → 契约 schema → 扩展 typecheck → build
powershell -File scripts/ci.ps1

# 只跑单测
node --test apps/desktop/test/turn-trace.test.ts apps/desktop/test/event-pump.test.ts
```

打包（Windows 安装包）：

```powershell
# 一键：解包 Electron + 内置 pi + NSIS；输出到 D:/build-output/omcp
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1

# 构建并自签名
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1 -Sign
```

> 直接 `pnpm dist` 在本机会卡在 Electron 解包阶段（ADR-030），请用上面的脚本。

发布流程：

1. 改 `package.json` / `apps/desktop/package.json` 版本；
2. 更新 `CHANGELOG.md` 与 `docs/release-notes-<版本>.md`；
3. 构建安装包，记录大小与 SHA256；
4. 提交并打附注标签 `v<版本>`；
5. `git push origin main --tags`；
6. `gh release create v<版本> <安装包> <SHA256SUMS.txt> --notes-file docs/release-notes-<版本>.md`。

## 文档

| 主题 | 文档 |
|---|---|
| 安装与运行 | [`docs/installation.md`](docs/installation.md) |
| 权限、审批、审计 | [`docs/permissions.md`](docs/permissions.md) · [`docs/p3-bypass-drill.md`](docs/p3-bypass-drill.md) |
| 设置与运维 | [`docs/settings.md`](docs/settings.md) |
| 内核（Python / R） | [`docs/r-kernel.md`](docs/r-kernel.md) |
| 技能 / 视觉 / 路线 | [`docs/skills.md`](docs/skills.md) · [`docs/vision.md`](docs/vision.md) · [`docs/route.md`](docs/route.md) |
| 验收记录 | [`docs/p4-acceptance.md`](docs/p4-acceptance.md) · [`docs/p3-acceptance.md`](docs/p3-acceptance.md) |
| 已知限制 | [`docs/known-limits.md`](docs/known-limits.md) |
| 决策记录 | [`docs/decisions.md`](docs/decisions.md) |
| 错误分类 | [`docs/error-taxonomy.md`](docs/error-taxonomy.md) |
| 协议与策略 | [`packages/shared/src/protocol.ts`](packages/shared/src/protocol.ts) · [`docs/policy.schema.json`](docs/policy.schema.json) |
| 第三方与许可 | [`docs/third-party.md`](docs/third-party.md) |

## 已知限制（摘要）

- 没有沙箱/容器；权限门不是安全边界。
- 安装包未签名；更新检查只支持公开仓库，且没有自动更新。
- 一个应用实例只有一个当前工作区；会话目录在工作区 `.omcp/sessions`，换机器需手动带走。
- 笔记本只保存 cell 代码，输出不落盘，重开需重跑。
- 审批超时按拒绝；长时间任务在用户离开时会被挡住。
- 首次启动 pi 可能需要几十秒（扩展加载），界面会明确显示启动状态。

完整列表见 [`docs/known-limits.md`](docs/known-limits.md)。

## 许可

本项目 MIT，见 [`LICENSE`](LICENSE)。内置 pi 及其第三方组件遵循各自许可，见 [`docs/third-party.md`](docs/third-party.md) 与安装包内 `NOTICE-pi.md` / `LICENSES-pi.md`。
