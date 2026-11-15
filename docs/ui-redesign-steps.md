# oh my coding pi 界面改造：分步实施

- 日期：2026-11-14
- 依据：`apps/renderer/src/App.tsx`（845 行）、`index.css`（1081 行）、`apps/desktop/src/main/index.ts` 的单 `currentSessionFile`
- 对照：DAWN Science 0.0.44 的三栏工作台，不是照搬团队 / 远程 / 插件
- 规则：每步可单独停、可单独回退。做完一步再开下一步。不在同一步里改主进程会话模型。

## 已冻结的约束

1. 页签只做切换。oh my coding pi 是单个 pi 进程、一个 `currentSessionFile`，切换走 `pi:switch-session`。并行多会话要重写 `supervisor`，不在本方案里。
2. `index.ts` 3308 行只追加 IPC，不拆文件、不顺手重构。
3. 笔记本组件不能同时挂两份。`Notebook.tsx` 会订内核事件，主区和右坞各挂一次会双写输出。
4. 权限文案保持“防误操作，不是安全边界”。审批仍是默认拒绝、四个选项。
5. 路线留在主区。权限、技能、设置以后进浮层，但不在右坞空壳这一步搬。
6. 亮色不能先做开关。`index.css` 里有大量写死的 `#0e1726`、`#16233a`，只改 `:root` 变量会变成花界面。
7. v1 范围（`docs/scope.md`）仍排除浏览器、MCP、子 agent。终端、远程、团队不进入这些步骤。

## 步骤

每步的完成标准都是：应用能打开，对话能发，审批弹窗还在，笔记本还能从主区标签打开。

### 步骤 0 · 右坞空壳（本步已落地）

目的：把布局从两栏改成可收起的三栏，先占住 DAWN 的右坞位置，不接数据。

改动：

- `apps/renderer/src/App.tsx`：`dockOpen` / `dockTab`，顶栏按钮，右坞三个空页。
- `apps/renderer/src/index.css`：`.shell.dock-open` 第三列 280px；窄屏隐藏右坞。

不做：

- 不挂 `Notebook`。
- 不读文件系统。
- 不改会话切换。

完成标准：点“收起右坞 / 右坞”后重启仍记住；主区六个标签行为与改前一致。

回退：去掉 `dock-open` 类和 `<aside className="dock">`。

### 步骤 1 · 颜色收成令牌

目的：让以后的亮色开关不会漏改。默认仍是现在的深色。

改动：

- 在 `:root` 增加 `--side`、`--side-2`、`--hover`、`--chip`、`--code-bg`。
- 把壳、侧栏、会话项、代码块、视图标签里的写死深色换成这些变量。
- 权限 / 路线 / 附件那一段浅色（`#f8fafc`、`#e2e8f0`）单独记一笔，本步不强迫它们变深。它们本来就是浅色卡片，和深色壳并存。

不做：不加主题切换按钮。令牌替换完、深色观感不变，才允许步骤 9 加亮色。

完成标准：并排截图，深色壳与改前一致；搜索 `index.css` 的壳相关规则不再出现 `#0e1726`、`#16233a`、`#131f33`。

### 步骤 2 · 会话标题

目的：左栏不再只显示 8 位 ID。

改动：

- 新文件 `apps/desktop/src/main/session-meta.ts`，读写 `<workspace>/.omcp/session-meta.json`。
- 字段只有 `title`、`archived`、`lastOpenedAt`。不改 pi 的 jsonl。
- preload 加 `getSessionMeta` / `setSessionMeta`。
- 左栏优先显示 title，没有 title 时仍显示 8 位 ID。
- 侧栏加“重命名”。归档只是元数据标记，不删文件。

不做：不改 `SessionSummary` 的扫描逻辑（ADR-009）。标题是旁路文件。

完成标准：重命名后重启还在；坏掉的 meta 文件被忽略，会话列表仍能出来。

本步实际落地（2026-11-14）：已完成上述改动。两个额外决定：① 元数据的键用会话文件名（basename），不用绝对路径，工作区搬家后标题不会失效；② 损坏的 meta 文件不覆盖，写操作直接报错，避免把用户数据静默冲掉。归档会话默认隐藏，侧栏“归档”按钮切换显示。

