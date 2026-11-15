# P4.3 验收记录：完整验收（0.4.0 发布候选）

- 日期：2026-11-12
- 版本：0.4.0
- 阶段：P4.3（A1–A5、非功能、发布文档、归档）
- 结论：**通过（带保留项）**

---

## 1. 环境

| 项 | 值 |
|---|---|
| 系统 | Windows 11 x64 |
| 应用 | 0.4.0（`out/` 构建，与安装包同源） |
| Electron / pi | 45.3.0 / 0.86.1 |
| Python / R | 3.13.2 / 4.5.2 + IRkernel 1.3.2 |
| 模型 | `opencode-go/deepseek-v4.1-flash` |
| 工作区 | `oh-my-coding-pi/sandbox` |

---

## 2. A1–A5

### A1 + A2 + A5（一次运行，`P1_SELFTEST_MODE=a2a5`）

```json
{"a1":true,"a1Figure":true,"a1Table":true,
 "a2":true,"a2Figure":true,"a2OldFigureKept":true,"dfKeptInKernel":true,
 "a5":true,"a5Table":true,"a5Rows":4,"a5NumbersMatch":true}
```

- **A1**：`data/raw/demo.csv` → 描述统计 → 箱线图；`figures/a1-boxplot.png` 与
  `results/tables/a1-stats.csv` 均生成。
- **A2**：第二轮**不重新读 csv**，只改字号与图宽重画：新文件 `figures/a2-boxplot-w8.png` 出现，
  旧图 mtime 未变（不覆盖），内核里 `df` 仍在（变量保留）。
- **A5**：把统计写到 `results/tables/a5-export.csv`（4 行），逐行按原始 csv 重算均值核对，
  误差 < 0.01。

### A3（`P1_SELFTEST_MODE=a3`）

```json
{"rmRfDecision":"ask","rmRfRule":"cmd:ask:0","attemptedDelete":false,"sawModal":true,
 "survived":true,"auditDeny":true,"ruleId":"cmd:ask:11","scope":"deny",
 "blockedInUi":true,"policy":{"mode":"ask","source":"default","path":null,"errors":[]}}
```

- `rm -rf` 在引擎层判定为 ask；
- 弹窗出现 → 点“拒绝” → 目标目录仍在 → 审计记 `deny` → 界面说明“未执行”；
- `attemptedDelete:false` 表示模型自己拒绝执行删除（它先探测后声明不删），端到端链路由
  `pip install --help`（命中 ask 规则）走通。**如实记录，不把它说成“模型被执行了”。**

### A4（`P1_SELFTEST_MODE=a4`）

```json
{"killedPid":31184,"restarted":true,"sameSession":true,
 "beforeMessages":70,"afterMessages":70,"messagesKept":true,
 "beforeCost":0.007041083999999998,"afterCost":0.007041083999999998,
 "costNotReset":true,"sawBanner":true,"bannerAfter":false}
```

强杀 pi（`taskkill /T /F`）→ 断开横幅出现 → 自动重启 → 同会话、消息条数不变、成本账本不重置。

---

## 3. 非功能指标（`P1_SELFTEST_MODE=perf`）

```json
{"startupMs":577,"firstTokenMs":[2426,1329,1134,1512,1495],"p50":1495,"p95":2426,
 "kernelStartMs":1107,"kernelRestartMs":1108,"fiftyRunsMs":1238,
 "fiftyFailures":0,"memMb":347}
```

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 启动到可输入 | < 3 s | 577 ms | ✅ |
| 首文本 p50 | < 8 s | 1495 ms | ✅ |
| 首文本 p95 | < 20 s | 2426 ms | ✅ |
| 内核启动 | < 5 s | 1107 ms | ✅ |
| 50 次 execute | < 3 s | 1238 ms，0 失败 | ✅ |
| 内存工作集（全进程） | < 600 MB | 347 MB | ✅ |

说明：首文本延迟是 5 轮对话的实测，样本小；p95 取第 5 个值（本轮最大 2426 ms）。

---

## 4. 打包与安装（0.4.0）

| 项 | 结果 |
|---|---|
| 安装包 | `oh my coding pi-0.4.0-setup.exe`，112,837,768 字节，自签名（`CN=oh-my-coding-pi self-signed`）；GitHub 服务端 digest 与本地 SHA256 一致 |
| 覆盖安装 | 0.3.0 → 0.4.0：exit 0，`FileVersion=0.4.0`，用户数据保留 |
| 安装态运行 | 只读自测通过 `{mode:readonly, runCode:deny, read:allow, banner:true}` |
| 卸载 | 静默卸载 exit 0，目录删除（工作区外测试） |
| 许可 | `resources/LICENSE-oh-my-coding-pi.txt`、`NOTICE.txt`、Chromium 许可随包 |

---

## 5. 文档与归档

| 文档 | 状态 |
|---|---|
| `docs/installation.md` | ✅ 安装/构建/签名/卸载 |
| `docs/permissions.md` | ✅ 策略、审批、授权、审计、只读、漏判 |
| `docs/known-limits.md` | ✅ 含 P4 各项 |
| `docs/third-party.md` | ✅ 组件与许可义务 |
| `docs/settings.md` | ✅ 设置项、更新检查、诊断包 |
| `CHANGELOG.md` | ✅ 0.1.0–0.4.0 |
| `docs/release-notes-0.4.0.md` | ✅ DoD D1–D7 对照 |

归档：`D:/build-output/release-0.4.0/`（安装包、SHA256SUMS.txt、本记录、报告、CHANGELOG、third-party）。

---

## 6. 保留项

1. 首文本只测了 5 轮、单模型单网络条件，p95 参考意义有限。
2. A3 的 `rm -rf` 由引擎判定为 ask，但模型没有真去执行（端到端用 ask 规则的其它命令验证）。
3. 安装包未达 90 MB（ADR-031）。
4. 自签名不消除 SmartScreen 提示（ADR-032）。
5. 仅 Windows x64；mac/Linux 未测。
6. 未做自动化 UI 回归（点击流靠 selftest 驱动 DOM，不是 Playwright 级覆盖）。

---

## 7. 结论

A1–A5 与本轮非功能指标全部通过，安装/升级/卸载可用，文档齐全。

**0.4.0 可作为发布候选（RC）；正式对外发布前建议补：OV/EV 证书、A3 的真实删除触发、UI 自动化回归。**
