/**
 * 插件册（ADR-045）：唯一的插件/族/工具定义来源。
 *
 * 约束：
 * - 本文件**零 import**。它同时被三方使用——
 *   1. 扩展进程（jiti 相对路径加载，资源目录里没有 node_modules）；
 *   2. 主进程（构建期内联，打包后不依赖运行期路径）；
 *   3. 渲染进程通过主进程的 plugins:list 拿到的就是这份数据。
 *   任何 import 都会让其中一方在打包后崩掉。
 * - 工具名与方案表格逐字一致，不改名（改名等于换 API）。
 *
 * 开关语义照 DAWN：`<键>` 整包、`<族键>` 单族，存的值 "1" 表示关；
 * 未存过时用 defaultOn（插件默认 off，见 ADR-044）。
 */

export interface PluginToolDef {
  name: string;
  label: string;
  description: string;
  /** false = 本批未实现，开关里显示「未实现」且不会注册（默认 true） */
  ready?: boolean;
}

export interface PluginFamilyDef {
  key: string;
  name: string;
  tools: PluginToolDef[];
}

export interface PluginDef {
  id: string;
  name: string;
  /** 设置文件里的整包开关键，如 plugin.memory */
  key: string;
  defaultOn: boolean;
  families: PluginFamilyDef[];
}

const SUBAGENT_PLUGIN: PluginDef = {
  id: "subagent",
  name: "子任务",
  key: "plugin.subagent",
  defaultOn: false,
  families: [
    {
      key: "subagent",
      name: "子任务",
      tools: [
        {
          name: "subagent",
          label: "子任务",
          description:
            "Delegate a task to a specialized subagent (its own pi process, isolated context). Modes: single / parallel (max 8 tasks, 4 at a time) / chain with {previous}. Global concurrency is capped in the app so parallel sessions cannot flood the provider.",
        },
      ],
    },
  ],
};

const MEMORY_PLUGIN: PluginDef = {
  id: "memory",
  name: "记忆",
  key: "plugin.memory",
  defaultOn: false,
  families: [
    {
      key: "memory.propose",
      name: "提议",
      tools: [
        {
          name: "memory_propose",
          label: "提议记忆",
          description:
            "Propose a long-lived fact for the user to confirm (project conventions,口径 decisions, architecture,踩坑结论). Goes to a pending queue in the app data directory; it takes effect only after the user adopts it. Do not use for progress notes or one-off details.",
        },
      ],
    },
    {
      key: "memory.list",
      name: "查看",
      tools: [
        {
          name: "memory_list",
          label: "查看记忆",
          description:
            "List proposed and adopted memories (optionally filtered). Use before proposing something that may already be recorded.",
        },
      ],
    },
    {
      key: "memory.skill",
      name: "技能沉淀",
      tools: [
        {
          name: "skill_propose",
          label: "沉淀技能",
          description:
            "Propose a reusable workflow as an Agent Skill (name + SKILL.md body). The user adopts it before anything is written to .agents/skills/. Only for procedures that will be repeated.",
        },
      ],
    },
  ],
};

const OFFICE_PLUGIN: PluginDef = {
  id: "office",
  name: "Office 文档",
  key: "plugin.office",
  defaultOn: false,
  families: [
    {
      key: "office.xlsx",
      name: "电子表格",
      tools: [
        { name: "xlsx_read", label: "读表格", description: "Read a .xlsx file: list sheets or read one sheet as a markdown table (file_path, sheet, range_start/range_end, max_rows)." },
        { name: "xlsx_write", label: "写表格", description: "Create or overwrite a .xlsx workbook from a 2D array; optional header_bold, column_widths, number_formats, formulas." },
        { name: "xlsx_edit", label: "改表格", description: "Edit an existing .xlsx: add sheets, update cells (value or formula), append rows; saves back unless output_path is given." },
        { name: "xlsx_recalc", label: "重算公式", description: "Recalculate every formula with a lightweight engine and report error values (#REF!/#DIV/0! ...). Unsupported functions are reported as warnings." },
        { name: "xlsx_audit", label: "审公式", description: "Statically inspect formula structure: array-formula traps, ranges that miss an adjacent row, hardcoded values in formula columns, self-references, literal division by zero." },
      ],
    },
    {
      key: "office.pdf",
      name: "PDF",
      tools: [
        { name: "pdf_create", label: "生成 PDF", description: "Generate a real PDF with headings, paragraphs, tables, lists and code blocks; CJK via an auto-detected system font." },
        { name: "pdf_read", label: "读 PDF", description: "Extract text from a PDF page range for reading into context." },
        { name: "pdf_merge", label: "合并 PDF", description: "Merge two or more PDFs into one, in the given order." },
        { name: "pdf_split", label: "拆分 PDF", description: "Split a PDF into single-page files, or extract specific pages." },
      ],
    },
    {
      key: "office.ppt",
      name: "演示文稿",
      tools: [
        { name: "pptx_create", label: "生成 PPT", description: "Generate a .pptx from slide definitions (title/section/content/two-column/image/table/chart) with an optional theme." },
        { name: "pptx_edit", label: "改 PPT", description: "Find/replace text runs in an existing .pptx while preserving layout and styling." },
        { name: "pptx_read", label: "读 PPT", description: "Extract slide text and optional structure (shapes, images, tables) from a .pptx." },
      ],
    },
    {
      key: "office.docx",
      name: "Word 文档",
      tools: [
        { name: "docx_create", label: "生成 Word", description: "Generate a .docx from content blocks (headings, paragraphs, tables, lists, code); optional background color and watermark." },
        { name: "docx_read", label: "读 Word", description: "Extract plain text from a .docx for reading into context." },
      ],
    },
  ],
};

