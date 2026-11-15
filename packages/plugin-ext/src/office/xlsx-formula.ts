/**
 * 最小公式求值器（office.xlsx · xlsx_recalc 用）。
 *
 * 为什么自己写：hyperformula 在 pi 的 jiti 加载下会因 CJS 循环引用直接崩（裸 Node 正常），
 * 把一个会在启动时炸的依赖塞进扩展不可接受；DAWN 也是自研引擎。
 *
 * 能力边界（必须在工具返回里说清楚，不装完整）：
 * - 支持：四则/乘方/百分号、比较运算、括号、数字与字符串、布尔、
 *   单元格引用（A1、$A$1）、区域（A1:B9）、跨表引用（'Sheet'!A1 或 Sheet!A1）、
 *   函数 SUM/AVERAGE/COUNT/COUNTA/MIN/MAX/PRODUCT/ABS/ROUND/ROUNDUP/ROUNDDOWN/
 *   INT/MOD/POWER/SQRT/IF/IFERROR/AND/OR/NOT/LEN/LEFT/RIGHT/MID/CONCAT/CONCATENATE/
 *   UPPER/LOWER/TRIM/EXACT/ISNUMBER/ISBLANK
 * - 不支持：查找引用函数（VLOOKUP/XLOOKUP/INDEX/MATCH）、日期函数、财务/统计高级函数、
 *   数组公式与动态数组。遇到未知函数返回 #NAME?，同时记一条 warning。
 */
import type ExcelJS from "exceljs";

export type CellError =
  | "#DIV/0!"
  | "#VALUE!"
  | "#REF!"
  | "#NAME?"
  | "#NUM!"
  | "#N/A"
  | "#CIRC!";

const ERRORS = new Set<string>([
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#CIRC!",
]);

export function isErrorValue(v: unknown): v is CellError {
  return typeof v === "string" && ERRORS.has(v);
}

type Value = number | string | boolean | null | CellError;

interface Pos {
  sheet: string;
  col: number; // 1-based
  row: number; // 1-based
}

interface Token {
  kind: "num" | "str" | "ref" | "op" | "func" | "lparen" | "rparen" | "comma" | "bool";
  text: string;
  sheet?: string;
  col?: number;
  row?: number;
  absCol?: boolean;
  absRow?: boolean;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function colName(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function cellAddress(col: number, row: number): string {
  return `${colName(col)}${row}`;
}

const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

function tokenize(formula: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const src = formula.startsWith("=") ? formula.slice(1) : formula;

  const pushRef = (sheet: string | undefined, body: string) => {
    const m = REF_RE.exec(body);
    if (!m) throw new Error(`引用写法不对：${body}`);
    out.push({
      kind: "ref",
      text: body,
      sheet,
      col: colIndex(m[2]),
      row: Number(m[4]),
      absCol: m[1] === "$",
      absRow: m[3] === "$",
    });
  };

  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          text += '"';
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        text += src[j++];
      }
      out.push({ kind: "str", text });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ kind: "num", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$']/.test(ch)) {
      // 可选：'Sheet name'!A1 / Sheet!A1
      let j = i;
      let sheet: string | undefined;
      if (ch === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new Error("单引号没有闭合");
        sheet = src.slice(i + 1, end);
        j = end + 1;
        if (src[j] !== "!") throw new Error("跨表引用缺少 !");
        j++;
      }
      let k = j;
      while (k < src.length && /[A-Za-z0-9_$.]/.test(src[k])) k++;
      const word = src.slice(j, k);
      if (!sheet && src[k] === "!") {
        sheet = word;
        k++;
        let m = k;
        while (m < src.length && /[A-Za-z0-9_$.]/.test(src[m])) m++;
        pushRef(sheet, src.slice(k, m));
        i = m;
        continue;
      }
      if (sheet) {
        pushRef(sheet, word);
        i = k;
        continue;
      }
      if (src[k] === "(") {
        out.push({ kind: "func", text: word.toUpperCase() });
        i = k;
        continue;
      }
      if (/^(TRUE|FALSE)$/i.test(word)) {
        out.push({ kind: "bool", text: word.toUpperCase() });
        i = k;
        continue;
      }
      if (REF_RE.test(word)) {
        pushRef(undefined, word);
        i = k;
        continue;
      }
      // 未加括号的函数名或未知标识符：交给求值阶段报 #NAME?
      out.push({ kind: "func", text: word.toUpperCase() });
      i = k;
      continue;
    }
    if (src.startsWith("<=", i) || src.startsWith(">=", i) || src.startsWith("<>", i)) {
      out.push({ kind: "op", text: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ("+-*/^%&=<>".includes(ch)) {
      out.push({ kind: "op", text: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      out.push({ kind: "lparen", text: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ kind: "rparen", text: ch });
      i++;
      continue;
    }
    if (ch === "," || ch === ";") {
      out.push({ kind: "comma", text: "," });
      i++;
      continue;
    }
    throw new Error(`无法识别的字符：${ch}`);
  }
  return out;
}

interface EvalCtx {
  getCell(sheet: string, col: number, row: number): Value;
  warnings: Set<string>;
  errors: Set<string>;
}

function toNumber(v: Value): number | CellError {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  if (typeof v === "string") {
    if (isErrorValue(v)) return v;
    const t = v.trim();
    if (!t) return 0;
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) ? n : "#VALUE!";
  }
  return "#VALUE!";
}

function toStringValue(v: Value): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return String(v);
}

function flatten(args: Array<Value | Value[]>): Value[] {
  const out: Value[] = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...a);
    else out.push(a);
  }
  return out;
}

