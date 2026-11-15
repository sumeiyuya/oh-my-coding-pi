# 沙箱与备份恢复演练

- 日期：2026-11-11
- 工作区：`oh-my-coding-pi/sandbox/`
- 备份：`oh-my-coding-pi/backups/sandbox-20261111-161033.zip`
- 结论：**通过**，备份可恢复，内容校验一致

---

## 1. 沙箱内容

```
sandbox/
├─ AGENTS.md
├─ data/raw/demo.csv          # 10 行，4 组（CK/LS/MS/HS）
├─ data/processed/
├─ analysis/scripts/
├─ analysis/notebooks/
├─ results/{tables,models,reports}/
├─ figures/
├─ recovery/canary.txt        # 恢复演练标记
└─ scripts/{backup.ps1,restore.ps1}
```

`demo.csv` 校验：10 行、3 列（group/value/weight）、4 个分组。

---

## 2. 备份

```powershell
powershell -File sandbox/scripts/backup.ps1
→ D:\desktop\coding\oh-my-coding-pi\backups\sandbox-20261111-161033.zip
```

| 项 | 值 |
|---|---|
| 大小 | 2.4 KB |
| 条目 | `AGENTS.md`、`data/raw/demo.csv`、`recovery/canary.txt`、`scripts/*` 等 |
| 方式 | `Compress-Archive` 整目录 |

---

## 3. 恢复演练

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | 计算 canary SHA256 | `B2BDF449…30A9E7E` |
| 2 | 删除 `recovery/canary.txt` | 文件不存在 |
| 3 | 执行 `restore.ps1 -Zip <zip>` | 恢复成功 |
| 4 | 重新计算 canary SHA256 | `B2BDF449…30A9E7E` |
| 5 | 比对 | **一致** |
| 6 | 目录清单 | `AGENTS.md`、`demo.csv`、`canary.txt`、脚本全部存在 |

哈希：

```
B2BDF4499C3FC0C0E1F621108365AB82A033C42A6041461C4EE89190830A9E7E
```

---

## 4. 过程中的问题

第一次恢复失败：

```
Join-Path : 无法将参数绑定到参数“Path”，因为该参数为空字符串
restore.ps1:3 $PSScriptRoot
```

原因：`$PSScriptRoot` 在参数默认值求值时为空（PowerShell 5.1 的边界行为）。

修复：把默认路径的计算移到脚本体里，并加 `$MyInvocation` 兜底：

```powershell
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Target) { $Target = Split-Path -Parent $scriptDir }
```

修复后恢复成功，哈希一致。

---

## 5. 结论

- 备份脚本可用，恢复脚本可用。
- 恢复后内容逐字节一致（SHA256 相同）。
- 该脚本可作为 P1 的“工作区备份”基线；产品化时需要增加：
  - 排除 `.omcp/sessions` 中的超大文件或单独备份；
  - 增量/保留策略；
  - 恢复前确认覆盖；
  - 备份失败时明确报错，不静默。
