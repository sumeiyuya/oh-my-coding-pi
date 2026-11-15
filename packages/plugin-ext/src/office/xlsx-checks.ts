/**
 * xlsx_recalc / xlsx_audit 的实现。
 *
 * 两个都是**只读**：不写回文件、不改单元格。recalc 用自研最小引擎算一遍并报错误值；
 * audit 只做静态结构检查（启发式，必须逐条人工确认）。
 */
import { existsSync } from "node:fs";
import ExcelJS from "exceljs";
import { buildWorkbookEvaluator, cellAddress, colName, isErrorValue, type CellError } from "./xlsx-formula";
import { displayPath, resolveInside } from "./paths";

const MAX_SAMPLES = 20;

type FormulaCell = { sheet: string; col: number; row: number; formula: string; address: string };

function collectFormulas(wb: ExcelJS.Workbook): FormulaCell[] {
  const out: FormulaCell[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const raw = cell.value as unknown;
        if (raw && typeof raw === "object" && "formula" in raw) {
          out.push({
            sheet: ws.name,
            col,
            row: row.number,
            formula: String((raw as { formula: string }).formula),
            address: `${colName(col)}${row.number}`,
          });
        }
      });
    });
  }
  return out;
}

export async function xlsxRecalc(params: { file_path: string; timeout?: number }): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const formulas = collectFormulas(wb);
  const { ctx, warnings } = buildWorkbookEvaluator(wb);

  const errors = new Map<CellError, string[]>();
  const started = Date.now();
  const timeoutMs = Math.max(1, Math.min(120, Number(params.timeout ?? 30))) * 1000;
  let timedOut = false;

  for (const cell of formulas) {
    if (Date.now() - started > timeoutMs) {
      timedOut = true;
      break;
    }
    const value = ctx.getCell(cell.sheet, cell.col, cell.row);
    if (isErrorValue(value)) {
      const list = errors.get(value) ?? [];
      if (list.length < MAX_SAMPLES) list.push(`${cell.sheet}!${cell.address} = ${cell.formula}`);
      errors.set(value, list);
    }
  }

  const totalErrors = [...errors.values()].reduce((n, list) => n + list.length, 0);
  const lines = [
    `文件：${displayPath(file)}`,
    `status: ${timedOut ? "timed_out" : totalErrors > 0 ? "errors_found" : "success"}`,
    `total_formulas: ${formulas.length}`,
    `total_errors: ${totalErrors}`,
    `elapsed_ms: ${Date.now() - started}`,
  ];

  if (errors.size > 0) {
    lines.push("", "error_summary:");
    for (const [err, list] of errors) {
      lines.push(`  ${err}: ${list.length} hit(s)`);
      for (const loc of list) lines.push(`    ${loc}`);
    }
    lines.push("", "修掉这些格子后重跑 xlsx_recalc，直到 status 为 success 再交付。");
  }
  if (timedOut) lines.push("", "（到超时上限，剩余公式未算；可用 timeout 参数放大）");

  if (warnings.size > 0) {
    lines.push("", "warnings:");
    for (const w of [...warnings].slice(0, MAX_SAMPLES)) lines.push(`  - ${w}`);
  }
  lines.push(
    "",
    "口径：自研最小引擎，支持四则/比较/区域/跨表与常用函数（SUM/AVERAGE/COUNT/MIN/MAX/ROUND/IF 等）；" +
      "不支持查找引用（VLOOKUP 等）、日期数组函数——那些格子会报 #NAME? 并单列在 warnings 里。",
  );
  return lines.join("\n");
}

/** 公式里出现的单元格/区域引用（含跨表前缀）。 */
function refsIn(formula: string): Array<{ sheet?: string; col: number; row: number }> {
  const out: Array<{ sheet?: string; col: number; row: number }> = [];
  const re = /(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})/g;
  for (const m of formula.matchAll(re)) {
    const letters = m[3];
    const row = Number(m[4]);
    let col = 0;
    for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    out.push({ sheet: m[1] ?? m[2] ?? undefined, col, row });
  }
  return out;
}

