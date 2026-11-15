# P0 技术验证（摘要）

本目录只保留结论。**原始验证日志、会话导出、node_modules 不随公开仓库发布**——
它们包含本机绝对路径、pi 的系统提示 dump 与会话内容，对使用者没有价值。

| Spike | 问题 | 结论 | 记录位置 |
|---|---|---|---|
| S1 | pi RPC 是否够用（流式、工具事件、abort） | 通过；`pi --mode rpc` + JSONL | `docs/go-no-go.md`、ADR-001 |
| S2 | 扩展能否承载 `run_code` 并回传图片 | 通过；image block 可用 | ADR-010 |
| S3 | 审批钩子的事件顺序与可选方案 | 通过；`tool_call` 可阻断，`select` 传 JSON 标题 | ADR-007、ADR-008 |
| S4 | 会话文件格式与恢复 | 通过；jsonl 首行 header + 消息行 | ADR-009 |
| S5 | Jupyter sidecar 托管内核 | 通过；1.3 s 启动、50 次 1.24 s | ADR-005 |
| S6 | Electron 打包、安装、卸载 | 通过；NSIS 按用户安装 | ADR-002、ADR-011 |

Go/No-Go 结论：**GO**（见 `docs/go-no-go.md`）。

> 需要原始日志时，从 git 历史里取（`git log --all -- spikes/`），或联系维护者。
