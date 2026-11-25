/**
 * Office 工具定义（office 插件，4 族 14 工具）。
 * 参数表用 pi 的 JSON Schema 形式；实现见同目录 xlsx/pptx/docx/pdf。
 */
import { docxCreate, docxRead } from "./docx";
import { pdfCreate, pdfMerge, pdfRead, pdfSplit } from "./pdf";
import { pptxCreate, pptxEdit, pptxRead } from "./pptx";
import { xlsxEdit, xlsxRead, xlsxWrite } from "./xlsx";
import { xlsxAudit, xlsxRecalc } from "./xlsx-checks";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

const pathProp = (desc: string) => ({ type: "string", description: desc });
const str = (desc: string) => ({ type: "string", description: desc });

export function officeTools(families: Set<string>): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];

  if (families.has("office.xlsx")) {
    tools.push(
      {
        name: "xlsx_read",
        label: "读表格",
        description:
          "Read a .xlsx file: list all sheets, or read a specific sheet as a markdown table. Supports range_start/range_end and max_rows for large files (a continuation hint is appended on truncation). Formula cells show the formula text.",
        promptSnippet: "xlsx_read: read a sheet as a markdown table",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Path to the .xlsx file"),
            sheet: str("Sheet name; omit to list all sheets"),
            range_start: str('Start cell, e.g. "A1"'),
            range_end: str('End cell, e.g. "D20"'),
            max_rows: { type: "number", description: "Max rows to print (default 100)" },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; sheet?: string; range_start?: string; range_end?: string; max_rows?: number }) {
          return text(await xlsxRead(p));
        },
      },
      {
        name: "xlsx_write",
        label: "写表格",
        description:
          "Create or overwrite a .xlsx workbook from a 2D array of rows. Cells may be plain values or { formula: \"SUM(A1:A9)\" }. Optional header_bold, column_widths (by position) and number_formats (by column letter, e.g. {\"B\":\"#,##0.00\"}).",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Destination .xlsx path"),
            data: { type: "array", items: { type: "array" }, description: "2D array of cell values" },
            sheet_name: str("Sheet name (default Sheet1)"),
            header_bold: { type: "boolean", description: "Bold the first row" },
            column_widths: { type: "array", items: { type: "number" }, description: "Column widths by position" },
            number_formats: { type: "object", description: "numFmt per column letter" },
          },
          required: ["file_path", "data"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: Record<string, unknown>) {
          return text(await xlsxWrite(p as never));
        },
      },
      {
        name: "xlsx_edit",
        label: "改表格",
        description:
          "Edit an existing .xlsx: add_sheet, update_cells (value or formula), append_rows. Saves back to the input file unless output_path is given.",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Existing .xlsx path"),
            operations: {
              type: "array",
              description:
                'Operations in order: {action:"add_sheet",name}, {action:"update_cells",sheet,cells:[{cell,value|formula}]}, {action:"append_rows",sheet,rows:[[...]]}',
              items: { type: "object" },
            },
            output_path: pathProp("Save to a different path instead of overwriting"),
          },
          required: ["file_path", "operations"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; operations: Array<Record<string, unknown>>; output_path?: string }) {
          return text(await xlsxEdit(p));
        },
      },
      {
        name: "xlsx_recalc",
        label: "重算公式",
        description:
          "Recalculate every formula with a lightweight engine and report error values (#REF!/#DIV/0!/#VALUE!/#NAME? ...) with cell locations. Read-only: does not write results back. Unsupported functions (VLOOKUP and other lookups, date/array functions) are reported as warnings rather than silently miscalculated.",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Path to the .xlsx file"),
            timeout: { type: "number", description: "Evaluation budget in seconds (default 30)" },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; timeout?: number }) {
          return text(await xlsxRecalc(p));
        },
      },
      {
        name: "xlsx_audit",
        label: "审公式",
        description:
          "Statically inspect formula structure: literal division by zero, self-references, SUM(IF(...)) array traps, aggregation ranges that miss the adjacent data row, inconsistent formulas within a column, and hardcoded numbers inside a formula column. Heuristic — inspect every reported sample.",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Path to the .xlsx file"),
          },
          required: ["file_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string }) {
          return text(await xlsxAudit(p));
        },
      },
    );
  }

  if (families.has("office.pdf")) {
    tools.push(
      {
        name: "pdf_create",
        label: "生成 PDF",
        description:
          "Generate a real PDF with headings, paragraphs, tables, lists and code blocks. CJK text is rendered via an auto-detected system font.",
        parameters: {
          type: "object",
          properties: {
            destination_path: pathProp("Output .pdf path"),
            title: str("Document title"),
            content: {
              type: "array",
              description:
                'Blocks: {type:"heading"|"h2"|"h3"|"paragraph"|"table"|"code"|"list", text?, headers?, rows?, items?, ordered?}',
              items: { type: "object" },
            },
            page_numbers: { type: "boolean", description: "Add footer page numbers" },
          },
          required: ["destination_path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: Record<string, unknown>) {
          return text(await pdfCreate(p as never));
        },
      },
      {
        name: "pdf_read",
        label: "读 PDF",
        description: "Extract text from a PDF for reading into context. Use start_page/end_page for large documents.",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Path to the .pdf file"),
            start_page: { type: "number", description: "First page to read (1-based)" },
            end_page: { type: "number", description: "Last page to read" },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; start_page?: number; end_page?: number }) {
          return text(await pdfRead(p));
        },
      },
      {
        name: "pdf_merge",
        label: "合并 PDF",
        description: "Merge two or more PDF files into one, in the given order.",
        parameters: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, description: "Input PDF paths (at least 2)" },
            output_path: pathProp("Output .pdf path"),
          },
          required: ["files", "output_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { files: string[]; output_path: string }) {
          return text(await pdfMerge(p));
        },
      },
      {
        name: "pdf_split",
        label: "拆分 PDF",
        description: "Split a PDF into single-page files, or extract specific pages (pages = \"1,3,5-7\").",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Input PDF path"),
            output_dir: pathProp("Directory to write page files into"),
            pages: str('Page spec, e.g. "1,3,5-7" (default: every page)'),
          },
          required: ["file_path", "output_dir"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; output_dir: string; pages?: string }) {
          return text(await pdfSplit(p));
        },
      },
    );
  }

  if (families.has("office.ppt")) {
    tools.push(
      {
        name: "pptx_create",
        label: "生成 PPT",
        description:
          "Generate a .pptx from slide definitions (title/section/content/two-column/image/table/chart) with speaker notes.",
        parameters: {
          type: "object",
          properties: {
            destination_path: pathProp("Output .pptx path"),
            title: str("Presentation title"),
            slides: {
              type: "array",
              description:
                'Slides: {type, title?, body?, items?, image?, headers?, rows?, chart?, data?, notes?}',
              items: { type: "object" },
            },
          },
          required: ["destination_path", "slides"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: Record<string, unknown>) {
          return text(await pptxCreate(p as never));
        },
      },
      {
        name: "pptx_read",
        label: "读 PPT",
        description: "Extract slide text and optional structure (shapes, images, tables) from a .pptx.",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Path to the .pptx file"),
            include: str('Add "summary" to include tables/images counts'),
          },
          required: ["file_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; include?: string }) {
          return text(await pptxRead(p));
        },
      },
      {
        name: "pptx_edit",
        label: "改 PPT",
        description:
          "Find/replace text inside slide runs, preserving layout and styling. Optional slide number limits the change to one slide.",
        parameters: {
          type: "object",
          properties: {
            file_path: pathProp("Existing .pptx path"),
            operations: {
              type: "array",
              description: "Operations: {find, replace?, slide?}",
              items: { type: "object" },
            },
            output_path: pathProp("Save to a different path instead of overwriting"),
          },
          required: ["file_path", "operations"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string; operations: Array<{ find: string; replace?: string; slide?: number }>; output_path?: string }) {
          return text(await pptxEdit(p));
        },
      },
    );
  }

  if (families.has("office.docx")) {
    tools.push(
      {
        name: "docx_create",
        label: "生成 Word",
        description:
          "Generate a .docx from content blocks (headings, paragraphs, tables, lists, code). Optional vertical title.",
        parameters: {
          type: "object",
          properties: {
            destination_path: pathProp("Output .docx path"),
            title: str("Document title (centered, bold)"),
            content: {
              type: "array",
              description: 'Blocks: {type:"heading"|"h2"|"h3"|"paragraph"|"table"|"code"|"list", ...}',
              items: { type: "object" },
            },
          },
          required: ["destination_path", "content"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { destination_path: string; title?: string; content: unknown }) {
          return text(await docxCreate(p as never));
        },
      },
      {
        name: "docx_read",
        label: "读 Word",
        description: "Extract plain text from a .docx for reading into context.",
        parameters: {
          type: "object",
          properties: { file_path: pathProp("Path to the .docx file") },
          required: ["file_path"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, p: { file_path: string }) {
          return text(await docxRead(p));
        },
      },
    );
  }

  return tools;
}
