# 权限与安全（P3）

- 版本：P3（0.3.0）
- 日期：2026-11-11
- 状态：**审批门、策略、授权、审计、只读模式已实现**

---

## 1. 一句话

**权限用于防误操作，不构成安全边界。**（ADR-004）模型与应用同以当前用户权限运行；权限门拦的是“手滑”和“模型自作主张”，不是恶意本机程序。

### 1.1 覆盖范围与不覆盖范围（D1，2026-11-15 决策）

**覆盖**：

| 入口 | 判定依据 |
|---|---|
| `run_code` 工具 | 策略文件 `runCode.requireApproval`，默认要求审批 |
| 通过 bash 调用脚本（`python x.py`、`Rscript x.R` 等） | 读脚本前 4 KB，命中删除/子进程模式则要求审批或拒绝 |
| 文件读写、删除类命令 | `paths` 与 `commands` 规则 |
| 方案期（`.omcp/plans/` 未批准） | 非只读工具一律 deny（`plan:readonly`） |
| 方案期已批准但文件被改/被删/读不出来 | 非只读工具 deny（`plan:drift`），同时撤销批准 |

**不覆盖**：

| 入口 | 实际行为 | 原因 |
|---|---|---|
| bash 命令里的内联代码（`python -c "..."`、`Rscript -e`、`node -e`） | 只按 bash 命令规则判定，不触发 `run_code` 审批 | 逐个枚举解释器写法无法构成边界，仍可被等价写法绕过 |
| 超过 4 KB 的脚本内容、动态拼接、编译后程序 | 静态检查看不到 | 不是静态分析器 |
| 同用户的其他进程、已授权脚本自身的后续操作 | 不受约束 | 进程以当前用户权限运行，无沙箱 |

结论：**不要把这套机制描述为沙箱或隔离执行**。它是“减少误操作、留下审计痕迹”的机制；需要真正的隔离时使用容器/WSL（v1.1 评估）。

---

## 2. 调用链

```
pi 扩展(permission-ext) ──tool_call──▶ 主进程 PolicyService(/decide)
                                        │ allow  → 工具执行
                                        │ deny   → 阻止，原因回给模型
                                        └ ask    → ctx.ui.select
                                                     │ extension_ui_request
                                                     ▼
                                           主进程解析 → 渲染进程弹窗
                                             │ 仅本次 / 本会话 / 总是允许 / 拒绝
                                             ▼
                                    extension_ui_response → 执行或阻止
```

- 判定发生在 `tool_call`（工具真正执行之前），因此被拒绝/被审批的命令不会产生副作用。
- `tool_execution_start` 先到，审批通过后才真正执行（ADR-007）。
- 扩展与主进程之间是 `127.0.0.1` + 一次性 token；token 只在进程环境变量里。

---

## 2.1 三档权限（ADR-049）

| 界面 | 内部名 | 行为 |
|---|---|---|
| 自动拦截 | `deny-risky` | 风险操作直接拒，理由回给模型让它改道 |
| 请求批准 | `ask-risky` | 风险操作弹既有四选项 |
| 完全访问权限 | `allow-all` | 只拦硬拒清单 |

- 档位现取：会话覆盖 > 应用默认 > 策略文件；改档下一次工具调用即生效。
- 硬拒（任何档都拒）：提权、强推、凭据形状+出网、动系统盘、从根 `find -delete`、
  受保护路径（系统目录、家目录顶层点文件、凭据目录）的写入与删除。
- 「不可问」：删除目标含通配符/变量/管道/多目标 → 直接拒，连请求批准档也不问。
- 判据是纯函数（`apps/desktop/src/main/risk.ts`），可逐条测；不认识工具的调用一律放行（已知缺口）。

## 3. 策略文件

**位置与优先级**：

1. `<工作区>/.omcp/policy.json`
2. 设置文件 `%APPDATA%\oh-my-coding-pi\settings.json` 的 `policyPath`
3. 内置默认策略（`packages/shared/src/policy.ts` 的 `DEFAULT_POLICY`）

文件变更后 1 秒内热重载；也可以点“权限”页的“重新加载”。

**可以只写要改的字段**，缺的回落到默认值：

```json
{ "version": 1, "mode": "readonly" }
```

**写错的字段会 fail-closed**：解析失败、正则非法、`mode` 拼错等，整份策略作废并切到 `mode: "deny"`，界面顶部报错说明文件和原因。宁可全拦，也不静默放行。

### 3.1 mode

| 值 | 含义 |
|---|---|
| `ask` | 按规则审批（默认） |
| `allow` | 全部放行（仅调试）；仍然执行 deny 规则 |
| `deny` | 全部拒绝 |
| `readonly` | 只允许 read / grep / find / ls / glob；run_code 直接拒绝 |

### 3.2 三类规则

