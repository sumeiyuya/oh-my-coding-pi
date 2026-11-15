/**
 * PDF 工具（office.pdf 族）。
 *
 * 生成：pdf-lib + fontkit，内嵌系统 CJK 字体（等线 Deng.ttf 优先）。
 * 读取：pdfjs-dist legacy（不需要 DOM）。
 * 合并/拆分：pdf-lib 的 copyPages。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, StandardFonts, type PDFFont } from "pdf-lib";
import { displayPath, resolveInside } from "./paths";

type Block = {
  type: string;
  text?: string;
  headers?: string[];
  rows?: string[][];
  items?: string[];
  ordered?: boolean;
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;

const FONT_CANDIDATES = [
  "C:/Windows/Fonts/Deng.ttf",
  "C:/Windows/Fonts/SimsunExtG.ttf",
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/arial.ttf",
];

function pickFontFile(): string | null {
  for (const candidate of FONT_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

/** 按可用宽度折行：中文逐字、拉丁按词，超宽再硬切。 */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text).split("\n")) {
    if (!rawLine) {
      out.push("");
      continue;
    }
    let line = "";
    for (const ch of Array.from(rawLine)) {
      const next = line + ch;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export async function pdfCreate(params: {
  destination_path: string;
  title?: string;
  content: Block[] | string;
  page_numbers?: boolean;
}): Promise<string> {
  const blocks: Block[] =
    typeof params.content === "string" ? [{ type: "paragraph", text: params.content }] : (params.content ?? []);
  if (blocks.length === 0) throw new Error("content 不能为空");
  const file = resolveInside(String(params.destination_path));

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontFile = pickFontFile();
  let body: PDFFont;
  let bold: PDFFont;
  let cjk = false;
  if (fontFile && !fontFile.endsWith(".ttc")) {
    const bytes = readFileSync(fontFile);
    body = await doc.embedFont(bytes, { subset: true });
    bold = body;
    cjk = true;
  } else {
    body = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (need: number) => {
    if (y - need < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const write = (text: string, size: number, opts: { bold?: boolean; indent?: number } = {}) => {
    const font = opts.bold ? bold : body;
    const indent = opts.indent ?? 0;
    const width = PAGE_W - MARGIN * 2 - indent;
    for (const line of wrap(text, font, size, width)) {
      ensure(size + 4);
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color: rgb(0.1, 0.12, 0.16) });
      y -= size + 4;
    }
  };

  if (params.title) {
    write(String(params.title), 20, { bold: true });
    y -= 6;
  }

  for (const block of blocks) {
    const type = String(block.type ?? "paragraph");
    if (type === "heading") {
      y -= 6;
      write(String(block.text ?? ""), 18, { bold: true });
      y -= 4;
    } else if (type === "h2") {
      y -= 4;
      write(String(block.text ?? ""), 15, { bold: true });
      y -= 2;
    } else if (type === "h3") {
      y -= 2;
      write(String(block.text ?? ""), 13, { bold: true });
    } else if (type === "code") {
      write(String(block.text ?? ""), 9);
      y -= 4;
    } else if (type === "list") {
      (block.items ?? []).forEach((item, i) => {
        write(`${block.ordered ? `${i + 1}.` : "•"} ${item}`, 11, { indent: 12 });
      });
      y -= 4;
    } else if (type === "table") {
      const headers = block.headers ?? [];
      const rows = block.rows ?? [];
      const all = headers.length ? [headers, ...rows] : rows;
      const cols = Math.max(1, ...all.map((r) => r.length));
      const colW = (PAGE_W - MARGIN * 2) / cols;
      const size = cols > 6 ? 7 : cols > 4 ? 8 : 9;
      for (let r = 0; r < all.length; r++) {
        const cells = all[r];
        const cellLines = cells.map((c) => wrap(String(c ?? ""), body, size, colW - 6)[0] ?? "");
        const rowH = size + 6;
        ensure(rowH);
        for (let c = 0; c < cols; c++) {
          const x = MARGIN + c * colW;
          page.drawRectangle({
            x,
            y: y - rowH + 2,
            width: colW,
            height: rowH,
            borderColor: rgb(0.8, 0.84, 0.88),
            borderWidth: 0.5,
            color: r === 0 && headers.length ? rgb(0.92, 0.94, 0.97) : undefined,
          });
          page.drawText(cellLines[c] ?? "", { x: x + 3, y: y - size, size, font: body });
        }
        y -= rowH;
      }
      y -= 6;
    } else {
      write(String(block.text ?? ""), 11);
      y -= 4;
    }
  }

  if (params.page_numbers) {
    const pages = doc.getPages();
    pages.forEach((p, i) => {
      p.drawText(`${i + 1} / ${pages.length}`, {
        x: PAGE_W / 2 - 16,
        y: 24,
        size: 9,
        font: body,
        color: rgb(0.4, 0.44, 0.5),
      });
    });
  }

  const bytes = await doc.save();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return `已生成 ${displayPath(file)}（${doc.getPageCount()} 页，字体：${cjk ? (fontFile ?? "").split("/").pop() : "Helvetica（未找到中文字体）"}）`;
}

export async function pdfRead(params: {
  file_path: string;
  start_page?: number;
  end_page?: number;
}): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const start = Math.max(1, Math.floor(params.start_page ?? 1));
  const end = Math.min(doc.numPages, Math.floor(params.end_page ?? doc.numPages));
  const lines: string[] = [`文件：${displayPath(file)}`, `共 ${doc.numPages} 页，读 ${start}-${end} 页`, ""];

  let budget = 8000;
  for (let p = start; p <= end; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("")
      .replace(/[ \t]+/g, " ")
      .trim();
    lines.push(`--- Page ${p} ---`, text || "（本页没有可抽取文本，可能是图片扫描件）", "");
    budget -= text.length;
    if (budget <= 0) {
      lines.push("（已截断：文本超长，请用 start_page/end_page 分段读）");
      break;
    }
  }
  return lines.join("\n");
}

export async function pdfMerge(params: { files: string[]; output_path: string }): Promise<string> {
  const files = (params.files ?? []).map((f) => resolveInside(String(f)));
  if (files.length < 2) throw new Error("至少需要两个 PDF");
  const out = await PDFDocument.create();
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
    const src = await PDFDocument.load(readFileSync(file));
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  const target = resolveInside(String(params.output_path));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await out.save());
  return `已合并 ${files.length} 个 PDF → ${displayPath(target)}（${out.getPageCount()} 页）`;
}

function parsePages(spec: string, total: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`页范围写法不对：${part}`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let p = from; p <= to; p++) if (p >= 1 && p <= total) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function pdfSplit(params: {
  file_path: string;
  output_dir: string;
  pages?: string;
}): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);
  const src = await PDFDocument.load(readFileSync(file));
  const total = src.getPageCount();
  const dir = resolveInside(String(params.output_dir));
  mkdirSync(dir, { recursive: true });

  const wanted = params.pages ? parsePages(String(params.pages), total) : Array.from({ length: total }, (_, i) => i + 1);
  if (wanted.length === 0) throw new Error("没有可拆的页");

  const written: string[] = [];
  for (const p of wanted) {
    const one = await PDFDocument.create();
    const [copied] = await one.copyPages(src, [p - 1]);
    one.addPage(copied);
    const target = join(dir, `page-${String(p).padStart(3, "0")}.pdf`);
    writeFileSync(target, await one.save());
    written.push(target);
  }
  return `已拆出 ${written.length} 页 → ${displayPath(dir)}（原文件 ${total} 页）`;
}
