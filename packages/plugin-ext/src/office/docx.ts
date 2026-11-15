/**
 * Word 工具（office.docx 族）。
 * 生成用 docx 包；读取用 jszip 解 word/document.xml 抽纯文本（不引 mammoth，省 3 MB）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import JSZip from "jszip";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { displayPath, resolveInside } from "./paths";

type Block = {
  type: string;
  text?: string;
  headers?: string[];
  rows?: string[][];
  items?: string[];
  ordered?: boolean;
};

function heading(level: number, text: string): Paragraph {
  const map: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  };
  return new Paragraph({ text, heading: map[level] ?? HeadingLevel.HEADING_3 });
}

function blockToDocx(block: Block): Array<Paragraph | Table> {
  const type = String(block.type ?? "paragraph");
  const text = String(block.text ?? "");
  if (type === "heading") return [heading(1, text)];
  if (type === "h2") return [heading(2, text)];
  if (type === "h3") return [heading(3, text)];
  if (type === "code") {
    return text.split("\n").map(
      (line) =>
        new Paragraph({
          children: [new TextRun({ text: line || " ", font: "Consolas", size: 18 })],
          spacing: { line: 240 },
        }),
    );
  }
  if (type === "list") {
    return (block.items ?? []).map((item, i) =>
      new Paragraph({
        text: block.ordered ? `${i + 1}. ${item}` : `• ${item}`,
        indent: { left: 360 },
      }),
    );
  }
  if (type === "table") {
    const headers = block.headers ?? [];
    const rows = block.rows ?? [];
    const all: string[][] = headers.length ? [headers, ...rows] : rows;
    return [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: all.map(
          (cells, r) =>
            new TableRow({
              children: cells.map(
                (cell) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: String(cell ?? ""), bold: headers.length > 0 && r === 0 })],
                      }),
                    ],
                  }),
              ),
            }),
        ),
      }),
    ];
  }
  // paragraph：空行用单个空格保住段间距
  return text.split("\n").map(
    (line) =>
      new Paragraph({
        children: [new TextRun(line || " ")],
        alignment: AlignmentType.LEFT,
      }),
  );
}

export async function docxCreate(params: {
  destination_path: string;
  title?: string;
  content: Block[] | string;
}): Promise<string> {
  const blocks: Block[] =
    typeof params.content === "string" ? [{ type: "paragraph", text: params.content }] : (params.content ?? []);
  if (blocks.length === 0) throw new Error("content 不能为空");
  const file = resolveInside(String(params.destination_path));

  const children: Array<Paragraph | Table> = [];
  if (params.title) children.push(new Paragraph({ text: String(params.title), heading: HeadingLevel.TITLE }));
  for (const block of blocks) children.push(...blockToDocx(block));

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buffer);
  return `已生成 ${displayPath(file)}（${blocks.length} 个块）`;
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function docxRead(params: { file_path: string }): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);
  const zip = await JSZip.loadAsync(readFileSync(file));
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("不是有效的 .docx（缺 word/document.xml）");
  const text = stripXml(await doc.async("string"));
  return [`文件：${displayPath(file)}`, "", text || "（没有可读文本）"].join("\n");
}
