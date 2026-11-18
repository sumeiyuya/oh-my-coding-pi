# 安装与运行

- 版本：0.6.5
- 平台：Windows 10/11 x64
- 日期：2026-11-18

---

## 1. 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64 |
| 运行时 | 应用自带 Electron 45（无需单独安装） |
| pi | **已内置 1.5.2**（无需单独安装） |
| 模型凭据 | `~/.pi/agent/auth.json`，或在应用「设置 → 模型注册表」里配置 |
| 磁盘 | 安装包约 136.9 MB（0.6.5）；安装后约 400 MB；会话/导出另计 |

> 应用本身不弹登录框；它使用 `~/.pi/agent/auth.json` 里的 provider 配置（内置 pi 与系统 pi 默认共用）。
> 首次使用前可用系统 pi 的 `pi -p "只回复 ok"` 验证凭据是否可用；没有系统 pi 时，只要能保证 `auth.json` 已存在即可。

---

## 2. 安装

1. 拿到 `oh my coding pi Setup 0.6.5.exe`。
2. 双击运行。安装器为 **当前用户安装**，不需要管理员权限。
3. 默认安装到：

```
%LOCALAPPDATA%\Programs\oh my coding pi\
```

4. 从开始菜单或安装目录启动 `oh my coding pi.exe`。

静默安装（部署/测试）：

```powershell
Start-Process "oh my coding pi Setup 0.6.5.exe" -ArgumentList "/S" -Wait
# 指定目录（/D 必须放最后，且不能加引号）
Start-Process "oh my coding pi Setup 0.6.5.exe" -ArgumentList '/S', '/D=C:\Tools\oh my coding pi' -Wait
```

卸载时若安装目录被其它程序占用（编辑器/索引服务），卸载器会重试并登记
“下次登录清理”（HKCU RunOnce），详见 `docs/decisions.md` ADR-029。

> 不要在 Git Bash 里直接传 `/S`，MSYS 会把它当路径。用 PowerShell。

---

## 3. 首次运行

1. 确认凭据：`~/.pi/agent/auth.json` 已存在，或在应用「设置 → 模型注册表」里保存 provider 与密钥。
2. 启动应用。首次启动 pi 要加载扩展，界面会显示“pi 正在启动…”并禁用发送；
   就绪后左下角显示 `READY`，通常 1 秒内，首次可能几十秒。
3. 打开工作区，在右上角选择模型，输入一句话测试；第一次会新建会话。
4. 若发送前预检失败，按提示补密钥 / 确认连接信息 / 换模型；预检不联网验证密钥有效性。

可选环境变量：

| 变量 | 作用 |
|---|---|
| `PI_PROVIDER` | 覆盖 provider；默认空，由设置或模型选择器决定 |
| `PI_MODEL` | 覆盖模型；默认空 |
| `OMCP_PERF_TRACE=0` | 关闭回合时序写盘（事件仍发给界面） |
| `OMCP_EVENT_PUMP=0` | 关闭事件合并，退回逐条转发 |
| `OMCP_KERNEL_PREWARM=python\|r` | 打开工作区后预热对应内核（默认关闭） |
| `P1_SELFTEST` | 内部自检，正常使用不要设置 |

---

## 4. 数据目录

应用数据都在：

```
%APPDATA%\oh-my-coding-pi\
├─ sessions\      # 会话 JSONL
├─ exports\       # 导出的 HTML
├─ logs\          # app.jsonl（错误日志）
├─ screenshots\   # 自检截图
├─ state.json     # 上次会话、日预算账本
├─ settings.json  # 可选：预算等设置
└─ workspace\     # 默认工作区（也可另选）
```

`settings.json` 示例：

```json
{
  "budget": {
    "sessionLimit": 1,
    "dailyLimit": 5,
    "alertRatio": 0.8
  }
}
```

---

## 5. 从源码构建

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dist
```

说明：

- pnpm 12 默认阻止依赖构建脚本。首次需要 `pnpm approve-builds --all`，允许 `electron` 与 `electron-winstaller`。
- 如果 `electron/dist/electron.exe` 不存在，在 electron 包目录执行 `node install.js`。
- 安装包输出在 `apps/desktop/release/`。

---

## 6. 卸载

方式一：Windows 设置 → 应用 → oh my coding pi → 卸载。

方式二（静默）：

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\oh my coding pi\Uninstall oh my coding pi.exe" -ArgumentList "/S" -Wait
```

卸载会删除安装目录与开始菜单项，**保留** `%APPDATA%\oh-my-coding-pi`（会话、导出、设置）。需要彻底清理由手动删除该目录。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动后无模型 / `No models available` | pi 没有 provider 凭据 | 检查 `~/.pi/agent/auth.json`，或在终端跑 `pi` 的 `/login` |
| 状态一直 `STARTING` / `ERROR` | `pi` 不在 PATH，或启动参数错误 | 命令行跑 `pi --version`；查看 `%APPDATA%\oh-my-coding-pi\logs\app.jsonl` |
| SmartScreen 提示“未知发布者” | 安装包未签名 | 内部使用可点“仍要运行”；对外分发前需代码签名 |
| 安装后没有快捷方式 | 安装器被中断 | 重新运行安装器，或直接用安装目录的 `oh my coding pi.exe` |
| 会话列表为空 | 首次运行 | 发一条消息后会生成第一个会话 |
| 预算拒绝发送 | 单会话/单日超限 | 改 `settings.json` 的 `budget`，重启应用 |

---

## 8. 已知限制

见 `docs/known-limits.md`。P1 **没有权限审批门**，不要在处理敏感数据时使用；权限在 P3 接入。


---

## 7. 从源码构建安装包（P4.1）

内置 pi 相关（P6 起）：

```powershell
node scripts/fetch-pi.mjs        # 按 package.json 的 piVersion 安装到 vendor/pi（不入库）
node scripts/prepare-pi-bundle.mjs   # 裁剪到 vendor/pi-bundle（打包用）
node scripts/license-scan.mjs    # 扫描许可；--write 生成 vendor/pi/NOTICE.generated.md
```


```powershell
# 一键构建（含 Electron 解包绕行、NSIS 打包）
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1

# 构建并签名（自签名证书，首次会自动创建 3 年证书）
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1 -Sign

# 只给已有安装包签名
powershell -ExecutionPolicy Bypass -File scripts/sign.ps1 -File "D:uild-output\omcp\oh my coding pi Setup 0.6.0.exe"

# 本机信任自签名证书（会让签名显示为已验证；只影响当前用户）
powershell -ExecutionPolicy Bypass -File scripts/sign.ps1 -File <exe> -TrustLocal
```

说明：

1. `scripts/build-installer.ps1` 会先把 Electron 解包到 `D:/build-output/electron-dist`，
   再用 `-c.electronDist` 让 electron-builder 直接拷贝。原因：本机 electron-builder 在
   `extractArchive` 阶段会对 `win-unpacked.tmp` 加锁重试并卡住（ADR-030）。
2. 安装包输出在 `D:/build-output/omcp/`；不写进仓库目录，避免被工作区索引进程占用。
3. 自签名证书**不在受信任根**里，资源管理器仍提示“未知发布者”——这是预期，不是失败（ADR-032）。