function numbersOf(values: Value[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (v === null || v === "") continue;
    const n = toNumber(v);
    if (typeof n === "number") out.push(n);
  }
  return out;
}

const FUNCS: Record<string, (args: Array<Value | Value[]>, ctx: EvalCtx) => Value> = {
  SUM: (a) => numbersOf(flatten(a)).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => {
    const ns = numbersOf(flatten(a));
    return ns.length ? ns.reduce((x, y) => x * y, 1) : 0;
  },
  AVERAGE: (a) => {
    const ns = numbersOf(flatten(a));
    return ns.length ? ns.reduce((x, y) => x + y, 0) / ns.length : "#DIV/0!";
  },
  COUNT: (a) => numbersOf(flatten(a)).length,
  COUNTA: (a) => flatten(a).filter((v) => v !== null && v !== "").length,
  MIN: (a) => {
    const ns = numbersOf(flatten(a));
    return ns.length ? Math.min(...ns) : 0;
  },
  MAX: (a) => {
    const ns = numbersOf(flatten(a));
    return ns.length ? Math.max(...ns) : 0;
  },
  ABS: (a) => {
    const n = toNumber(flatten(a)[0] ?? null);
    return typeof n === "number" ? Math.abs(n) : n;
  },
  INT: (a) => {
    const n = toNumber(flatten(a)[0] ?? null);
    return typeof n === "number" ? Math.floor(n) : n;
  },
  ROUND: (a) => {
    const n = toNumber(flatten(a)[0] ?? null);
    const d = toNumber(flatten(a)[1] ?? 0);
    if (typeof n !== "number") return n;
    const digits = typeof d === "number" ? d : 0;
    const f = Math.pow(10, digits);
    return Math.round(n * f) / f;
  },
  ROUNDUP: (a) => {
    const n = toNumber(flatten(a)[0] ?? null);
    const d = toNumber(flatten(a)[1] ?? 0);
    if (typeof n !== "number") return n;
    const f = Math.pow(10, typeof d === "number" ? d : 0);
    return (n >= 0 ? Math.ceil(n * f) : Math.floor(n * f)) / f;
  },
  ROUNDDOWN: (a) => {
    const n = toNumber(flatten(a)[0] ?? null);
    const d = toNumber(flatten(a)[1] ?? 0);
    if (typeof n !== "number") return n;
    const f = Math.pow(10, typeof d === "number" ? d : 0);
    return (n >= 0 ? Math.floor(n * f) : Math.ceil(n * f)) / f;
  },
  MOD: (a) => {
    const x = toNumber(flatten(a)[0] ?? null);
    const y = toNumber(flatten(a)[1] ?? null);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    return y === 0 ? "#DIV/0!" : x % y;
  },
  POWER: (a) => {
    const x = toNumber(flatten(a)[0] ?? null);
    const y = toNumber(flatten(a)[1] ?? null);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    const r = Math.pow(x, y);
    return Number.isFinite(r) ? r : "#NUM!";
  },
  SQRT: (a) => {
    const n = toNumber(flatten(a)[0] ?? null);
    if (typeof n !== "number") return n;
    return n < 0 ? "#NUM!" : Math.sqrt(n);
  },
  IF: (a, ctx) => {
    const cond = flatten([a[0] ?? null])[0] ?? null;
    let truthy = false;
    if (typeof cond === "boolean") truthy = cond;
    else if (typeof cond === "number") truthy = cond !== 0;
    else if (typeof cond === "string") truthy = cond.trim().toUpperCase() === "TRUE";
    void ctx;
    return truthy ? (flatten([a[1] ?? null])[0] ?? null) : (flatten([a[2] ?? null])[0] ?? null);
  },
  IFERROR: (a) => {
    const v = flatten([a[0] ?? null])[0] ?? null;
    return isErrorValue(v) ? (flatten([a[1] ?? null])[0] ?? null) : v;
  },
  AND: (a) => flatten(a).every((v) => toNumber(v) === 1 || v === true),
  OR: (a) => flatten(a).some((v) => toNumber(v) === 1 || v === true),
  NOT: (a) => !(toNumber(flatten(a)[0] ?? null) === 1),
  LEN: (a) => toStringValue(flatten([a[0] ?? null])[0] ?? null).length,
  LEFT: (a) => {
    const s = toStringValue(flatten([a[0] ?? null])[0] ?? null);
    const n = toNumber(flatten([a[1] ?? 1])[0] ?? 1);
    return s.slice(0, typeof n === "number" ? Math.max(0, n) : 1);
  },
  RIGHT: (a) => {
    const s = toStringValue(flatten([a[0] ?? null])[0] ?? null);
    const n = toNumber(flatten([a[1] ?? 1])[0] ?? 1);
    return typeof n === "number" ? s.slice(Math.max(0, s.length - n)) : s;
  },
  MID: (a) => {
    const s = toStringValue(flatten([a[0] ?? null])[0] ?? null);
    const start = toNumber(flatten([a[1] ?? 1])[0] ?? 1);
    const n = toNumber(flatten([a[2] ?? 1])[0] ?? 1);
    if (typeof start !== "number" || typeof n !== "number") return "#VALUE!";
    return s.slice(Math.max(0, start - 1), Math.max(0, start - 1) + Math.max(0, n));
  },
  CONCAT: (a) => flatten(a).map(toStringValue).join(""),
  CONCATENATE: (a) => flatten(a).map(toStringValue).join(""),
  UPPER: (a) => toStringValue(flatten([a[0] ?? null])[0] ?? null).toUpperCase(),
  LOWER: (a) => toStringValue(flatten([a[0] ?? null])[0] ?? null).toLowerCase(),
  TRIM: (a) => toStringValue(flatten([a[0] ?? null])[0] ?? null).trim(),
  EXACT: (a) =>
    toStringValue(flatten([a[0] ?? null])[0] ?? null) === toStringValue(flatten([a[1] ?? null])[0] ?? null),
  ISNUMBER: (a) => typeof flatten([a[0] ?? null])[0] === "number",
  ISBLANK: (a) => {
    const v = flatten([a[0] ?? null])[0];
    return v === null || v === "";
  },
};