export async function xlsxAudit(params: { file_path: string }): Promise<string> {
  const file = resolveInside(String(params.file_path));
  if (!existsSync(file)) throw new Error(`文件不存在：${params.file_path}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const formulas = collectFormulas(wb);

  const issues = new Map<string, string[]>();
  const add = (type: string, sample: string) => {
    const list = issues.get(type) ?? [];
    if (list.length < MAX_SAMPLES) list.push(sample);
    issues.set(type, list);
  };

  for (const cell of formulas) {
    const f = cell.formula;
    const where = `${cell.sheet}!${cell.address}`;

    // 1) 字面量除零
    if (/\/\s*0(?![.\d])/.test(f)) add("literal_division_by_zero", `${where} = ${f}`);

    // 2) 自引用
    for (const ref of refsIn(f)) {
      const sameSheet = !ref.sheet || ref.sheet === cell.sheet;
      if (sameSheet && ref.col === cell.col && ref.row === cell.row) {
        add("self_reference", `${where} = ${f}`);
        break;
      }
    }

    // 3) 数组公式陷阱：SUM(IF(...)) 不带数组语义
    if (/\b(SUM|AVERAGE|COUNT|MAX|MIN)\s*\(\s*IF\s*\(/i.test(f)) {
      add("aggregate_wrapping_if", `${where} = ${f}`);
    }

    // 4) 聚合区域疑似漏行：区域结束行的下一行同列还有数据
    for (const m of f.matchAll(/\b(SUM|AVERAGE|COUNT|MIN|MAX)\s*\(\s*(?:\$?([A-Za-z]{1,3})\$?(\d+)\s*:\s*\$?([A-Za-z]{1,3})\$?(\d+))/gi)) {
      const sheet = wb.getWorksheet(cell.sheet);
      if (!sheet) continue;
      const endRow = Number(m[5]);
      const startCol = m[2];
      const endCol = m[4];
      const c1 = refsIn(`${startCol}1`)[0]?.col ?? 1;
      const c2 = refsIn(`${endCol}1`)[0]?.col ?? 1;
      let hasBelow = false;
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const below = sheet.getCell(endRow + 1, c).value;
        if (below !== null && below !== undefined && String(below).trim() !== "") hasBelow = true;
      }
      if (hasBelow) add("aggregate_range_gap", `${where} = ${f}（区域到第 ${endRow} 行，下一行仍有数据）`);
    }
  }

  // 5) 列内公式不一致（同一列相邻公式的结构差异，多半是拖拽时漏改）
  for (const ws of wb.worksheets) {
    const byCol = new Map<number, FormulaCell[]>();
    for (const cell of formulas.filter((c) => c.sheet === ws.name)) {
      const list = byCol.get(cell.col) ?? [];
      list.push(cell);
      byCol.set(cell.col, list);
    }
    for (const [col, list] of byCol) {
      if (list.length < 4) continue;
      const shape = (f: string) => f.replace(/\$?\d+/g, "#").replace(/\$?[A-Za-z]{1,3}(?=\D|$)/g, "@");
      const counts = new Map<string, number>();
      for (const cell of list) counts.set(shape(cell.formula), (counts.get(shape(cell.formula)) ?? 0) + 1);
      const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const odd = list.filter((cell) => shape(cell.formula) !== mode[0]);
      if (odd.length > 0 && odd.length <= Math.max(1, Math.floor(list.length * 0.25))) {
        for (const cell of odd.slice(0, 3)) {
          add("inconsistent_formula_in_column", `${ws.name}!${cellAddress(col, cell.row)} = ${cell.formula}（同列多数写法：${mode[0]}）`);
        }
      }
    }
  }

  // 6) 公式列里夹着硬编码常量（覆盖了本应计算的格子）
  for (const ws of wb.worksheets) {
    const byCol = new Map<number, FormulaCell[]>();
    for (const cell of formulas.filter((c) => c.sheet === ws.name)) {
      const list = byCol.get(cell.col) ?? [];
      list.push(cell);
      byCol.set(cell.col, list);
    }
    for (const [col, list] of byCol) {
      if (list.length < 2) continue;
      const rows = list.map((c) => c.row).sort((a, b) => a - b);
      const formulaRows = new Set(rows);
      const from = rows[0];
      const to = rows[rows.length - 1];
      for (let r = from; r <= to; r++) {
        if (formulaRows.has(r)) continue;
        // 只有“上下都是公式”才像漏改的硬编码；值列里零星公式不算问题
        const hasAbove = rows.some((x) => x < r);
        const hasBelow = rows.some((x) => x > r);
        if (!hasAbove || !hasBelow) continue;
        const value = ws.getCell(r, col).value as unknown;
        if (typeof value === "number") {
          add(
            "hardcoded_value_in_formula_column",
            `${ws.name}!${cellAddress(col, r)} = ${value}（上下相邻格都是公式，像是把公式改成了常量）`,
          );
        }
      }
    }
  }

  const lines = [
    `文件：${displayPath(file)}`,
    `status: ${issues.size > 0 ? "issues_found" : "clean"}`,
    `total_formulas: ${formulas.length}`,
    `issue_types: ${issues.size}`,
  ];
  if (issues.size > 0) {
    lines.push("", "summary:");
    for (const [type, list] of issues) lines.push(`  ${type}: ${list.length} 处`);
    lines.push("", "samples:");
    for (const [, list] of issues) for (const sample of list) lines.push(`  - ${sample}`);
    lines.push(
      "",
      "这些是启发式怀疑项：逐条看，改掉或确认是有意为之；不要不看就批量改。",
    );
  }
  lines.push("", "口径：只做静态结构检查，不判断业务正确性；不写回文件。");
  return lines.join("\n");
}
