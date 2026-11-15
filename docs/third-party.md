# 第三方组件与许可

- 版本：0.4.0（P4.1）
- 日期：2026-11-12
- 用途：发布物合规（DoD D7「文档齐」）；安装包内附 `LICENSE.txt` 与 `NOTICE.txt`

---

## 1. 运行时依赖

| 组件 | 版本 | 许可 | 使用方式 |
|---|---|---|---|
| Electron | 45.3.0 | MIT + Chromium BSD 类 | 桌面外壳；完整 Chromium 许可随安装包（`LICENSES.chromium.html`） |
| @earendil-works/pi-coding-agent | 0.86.1 | MIT | 以 RPC 子进程调用，不 fork、不修改 |
| jupyter_client | 8.10.0 | BSD-3-Clause | sidecar 托管内核 |
| ipykernel | 7.3.0 | BSD-3-Clause | Python 内核 |
| jupyter_core | 5.9.1 | BSD-3-Clause | 内核启动 |
| traitlets | 5.16.1 | BSD-3-Clause | 内核配置 |
| pyzmq | 27.2.0 | LGPL-3.0 / BSD-3-Clause 双许可 | 以内核通信库动态加载 |
| IRkernel | 1.3.2 | MIT | R 内核 |
| R | 4.5.2 | GPL-2 / GPL-3 | 以独立进程（Rterm.exe）调用，不链接 |

## 2. 构建期依赖（不随安装包分发）

electron-builder 26.18.0（MIT）、electron-vite 6.x（MIT）、Vite 8.x（MIT）、
React 19（MIT）、TypeScript 7（Apache-2.0）、pnpm（MIT）。

## 2.1 内置 pi 的依赖（0.5.1 起）

pi 以 1.5.2 内置在安装包 `resources/pi` 下，合计 **122 个包**：

| 许可 | 包数 |
|---|---|
| MIT | 60 |
| Apache-2.0 | 37 |
| BSD | 14 |
| ISC | 6 |
| BlueOak-1.0.0 | 4 |
| Unlicense | 1 |

- **无 GPL / AGPL / LGPL**。
- 完整清单：`build/NOTICE.pi.md`（安装包内 `resources/NOTICE-pi.md`）。
- 许可全文（按文本去重）：`build/LICENSES.pi.md`（安装包内 `resources/LICENSES-pi.md`）。
- 14 个包只声明许可、未附带文本（含 pi 自身的 npm 包），已在全文汇总里单列。

## 3. 许可义务说明

1. **Electron/Chromium**：安装目录保留 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`，未删除。
2. **pyzmq（LGPL）**：以未修改的动态库形式使用，用户可自行替换 `site-packages` 中的实现；本程序不静态链接。
3. **R（GPL）**：仅通过独立进程与文件/协议交互，不构成衍生作品。
4. **pi（MIT）**：以精确版本 `0.86.1` 通过 `pi --mode rpc` 调用，未修改其源码。

## 4. 检查方式

```powershell
# 安装包内的许可文件
Get-ChildItem "$env:LOCALAPPDATA\Programs\oh my coding pi" -Filter "*LICENSE*"
Get-Content "$env:LOCALAPPDATA\Programs\oh my coding pi\resources\NOTICE.txt"

# 依赖清单
pnpm list --depth 0
python -m pip show jupyter_client ipykernel
Rscript -e 'packageVersion("IRkernel")'
```