### 步骤 3 · 顶栏页签（只切换）

目的：已打开的会话出现在顶栏，点击等于现在的 `loadSession`。

改动：

- `App.tsx` 增加 `openTabs: string[]`，最多 8 个，写入 localStorage。
- 切换前把 `input` 和 `listRef.scrollTop` 按 sessionFile 存进内存。
- 关闭页签不删除会话文件。

不做：不新开 pi 进程，不承诺后台继续跑。

完成标准：两个会话来回点，输入框草稿还在；忙碌时切换按钮禁用，避免切到一半。

本步实际落地（2026-11-14）：已完成。另加：① 九个以上页签时丢最早的，保证刚打开的会话一定在页签里；② 至少保留一个页签，关不了最后一个；③ 页签列表只保留当前工作区真实存在的会话文件，换工作区不会留下旧路径。页签数组逻辑放在新文件 `apps/renderer/src/session-tabs.ts`，便于单独测。

### 步骤 4 · 只读文件树

目的：右坞“文件”页列出当前工作区。

改动：

- 新文件 `apps/desktop/src/main/file-service.ts`。
- IPC：`fs:list`、`fs:stat`。本步不读文件内容。
- 路径必须 `realpath` 后仍在 `workspace.root` 内。拒绝 `..`。跳过 `.git`、`node_modules`、`.omcp`。
- `index.ts` 只注册这两个 handle。
- 右坞文件页懒加载一层目录。

不做：不提供删除、重命名、写入。不预览。

完成标准：用工作区外路径调用 `fs:list` 被拒；一万级目录只列当前层，不递归。

本步实际落地（2026-11-14）：已完成。实现细节：① 只收相对路径，`realpath` 后再比一次根目录（Windows 大小写不敏感），符号链接指向外部就被拒；② 单目录 1000 条上限，超出返回 `truncated`；③ 符号链接仍列表（名字带标记），但读取时重建路径再校一遍；④ 文件页点文件只显示 `fs:stat` 的大小与时间，不读内容。

### 步骤 5 · 只读预览

目的：点文件能看，不能改。

改动：

- IPC `fs:read`，文本上限 2 MB，图片上限 8 MB。
- 预览种类：图片、文本、Markdown 原文、CSV/TSV 表格。
- PDF 单独作为本步尾巴：`pdfjs-dist` 的 worker 路径进 electron-vite 打包后再勾完成。打不进就记已知限制，不阻塞下一步。

不做：DOCX、XLSX、HTML。HTML 禁止 `file://`。

完成标准：`figures/` 里的 png 和 `data/processed/` 里的 csv 能打开；超限文件显示原因，不把整个文件塞进渲染进程。

本步实际落地（2026-11-14）：图片、文本、Markdown 原文、CSV/TSV 表格已完成，PDF **未做**。`pdfjs-dist` 不在依赖里，装它要联网并配 electron-vite 的 worker 打包，按方案“打不进就记已知限制”处理，不影响步骤 6。另外定下：SVG 当文本显示，不当图片渲染；文本超过 2 MB 直接拒，不做截断读取；界面层再限一次 20 万字符只显示。

### 步骤 6 · 笔记本迁入右坞

目的：对话和笔记本同屏。这是第一个会改导航的步骤。

改动：

- 右坞“笔记本”页挂现有 `Notebook`。
- 主区标签去掉“笔记本”。
- `Notebook` 的内核调用不动。

不做：不导出 `.ipynb`，不把对话里的 `run_code` 变成笔记本 cell。

完成标准：Python、R 各跑一次；中断和重启仍可用；全仓库只有一处 `<Notebook />`。

本步实际落地（2026-11-14）：已完成。关键做法：右坞不再条件渲染，**常驻挂载**，收起时用 `.dock-collapsed { display: none }` 藏起来、非笔记本页签时用 `display: none` 藏笔记本容器。这样全仓库只有一处 `<Notebook />`，切页签/收右坞不会卸载组件，正在跑的 cell 不会丢输出，内核事件也只有一份订阅。因此“Python/R 各跑一次、中断与重启”仍需开窗口验，代码层面只验证到“只有一处挂载 + 只有一处订阅”。

