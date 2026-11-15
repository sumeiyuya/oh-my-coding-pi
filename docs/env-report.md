# S0 环境体检报告

- 日期：2026-11-11
- 平台：Windows x64
- 说明：本报告保留可复现的版本与结论；本机路径已替换为通用写法（`%USERPROFILE%`、`%APPDATA%`）。

## 1. 工具链

| 项 | 版本 | 状态 |
|---|---|---|
| Node | v24.19.0 | ✅ 满足 ≥ 22.19 |
| npm | 11.17.0 | ✅ |
| pnpm | 12.18.0 | ✅ |
| Python | 3.13.2 | ✅ |
| ipykernel | 7.3.0 | ✅ |
| jupyter_client | 8.10.0 | ✅ |
| Python kernelspec | `python3` | ✅ |
| R | 4.5.2 | ✅ |
| IRkernel | 1.3.2 | ⚠️ 已安装但未注册 kernelspec（P2 执行 `IRkernel::installspec()`） |
| git | 2.55.0.windows.5 | ✅ |

## 2. pi

| 项 | 值 |
|---|---|
| 安装方式 | 全局 npm |
| 版本 | 0.86.1 |
| 命令 | `%APPDATA%\npm\pi.cmd` |
| 包目录 | `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent` |
| 配置目录 | `%USERPROFILE%\.pi\agent` |

## 3. 模型通道

**状态：已打通。**

| 项 | 值 |
|---|---|
| Provider | `opencode-go`（pi 内置） |
| Base URL | `https://opencode.ai/zen/go/v1` |
| 模型 | `deepseek-v4.1-flash` |
| 上下文 / 输出 | 1M / 384K |
| 图像输入 | 支持 |
| 凭据 | `%USERPROFILE%\.pi\agent\auth.json`（当前用户可读，不随仓库分发） |

冒烟测试：

```
pi -p "只回复 ok" --provider opencode-go --model deepseek-v4.1-flash --no-session
→ ok（退出码 0）
```

一次最小调用的用量与成本：

| 项 | 数值 |
|---|---|
| input | 2,127 tokens |
| cacheRead | 256 tokens |
| output | 3 tokens |
| 单次成本 | $0.000322 |

> 2,127 输入 token 是 pi 的最小系统提示 + 4 个内置工具的固定开销，后续估算成本时按此基线。

## 4. 已就绪

- 仓库骨架：`packages/`、`apps/`、`docs/`、`scripts/`（`sandbox/`、`backups/` 不入库）
- `.gitignore` 排除 node_modules、构建产物、安装包、sandbox、backups
- `pi --version` = 0.86.1；`pi --list-models` 可见 `opencode-go/deepseek-v4.1-flash`
- `pi -p` 冒烟测试通过

## 5. 后续

P0 的技术验证结论见 `docs/go-no-go.md` 与 `docs/decisions.md`（原始 spike 日志不随公开仓库发布）。
