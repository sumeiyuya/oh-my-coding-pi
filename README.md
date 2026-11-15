# oh-my-coding-pi

基于 pi 的科研分析桌面工具。pi 负责模型、工具循环、会话与压缩；本项目自建 Electron 外壳、笔记本与权限体系。

> ### 开始之前必读
>
> 1. **权限不是安全边界。** 应用与 pi 以你的用户权限在本机直跑，没有沙箱；审批门用于防误操作，挡不住恶意程序，也能被同用户进程绕过（ADR-004）。
> 2. **数据会离开本机。** 对话内容、工具读取到的文件内容、`run_code` 的代码与输出都会发送给你配置的模型 provider。不要用它处理未发表数据，除非你接受这一点。
> 3. **pi 已内置，只需配好凭据。** 安装包自带 pi 1.5.2，不再需要预装 `pi` 或 Node；但模型凭据仍要你自己提供（`~/.pi/agent/auth.json`，与系统 pi 共用）。
>
> 详细边界见 [`docs/known-limits.md`](docs/known-limits.md)，安全问题请见 [`SECURITY.md`](SECURITY.md)。

## 当前阶段

**0.5.0 发布候选（P1–P5 全部完成）。**

- 发布说明：`docs/release-notes-0.5.0.md`
- 0.5 新增：技能（本地目录）、视觉转述（纯文本模型）、分析路线、方案期只读门
- 验收记录：`docs/p4-acceptance.md`
- 变更日志：`CHANGELOG.md`

- 技能：`docs/skills.md`（只读本地目录，不做在线安装）
- 视觉：`docs/vision.md`（纯文本模型的图片转述；图片会发往你配置的端点）
- 路线与方案期：`docs/route.md`（记录步骤；方案期只读、bash 整件拒）
- 设置与运维：`docs/settings.md`
- P3 验收：`docs/p3-acceptance.md`
- 权限说明：`docs/permissions.md`
- 绕过演练：`docs/p3-bypass-drill.md`
- P2 验收：`docs/p2-acceptance.md`
- 安装与运行：`docs/installation.md`
- 已知限制：`docs/known-limits.md`
- R 内核：`docs/r-kernel.md`
- 范围与 DoD：`docs/scope.md`
- 协议契约：`packages/shared/src/protocol.ts`
- 策略 schema：`docs/policy.schema.json`（示例：`docs/policy.example.json`）
- 错误分类：`docs/error-taxonomy.md`
- 决策记录：`docs/decisions.md`
- 版本与验收：`CHANGELOG.md`、`docs/p4-acceptance.md`

## 目录

```
apps/
  desktop/     # Electron 主进程（含 PolicyService、审批、审计）、preload、打包
  renderer/    # React UI（对话 / 笔记本 / 权限）
packages/
  shared/      # 协议、类型、策略引擎（纯函数）
  science-ext/ # run_code 扩展
  permission-ext/ # 工具调用审批钩子（tool_call）
  kernel-sidecar/ # Python/R 内核桥
docs/          # 范围、契约、文档、验收
spikes/        # P0 技术验证结论（原始日志不入库）
sandbox/       # 测试工作区（假数据）
backups/       # 备份
scripts/       # CI、演练、工具脚本
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dev

# 内置 pi（P6 起打包需要；vendor/ 不入库）
pnpm fetch:pi
pnpm license:scan
```

打包（Windows 安装包）：

```powershell
# 一键构建：解包 Electron 绕行 + NSIS；输出到 D:/build-output/omcp
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1

# 构建并自签名
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1 -Sign
```

> 直接 `pnpm dist` 在本机会卡在 Electron 解包阶段（ADR-030），请用上面的脚本。

首次 pnpm 安装若提示 `ERR_PNPM_IGNORED_BUILDS`：

```bash
pnpm approve-builds --all
```

R 内核：装好 IRkernel 即可，在「设置 → 内核」里填 R 解释器路径（推荐）或留空沿用机器上的 `sci-ir`：

```bash
Rscript -e "IRkernel::installspec(name='ir', displayname='R (IRkernel)')"
```

> `scripts/make_sci_ir_spec.py` 是旧方案（把 `ir` 的 `R.exe` 换成 `Rterm.exe`）。
> 现在填了路径就由应用自己生成 `omcp-r` 的 kernelspec 并启动，不再需要跑这个脚本。

## 硬约束

- 不 fork pi，使用精确版本 `@earendil-works/pi-coding-agent@0.86.1`
- 契约只加不改；变更走 `docs/decisions.md`
- **权限用于防误操作，不构成安全边界**（ADR-004）：本机直跑、未沙箱化
- 原始数据只读；所有写操作先确认目标路径
- 内核是工作区级的；图片自动写 `figures/`，表由分析代码写 `results/tables/`
- 策略写错会 fail-closed（全部拒绝）；缺字段回落默认值

## 数据出站

应用只在调用模型时联网，发送的内容是：

| 会发送 | 不会发送 |
|---|---|
| 你的对话消息 | `~/.pi/agent/auth.json` 里的密钥（pi 自己用） |
| 模型主动通过工具读取的文件内容 | 授权文件 `grants.json`、审计日志 |
| `run_code` 的代码、stdout/stderr 与图片（作为上下文回传） | 工作区里未被工具读取的文件 |

除此之外只有两个出网点：**检查更新**（请求 `api.github.com` 的 Release 信息，仅当你在设置里填了仓库）与
**你的模型 provider**。应用本身没有遥测、没有账号体系。

## 验证

```powershell
# 全量 CI：install → typecheck → 策略单测 → 契约 schema → 扩展 typecheck → build
powershell -File scripts/ci.ps1

# 策略单测（27 条）
node --test packages/shared/test/policy.test.ts

# 绕过演练（23 条写法）
node scripts/policy-drill.mjs

# 端到端自测：A3 / 授权 / 只读 / 超时 / A1 / 稳定性
$env:P1_SELFTEST=1; $env:P1_SELFTEST_MODE="a3"
pnpm --filter @oh-my-coding-pi/desktop exec electron .
```