/** 递归下降求值；失败抛 {error} 由上层转成单元格错误值。 */
export function evaluateFormula(formula: string, pos: Pos, ctx: EvalCtx): Value {
  let tokens: Token[];
  try {
    tokens = tokenize(formula);
  } catch {
    return "#VALUE!";
  }
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  const parsePrimary = (): Value => {
    const token = next();
    if (!token) return "#VALUE!";
    if (token.kind === "num") return Number(token.text);
    if (token.kind === "str") return token.text;
    if (token.kind === "bool") return token.text === "TRUE";
    if (token.kind === "ref") {
      const sheet = token.sheet ?? pos.sheet;
      return ctx.getCell(sheet, token.col ?? 0, token.row ?? 0);
    }
    if (token.kind === "lparen") {
      const v = parseExpr();
      if (peek()?.kind === "rparen") next();
      return v;
    }
    if (token.kind === "op" && (token.text === "-" || token.text === "+")) {
      const v = toNumber(parsePrimary());
      if (typeof v !== "number") return v;
      return token.text === "-" ? -v : v;
    }
    if (token.kind === "func") {
      // 函数调用
      const args: Array<Value | Value[]> = [];
      if (peek()?.kind === "lparen") next();
      if (peek()?.kind !== "rparen") {
        for (;;) {
          args.push(parseArg());
          if (peek()?.kind === "comma") {
            next();
            continue;
          }
          break;
        }
      }
      if (peek()?.kind === "rparen") next();
      const fn = FUNCS[token.text];
      if (!fn) {
        ctx.warnings.add(`不支持函数 ${token.text}（按 #NAME? 计）`);
        return "#NAME?";
      }
      try {
        return fn(args, ctx);
      } catch {
        return "#VALUE!";
      }
    }
    return "#VALUE!";
  };

  // 参数：可能是区域（ref:ref）
  const parseArg = (): Value | Value[] => {
    const token = peek();
    if (token?.kind === "ref" && tokens[index + 2]?.kind === "op" && tokens[index + 2]?.text === ":") {
      const left = next() as Token;
      next(); // :
      const right = next() as Token;
      if (right.kind !== "ref") return "#VALUE!";
      const sheet = left.sheet ?? pos.sheet;
      const c1 = Math.min(left.col ?? 1, right.col ?? 1);
      const c2 = Math.max(left.col ?? 1, right.col ?? 1);
      const r1 = Math.min(left.row ?? 1, right.row ?? 1);
      const r2 = Math.max(left.row ?? 1, right.row ?? 1);
      const values: Value[] = [];
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) values.push(ctx.getCell(sheet, c, r));
      return values;
    }
    return parseExpr();
  };

  const parsePower = (): Value => {
    let left = parsePrimary();
    while (peek()?.kind === "op" && peek().text === "^") {
      next();
      const right = parsePower();
      const a = toNumber(left);
      const b = toNumber(right);
      left = typeof a === "number" && typeof b === "number" ? Math.pow(a, b) : "#VALUE!";
    }
    return left;
  };

  const parseUnary = (): Value => {
    if (peek()?.kind === "op" && peek().text === "-") {
      next();
      const v = toNumber(parseUnary());
      return typeof v === "number" ? -v : v;
    }
    if (peek()?.kind === "op" && peek().text === "+") {
      next();
      return parseUnary();
    }
    return parsePower();
  };

  const parseTerm = (): Value => {
    let left = parseUnary();
    while (peek()?.kind === "op" && "*/%".includes(peek().text)) {
      const op = next().text;
      const right = parseUnary();
      const a = toNumber(left);
      const b = toNumber(right);
      if (op === "%") {
        left = typeof a === "number" ? a / 100 : a;
        continue;
      }
      if (typeof a !== "number") {
        left = a;
        continue;
      }
      if (typeof b !== "number") {
        left = b;
        continue;
      }
      if (op === "*") left = a * b;
      else left = b === 0 ? "#DIV/0!" : a / b;
    }
    return left;
  };

  const compare = (op: string, a: Value, b: Value): Value => {
    const an = toNumber(a);
    const bn = toNumber(b);
    if (typeof an === "number" && typeof bn === "number") {
      if (op === "=") return an === bn;
      if (op === "<>") return an !== bn;
      if (op === "<") return an < bn;
      if (op === ">") return an > bn;
      if (op === "<=") return an <= bn;
      return an >= bn;
    }
    const as = toStringValue(a).toUpperCase();
    const bs = toStringValue(b).toUpperCase();
    if (op === "=") return as === bs;
    if (op === "<>") return as !== bs;
    if (op === "<") return as < bs;
    if (op === ">") return as > bs;
    if (op === "<=") return as <= bs;
    return as >= bs;
  };

  const parseExpr = (): Value => {
    let left = parseTerm();
    for (;;) {
      const token = peek();
      if (!token) break;
      if (token.kind === "op" && ["+", "-"].includes(token.text)) {
        next();
        const right = parseTerm();
        const a = toNumber(left);
        const b = toNumber(right);
        if (typeof a !== "number") {
          left = a;
          continue;
        }
        if (typeof b !== "number") {
          left = b;
          continue;
        }
        left = token.text === "+" ? a + b : a - b;
        continue;
      }
      if (token.kind === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(token.text)) {
        next();
        const right = parseTerm();
        left = compare(token.text, left, right);
        continue;
      }
      break;
    }
    return left;
  };

  try {
    const value = parseExpr();
    return value;
  } catch {
    return "#VALUE!";
  }
}

