# 设置与运维（P4.2）

- 版本：0.4.0
- 日期：2026-11-12
- 位置：界面「设置」页；存储 `%APPDATA%\oh-my-coding-pi\settings.json`

---

## 1. 设置项

| 分组 | 字段 | 说明 | 生效方式 |
|---|---|---|---|
| 模型 | `provider` / `model` | 当前模型；同 provider 切换走 RPC `set_model`，换 provider 重启 pi | 立即 |
| 预算 | `sessionLimit` / `dailyLimit` | 单会话 / 单日美元上限（`0` = 不限制） | 立即 |
| 模型服务 | 无（存在安全存储与 `model-registry.json`） | 内置 provider 只填密钥；地址来自内置目录；自定义 provider 需确认 baseUrl 与模型 | 保存后重启 pi |

> 补全入口：「设置 → 补全当前 Provider」或模型选择器里点「缺密钥 · 填入」。
> 两处打开同一个对话框，先确认服务地址与模型，再保存密钥；取消不写入任何内容。
> 发送前会做一次预检（缺凭据 / 地址不对 / 模型不存在），不通过则不发送。

| 内核 | `pythonPath` | 空 = 工作区 `.venv` → `OMCP_PYTHON` → 系统 `python` | 保存后重启 Python 内核（运行中会先要求确认，变量会清空） |
| 策略 | `policyPath` | 空 = `<ws>/.omcp/policy.json` → 默认策略 | 保存即热重载 |
| 视觉 | `visionBaseUrl` / `visionModel` | 纯文本模型的图片转述端点；key 存安全存储，不在这里 | 保存即生效（下次发图） |
| pi 运行时 | `piConfigDir` | 空 = 共享 `~/.pi/agent`；非空 = 独立配置目录（传 `PI_CODING_AGENT_DIR`，需重新登录） | 保存后重启 pi |
| 项目资源 | `trustProject` | 是否加载项目里的 `.pi` 设置、项目扩展与 `.agents/skills`；默认 **关**（`--no-approve`） | 保存后重启 pi |
| 更新 | `updateRepo` | `owner/repo`；空 = 不检查更新 | 立即 |
| 权限 | `grantTtlDays` / `readonlyNotebook` | 授权期限、只读时是否允许笔记本 | 立即 |
| 诊断 | — | 导出 zip | — |

工作区级 `.omcp/settings.json` 里的 `provider`/`model` 仍然有效，优先级高于应用级设置。
R 内核路径不在这里配：它由 IRkernel 的 `sci-ir` kernelspec（`Rterm.exe`）决定，见 `docs/r-kernel.md`。

---

## 2. 检查更新（手动）

- 入口：设置页「检查更新」。
- 数据源：`https://api.github.com/repos/<updateRepo>/releases/latest`（无 token，受 IP 限流 60 次/小时）。
- 结果：当前版本、最新 tag、是否有新版本、发布页链接、发布说明、发布附带的 SHA256 资产（若存在）。
- **不做静默下载或自动安装**（ADR-002 / d2）：下载后请用发布页的 SHA256 校验，再手动安装。

失败情形都会给出明确文案（未配置 / 格式不对 / 网络失败 / 超时 / 无 tag），不会卡住界面。

---

## 3. 诊断包

- 入口：设置页「导出诊断包」→ `%APPDATA%\oh-my-coding-pi\exports\diagnostics-<时间戳>.zip`。
- 内容：

| 文件 | 内容 |
|---|---|
| `diagnostic.md` | 版本、Electron/Chromium/Node、系统、工作区、策略摘要、授权与审计计数、Python 解释器 |
| `settings.json` | 应用设置（密钥类字段置 `[redacted]`） |
| `policy.json` | 策略摘要（mode/source/path/errors） |
| `audit-tail.jsonl` | 最近 100 条审计（摘要再过一遍脱敏） |
| `app-log-tail.txt` | `logs/app.jsonl` 末尾 200 行（Bearer/sk-/key= 脱敏） |
| `manifest.json` | 每个文件的字节数与 SHA256 |

- 实现：`apps/desktop/src/main/diagnostics.ts`，自带最小 ZIP 写入（store 模式，无第三方依赖）。
- 校验：`node scripts/p42-checks.mjs` 会用系统 `Expand-Archive` 解开，逐项检查文件与脱敏结果。

---

## 4. 崩溃恢复（A4）

`P1_SELFTEST_MODE=a4` 实测（强杀 pi 进程，不设 stopping，让 supervisor 自动重启）：

```json
{"killedPid":14576,"restarted":true,"sameSession":true,
 "beforeMessages":52,"afterMessages":52,"messagesKept":true,
 "beforeCost":0.0062155,"afterCost":0.0062155,"costNotReset":true,
 "sawBanner":true,"bannerAfter":false}
```

- 断开期间顶部出现黄色横幅（`sawBanner: true`），恢复后自动消失；
- 会话文件不变、消息条数不变、成本账本不重置。

---

## 5. 自测

```powershell
node --test packages/shared/test/version.test.ts   # 版本比较 4 条
node scripts/p42-checks.mjs                        # 诊断包 12 项

$env:P1_SELFTEST=1
$env:P1_SELFTEST_MODE="p42"   # 设置保存/更新检查/诊断导出/设置页渲染
$env:P1_SELFTEST_MODE="a4"    # 强杀 pi 后恢复
pnpm --filter @oh-my-coding-pi/desktop exec electron .
```
