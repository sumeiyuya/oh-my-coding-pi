/** CSV/TSV 的最小解析：只够预览用，不做类型推断，不处理跨行引号。 */

export interface ParsedTable {
  rows: string[][];
  /** 原始行数（含被截掉的） */
  totalRows: number;
  /** 行数超过上限 */
  truncatedRows: boolean;
  /** 列数超过上限 */
  truncatedCols: boolean;
  width: number;
}

/** 按分隔符切一行，支持双引号包裹与 "" 转义 */
export function splitDelimitedLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseDelimited(
  text: string,
  sep: string,
  limits: { maxRows?: number; maxCols?: number } = {},
): ParsedTable {
  const maxRows = limits.maxRows ?? 200;
  const maxCols = limits.maxCols ?? 30;
  const all = text.split(/\r?\n/);
  // 末尾换行会切出一个空串，不算一行数据
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  const rows = all.slice(0, maxRows).map((line) => splitDelimitedLine(line, sep));
  let truncatedCols = false;
  const clipped = rows.map((row) => {
    if (row.length > maxCols) {
      truncatedCols = true;
      return row.slice(0, maxCols);
    }
    return row;
  });
  const width = clipped.reduce((m, row) => Math.max(m, row.length), 0);
  return {
    rows: clipped,
    totalRows: all.length,
    truncatedRows: all.length > maxRows,
    truncatedCols,
    width,
  };
}