| 规则 | 写法 | 示例 |
|---|---|---|
| `commands.deny` / `commands.ask` | JS 正则，作用于 bash 命令文本 | `\\brm\\s+[^\\n|;&]*-[a-zA-Z]*([rR][a-zA-Z]*[fF]|...)` |
| `paths.denyWrite` / `allowWrite` / `denyRead` | glob，三种基准 | `.env`（工作区相对）、`<workspace>/**`（工作区绝对）、`C:/Windows/**`、`**/.ssh/**`（任意位置） |
| `tools.allow` / `tools.deny` | 工具名精确匹配；deny 优先 | `run_code`、`bash` |

`runCode.requireApproval` 控制 run_code 是否默认要审批；`timeoutSec`、`maxOutputChars` 为上限。

**run_code 的内置高危模式**（不占 policy.json 字段）：`shutil.rmtree`、`os.remove/unlink/rmdir`、`subprocess.*`、`os.system/popen/exec*`、`Path(...).unlink()`，命中即 ask。

---

## 4. 审批

四个选项与作用域：

| 选项 | 记录方式 | 生效范围 |
|---|---|---|
| 仅本次 | 不记录 | 这一次调用 |
| 本会话 | 内存，会话结束/切工作区清空 | 当前会话 + 同类规则 |
| 总是允许 | `%APPDATA%\oh-my-coding-pi\grants.json`，30 天 | 当前工作区 + 同类规则 |
| 拒绝 | 审计记 deny | 不执行 |

- 授权键是 **规则 id**（如 `cmd:ask:0`），不是完整命令（ADR-006）：模型给命令加后缀不会反复弹窗。
- 授权期限在「权限」页可选：7 / 30 / 90 天 / 永久（默认 30，写 `settings.json` 的 `grantTtlDays`）；过期条目可在同一页清理。
- 持久授权按 `sha256(规范化工作区绝对路径)` 绑定，换工作区要重新授权。
- **超时 120 秒按拒绝处理**，审计记 `timeout`；弹窗默认焦点在“拒绝”。
- 授权页可逐条撤销、清空；撤销后同类命令立刻恢复弹窗。
- 授权不读工作区里的任何 grant 文件（避免仓库预置授权）。

---

## 5. 审计

- 位置：`<工作区>/.omcp/logs/audit.jsonl`，一行一条。
- 技能：模型读 `SKILL.md` 或调用 `use_skill` 时，摘要写成 `skill:<name> · <路径>`；技能启停也落一条。
- 字段：`ts`、`toolName`、`ruleId`、`decision`（allow/deny/timeout）、`scope`（policy/grant/once/session/always/deny/timeout）、`summary`（≤200 字）、`sessionId`、`source`。
- 轮转：10MB × 3；写失败不阻断主流程。
- 脱敏：Bearer token、`sk-/pk-` 开头密钥、`api_key/token/secret/password=` 形式的赋值、用户主目录路径。
- 权限页可按时间倒序查看最近记录，导出 CSV 到 `%APPDATA%\oh-my-coding-pi\exports\`。

---

## 6. 只读模式

- 只放行 `read / grep / find / ls / glob`。
- `run_code` 直接拒绝，**不做代码静态分析**（D6）：想“能算不能写”，需要容器或 IO 拦截，v1 不做。
- 顶部常驻横幅说明当前口径；退出只读（改策略）后横幅自动消失。

---

## 7. 边界与已知漏判

1. 同用户进程可以直接读写文件，绕过应用内的权限门——这是 ADR-004 的既定边界。
2. 删除逻辑藏在脚本文件里时，命令正则看不见；P4.0 加了启发式检查（读脚本前 4KB，命中即审批，读不到也审批），但只看开头 4KB、只认固定模式，**不是安全保证**（ADR-026）。
3. `bash` 里调 `python -c "shutil.rmtree(...)"` 已由内置规则覆盖，但任意自写程序不在检查范围。
4. 只读模式下笔记本 cell **默认拒绝执行**（P4.0 起），可在「权限」页勾选“只读时允许执行笔记本 cell”放开。

完整的绕过演练结果见 `docs/p3-bypass-drill.md` 与 `docs/p3-acceptance.md`。

---

## 8. 自测

```powershell
# 策略单测（28 条）
node --test packages/shared/test/policy.test.ts

# 绕过演练（23 条写法）
node scripts/policy-drill.mjs

# 端到端：A3 / 授权 / 只读 / 超时
$env:P1_SELFTEST=1; $env:P1_SELFTEST_MODE="a3"; pnpm --filter @oh-my-coding-pi/desktop exec electron .
```

---

## 9. 相关文档

- `docs/policy.schema.json`：字段定义
- `docs/decisions.md`：ADR-004（不是安全边界）、ADR-006（授权粒度）、ADR-020～025（P3）
- `docs/error-taxonomy.md`：拒绝与超时的分类
- `docs/p3-acceptance.md`：验收证据
