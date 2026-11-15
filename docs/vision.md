# 视觉转述（图片输入）

- 版本：0.5.0（P5.2）
- 日期：2026-11-13
- 入口：设置 → 视觉服务；输入框粘贴/拖拽图片

---

## 1. 两条路径

| 当前模型 | 行为 |
|---|---|
| 支持图片（`ModelInfo.input` 含 `image`） | 图片原样随消息发送给模型 |
| 仅文本 | 图片先发到**视觉端点**转述成文字，再把文字拼进消息 |

判断依据是 pi 返回的模型元数据，不是模型名字猜测。

---

## 2. 配置

设置 → 视觉服务：

| 字段 | 说明 |
|---|---|
| Base URL | OpenAI 兼容端点根地址，例如 `https://api.example.com/v1`（会自动补 `/chat/completions`） |
| 模型 | 支持 `image_url` 的视觉模型 |
| API Key | 用 Electron `safeStorage` 加密后存 `%APPDATA%\oh-my-coding-pi\secrets.json`，**不写 settings.json** |

默认关闭。未配置时，纯文本模型收到图片会明确提示“未配置视觉服务”，不会静默丢图。

---

## 3. 转述内容

提示词要求只描述看到的东西，不推断：

1. 标题与副标题（原文照抄）；
2. 坐标轴名称、刻度范围与单位；
3. 图例项；
4. 图中可见的数字与标注；
5. 整体趋势或形状。

看不清要求写“看不清”。返回文本以 `[图片转述]` 开头（多张时 `[图片 1/3 转述]`）。

---

## 4. run_code 的图

- 模型支持图片：图片照常回传，同时保存到 `figures/`。
- 模型仅文本：主进程在 kernel broker 层拦截 `display image/png`，转述后以
  `[图片转述] …` 文本返回给模型，不再塞 image block。
- 笔记本面板不受影响（那是给人看的，图照常显示）。

---

## 5. 数据出站

开启视觉服务后：

| 会发送 | 不会发送 |
|---|---|
| 你粘贴的图片 | 工作区其它文件 |
| 转述请求本身（图 + 提示词） | API key（只在请求头） |

图片会离开本机。**不要用未发表数据验证视觉功能**；需要离线时把 Base URL 指向本机服务。

---

## 6. 限制

1. 单条消息最多 4 张图；超过会被截断。
2. 转述是一次请求、30 秒超时、不重试；失败时消息里写明原因。
3. 转述可能失真——模型只能描述“看到的内容”，无法保证数字准确；关键数字仍应回看原图。
4. 图片存 `.omcp/attachments/`，不写 `figures/`；目前没有自动清理（手动删目录即可）。
5. 视觉服务默认关，且不复用 pi 的模型凭据——两套配置互不影响。

---

## 7. 自测

```powershell
$env:P1_SELFTEST=1
$env:P1_SELFTEST_MODE="p52"
pnpm --filter @oh-my-coding-pi/desktop exec electron .
```

自测用本地 mock 端点，不访问真实网络，输出 `P3_SELFTEST_P52`：

```json
{"describeOk":true,"describeHasMarker":true,"transcribedHasHeader":true,
 "attachmentSaved":true,"brokerTextOnlyPath":true,"restored":true}
```
