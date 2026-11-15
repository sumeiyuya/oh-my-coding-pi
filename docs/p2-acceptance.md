# P2 验收记录

- 日期：2026-11-11
- 版本：0.2.0
- 阶段：P2（工作区 + 内核 + 笔记本 + R + A1）
- 结论：**通过（带保留项）**

---

## 1. 验收环境

| 项 | 值 |
|---|---|
| 系统 | Windows 11 x64 |
| Electron | 45.3.0 |
| pi | 0.86.1 |
| Python | 3.13.2 |
| R | 4.5.2 + IRkernel 1.3.2 |
| 模型 | `opencode-go/deepseek-v4.1-flash` |
| 工作区 | `oh-my-coding-pi/sandbox` |

---

## 2. AP2-1 工作区

**方法**：`workspace:open` 切到 `sandbox`，检查 `.omcp`、目录骨架、旧会话迁移。

**结果**：

```json
{
  "root": "D:\\desktop\\coding\\oh-my-coding-pi\\sandbox",
  "initialized": true,
  "migratedSessions": 0,
  "sessions": 3
}
```

首次打开 `migratedSessions:3`，第二次 0；`.omcp/{sessions,logs,notebooks,figures}`、`data/analysis/results`、`AGENTS.md` 均已创建。

**判定**：通过。

---

## 3. AP2-2 run_code

**方法**：聊天里让 `run_code` 先执行 `x=41; print(x)`，再执行 `print(x+1)`。

**结果**：

```json
{"has41":true,"has42":true}
```

**判定**：通过（同一内核变量保留）。

---

## 4. AP2-3 笔记本图片

**方法**：笔记本 cell 执行 `plt.plot([1,2,3],[1,4,9]); plt.show()`。

**结果**：

```json
{"run":true,"clicked":true,"hasCell":true,"images":1,"vars":7}
```

2026-11-15 复测（安装版 0.5.6）把验收脚本修好了：笔记本已从顶部 viewtabs 改成**右坞页签**，
旧脚本按 viewtabs 找“笔记本”按钮已经点不到；而且它先写 notebook 文件再点页签，
但 Notebook 在启动时就把 cells 读进内存了，不重载渲染进程的话 `runId` 对不上、图片永远数不到。
现在的脚本：写文件 → `reload()` → 展开坞 →点“笔记本” → 数 `.nb-cell` / `.nb-output img`。

图片通过 `.nb-output img` 内嵌；代码保存到 `.omcp/notebooks/default.json`。

**判定**：通过（图片不持久化，只恢复代码）。

---

## 5. AP2-4 R 内核

**方法**：R cell 执行 `x <- 41; print(x+1); plot(1:10)`。

**结果**：

```json
{"run":true,"has42":true,"images":1,"vars":39,"hasX":true}
```

R 图显示，变量含 `x`；`sci-ir` kernelspec 使用 `Rterm.exe` 直接启动，退出后无 Rterm 残留。

**判定**：通过。

---

## 6. AP2-5 稳定性与中断

**方法**：连续 50 次 `kernel:run`；再执行 `while True: pass` 并 interrupt；最后 restart。

**结果**：

```json
{"runs":50,"failures":0,"restarted":true}
```

**判定**：通过。

---

## 7. AP2-6 A1

**方法**：`runCell` 执行：

```python
import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv("data/raw/demo.csv")
stats = df.groupby("group")["value"].agg(["mean","median","count"])
print(stats)
df.boxplot(column="value", by="group")
plt.suptitle("")
plt.savefig("figures/a1-boxplot.png", dpi=150)
plt.show()
stats.to_csv("results/tables/a1-stats.csv")
```

**结果**：

```json
{"run":true,"figure":true,"table":true}
```

产物：

| 文件 | 大小/内容 |
|---|---|
| `figures/a1-boxplot.png` | 12 KB 箱线图 |
| `results/tables/a1-stats.csv` | 4 组 mean/median/count |

**判定**：通过。

---

## 8. AP2-7 安装回归

| 项 | 结果 |
|---|---|
| 安装包 | `oh my coding pi Setup 0.1.0.exe` |
| 大小 | 121,277,671 字节 |
| extraResources | `kernel-sidecar/sidecar.py`、`science-ext/src/index.ts` |
| 安装 | `/S` → exit 0，`%LOCALAPPDATA%\Programs\oh my coding pi` |
| 安装态 A1 | `{"run":true,"figure":true,"table":true}` |
| 卸载 | `/S` → exit 0，安装目录删除 |
| 用户数据 | `%APPDATA%\oh-my-coding-pi` 保留 |

**判定**：通过。

---

## 9. 里程碑

| 里程碑 | 标准 | 结果 |
|---|---|---|
| M1 工作区 | 打开目录、`.omcp`、迁移 | ✅ |
| M2 内核与 run_code | 双内核、broker、变量保留 | ✅ |
| M3 笔记本 | cell、图、中断/重启 | ✅ |
| M4 R + A1 + 安装 | R 图、A1、稳定性、安装 | ✅ |

---

## 10. 保留项

1. **R 依赖 `sci-ir` kernelspec**：由 `scripts/make_sci_ir_spec.py` 从 `ir` 生成（把 `R.exe` 换成 `Rterm.exe`，便于按 PID 清理）。新机器首次使用 R 前需要跑一次。
2. 笔记本图片/长输出不持久化，只保存 cell 代码。
3. `KernelService` 没有执行队列；并发 execute 由 UI 禁用或 sidecar 返回 busy。
4. 变量列表未过滤 IPython/R profile 内置名。
5. 安装包未签名、默认图标、约 115.7 MiB。
6. 只测 Windows 10/11 x64。

---

## 11. 结论

P2 的工作区、Python/R 内核、`run_code`、笔记本、A1、稳定性与安装均可用。**可以进入 P3（审批门与安全）。**
