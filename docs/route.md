# 分析路线与方案期

- 版本：0.5.0（P5.3）
- 日期：2026-11-13
- 入口：界面「路线」页；磁盘 `.omcp/route.json`、`.omcp/plans/`

---

## 1. 两件事，别混

| | 分析路线 | 方案期门 |
|---|---|---|
| 是什么 | **人写的记录**：这一步做什么、吃什么、产出什么、证据到什么程度 | **执行约束**：未批准方案前，只允许只读工具 |
| 存哪 | `.omcp/route.json` | 内存状态 + `.omcp/plans/*.md` |
| 谁维护 | 你（或你让模型起草后人工确认） | 你开关与批准 |
| 能不能自动推断 | 不能，刻意不做 | 不适用 |

---

## 2. 路线

字段（8 个，刻意少）：

| 字段 | 说明 |
|---|---|
| `title` | 步骤名 |
| `purpose` | 这一步回答什么问题 |
| `inputs` | 输入：文件 / 表 / 上游步骤 |
| `outputs` | 产出：`results/tables/x.csv`、`figures/x.png`（多个用逗号分隔） |
| `status` | 待办 / 进行中 / 完成 / 阻塞 |
| `evidence` | 无 / 有限 / 较强（只表示“有无产物与复核”） |
| `id` / `updatedAt` | 内部字段 |

- 保存是**原子写**（先写 `.tmp` 再 rename），连点保存不会留半个文件。
- 导出 Markdown 到 `results/reports/route-<时间戳>.md`，产物路径会标「缺失」如果文件不存在。
- 导出内容明确写着「本表由作者手动维护，不是自动推断」。

---

## 3. 方案期门

开启后（默认关）：

| 工具 | 结果 |
|---|---|
| `read` / `grep` / `find` / `ls` / `glob` | 放行 |
| `write` / `edit` / `run_code` | 拒绝（`plan:readonly`） |
| `bash` / `powershell` | **整件拒**——不配只读命令白名单 |

为什么 bash 整件拒：shell 的词法比正则大（引号拆词、选项缩写、冷门写文件开关），
配白名单等于给自己一种“拦住了”的错觉。

解锁方式：

1. 把方案写到 `.omcp/plans/<name>.md`；
2. 在「路线」页填入该路径并点「批准」；
3. 批准后写操作放行。

约束：

- 批准路径必须位于 `.omcp/plans/` 且文件存在（填 `README.md` 会被拒）；
- **切会话或切工作区会回到未批准**；
- 关闭方案期会同时清空批准状态；
- 进入/退出/批准都会落审计（`toolName: "plan"`）。

---

## 4. 拒绝理由

方案期拒绝时返回：

```
方案期只读：先写方案（.omcp/plans/），批准后再执行写操作。
```

模型会收到这条理由（与权限门同一套机制），可以据此改道去写方案，而不是反复重试。

---

## 5. 不做的事

1. **不做“被改就恢复”**：DAWN 那套“批准时记指纹、每轮核对、被改就恢复成原内容”更重；
   本实现对内容做 sha256 绑定（P1-01）：批准后文件一旦被改、被删或读不出来，批准立即失效并退回只读，
   但**不会**把文件写回批准时的版本。恢复需要备份策略，未在 P1 范围内。
   只规范化两件事：去 BOM、CRLF/CR 统一为 LF，因此仅改换行符不算“改内容”。
2. **不做自动推断路线**：不根据对话猜步骤，避免生成一份看起来严谨、实际编造的表。
3. **不做跨会话持久批准**：批准是当前会话的，换会话要重新批。

---

## 6. 自测

```powershell
$env:P1_SELFTEST=1
$env:P1_SELFTEST_MODE="p53"
pnpm --filter @oh-my-coding-pi/desktop exec electron .
```

输出：

```json
{"route":{"saved":true,"loadedSteps":3,"exists":true,"exported":true,"exportHasSteps":true,"uiSteps":3},
 "plan":{"blockedWrite":"deny","blockedRule":"plan:readonly","allowedRead":"allow",
         "blockedBash":"deny","badApprove":false,"goodApprove":true,
         "approvedPath":".omcp/plans/p53.md",
         "writeAfterApprove":"ask",
         "writeAfterDrift":"deny","driftRule":"plan:drift","revokedAfterDrift":true,
         "writeAfterDisable":"ask"}}
```

> 2026-11-15 实跑（0.5.6，独立 userData）。`writeAfterApprove` / `writeAfterDisable` 的值随生效档位而变：
> 默认 `ask` 档下是 `ask`（已解锁，进入正常审批），`allow` 档下才是 `allow`。关键是
> `writeAfterDrift=deny` + `driftRule=plan:drift` + `revokedAfterDrift=true` 三项：批准后改一行方案文件，
> 下一次非只读调用就被拦下且批准被撤销（P1-01 的内容绑定）。
