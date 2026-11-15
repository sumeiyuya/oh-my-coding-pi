# P3 验收记录

- 日期：2026-11-11
- 版本：0.3.0
- 阶段：P3（审批门 + 策略 + 授权 + 审计 + 只读）
- 结论：**通过（带保留项）**

---

## 1. 验收环境

| 项 | 值 |
|---|---|
| 系统 | Windows 11 x64 |
| Electron | 45.3.0 |
| pi | 0.86.1（`--mode rpc`，`--extension` ×2） |
| Python | 3.13.2 |
| R | 4.5.2 + IRkernel 1.3.2 |
| 模型 | `opencode-go/deepseek-v4.1-flash` |
| 工作区 | `oh-my-coding-pi/sandbox` |
| 策略 | 默认策略（`source: default`，`mode: ask`） |

---

## 2. 策略引擎（P3.0）

**方法**：`node --test packages/shared/test/policy.test.ts`

**结果**：`tests 27 / pass 27 / fail 0`

覆盖：mode 四态、tools deny 优先、readonly 白名单、rm 系列 7 种写法、PowerShell/cmd 删除、清盘级命令、
sudo/curl|bash、git push/pip install、`.env`/`.git`/`node_modules` 写入拒绝、工作区外写审批、
`.ssh` 读拒绝、路径穿越、run_code 默认审批与 4 类危险 API、mode=allow 仍执行 deny、
未列入 allow 的工具审批、三种路径基准的 glob、坏正则/坏 mode 报错、部分策略补默认值、摘要截断。

**判定**：通过。

---

## 3. 绕过演练（P3.3）

**方法**：`node scripts/policy-drill.mjs`（23 条写法）

**结果**：命中 22 / 偏差 1

唯一偏差：

```
bash scripts/clean.sh → allow（期望 ask）
```

删除逻辑在脚本文件里，命令文本不可见。已写入 `docs/known-limits.md`，完整表见 `docs/p3-bypass-drill.md`。

**判定**：通过（漏判已知且记录在案）。

---

## 4. A3 危险命令被拦并解释（端到端）

**方法**：`P1_SELFTEST_MODE=a3`。分两段：

1. 让模型执行 `rm -rf "<workspace>/a3-target"`，记录模型是否真的发起删除；
2. 用一条模型愿意执行、但命中 ask 规则的无害命令（`pip install --help`）走完整审批链路：
   弹窗出现 → 点“拒绝” → 检查目录仍在、审计有 deny、界面有说明。

**结果**：

```json
{"rmRfDecision":"ask","rmRfRule":"cmd:ask:0","attemptedDelete":false,"sawModal":true,
 "survived":true,"auditDeny":true,"ruleId":"cmd:ask:10","scope":"deny","blockedInUi":true,
 "policy":{"mode":"ask","source":"default","path":null,"errors":[]},"auditCount":1}
```

审计记录：

```json
{"ts":"...","toolName":"bash","ruleId":"cmd:ask:10","decision":"deny","scope":"deny",
 "summary":"pip install --help 2>&1 | head -40","sessionId":"...jsonl"}
```

说明：

- `rmRfDecision: ask` 证明 `rm -rf` 在引擎层面会进入审批（`cmd:ask:0`）。
- `attemptedDelete: false` 是**模型自己拒绝执行删除**（它先 `ls` 探测后声明不删）。这是模型行为，不是权限门失效；
  端到端链路由第 2 段的 `pip install` 证明。
- `survived: true`、`auditDeny: true`、`blockedInUi: true` 三项均符合 A3 期望。

**判定**：通过（`rm -rf` 端到端未由模型触发，已如实记录）。

---

## 5. 授权（P3.2）

**方法**：`P1_SELFTEST_MODE=grant`：

1. `pip install --help` → 弹窗 → 点“总是允许”；
2. 再执行同类命令 `pip install --version` → 期待不再弹窗；
3. `grants:clear` 清空 → 再执行 → 期待重新弹窗。

**结果**：

```json
{"modal1":true,"alwaysAudited":true,"modal2":false,"grantsAfter":1,
 "grantsCleared":0,"modal3":true,"auditCount":2}
```

审计：

```json
{"ruleId":"cmd:ask:10","decision":"allow","scope":"always", ...}
{"ruleId":"cmd:ask:10","decision":"allow","scope":"grant", ...}
```

**判定**：通过（持久化、免重复弹窗、可撤销均生效）。

---

## 6. 只读模式（P3.2）

**方法**：`P1_SELFTEST_MODE=readonly`：写入 `<ws>/.omcp/policy.json`（只写 `version` 与 `mode`）→ 热重载 → 检查判定与横幅。

**结果**：

```json
{"mode":"readonly","source":"workspace","runCode":"deny","read":"allow","banner":true}
```

**判定**：通过（只读生效、横幅出现、部分策略文件可用）。

---

## 7. 审批超时（P3.1）

**方法**：`P1_SELFTEST_MODE=timeout`：触发审批后不点任何选项，等弹窗自动关闭。

**结果**：

```json
{"opened":true,"autoClosed":true,"seconds":120,"auditTimeout":true,"scope":"timeout"}
```

审计：`decision:"timeout"`, `scope:"timeout"`。

**判定**：通过（120 秒无操作按拒绝处理）。

---

## 8. P1/P2 回归（P3.3）

| 项 | 方法 | 结果 |
|---|---|---|
| A1 | `P1_SELFTEST_MODE=a1` | `{"run":true,"figure":true,"table":true}` |
| 50 次 execute | `P1_SELFTEST_MODE=stability` | `{"runs":50,"failures":0,"restarted":true}` |
| CI | `scripts/ci.ps1` | `CI OK`（install → typecheck → 27 条策略单测 → 契约 schema → 扩展 typecheck → build） |

**判定**：通过。

---

## 9. 安装回归（P3.3）

| 项 | 结果 |
|---|---|
| 安装包 | `release3/oh my coding pi Setup 0.3.0.exe`，121,209,895 字节 |
| extraResources | `kernel-sidecar/`、`science-ext/`、**`permission-ext/`** |
| 安装 | `/S /D=...` → 退出码 0；`resources/` 三个扩展齐全 |
| 安装态 | `P1_SELFTEST_MODE=readonly` 通过：`{"mode":"readonly","source":"workspace","runCode":"deny","read":"allow","banner":true}` |
| 卸载 | `/S` → 退出码 0；**`resources/app.asar` 残留**（被占用，无法删除/移动），其余文件删除 |
| 用户数据 | `%APPDATA%\oh-my-coding-pi` 保留 |

卸载残留是本次实测发现的缺陷：卸载器退出码 0，但 `app.asar` 处于 sharing violation 状态，随后也无法手动删除或移动（`Device or resource busy`），需要重启或关闭占用进程后清理。已记入 `docs/known-limits.md`，列为 P4 待修。

---

## 10. 保留项

1. `rm -rf` 的端到端演练依赖模型配合；模型会主动拒删，实际证据来自引擎判定 + ask 规则的端到端链路。
2. 审批的“取消/断线”分支只有实现，没有独立用例（杀 pi 场景隐式覆盖）。
3. 授权固定 30 天，界面不能改期限；过期仅在读取时过滤。
4. 审计列表只取最近 200 条；全量看文件或导出 CSV。
5. `bash scripts/x.sh` 形式的脚本内删除不检查（已知漏判）。
6. 只读模式不限制笔记本 cell。
7. 安装包未签名；约 121 MB。

---

## 11. 结论

P3 的四条主线——策略判定、四选项审批、授权与审计、只读模式——均有可复现证据。
**可以进入 P4（硬化、打包、自动更新、完整验收）。**
