import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillInfo {
  /** frontmatter 里的 name（缺失时回落目录名） */
  name: string;
  description: string;
  /** 相对工作区的路径，便于界面展示 */
  path: string;
  enabled: boolean;
  /** 校验问题；空数组表示可用 */
  errors: string[];
}

const SKILL_FILE = "SKILL.md";
const DISABLED_FILE = "SKILL.md.disabled";

function parseFrontmatter(text: string): { data: Record<string, string>; body: string; error?: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return { data: {}, body: normalized, error: "缺少 frontmatter（文件应以 --- 开头）" };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: normalized, error: "frontmatter 未闭合（缺少结束的 ---）" };
  const head = normalized.slice(3, end);
  const body = normalized.slice(end + 4);
  const data: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) data[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body };
}

function skillsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", "skills");
}

/** 扫描工作区技能目录；只认 `<name>/SKILL.md` 或 `<name>/SKILL.md.disabled` */
export function scanSkills(workspaceRoot: string): SkillInfo[] {
  const root = skillsRoot(workspaceRoot);
  if (!existsSync(root)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const enabledFile = join(dir, SKILL_FILE);
    const disabledFile = join(dir, DISABLED_FILE);
    const enabled = existsSync(enabledFile);
    const file = enabled ? enabledFile : disabledFile;
    if (!existsSync(file)) continue;

    const rel = `.agents/skills/${entry}/${enabled ? SKILL_FILE : DISABLED_FILE}`;
    const errors: string[] = [];
    let name = entry;
    let description = "";
    try {
      const text = readFileSync(file, "utf8");
      const parsed = parseFrontmatter(text);
      if (parsed.error) errors.push(parsed.error);
      if (parsed.data.name) {
        name = parsed.data.name;
        if (!/^[a-z0-9-]+$/.test(name)) errors.push("frontmatter.name 只能是小写字母、数字与连字符");
        if (name.length > 64) errors.push("frontmatter.name 超过 64 字符");
      } else {
        errors.push("frontmatter 缺少 name");
      }
      description = parsed.data.description ?? "";
      if (!description) errors.push("frontmatter 缺少 description（模型靠它判断何时使用）");
      if (description.length > 1024) errors.push("description 超过 1024 字符");
    } catch (err) {
      errors.push("读取失败：" + (err as Error).message);
    }
    out.push({ name, description, path: rel, enabled, errors });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 启用/停用：只重命名 SKILL.md ↔ SKILL.md.disabled，pi 只认 SKILL.md */
export function setSkillEnabled(workspaceRoot: string, name: string, enabled: boolean): boolean {
  const dir = join(skillsRoot(workspaceRoot), name);
  const from = join(dir, enabled ? DISABLED_FILE : SKILL_FILE);
  const to = join(dir, enabled ? SKILL_FILE : DISABLED_FILE);
  if (!existsSync(from)) return false;
  renameSync(from, to);
  return true;
}

export function readSkill(workspaceRoot: string, name: string): string | null {
  const dir = join(skillsRoot(workspaceRoot), name);
  for (const file of [SKILL_FILE, DISABLED_FILE]) {
    const path = join(dir, file);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

/** 新建技能：返回新目录名；已存在则返回 null */
export function createSkill(
  workspaceRoot: string,
  slug: string,
  description: string,
): string | null {
  const safe = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(safe)) return null;
  const dir = join(skillsRoot(workspaceRoot), safe);
  if (existsSync(dir)) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_FILE),
    [
      "---",
      `name: ${safe}`,
      `description: ${description.trim() || "（写清什么时候该用这个技能）"}`,
      "---",
      "",
      `# ${safe}`,
      "",
      "1. ",
      "2. ",
      "3. ",
      "",
      "## 产出",
      "",
      "- 写到 `results/tables/` 或 `figures/`，并在回复里说明路径。",
      "",
    ].join("\n"),
    "utf8",
  );
  return safe;
}