### 步骤 7 · 输入卡补两处

目的：靠近 DAWN 的输入卡，但不重做发送逻辑。

改动：

- 输入框以 `@` 结尾时，用步骤 4 的文件列表做补全，插入路径文本。不新增“模型必须读这个文件”的协议。
- 费用条上加权限 pill，只显示 `policy.mode`，点击切到权限页。只读模式横幅保留。

不做：不做 `/` 技能执行器。技能仍在技能页启停。

完成标准：`@` 补全插入的是工作区内相对路径；发送、插入、追加三个按钮行为不变。

本步实际落地（2026-11-14）：已完成。补全规则：`@` 前必须是行首或空白，`@` 后不允许空格/第二个 `@`；query 带目录时（`data/pro`）先对目录部分调 `fs:list`，再对末段做前缀匹配；目录补 `/`，文件补空格（后文已有空格就不重复补）。另加：输入卡右下的权限 pill 只读 `policy.mode`，点击跳权限页；只读横幅保留。纯函数拆到 `apps/renderer/src/mention.ts` 便于单测。

窗口验收（2026-11-14）又修了一处：补全列表项原本被 `.composer button` 的蓝色发送按钮样式覆盖（蓝底白字），已把选择器改成 `.composer .mention-list button`；同时“路径与名字相同”时不再重复显示路径。

### 步骤 8 · 消息渲染

目的：助手回复不再只按三个反引号切代码块。

改动：

- 渲染层替换 `RichText`。候选：`react-markdown`、`remark-gfm`、`rehype-katex`。代码高亮如果打包变大，本步可以仍用现有 `CodeBlock`。
- 工具调用从 `<details>` 改成卡片，字段仍是 name / args / result / done。
- 流式文本 40ms 节流后再渲染。

不做：不改 `AgentMessage` 协议，不改 pi 事件解析。

完成标准：一条含表格和 `$...$` 的回复能排版；复制按钮复制的仍是原文，不是 HTML。

本步实际落地（2026-11-14）：已完成。新增依赖 `react-markdown` / `remark-gfm` / `remark-math` / `rehype-katex` / `katex`（渲染进程）。`pnpm build` 通过，KaTeX 字体作为相对路径资源打入 `out/renderer/assets`（`url(./KaTeX_*.woff2)`），file:// 下可用。另两处：① 工具调用改成卡片，输出默认收起，点头部展开；② 流式 40 ms 一批。**链接点击不导航**：没有 `shell.openExternal` 桥，渲染进程跳转会顶掉界面，先只显示不跳。

### 步骤 9 · 浮层与亮色

目的：设置、权限、技能不再占主区标签；亮色作为可选项，默认仍深色。

改动：

- `overlay` 状态：`null | "settings" | "permissions" | "skills"`。
- 关闭浮层回到打开前的滚动位置。
- `[data-theme="light"]` 覆盖步骤 1 的令牌。顶栏加“外观”，写入 localStorage。
- 主区标签只留“对话”和“路线”。

不做：不做中英切换。不做命令面板。

完成标准：只读模式横幅在浮层打开时仍可见；审计 CSV 导出还能用；切回深色与步骤 1 截图一致。

本步实际落地（2026-11-14）：已完成。几处具体做法：① 浮层遮住了主区横幅，所以在浮层内又放一份只读横幅（同一个 `ReadonlyBanner` 组件），否则打开浮层就看不到只读提示；② 浮层 z-index 40，低于审批弹窗的 50，审批仍在上层；③ 主区始终不卸载，所以关掉浮层自然回到原滚动位置，没额外存 scrollTop；④ 亮色只覆盖令牌 + 五处语义色，不改布局；`--muted` 从 `#667085` 调到 `#5f6876`（前者在亮色侧栏上对比度 4.39，不满足 4.5）；⑤ 入口：侧栏底部“权限 / 技能 / 设置”，以及输入卡的权限 pill。

窗口验收（2026-11-14）另修一处既有 bug：`.perm-row span { width: 48px }` 把所有 span 压到 48px，设置页的长说明被挤成竖排，已改为只约束第一个 span。

