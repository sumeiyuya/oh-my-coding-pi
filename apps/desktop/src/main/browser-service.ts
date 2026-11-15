/**
 * 浏览器服务（主进程）。
 *
 * 为什么不在 pi 扩展里跑：扩展由 jiti 加载，jiti 转译 playwright-core 的 CJS 会让
 * graceful-fs 二次初始化（`Cannot redefine property: Symbol(graceful-fs.queue)`），
 * 裸 require 也一样。主进程不是 jiti，直接 require payload 里的真实目录即可。
 *
 * 形态照 kernel broker / policy service：127.0.0.1 + 一次性 token，扩展侧只发
 * `POST /call {tool,args}`，所有页面逻辑留在这里。
 *
 * 语义照 DAWN 的 src/tools/browser/*：共享一台无头浏览器（msedge → chrome → chromium），
 * 产物只落工作区，goto 失败关掉空白标签。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

const NAV_TIMEOUT = 15_000;
const ACTION_TIMEOUT = 10_000;
const MAX_WAIT = 10_000;
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_EVAL_BYTES = 64 * 1024;
const SHOT_DIR = ".omcp/screenshots";
const MAX_SHOTS = 200;
const MAX_SHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------ 纯函数（可单测） ------------------------------ */

export function resolveInWorkspace(input: string, root: string): string {
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`拒绝：路径在工作区之外（${input}）`);
  return target;
}

export function downloadFileName(url: string, saveAs?: string): string {
  const tail = url.split("/").pop()?.split("?")[0]?.trim();
  const name = String(saveAs ?? "").trim() || (tail && tail.length > 0 ? tail : "下载文件");
  if (name === "." || name === ".." || /[<>:"|?*\u0000-\u001f]/.test(name)) {
    throw new Error(`保存名不合法：${name}`);
  }
  return name;
}

export function sanitizeEvalValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[深度截断]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[循环引用]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeEvalValue(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) out[k] = sanitizeEvalValue(v, depth + 1, seen);
    return out;
  }
  return String(value);
}

export function evalResultText(value: unknown): string {
  const text = JSON.stringify(sanitizeEvalValue(value), null, 1) ?? "undefined";
  if (Buffer.byteLength(text, "utf8") > MAX_EVAL_BYTES) {
    throw new Error(`返回值超过 ${MAX_EVAL_BYTES / 1024} KB；请只取需要的字段`);
  }
  return text;
}

/* ------------------------------ 会话层 ------------------------------ */

interface Tab {
  id: string;
  page: Page;
}

export interface BrowserServiceOptions {
  /** playwright-core 的真实目录（打包态是 resources/plugin-ext/payload/node_modules/playwright-core） */
  playwrightDir: string;
  getWorkspace: () => string;
  onError?: (message: string) => void;
}

export class BrowserService {
  private server: Server | null = null;
  private browser: Browser | null = null;
  private starting: Promise<Browser> | null = null;
  private closing: Promise<void> | null = null;
  private generation = 0;
  private channel = "";
  private tabs = new Map<string, Tab>();
  private activeTab: string | null = null;
  private counter = 0;

  url = "";
  token = "";

  private readonly opts: BrowserServiceOptions;