/** 从 exceljs 工作簿取值：缓存结果、公式、常量混在一起，按依赖递归求值。 */
export function buildWorkbookEvaluator(wb: ExcelJS.Workbook) {
  const warnings = new Set<string>();
  const memo = new Map<string, Value>();
  const visiting = new Set<string>();
  const cells = new Map<string, { formula?: string; value: Value }>();

  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const raw = cell.value as unknown;
        const key = `${ws.name}\u0000${col}\u0000${row.number}`;
        if (raw && typeof raw === "object" && "formula" in raw) {
          const f = raw as { formula: string; result?: unknown };
          cells.set(key, { formula: f.formula, value: null });
        } else {
          let v: Value = null;
          if (raw instanceof Date) v = raw.toISOString().slice(0, 10);
          else if (raw && typeof raw === "object") {
            const obj = raw as { richText?: Array<{ text: string }>; text?: string };
            if (Array.isArray(obj.richText)) v = obj.richText.map((t) => t.text).join("");
            else if (typeof obj.text === "string") v = obj.text;
            else v = null;
          } else v = (raw as Value) ?? null;
          cells.set(key, { value: v });
        }
      });
    });
  }

  const ctx: EvalCtx = {
    warnings,
    errors: new Set(),
    getCell(sheet: string, col: number, row: number): Value {
      const key = `${sheet}\u0000${col}\u0000${row}`;
      if (memo.has(key)) return memo.get(key) as Value;
      const entry = cells.get(key);
      if (!entry) return null;
      if (!entry.formula) return entry.value;
      if (visiting.has(key)) return "#CIRC!";
      visiting.add(key);
      const value = evaluateFormula(entry.formula, { sheet, col, row }, ctx);
      visiting.delete(key);
      memo.set(key, value);
      return value;
    },
  };

  return { cells, ctx, warnings };
}
