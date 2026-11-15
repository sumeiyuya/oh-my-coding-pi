# R 内核配置与排错

- 版本：P2（0.2.0）；2026-11-14 起推荐改用「设置 → 内核」填路径
- 日期：2026-11-11
- 适用：`IRkernel` 1.3.2 + R 4.5.2

> **新方式（推荐）**：在「设置 → 内核」里填 R 解释器路径（如 `D:/Software_study/R-4.5.2/bin/R.exe`），
> 应用会生成 `omcp-r` 的 kernelspec（argv 用同目录 `Rterm.exe`）并按它启动。
> 不需要再手工跑 `make_sci_ir_spec.py`，也不需要改 `%APPDATA%\jupyter`。
> 下面是旧方案，保留给「路径留空、回退到 sci-ir」的场景。

---

## 1. 注册 kernelspec（旧方案）

应用使用 `sci-ir`（不是 `ir`）。`ir` 的 `argv[0]` 是 `R.exe`，它会再启动 `Rterm.exe`，内核 PID 与真实进程不一致，退出后容易残留；`sci-ir` 直接用 `Rterm.exe`，PID 可被清理。

```bash
# 1. 注册标准 IRkernel
Rscript -e "IRkernel::installspec(name='ir', displayname='R (IRkernel)')"

# 2. 生成本应用专用的 sci-ir（把 R.exe 换成 Rterm.exe）
python scripts/make_sci_ir_spec.py
```

验证：

```bash
python -m jupyter kernelspec list
```

应看到 `ir`、`sci-ir`、`python3` 三个。`sci-ir/kernel.json` 的 `argv` 指向 `Rterm.exe`：

```json
{
  "argv": [
    "D:/Software_study/R-4.5.2/bin/x64/R",
    "--slave",
    "-e",
    "IRkernel::main()",
    "--args",
    "{connection_file}"
  ],
  "display_name": "R (IRkernel)",
  "language": "R"
}
```

---

## 2. 应用内使用

- 笔记本顶部 `＋ R` 新建 R cell；cell 左上角下拉可切换 `python` / `r`。
- 工具栏“重启 Py / 重启 R”分别重启两个内核。
- 变量按钮同时显示 `py:` 与 `r:` 前缀的变量。
- 对话里的 `run_code` 支持 `language: "r"`。

Python 与 R 是**两个独立内核**，变量不互通；这是刻意设计，避免 `x` 互相覆盖。

---

## 3. R 绘图

IRkernel 会自动把绘图设备输出成 `image/png`：

```r
plot(1:10)
```

ggplot2 需要显式 `print()`：

```r
library(ggplot2)
p <- ggplot(mtcars, aes(wt, mpg)) + geom_point()
print(p)
```

---

## 4. 变量列表

应用通过 `ls(globalenv())` 获取变量名。R 启动时可能加载 `.Rprofile`，因此会看到一些包函数（如 `nat_*`），这是正常的；只关心自己定义的变量即可。

---

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 笔记本 R cell 一直“运行中” | `ir` kernelspec 缺失或 R 路径不对 | 重跑 `IRkernel::installspec()`；检查 `jupyter kernelspec list` |
| `could not find function "IRkernel"` | R 库路径不包含 IRkernel | `Rscript -e "library(IRkernel)"` 检查；重装 `install.packages('IRkernel')` |
| R 图不显示 | ggplot 未 `print()`；或绘图设备被改 | 用 `print(p)`；不要手动 `dev.off()` |
| 中文乱码 | Windows 编码/字体 | 图里用 `family="Microsoft YaHei"`；源码 UTF-8 |
| R 内核启动慢 | IRkernel 首次加载包 | 正常 3–5 秒；不要重复点运行 |
| 找不到 `sci-ir` kernelspec | 未生成本应用专用 R 规格 | 在设置里填 R 路径（推荐），或按旧方案跑脚本 |

---

## 6. 已知限制

1. **R 的两种起法**：填了路径就用应用生成的 `omcp-r`；留空才用机器上的 `sci-ir`（旧方案需手工脚本生成）。
2. 只验证了 R 4.5.2 + IRkernel 1.3.2。
3. 没有做 `renv` 自动激活；工作区 `.Rprofile` 会按 R 默认行为加载。
4. R 与 Python 不共享变量；跨语言传数据请写文件或重新读入。
