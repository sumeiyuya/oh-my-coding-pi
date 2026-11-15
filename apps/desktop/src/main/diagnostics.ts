import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** 与 audit.ts 同口径的脱敏；单独一份是为了让本模块可被 node 直接导入做检查 */
function sanitize(text: string): string {
  return String(text ?? "")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[redacted]")
    .replace(/(sk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)["'\s:=]+)[^\s"',;}]{4,}/gi, "$1[redacted]")
    .replace(/[A-Za-z]:\Users\[^\\s"]+/g, "%USERPROFILE%")
    .replace(/[A-Za-z]:\/Users\/[^/\s"]+/g, "%USERPROFILE%");
}

/* ------------------------------------------------------------------ */
/* 最小 ZIP 写入（store 模式，无第三方依赖）                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const d = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名字
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* ------------------------------------------------------------------ */
/* 诊断包                                                              */
/* ------------------------------------------------------------------ */

export interface DiagnosticInput {
  version: string;
  pi: {
    origin: string;
    entry: string;
    expected: string | null;
    actual: string | null;
    configDir: string;
    isolated: boolean;
    systemPath: string | null;
    systemVersion: string | null;
  };
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  workspace: string;
  policy: { mode: string; source: string; path: string | null; errors: string[] };
  grants: number;
  auditEntries: number;
  settings: Record<string, unknown>;
  pythonPath: string;
  rKernel: string;
  auditTail: unknown[];
  appLogTail: string;
}

const SECRET_KEYS = /token|secret|password|apikey|api_key|authorization/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v);
    }
    return out;
  }
  if (typeof value === "string") return sanitize(value);
  return value;
}

export function buildDiagnosticZip(input: DiagnosticInput, exportsDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `diagnostics-${stamp}.zip`;
  const target = join(exportsDir, name);

  const summary = [
    "# oh-my-coding-pi 诊断信息",
    "",
    `- 生成时间：${now.toISOString()}`,
    `- 应用版本：${input.version}`,
    `- pi：来源 ${input.pi.origin} · 实际 ${input.pi.actual ?? "未探测"} · 期望 ${input.pi.expected ?? "未记录"}`,
    `- pi 入口：${input.pi.entry}`,
    `- pi 配置目录：${input.pi.configDir}${input.pi.isolated ? "（独立）" : "（共享 ~/.pi/agent）"}`,
    `- 系统 pi：${input.pi.systemPath ?? "未安装"} ${input.pi.systemVersion ?? ""}`.trimEnd(),
    `- Electron：${input.electron}`,
    `- Chromium：${input.chrome}`,
    `- Node：${input.node}`,
    `- 系统：${input.platform} ${input.arch}`,
    `- 工作区：${input.workspace}`,
    `- 权限策略：mode=${input.policy.mode} source=${input.policy.source} path=${input.policy.path ?? "（默认）"}`,
    `- 策略错误：${input.policy.errors.length ? input.policy.errors.join("；") : "无"}`,
    `- 持久授权：${input.grants} 条`,
    `- 审计条目：${input.auditEntries} 条（随包附带最近 ${input.auditTail.length} 条）`,
    `- Python 解释器：${input.pythonPath}`,
    `- R 内核：${input.rKernel}`,
    "",
    "## 设置（已脱敏）",
    "",
    "```json",
    JSON.stringify(scrub(input.settings), null, 2),
    "```",
    "",
  ].join("\n");

  const manifest = {
    createdAt: now.toISOString(),
    appVersion: input.version,
    primaryTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    files: [] as Array<{ name: string; bytes: number; sha256: string }>,
  };

  const entries: ZipEntry[] = [];
  const add = (entryName: string, text: string) => {
    const data = Buffer.from(text, "utf8");
    entries.push({ name: entryName, data });
    manifest.files.push({
      name: entryName,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  };

  add("diagnostic.md", summary);
  add("settings.json", JSON.stringify(scrub(input.settings), null, 2));
  if (input.auditTail.length) {
    const safeTail = input.auditTail.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return { ...item, summary: sanitize(String(item.summary ?? "")) };
    });
    add("audit-tail.jsonl", safeTail.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  if (input.appLogTail.trim()) add("app-log-tail.txt", sanitize(input.appLogTail));
  add("policy.json", JSON.stringify(scrub(input.policy), null, 2));
  add("manifest.json", JSON.stringify(manifest, null, 2));

  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(target, createZip(entries, now));
  return target;
}

/** 读取文件末尾若干行；文件不存在返回空串 */
export function tailFile(file: string, lines: number): string {
  if (!existsSync(file)) return "";
  try {
    const all = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}