  constructor(opts: BrowserServiceOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token = randomBytes(24).toString("hex");
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      });
    });
    await new Promise<void>((resolveStart) => {
      this.server!.listen(0, "127.0.0.1", () => resolveStart());
    });
    const addr = this.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await this.closeBrowser().catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/call") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    const body = await new Promise<string>((ok, fail) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 2_000_000) fail(new Error("request too large"));
      });
      req.on("end", () => ok(data));
      req.on("error", fail);
    });
    const payload = JSON.parse(body) as { tool?: string; args?: Record<string, unknown> };
    try {
      const text = await this.call(String(payload.tool ?? ""), payload.args ?? {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, text }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.onError?.(message);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  /* -------- 浏览器与标签 -------- */

  private async loadChromium(): Promise<(typeof import("playwright-core"))["chromium"]> {
    const dir = this.opts.playwrightDir;
    const req = createRequire(`${dir}/package.json`);
    const mod = req(dir) as typeof import("playwright-core");
    return mod.chromium;
  }

  private async launch(): Promise<Browser> {
    const chromium = await this.loadChromium();
    const errors: string[] = [];
    for (const channel of ["msedge", "chrome"] as const) {
      try {
        const b = await chromium.launch({ channel, headless: true });
        this.channel = channel;
        return b;
      } catch (err) {
        errors.push(`${channel}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
      }
    }
    try {
      const b = await chromium.launch({ headless: true });
      this.channel = "chromium";
      return b;
    } catch (err) {
      errors.push(`chromium: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
    throw new Error(
      `本机没探测到可用的浏览器（试过 Edge / Chrome / Chromium）。装一个 Edge 或 Chrome，` +
        `或跑 npx playwright install chromium。\n${errors.join("\n")}`,
    );
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.closing) await this.closing;
    if (this.browser?.isConnected()) return this.browser;
    return (this.starting ??= this.launch()
      .then((b) => {
        this.browser = b;
        return b;
      })
      .finally(() => {
        this.starting = null;
      }));
  }

  private async openTab(url?: string, newTab = true): Promise<Tab> {
    const gen = this.generation;
    const b = await this.ensureBrowser();
    const page = await b.newPage();
    if (gen !== this.generation || !b.isConnected()) {
      await page.close().catch(() => undefined);
      throw new Error("浏览器已关闭，请重新打开");
    }
    const id = `tab-${++this.counter}`;
    const tab: Tab = { id, page };
    this.tabs.set(id, tab);
    this.activeTab = id;
    page.on("close", () => {
      this.tabs.delete(id);
      if (this.activeTab === id) this.activeTab = [...this.tabs.keys()].at(-1) ?? null;
    });
    if (url) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } catch (err) {
        await page.close().catch(() => undefined);
        throw err;
      }
    }
    return tab;
  }

  private async ensurePage(): Promise<Page> {
    const t = this.activeTab ? this.tabs.get(this.activeTab) : undefined;
    if (t && !t.page.isClosed()) return t.page;
    return (await this.openTab(undefined, true)).page;
  }

  private async closeBrowser(): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    this.closing = (async () => {
      const b = this.starting ? await this.starting.catch(() => null) : this.browser;
      await b?.close().catch(() => undefined);
      this.browser = null;
      this.tabs.clear();
      this.activeTab = null;
      this.channel = "";
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async selectorFor(page: Page, index: number): Promise<string> {
    return page.evaluate((i: number) => {
      const all = [...document.querySelectorAll("a[href], input, textarea, select, button, [role=button]")];
      const el = all[i] as HTMLElement | undefined;
      if (!el) return "";
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testid = el.getAttribute("data-testid");
      if (testid) return `[data-testid="${testid}"]`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const href = el.getAttribute("href");
      if (el.tagName === "A" && href && href.length < 120) return `a[href="${href}"]`;
      const parts: string[] = [];
      let cur: HTMLElement | null = el;
      for (let depth = 0; cur && depth < 4; depth++) {
        let part = cur.tagName.toLowerCase();
        const parent: HTMLElement | null = cur.parentElement;
        if (parent) {
          const self = cur;
          const same = [...parent.children].filter((c) => c.tagName === self.tagName);
          const idx = same.indexOf(self);
          if (same.length > 1 && idx >= 0) part += `:nth-of-type(${idx + 1})`;
        }
        parts.unshift(part);
        if (cur.id) {
          parts[0] = `#${CSS.escape(cur.id)}`;
          break;
        }
        cur = parent;
      }
      return parts.join(" > ");
    }, index);
  }

  private cleanupShots(dir: string): number {
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ full: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    let removed = 0;
    files.forEach((f, i) => {
      if (i >= MAX_SHOTS || Date.now() - f.at > MAX_SHOT_AGE_MS) {
        try {
          rmSync(f.full);
          removed++;
        } catch {
          /* 清理失败不影响主流程 */
        }
      }
    });
    return removed;
  }

  /* -------- 工具分派 -------- */

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const root = this.opts.getWorkspace();
    switch (tool) {
      case "browser_open": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("URL 必须以 http(s):// 开头");
        if (args.new_tab === false) {
          const page = await this.ensurePage();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
          return `已打开 ${url}\n标题：${await page.title()}`;
        }
        const tab = await this.openTab(url, true);
        return `已在新标签 ${tab.id} 打开 ${url}\n标题：${await tab.page.title()}`;
      }
      case "browser_tabs": {
        const action = String(args.action ?? "");
        if (action === "list") {
          const list = [...this.tabs.values()].map((t) => ({
            id: t.id,
            url: t.page.url() || "about:blank",
            active: t.id === this.activeTab,
          }));
          if (list.length === 0) return "还没有标签。用 browser_open 打开一个。";
          return list.map((t) => `${t.active ? "▶ " : "  "}${t.id}  ${t.url}`).join("\n");
        }
        const id = String(args.id ?? "");
        if (!id) throw new Error(`${action} 需要 id`);
        if (action === "switch") {
          if (!this.tabs.has(id)) throw new Error(`没有这个标签：${id}`);
          this.activeTab = id;
          return `已切到 ${id}`;
        }
        if (action === "close") {
          const t = this.tabs.get(id);
          if (!t) throw new Error(`没有这个标签：${id}`);
          await t.page.close().catch(() => undefined);
          return `已关闭 ${id}`;
        }
        throw new Error(`未知 action：${action}`);
      }
      case "browser_back": {
        const page = await this.ensurePage();
        await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => undefined);
        return `现在在 ${page.url()}`;
      }
      case "browser_reload": {
        const page = await this.ensurePage();
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        return `已刷新 ${page.url()}`;
      }
      case "browser_wait": {
        const page = await this.ensurePage();
        if (args.selector) {
          await page.waitForSelector(String(args.selector), { timeout: MAX_WAIT });
          return `等到了 ${args.selector}`;
        }
        const ms = Math.max(0, Math.min(MAX_WAIT, Math.floor(Number(args.ms ?? 1000))));
        await page.waitForTimeout(ms);
        return `等了 ${ms} ms`;
      }
      case "browser_status": {
        const t = this.activeTab ? this.tabs.get(this.activeTab) : undefined;
        const open = Boolean(this.browser?.isConnected());
        return open
          ? `浏览器开着（${this.channel}），${this.tabs.size} 个标签\n当前：${t && !t.page.isClosed() ? t.page.url() : "about:blank"}`
          : "浏览器没开。第一次用工具时会自动启动。";
      }
      case "browser_close":
        await this.closeBrowser();
        return "浏览器已关。";
      case "browser_snapshot": {
        const page = await this.ensurePage();
        const maxText = Math.max(500, Math.min(40000, Math.floor(Number(args.max_text ?? 8000))));
        const maxLinks = Math.max(1, Math.min(200, Math.floor(Number(args.max_links ?? 40))));
        const data = await page.evaluate(
          ({ maxText, maxLinks }: { maxText: number; maxLinks: number }) => {
            const body = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
            const links = [...document.querySelectorAll("a[href]")]
              .map((a) => {
                const el = a as HTMLAnchorElement;
                return { text: (el.innerText || el.href).trim().slice(0, 120), href: el.href };
              })
              .filter((l) => l.href.startsWith("http"))
              .slice(0, maxLinks);
            return {
              title: document.title,
              url: location.href,
              text: body.slice(0, maxText),
              truncated: body.length > maxText,
              totalChars: body.length,
              links,
              inputs: document.querySelectorAll("input, textarea, select").length,
            };
          },
          { maxText, maxLinks },
        );
        const lines = [`${data.title || "（无标题）"}`, data.url, "", data.text || "（没有可见正文）"];
        if (data.truncated) lines.push("", `（正文已截断：共 ${data.totalChars} 字符，只显示前 ${maxText}）`);
        if (data.links.length) {
          lines.push("", `链接（${data.links.length}）：`);
          for (const l of data.links) lines.push(`- ${l.text} → ${l.href}`);
        }
        lines.push("", `输入框 ${data.inputs} 个；要精确操作请用 browser_elements 拿选择器。`);
        return lines.join("\n");
      }
      case "browser_elements": {
        const page = await this.ensurePage();
        const max = Math.max(1, Math.min(200, Math.floor(Number(args.max ?? 60))));
        const items = await page.evaluate((max: number) => {
          const nodes = [...document.querySelectorAll("a[href], input, textarea, select, button, [role=button]")].slice(0, max);
          return nodes.map((n) => {
            const el = n as HTMLElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type") ?? "",
              name: el.getAttribute("name") ?? "",
              placeholder: el.getAttribute("placeholder") ?? "",
              text: (el.innerText ?? "").trim().slice(0, 80),
              href: el.getAttribute("href") ?? "",
            };
          });
        }, max);
        if (items.length === 0) return "没有找到可交互元素。先用 browser_snapshot 看看页面是否加载成功。";
        const lines = [`可交互元素（${items.length}）：`];
        for (let i = 0; i < items.length; i++) {
          const it = items[i]!;
          const sel = await this.selectorFor(page, i);
          const label = it.text || it.name || it.placeholder || it.href || "";
          lines.push(`- ${it.tag}${it.type ? `[${it.type}]` : ""} ${label.slice(0, 60)}  →  ${sel}`);
        }
        return lines.join("\n");
      }
      case "browser_click": {
        const page = await this.ensurePage();
        await page.click(String(args.selector), { timeout: ACTION_TIMEOUT });
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        return `点了 ${args.selector}\n现在在 ${page.url()}`;
      }
      case "browser_type": {
        const page = await this.ensurePage();
        const sel = String(args.selector);
        if (args.clear) await page.fill(sel, String(args.text), { timeout: ACTION_TIMEOUT });
        else {
          await page.click(sel, { timeout: ACTION_TIMEOUT });
          await page.keyboard.type(String(args.text));
        }
        if (args.submit) await page.keyboard.press("Enter");
        return `已输入。现在在 ${page.url()}`;
      }
      case "browser_press": {
        const page = await this.ensurePage();
        await page.keyboard.press(String(args.key));
        return `按了 ${args.key}`;
      }
      case "browser_eval": {
        const page = await this.ensurePage();
        const value = await page.evaluate((code: string) => eval(code) as unknown, String(args.code));
        return evalResultText(value);
      }
      case "browser_screenshot": {
        const page = await this.ensurePage();
        const dir = resolveInWorkspace(SHOT_DIR, root);
        mkdirSync(dir, { recursive: true });
        const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        await page.screenshot({ path: join(dir, name), fullPage: args.full_page === true });
        const cleaned = this.cleanupShots(dir);
        return `截图存到 ${SHOT_DIR}/${name}${cleaned > 0 ? `（顺手清了 ${cleaned} 张过期的）` : ""}`;
      }
      case "browser_download": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("URL 必须以 http(s):// 开头");
        const page = await this.ensurePage();
        const resp = await page.request.get(url, { timeout: 30_000 });
        if (!resp.ok()) throw new Error(`下载失败：HTTP ${resp.status()} ${url}`);
        const declared = Number(resp.headers()["content-length"] ?? 0);
        if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`文件太大：${Math.round(declared / 1024 / 1024)} MB，上限 200 MB`);
        const body = await resp.body();
        if (body.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new Error(`文件太大：${Math.round(body.byteLength / 1024 / 1024)} MB，上限 200 MB`);
        }
        const name = downloadFileName(url, args.save_as as string | undefined);
        const target = resolveInWorkspace(name, root);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
        return `已下载 ${body.byteLength} 字节 → ${name}`;
      }
      default:
        throw new Error(`未知工具：${tool}`);
    }
  }
}

export const browserLimits = { NAV_TIMEOUT, ACTION_TIMEOUT, MAX_WAIT, MAX_DOWNLOAD_BYTES, MAX_EVAL_BYTES };
export type { Browser, BrowserContext, Page };