const BROWSER_PLUGIN: PluginDef = {
  id: "browser",
  name: "浏览器",
  key: "plugin.browser",
  defaultOn: false,
  families: [
    {
      key: "browser.navigate",
      name: "浏览",
      tools: [
        { name: "browser_open", label: "打开", description: "Open a URL in the shared headless browser (reuses system Edge/Chrome)." },
        { name: "browser_tabs", label: "标签", description: "List, switch or close tabs." },
        { name: "browser_back", label: "后退", description: "Go back one page." },
        { name: "browser_reload", label: "刷新", description: "Reload the current page." },
        { name: "browser_wait", label: "等待", description: "Wait for a selector or a fixed delay." },
        { name: "browser_status", label: "状态", description: "Report whether the browser is open, tab count and current URL." },
        { name: "browser_close", label: "关闭", description: "Close the shared browser." },
      ],
    },
    {
      key: "browser.read",
      name: "读页",
      tools: [
        { name: "browser_snapshot", label: "读正文", description: "Read the current page as plain text plus a bounded link list." },
        { name: "browser_elements", label: "找元素", description: "List interactive elements with ready-to-use CSS selectors." },
      ],
    },
    {
      key: "browser.act",
      name: "操作",
      tools: [
        { name: "browser_click", label: "点击", description: "Click an element by CSS selector." },
        { name: "browser_type", label: "输入", description: "Type into an input; optional clear and submit." },
        { name: "browser_press", label: "按键", description: "Press a key (Enter/Tab/Escape/ArrowDown ...)." },
        { name: "browser_eval", label: "执行 JS", description: "Evaluate JavaScript in the page context and return a JSON-safe value." },
      ],
    },
    {
      key: "browser.artifact",
      name: "产物",
      tools: [
        { name: "browser_screenshot", label: "截图", description: "Screenshot the viewport or full page into the workspace screenshots directory." },
        { name: "browser_download", label: "下载", description: "Download a URL into the workspace (carries the page cookies)." },
      ],
    },
  ],
};

/** 分期刊出的插件都登记在这里；Office 与浏览器等决策门结论（ADR-044）。 */
export const PLUGINS: PluginDef[] = [MEMORY_PLUGIN, OFFICE_PLUGIN, BROWSER_PLUGIN, SUBAGENT_PLUGIN];

export type PluginFlags = Record<string, string>;

function off(flags: PluginFlags | undefined, key: string): boolean {
  return flags?.[key] === "1";
}

/** 显式值优先于默认值：三态（未存 / "0" 开 / "1" 关），否则默认关的插件永远打不开。 */
export function pluginEnabled(plugin: PluginDef, flags: PluginFlags | undefined): boolean {
  const stored = flags?.[plugin.key];
  if (stored === "1") return false;
  if (stored === "0") return true;
  return plugin.defaultOn;
}

export function familyEnabled(
  plugin: PluginDef,
  familyKey: string,
  flags: PluginFlags | undefined,
): boolean {
  if (!pluginEnabled(plugin, flags)) return false;
  return flags?.[familyKey] !== "1";
}

/** 下发给扩展的族键列表（只有真正要注册的族才在里面）。 */
export function enabledFamilyKeys(flags: PluginFlags | undefined): string[] {
  const out: string[] = [];
  for (const plugin of PLUGINS) {
    if (!pluginEnabled(plugin, flags)) continue;
    for (const family of plugin.families) {
      if (!off(flags, family.key)) out.push(family.key);
    }
  }
  return out;
}

/** 插件默认值的显式表（主进程写进 settings.json，渲染进程据此画开关）。 */
export function defaultFlags(): PluginFlags {
  const out: PluginFlags = {};
  for (const plugin of PLUGINS) {
    out[plugin.key] = plugin.defaultOn ? "0" : "1";
    for (const family of plugin.families) out[family.key] = "0";
  }
  return out;
}
