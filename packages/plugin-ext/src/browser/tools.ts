/**
 * 浏览器 15 个工具的**客户端**（T1–T4）。
 *
 * 页面逻辑在主进程 BrowserService（ADR-050）：pi 扩展由 jiti 加载，jiti 会转译
 * playwright-core 的 CJS 并让 graceful-fs 二次初始化（`Cannot redefine property`），
 * 浏览器在扩展进程里起不来。这里只保留参数表与描述，执行走 OMCP_BROWSER_URL（与内核/策略同一 broker 模式）。
 */
declare const process: { env: Record<string, string | undefined> };

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

async function callBroker(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const base = process.env.OMCP_BROWSER_URL;
  const token = process.env.OMCP_BROWSER_TOKEN;
  if (!base || !token) throw new Error("浏览器服务未配置（OMCP_BROWSER_URL）");
  const res = await fetch(`${base}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; text?: string; error?: string } | null;
  if (!data) throw new Error(`浏览器服务返回异常：HTTP ${res.status}`);
  if (!data.ok) throw new Error(data.error ?? "浏览器操作失败");
  return data.text ?? "";
}

const SHOT_DIR = ".omcp/screenshots";

export function browserTools(families: Set<string>): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  /**
   * pi 的工具签名是 `execute(toolCallId, params, …)`——**第一个参数不是 params**。
   * 这里用闭包生成 execute，所以要把 toolCallId 显式接住，否则 broker 收到的是
   * 一串 `call_xxx`，参数全丢（0.7.0 修过另外 17 个工具的同款错误，漏了这一族）。
   */
  const run = (name: string) =>
    async (_toolCallId: string, p: Record<string, unknown> = {}) => text(await callBroker(name, p));

  if (families.has("browser.navigate")) {
    tools.push(
      {
        name: "browser_open",
        label: "打开",
        description: "在共享的无头浏览器里打开 URL（复用系统 Edge/Chrome）。之后用 browser_snapshot 读内容、browser_elements 找可点的东西、browser_click / browser_type 操作。浏览器在多段对话间共享。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "完整 URL（含协议）" },
            new_tab: { type: "boolean", description: "开新标签（默认 true；false 时在当前页导航）" },
          },
          required: ["url"],
          additionalProperties: false,
        },
        execute: run("browser_open"),
      },
      {
        name: "browser_tabs",
        label: "标签",
        description: "标签页管理：list 列出全部；switch / close 按 id 操作。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "switch", "close"] },
            id: { type: "string", description: "switch / close 的目标标签 id" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: run("browser_tabs"),
      },
      {
        name: "browser_back",
        label: "后退",
        description: "后退一页。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: run("browser_back"),
      },
      {
        name: "browser_reload",
        label: "刷新",
        description: "刷新当前页。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: run("browser_reload"),
      },
      {
        name: "browser_wait",
        label: "等待",
        description: "等一个选择器出现，或干等几毫秒（≤10000）。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "等它出现（CSS 选择器）" },
            ms: { type: "number", description: "没给 selector 时干等的毫秒数" },
          },
          additionalProperties: false,
        },
        execute: run("browser_wait"),
      },
      {
        name: "browser_status",
        label: "状态",
        description: "浏览器状态：开没开、用的是 Edge 还是 Chrome、几个标签、当前 URL。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: run("browser_status"),
      },
      {
        name: "browser_close",
        label: "关闭",
        description: "关掉共享浏览器（多段对话共享——关了别的对话也得重启它；不确定就别关）。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: run("browser_close"),
      },
    );
  }

  if (families.has("browser.read")) {
    tools.push(
      {
        name: "browser_snapshot",
        label: "读正文",
        description: "读取当前页：正文文本（截断会说明）、前 N 条链接、输入框计数。这是纯文本模型“看”网页的方式——先 snapshot 再决定点哪儿。",
        parameters: {
          type: "object",
          properties: {
            max_text: { type: "number", description: "正文最多字符（默认 8000）" },
            max_links: { type: "number", description: "最多列几条链接（默认 40）" },
          },
          additionalProperties: false,
        },
        execute: run("browser_snapshot"),
      },
      {
        name: "browser_elements",
        label: "找元素",
        description: "列出可交互元素（input / textarea / select / button / 链接）：类型、名字、占位符、文本，并给出现成的 CSS 选择器——直接喂给 browser_click / browser_type。",
        parameters: {
          type: "object",
          properties: { max: { type: "number", description: "最多列几个（默认 60，上限 200）" } },
          additionalProperties: false,
        },
        execute: run("browser_elements"),
      },
    );
  }

  if (families.has("browser.act")) {
    tools.push(
      {
        name: "browser_click",
        label: "点击",
        description: "点击一个元素（CSS 选择器，browser_elements 会给现成的）。",
        parameters: {
          type: "object",
          properties: { selector: { type: "string", description: "CSS 选择器" } },
          required: ["selector"],
          additionalProperties: false,
        },
        execute: run("browser_click"),
      },
      {
        name: "browser_type",
        label: "输入",
        description: "往一个输入框里打字。clear 先清空；submit 打完按回车。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS 选择器" },
            text: { type: "string", description: "要打的字" },
            clear: { type: "boolean", description: "先清空（默认追加）" },
            submit: { type: "boolean", description: "打完按回车" },
          },
          required: ["selector", "text"],
          additionalProperties: false,
        },
        execute: run("browser_type"),
      },
      {
        name: "browser_press",
        label: "按键",
        description: "按一个键（Enter / Tab / Escape / ArrowDown …）。",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "键名" } },
          required: ["key"],
          additionalProperties: false,
        },
        execute: run("browser_press"),
      },
      {
        name: "browser_eval",
        label: "执行 JS",
        description: "在页面上下文执行一段 JS，返回值净化成 JSON（限 64 KB）。snapshot / elements 不够用时的精确手段。",
        parameters: {
          type: "object",
          properties: { code: { type: "string", description: "JS 表达式或语句（其返回值会被带回）" } },
          required: ["code"],
          additionalProperties: false,
        },
        execute: run("browser_eval"),
      },
    );
  }

  if (families.has("browser.artifact")) {
    tools.push(
      {
        name: "browser_screenshot",
        label: "截图",
        description: `把当前页截图存进工作区 ${SHOT_DIR}/（自动清理：7 天 / 200 张）。给人看的；模型读页面用 browser_snapshot。`,
        parameters: {
          type: "object",
          properties: { full_page: { type: "boolean", description: "整页长图（默认视口）" } },
          additionalProperties: false,
        },
        execute: run("browser_screenshot"),
      },
      {
        name: "browser_download",
        label: "下载",
        description: "把一个 URL 的内容下载进工作区（经页面上下文发请求，带着当前 Cookie——登录后的文件也拿得到）。单文件上限 200 MB。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要下载的 URL" },
            save_as: { type: "string", description: "存成的相对路径（默认按 URL 尾段取名，落工作区根）" },
          },
          required: ["url"],
          additionalProperties: false,
        },
        execute: run("browser_download"),
      },
    );
  }

  return tools;
}