## 明确不做

| 项 | 原因 |
|---|---|
| 每页签一个 pi 进程 | 要改 `currentSessionFile` 和 supervisor |
| 终端 / SSH / 文件传输 | 原生模块和远程会话，超出 v1 |
| 插件、MCP、团队、Bot、定时任务 | `docs/scope.md` 已排除 |
| 对话 cell 导出 `.ipynb` | 数据模型改造，不是布局 |
| 在线安装技能 | 现有设计是本地目录 |

## 回归清单（每步结束勾一次）

2026-11-14 整体验收一次（临时用户目录 + 临时工作区，未动真实配置）。标注「未验」的需要模型可用。

- [x] 新建会话、切换会话、导出 HTML（新建的空会话要发第一条消息才落盘，列表里才看得到）
- [ ] 克隆——未验（依赖同一套会话落盘时机）
- [ ] 审批四个选项，30 秒默认拒绝——未验：模型返回 429，没有工具调用可触发
- [x] 只读模式横幅还在（workspace policy 切成 readonly 后主区与浮层内各一条，恢复后消失）
- [x] 笔记本 Python / R、中断、重启（55 / 2.5 / KeyboardInterrupt / 重启后变量清空）
- [x] 路线编辑与方案门（路线页可开，方案期区块在）
- [ ] 技能启停——未验
- [ ] 设置里的模型与预算保存——未验
- [ ] 粘贴图片仍能进输入框——未验

## 当前进度

- [x] 步骤 0：右坞空壳。代码已改，渲染进程类型检查通过。窗口未打开，不算界面验收。报告：`D:/desktop/coding/results/reports/omcp-ui-step-0-report.md`。
- [x] 步骤 1：壳层颜色收成令牌。深色数值未改，未加主题开关。窗口未并排看过。报告：`D:/desktop/coding/results/reports/omcp-ui-step-1-report.md`。
- [x] 步骤 2：会话标题。旁路文件 + 重命名 + 归档标记。三个包类型检查通过，session-meta 模块 18 项运行时检查通过。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-2-report.md`。
- [x] 步骤 3：顶栏页签。只切换，不新开 pi 进程；草稿与滚动位置存内存。渲染进程类型检查通过，页签数组 16 项运行时检查通过。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-3-report.md`。
- [x] 步骤 4：只读文件树。`fs:list` / `fs:stat`，路径夹在工作区内。三个包类型检查通过，file-service 22 项运行时检查通过（含越界符号链接被拒）。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-4-report.md`。
- [x] 步骤 5：只读预览。图片/文本/Markdown 原文/CSV 表格完成，PDF 因 `pdfjs-dist` 未装而记作已知限制。三个包类型检查通过，读取与解析 21 项运行时检查通过。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-5-report.md`。
- [x] 步骤 6：笔记本迁入右坞。主区去掉“笔记本”标签（剩 5 个），右坞常驻挂载 `Notebook`，全仓库一处 `<Notebook />`、一处内核订阅。渲染进程类型检查通过。Python/R 实跑与中断重启未验。报告：`D:/desktop/coding/results/reports/omcp-ui-step-6-report.md`。
- [x] 步骤 7：输入卡两处。`@` 路径补全（复用 `fs:list`）+ 权限 pill。渲染进程类型检查通过，补全纯函数 19 项运行时检查通过。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-7-report.md`。
- [x] 步骤 8：消息渲染。react-markdown + GFM + KaTeX 替换 RichText；工具卡；40 ms 节流。新增 5 个渲染进程依赖。类型检查与 `pnpm build` 通过，渲染管线 7 项运行时检查通过。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-8-report.md`。
- [x] 步骤 9：浮层与亮色。权限/技能/设置进浮层，主区只剩对话与路线；亮色令牌 + 顶栏切换。类型检查与 `pnpm build` 通过，两套配色对比度已算。窗口未打开。报告：`D:/desktop/coding/results/reports/omcp-ui-step-9-report.md`。
- [ ] 步骤 0–9 已在代码层面落地，待窗口验收（见上方回归清单）
