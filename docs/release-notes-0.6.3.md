# 发布说明 0.6.3

- 日期：2026-11-17
- 安装包：`oh my coding pi Setup 0.6.3.exe`
- 平台：Windows 10/11 x64（按当前用户安装，不需要管理员）
- 仓库：`sumeiyuya/oh-my-coding-pi`
- 上一版：0.6.2（2026-11-17）

## 下载

- [oh my coding pi Setup 0.6.3.exe](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.3/oh.my.coding.pi.Setup.0.6.3.exe)
- [SHA256SUMS.txt](https://github.com/sumeiyuya/oh-my-coding-pi/releases/download/v0.6.3/SHA256SUMS.txt)

---

## 1. 内核：修掉“时好时坏”的启动失败

上一版之后在真实机器上做了一轮根因测试，结论不是路径、也不是 ipykernel，而是**通道建早了**：

- `start_kernel()` 返回时内核还在 import，shell/iopub 端口约 1 s 后才 bind；
  这时 `km.client()` + `start_channels()` 建立的 socket 会停在 `CONNECT_DELAYED`，
  本机 pyzmq 27.2 / libzmq 4.3.5（Windows）不再重试——哪条通道哑是随机的。
- 实测：不改 13 次只成 1 次（每次 ≈21 s）；等端口后再建通道 11 次成 10 次，ready ≈2 s。

这一版：

1. 建通道前**等端口 bind 完**（`socket.connect_ex`，默认 10 s，`OMCP_KERNEL_PORT_WAIT_S` 可调），
   就绪后再留 0.1 s 让 ROUTER 完成 peer 注册；重启内核走同一条路径。
2. 等端口期间**先接住内核 stderr**；内核在端口就绪前退出（例如缺 `ipykernel`）会**立刻**失败
   并带出它自己的话，不再空等 10–20 s。
3. 握手仍失败时**重建一条通道重试一次**（8 s 预算）。
4. 诊断不再丢 sidecar 的原因：错误信息里会同时保留 `shell=/iopub=` 与内核 stderr，
   不会再出现“原因认不出”。
5. 内核那句 `Kernel is running over TCP without encryption` 是正常警告，不再被当成失败原因。

## 2. 工具组：默认收起，且不会再消失

- 工具调用组**默认收起**：组头只写「跑了 N 条命令」+ 失败数 + 总耗时，点开才看逐条。
- 运行中自动展开看进度，**跑完收起**。
- 工具调用改为从会话内容块重建：**开始下一段对话、切会话、翻历史，之前那组命令都还在**。
- 历史数据没有起止时刻时不显示耗时（不编）。

## 3. 验证与已知限制

- 本机验收 **15/15**（`--coldstarts 6`：6/6，ready 中位数 1.06 s，等端口中位数 473 ms）；
  单测 **213/213**；`pnpm -r typecheck` 全绿；`pnpm build` 通过。
- 负向用例：用一个没装 ipykernel 的 venv 当解释器，现在立刻报
  `内核进程在端口就绪前退出了 | No module named ipykernel_launcher`，而不是超时后“认不出”。
- **没有在故障机上复跑**：建议在那台机器上执行一次
  `node scripts/kernel-acceptance.mjs --driver <python> --python <python> --coldstarts 10`。
- 工具组：GUI 未手测；折叠收放与历史重建建议装完点一遍。
- 报告里一次 45 s 无事件的偶发卡死没有复现，这一版未针对性处理。

## 4. 安装包

| 项 | 值 |
|---|---|
| 文件 | `oh my coding pi Setup 0.6.3.exe` |
| 大小 | **136,861,027 字节**（较 0.6.2 增 17,354 B） |
| 签名 | 未签名（SmartScreen 可能提示“未知发布者”） |
| SHA256 | `7296f2e834dcad3b97fd0b465e6aa62f94c0f33af06f49eb4c682b2dbe4f8e9c` |
