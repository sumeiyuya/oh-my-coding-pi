/**
 * Excel 工具（office.xlsx 族）。
 *
 * 读写用 exceljs（与 DAWN 一致）。公式只当作文本搬运，**不在这里求值**；
 * 重算与审计是独立工具（xlsx_recalc / xlsx_audit），下一批实现。
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { displayPath, resolveInside } from "./paths";

type CellValue = string | number | boolean | null | { formula: string; result?: number | string } | { value: unknown };

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseRange(range: string): { startRow: number; startCol: number; endRow?: number; endCol?: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)?(?::\$?([A-Za-z]+)\$?(\d+)?)?$/.exec(range.trim());
  if (!m) return null;
  return {
    startCol: colToIndex(m[1]),
    startRow: m[2] ? Number(m[2]) : 1,
    endCol: m[3] ? colToIndex(m[3]) : undefined,
    endRow: m[4] ? Number(m[4]) : undefined,
  };
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const obj = v as { formula?: string; result?: unknown; richText?: Array<{ text: string }>; text?: string; error?: string };
    if (typeof obj.formula === "string") return `=${obj.formula}`;
    if (Array.isArray(obj.richText)) return obj.richText.map((t) => t.text).join("");
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.error === "string") return obj.error;
  }
  return String(v);
}

export async function xlsxRead(params: {
  file_path: string;
  sheet?: string;
  range_start?: string;
  range_end?: string;
  max_rows?: number;
}): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  if (!params.sheet) {
    const lines = [`文件：${displayPath(file)}`, `工作表 ${wb.worksheets.length} 个：`];
    for (const ws of wb.worksheets) lines.push(`- ${ws.name} · ${ws.rowCount} 行 × ${ws.columnCount} 列`);
    lines.push("", "要读某张表，传 sheet 参数。");
    return lines.join("\n");
  }

  const ws = wb.getWorksheet(String(params.sheet));
  if (!ws) throw new Error(`没有工作表「${params.sheet}」。现有：${wb.worksheets.map((w) => w.name).join(" / ")}`);

  const maxRows = Math.max(1, Math.min(500, Math.floor(params.max_rows ?? 100)));
  const range = params.range_start ? parseRange(String(params.range_start)) : null;
  const startRow = range?.startRow ?? 1;
  const startCol = range?.startCol ?? 1;
  const endRow = range?.endRow ?? ws.rowCount;
  const endCol = range?.endCol ?? Math.max(1, ws.columnCount);

  const header: string[] = [];
  for (let c = startCol; c <= endCol; c++) header.push(ws.getCell(1, c).text || String.fromCharCode(64 + Math.min(26, c)));
  const lines = [`工作表 ${ws.name}（行 ${startRow}-${Math.min(endRow, startRow + maxRows - 1)}，列 ${startCol}-${endCol}）`, ""];
  lines.push("| " + header.join(" | ") + " |");
  lines.push("|" + header.map(() => "---").join("|") + "|");

  let printed = 0;
  for (let r = Math.max(2, startRow); r <= endRow && printed < maxRows; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = startCol; c <= endCol; c++) cells.push(cellText(row.getCell(c)).replace(/\|/g, "\\|"));
    lines.push("| " + cells.join(" | ") + " |");
    printed++;
  }
  if (printed >= maxRows) {
    lines.push("", `（已截断，继续读请传 range_start=\"A${startRow + maxRows}\"）`);
  }
  return lines.join("\n");
}

function applyCell(cell: ExcelJS.Cell, value: CellValue): void {
  if (value === null || value === undefined) {
    cell.value = null;
    return;
  }
  if (typeof value === "object" && value !== null && "formula" in value) {
    const f = value as { formula: string; result?: number | string };
    cell.value = { formula: f.formula.replace(/^=/, ""), result: f.result ?? undefined } as ExcelJS.CellFormulaValue;
    return;
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    cell.value = (value as { value: unknown }).value as ExcelJS.CellValue;
    return;
  }
  cell.value = value as ExcelJS.CellValue;
}

export async function xlsxWrite(params: {
  file_path: string;
  data: CellValue[][];
  sheet_name?: string;
  header_bold?: boolean;
  column_widths?: number[];
  number_formats?: Record<string, string>;
}): Promise<string> {
  if (!Array.isArray(params.data) || params.data.length === 0) throw new Error("data 必须是非空的二维数组");
  const file = resolveInside(String(params.file_path));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(params.sheet_name ? String(params.sheet_name) : "Sheet1");

  params.data.forEach((row, r) => {
    row.forEach((value, c) => applyCell(ws.getCell(r + 1, c + 1), value));
  });

  if (params.header_bold) ws.getRow(1).font = { bold: true };
  if (Array.isArray(params.column_widths)) {
    params.column_widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = Math.max(4, Math.min(120, Number(w) || 12));
    });
  }
  if (params.number_formats && typeof params.number_formats === "object") {
    for (const [letter, fmt] of Object.entries(params.number_formats)) {
      ws.getColumn(letter).numFmt = String(fmt);
    }
  }

  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return `已写入 ${displayPath(file)}（${params.data.length} 行 × ${Math.max(...params.data.map((r) => r.length))} 列，工作表 ${ws.name}）`;
}

export async function xlsxEdit(params: {
  file_path: string;
  operations: Array<Record<string, unknown>>;
  output_path?: string;
}): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const applied: string[] = [];
  for (const op of params.operations ?? []) {
    const action = String(op.action ?? "");
    if (action === "add_sheet") {
      const name = String(op.name ?? "").trim();
      if (!name) throw new Error("add_sheet 需要 name");
      wb.addWorksheet(name);
      applied.push(`加工作表 ${name}`);
    } else if (action === "update_cells") {
      const ws = wb.getWorksheet(String(op.sheet ?? ""));
      if (!ws) throw new Error(`没有工作表「${op.sheet}」`);
      for (const item of (op.cells as Array<{ cell: string; value?: unknown; formula?: string }>) ?? []) {
        const cell = ws.getCell(String(item.cell));
        if (typeof item.formula === "string") applyCell(cell, { formula: item.formula });
        else applyCell(cell, (item.value ?? null) as CellValue);
      }
      applied.push(`更新 ${(op.cells as unknown[])?.length ?? 0} 个单元格（${op.sheet}）`);
    } else if (action === "append_rows") {
      const ws = wb.getWorksheet(String(op.sheet ?? ""));
      if (!ws) throw new Error(`没有工作表「${op.sheet}」`);
      const rows = (op.rows as CellValue[][]) ?? [];
      for (const row of rows) ws.addRow(row as ExcelJS.CellValue[]);
      applied.push(`追加 ${rows.length} 行（${op.sheet}）`);
    } else {
      throw new Error(`未知操作：${action}（支持 add_sheet / update_cells / append_rows）`);
    }
  }

  const target = params.output_path ? resolveInside(String(params.output_path)) : file;
  await wb.xlsx.writeFile(target);
  return [`已保存 ${displayPath(target)}`, ...applied.map((a) => "- " + a)].join("\n");
}
