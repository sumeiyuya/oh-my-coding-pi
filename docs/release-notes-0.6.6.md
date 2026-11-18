# 发布说明 0.6.6

- 日期：2026-11-18
- 安装包：`oh my coding pi Setup 0.6.6.exe`
- 平台：Windows 10/11 x64（按当前用户安装，不需要管理员）
- 仓库：`sumeiyuya/oh-my-coding-pi`
- 上一版：0.6.5（2026-11-18）

## 下载

- [oh my coding pi Setup 0.6.6.exe](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.6/oh.my.coding.pi.Setup.0.6.6.exe)
- [SHA256SUMS.txt](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.6/SHA256SUMS.txt)

---

## 1. 顶栏：面板按钮固定最右

- 「面板：X」从可换行控件区拆出来，放进独立固定区（`flex: 0 0 auto; margin-left: auto`）。
- 权限 pill、上下文、模型、推理强度、状态再多，换行时面板按钮也贴在主区右缘，不会被挤到第二行。
- 开合逻辑、`Ctrl+J`、焦点回到按钮的行为不变。

## 2. 外观：颜色开关移入设置

- 顶栏不再有「深色 / 浅色」按钮。
- 设置第一张卡是「外观」，深色 / 浅色分段控件；切换立即生效并写 `localStorage`，下次启动保持。
- 顶栏少一个按钮，右侧留给模型与推理强度。

## 3. 模型栏：推理强度

- 模型选择器右侧新增「推理：高 ▾」，与模型按钮连体。
- 档位**来自 pi**（`get_available_thinking_levels`），不硬编码；中文映射：关闭 / 最少 / 低 / 中 / 高 / 更高 / 最高。
- 当前模型不支持的档（例如 DeepSeek V4.1 Flash 没有「中」「更高」）不会出现在菜单里；`reasoning: false` 的模型不显示按钮。
- 改档立即生效（`set_thinking_level`），并写入设置作为默认：**新会话沿用**，**旧会话保留自己的档位记录**。
- pi 把请求档钳制时，按钮显示 `get_state.thinkingLevel` 回读的实际值，不做乐观更新。
- 空态区分：
  - pi 未响应 / 超时 →「读取可用档位失败：pi 未响应或还没启动。」+「重试」；
  - pi 正常但模型没有可调档位 →「当前模型没有可调档位…换一个支持推理的模型即可调整。」

## 4. 侧栏：版本号不再是写死的 P2

- 标题旁的徽章从写死的 `P2`（0.2.0 阶段的遗留）改为 `v0.6.6`。
- 版本号在构建时由 `apps/desktop/package.json` 注入（`__APP_VERSION__`），以后改版本会自动跟着变。

## 5. 验证

- `pnpm typecheck` 全绿；`pnpm build` 通过。
- `P1_SELFTEST_MODE=layoutcheck`：面板按钮存在、文本正确、开合 `320 → 0 → 320`。
- 真机 CDP：
  - 顶栏无主题按钮；`.bar-fixed` 贴主区右缘；
  - 设置首卡「外观」，深/浅色切换生效并写 `localStorage`；
  - 推理菜单显示「低 / 高✓ / 最高」（DeepSeek V4.1 Flash 的实际可用档）；点「最高」→ `thinkingLevel=max`，点回「高」→ `high`；
  - 空态两分支分别验证：失败态有「重试」且档位项为 0；空数组态显示「没有可调档位」且档位项为 0；
  - 侧栏徽章读到 `v0.6.6`。

## 6. 已知限制

- 「新建会话沿用默认档」只有代码路径（`pi:new-session` → `set_thinking_level`），未做真机点新建对比。
- 「旧会话重启后保留自己的档位」依赖 pi 的分支记录，未做重启对比测试。
- pi 首次启动约 30–40 秒，期间没有模型状态，推理按钮不显示（正确但看起来像没做）。
- 窗口窄于 820px 时右坞与面板按钮一起隐藏（维持旧行为）。

## 7. 安装包

| 项 | 值 |
|---|---|
| 文件 | `oh my coding pi Setup 0.6.6.exe` |
| 大小 | **136,875,403 字节**（约 130.5 MiB） |
| 签名 | 未签名（SmartScreen 可能提示“未知发布者”） |
| SHA256 | `61b9e69442c9cdd71419881cf0145fd3786f1ed2425e6e0252b51554c83b234e` |
