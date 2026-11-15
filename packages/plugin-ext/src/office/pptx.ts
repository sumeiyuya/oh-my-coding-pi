/**
 * 演示文稿工具（office.ppt 族）。
 * 生成用 pptxgenjs；读取与文本替换用 jszip 直接改 slide XML。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { displayPath, resolveInside } from "./paths";

type Slide = {
  type: string;
  title?: string;
  body?: string;
  items?: string[];
  image?: string;
  headers?: string[];
  rows?: string[][];
  chart?: string;
  data?: Array<{ name: string; labels: string[]; values: number[] }>;
  notes?: string;
};

export async function pptxCreate(params: {
  destination_path: string;
  title?: string;
  slides: Slide[];
}): Promise<string> {
  const slides = params.slides ?? [];
  if (slides.length === 0) throw new Error("slides 不能为空");
  const file = resolveInside(String(params.destination_path));
  if (params.destination_path && file !== resolveInside(String(params.destination_path))) {
    throw new Error("路径异常");
  }

  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  if (params.title) pptx.title = String(params.title);

  slides.forEach((slide, index) => {
    const page = pptx.addSlide();
    const type = String(slide.type ?? "content");
    if (type === "title") {
      page.addText(String(slide.title ?? params.title ?? `Slide ${index + 1}`), {
        x: 0.8,
        y: 2.0,
        w: 8.4,
        h: 1.2,
        fontSize: 34,
        bold: true,
      });
      if (slide.body) page.addText(String(slide.body), { x: 0.8, y: 3.2, w: 8.4, h: 1.0, fontSize: 16 });
    } else if (type === "section") {
      page.addText(String(slide.title ?? ""), { x: 0.8, y: 2.2, w: 8.4, h: 1.0, fontSize: 30, bold: true });
      if (slide.body) page.addText(String(slide.body), { x: 0.8, y: 3.2, w: 8.4, h: 1.0, fontSize: 15 });
    } else if (type === "table") {
      if (slide.title) page.addText(String(slide.title), { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 22, bold: true });
      const rows = [slide.headers ?? [], ...(slide.rows ?? [])].filter((r) => r.length > 0);
      if (rows.length) {
        page.addTable(
          rows.map((cells, r) =>
            cells.map((cell) => ({
              text: String(cell ?? ""),
              options: r === 0 ? { bold: true, fill: "E8EEF7" } : {},
            })) as never,
          ),
          { x: 0.5, y: 1.1, w: 9, fontSize: 12, border: { pt: 1, color: "CBD5E1" } } as never,
        );
      }
    } else if (type === "image") {
      if (slide.title) page.addText(String(slide.title), { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 22, bold: true });
      if (!slide.image) throw new Error("image 幻灯片需要 image 路径");
      const imagePath = resolveInside(String(slide.image));
      if (!existsSync(imagePath)) throw new Error(`图片不存在：${slide.image}`);
      page.addImage({ path: imagePath, x: 0.9, y: 1.1, w: 8.2, h: 4.1, sizing: { type: "contain", w: 8.2, h: 4.1 } });
    } else if (type === "chart") {
      if (slide.title) page.addText(String(slide.title), { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 22, bold: true });
      const series = slide.data ?? [];
      if (!series.length) throw new Error("chart 幻灯片需要 data");
      const kind = String(slide.chart ?? "bar");
      const chartType =
        kind === "line" ? pptx.ChartType.line : kind === "pie" ? pptx.ChartType.pie : pptx.ChartType.bar;
      page.addChart(
        chartType,
        series.map((s) => ({ name: s.name, labels: s.labels, values: s.values })),
        { x: 0.7, y: 1.1, w: 8.6, h: 4.2 },
      );
    } else {
      if (slide.title) page.addText(String(slide.title), { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 24, bold: true });
      if (slide.body) page.addText(String(slide.body), { x: 0.6, y: 1.0, w: 8.8, h: 0.8, fontSize: 14 });
      if (slide.items?.length) {
        page.addText(
          slide.items.map((item) => ({ text: String(item), options: { bullet: true, fontSize: 14 } })),
          { x: 0.7, y: 1.7, w: 8.6, h: 3.8 },
        );
      }
    }
    if (slide.notes) page.addNotes(String(slide.notes));
  });

  mkdirSync(dirname(file), { recursive: true });
  const data = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  writeFileSync(file, data);
  return `已生成 ${displayPath(file)}（${slides.length} 页）`;
}

function slideIndex(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

export async function pptxRead(params: { file_path: string; include?: string }): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);
  const zip = await JSZip.loadAsync(readFileSync(file));
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
  if (slides.length === 0) throw new Error("不是有效的 .pptx（没有 slide）");

  const wantStructure = String(params.include ?? "").includes("summary");
  const images = Object.keys(zip.files).filter((n) => /^ppt\/media\//.test(n));
  const lines: string[] = [`文件：${displayPath(file)}`, `幻灯片 ${slides.length} 页`, ""];

  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i])!.async("string");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
      m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim(),
    );
    lines.push(`## Slide ${i + 1}`, texts.filter(Boolean).join("\n") || "（无文本）", "");
    if (wantStructure) {
      const tables = (xml.match(/<a:tbl>/g) ?? []).length;
      const pics = (xml.match(/<p:pic>/g) ?? []).length;
      lines.push(`结构：表格 ${tables} 个，图片 ${pics} 张`);
    }
  }
  if (wantStructure) lines.push(`整包媒体文件 ${images.length} 个`);
  return lines.join("\n");
}

export async function pptxEdit(params: {
  file_path: string;
  operations: Array<{ find: string; replace?: string; slide?: number }>;
  output_path?: string;
}): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);
  const zip = await JSZip.loadAsync(readFileSync(file));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  let changed = 0;
  for (const op of params.operations ?? []) {
    const find = String(op.find ?? "");
    if (!find) continue;
    const replace = String(op.replace ?? "");
    const targets = op.slide ? slideNames.filter((n) => slideIndex(n) === Number(op.slide)) : slideNames;
    for (const name of targets) {
      const xml = await zip.file(name)!.async("string");
      // 只改文本节点，保留 run 的排版属性
      const next = xml.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (whole, inner: string) => {
        if (!inner.includes(find)) return whole;
        changed++;
        return `<a:t>${inner.split(find).join(replace)}</a:t>`;
      });
      if (next !== xml) zip.file(name, next);
    }
  }
  if (changed === 0) return "没有匹配到要替换的文本（未改动文件）";

  const target = params.output_path ? resolveInside(String(params.output_path)) : file;
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(target, buffer);
  return `已替换 ${changed} 处文本并保存 ${displayPath(target)}`;
}
