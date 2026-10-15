// 项目知识的读侧：把 <scope>/projects/<slug>/ 整个目录压成一段给模型读的摘要。
//
// 只注入 README 是不够的——2026-10 实测 vault 里 40 个项目的 README 全是收割建的空骨架（~230 字节），
// 真正的项目记忆在 log/YYYY-MM.md（每次会话/任务收割出的 Problem → Solution）和晋升出来的
// decisions.md / operations.md 里。角色「读得到整个项目的记忆」= 按预算依次装：
//   README（空骨架就跳过）→ 项目决策 → 部署与排障 → 近期工作日志（新的在前）→ 其它文档的目录。
//
// 纯函数 + 显式根目录：roles.ts（组装角色记忆包）和 project-memory.ts（写候选）都依赖它，
// 它自己不依赖任何一方，不会成环。README 骨架也只定义在这里，收割（capture.ts）建骨架、
// 这里判「还是空骨架」，两边用同一份文本才不会漂。
import { isStrictlyWithin } from "./path-within.ts";
import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import type { Scope } from "./paths.ts";

/** 收割建 README 时的占位行。改它要同时想到：旧 vault 里成百上千份 README 还是旧文本 */
export const PROJECT_README_PLACEHOLDER = "(项目当前状态、入口、未决问题——人和 AI 共同维护，这是项目唯一真相)";

export function projectReadmeSkeleton(slug: string, scope: Scope, date: string): string {
  return [
    "---", "type: project_memory", `project: ${slug}`, ...(scope ? [`scope: ${scope}`] : []), `updated_at: ${date}`, "---", "",
    `# ${slug}`, "",
    "## 现状", PROJECT_README_PLACEHOLDER, "",
    "## 已知陷阱", "", "## 决策", "",
  ].join("\n");
}

/** 领域角色的虚拟项目 README（没有代码目录的那类活）。frontmatter 多一行 kind: domain——
 *  isDomainReadme 靠它认「这个项目目录是领域角色建的」，别的仓库的收割目录不会被当成虚拟项目接管。
 *  没写现状就用同一行占位，isSkeletonReadme 照样认得出这是空骨架 */
export function domainReadme(name: string, slug: string, scope: Scope, description: string, date: string): string {
  return [
    "---", "type: project_memory", `project: ${slug}`, "kind: domain", ...(scope ? [`scope: ${scope}`] : []), `updated_at: ${date}`, "---", "",
    `# ${name}`, "",
    "## 现状", description.trim() || PROJECT_README_PLACEHOLDER, "",
    "## 已知陷阱", "", "## 决策", "",
  ].join("\n");
}

export function isDomainReadme(text: string): boolean {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  return !!fm && /^kind:\s*domain\s*$/m.test(fm[1]);
}

const stripFrontmatter = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n?/, "");

/** 只剩 frontmatter / 标题 / 占位行：注进去全是噪音，还会让模型以为「项目现状就这些」 */
export function isSkeletonReadme(text: string): boolean {
  return stripFrontmatter(text).split("\n").every((l) => {
    const t = l.trim();
    return !t || t.startsWith("#") || t === PROJECT_README_PLACEHOLDER;
  });
}

/** markdown 里「有没有实质条目」：顶格非标题非引导语的行（同 web/roles.js 的 docEntries） */
export function hasEntries(text: string): boolean {
  return stripFrontmatter(text).split("\n").some((raw) => raw.trim() && !/^\s/.test(raw) && !/^[>#]/.test(raw.trim()));
}

function cap(t: string, n: number): string {
  if (n <= 0) return "";
  return t.length > n ? t.slice(0, Math.max(0, n - 6)).trimEnd() + "\n…(截断)" : t;
}

function readText(file: string): string {
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

const LOG_FILE_RE = /^\d{4}-\d{2}\.md$/;
const DOC_FILE_RE = /^[^.][^/]*\.md$/;
const CORE_DOCS = new Set(["README.md", "decisions.md", "operations.md"]);

interface LogEntry { month: string; head: string; problem: string; solution: string; failed: string }

/** 一个月度日志文件 → 条目（文件内按时间追加，返回时新的在前） */
export function parseLogEntries(month: string, text: string): LogEntry[] {
  const out: LogEntry[] = [];
  let cur: LogEntry | null = null;
  const field = (line: string, key: string) => {
    const m = line.match(new RegExp(`^-\\s*\\*\\*${key}\\*\\*\\s*[:：]\\s*(.*)$`));
    return m ? m[1].trim() : null;
  };
  for (const line of stripFrontmatter(text).split("\n")) {
    if (line.startsWith("## ")) {
      if (cur) out.push(cur);
      // 收割格式：「## HH:MM | slug | 标题」；别的格式原样当标题
      const parts = line.slice(3).split("|").map((s) => s.trim());
      const head = parts.length >= 3 ? `${parts[0]} ${parts.slice(2).join(" | ")}` : line.slice(3).trim();
      cur = { month, head, problem: "", solution: "", failed: "" };
      continue;
    }
    if (!cur) continue;
    cur.problem ||= field(line, "Problem") ?? "";
    cur.solution ||= field(line, "Solution") ?? "";
    cur.failed ||= field(line, "Failed attempt") ?? "";
  }
  if (cur) out.push(cur);
  return out.reverse();
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 最近 n 条工作日志的标题（新的在前）：给领域匹配当「这个角色平时干什么」的样例。
 *  路径复核同 projectMemoryDigest：slug 拼出来的目录必须仍在 projectsBase 里 */
export function recentLogTitles(projectsBase: string, slug: string, n = 8): string[] {
  const dir = join(projectsBase, slug, "log");
  if (!isStrictlyWithin(projectsBase, dir) || !existsSync(dir)) return [];
  try {
    // 软链复核同 projectMemoryDigest：字符串前缀拦不住 projects/foo -> /etc 这种目录软链
    if (!isStrictlyWithin(realpathSync(projectsBase), realpathSync(dir))) return [];
  } catch { return []; }
  let months: string[] = [];
  try { months = readdirSync(dir).filter((f) => LOG_FILE_RE.test(f)).sort().reverse(); } catch { return []; }
  const out: string[] = [];
  for (const f of months.slice(0, 6)) {
    for (const e of parseLogEntries(f.slice(0, 7), readText(join(dir, f)))) {
      // 「HH:MM 标题」→ 只要标题
      out.push(clip(e.head.replace(/^\d{1,2}:\d{2}\s+/, ""), 40));
      if (out.length >= n) return out;
    }
  }
  return out;
}

function entryText(e: LogEntry): string {
  return [
    `- [${e.month} ${e.head}]`,
    ...(e.problem ? [`  问题：${clip(e.problem, 140)}`] : []),
    ...(e.solution ? [`  结论：${clip(e.solution, 240)}`] : []),
    ...(e.failed ? [`  踩坑：${clip(e.failed, 140)}`] : []),
  ].join("\n");
}

export interface DigestOptions {
  /** 这一个项目最多占多少字（中文按字计）。README 等各份文档按比例分，剩下的全给日志 */
  budget: number;
  /** 段落标题：「主项目记忆」/「项目记忆」——chat/roles 的老测试按这个字面认 */
  label: string;
  /** 给能读文件的 agent：附上完整记忆目录的绝对路径，细节自己去读 */
  pointer?: boolean;
}

/** 一个项目的记忆摘要；什么都没有就空串（调用方据此不出段落标题）。
 *  projectsBase 必须是调用方已经按 scope 定死的 <root>/<scope>/projects——这里只做两道复核：
 *  slug 拼出来的目录仍在 base 内（字符串前缀），且 realpath 也没被软链带出 base。 */
export function projectMemoryDigest(projectsBase: string, slug: string, opts: DigestOptions): string {
  const dir = join(projectsBase, slug);
  if (!isStrictlyWithin(projectsBase, dir) || !existsSync(dir)) return "";
  try {
    if (!isStrictlyWithin(realpathSync(projectsBase), realpathSync(dir))) return "";
  } catch { return ""; }

  const parts: string[] = [];
  let left = opts.budget;
  const take = (title: string, text: string, share: number) => {
    if (!text || left <= 0) return;
    const t = cap(text, Math.min(left, Math.floor(opts.budget * share)));
    if (!t) return;
    parts.push(title ? `#### ${title}\n${t}` : t);
    left -= t.length + title.length;
  };

  const readme = readText(join(dir, "README.md"));
  if (readme && !isSkeletonReadme(readme)) take("", readme, 0.55);
  // 晋升建出来的文件自带「# x · 项目决策」一级标题：外面已经有段落标题了，去掉免得重复
  const docBody = (t: string) => stripFrontmatter(t).trim().replace(/^#\s[^\n]*\n+/, "");
  const decisions = readText(join(dir, "decisions.md"));
  if (hasEntries(decisions)) take("项目决策", docBody(decisions), 0.2);
  const ops = readText(join(dir, "operations.md"));
  if (hasEntries(ops)) take("部署与排障", docBody(ops), 0.15);

  // 近期日志：从最新的月份往回翻，一条条装到预算用完（最多 12 条，再多模型也不看）
  const logDir = join(dir, "log");
  const months = (() => { try { return readdirSync(logDir).filter((f) => LOG_FILE_RE.test(f)).sort().reverse(); } catch { return []; } })();
  const lines: string[] = [];
  let logLeft = left - 40;
  outer: for (const f of months.slice(0, 6)) {
    for (const e of parseLogEntries(f.slice(0, 7), readText(join(logDir, f)))) {
      const t = entryText(e);
      if (t.length > logLeft || lines.length >= 12) break outer;
      lines.push(t);
      logLeft -= t.length + 1;
    }
  }
  if (lines.length) {
    parts.push(`#### 近期工作日志（log/，新的在前）\n${lines.join("\n")}`);
    left = logLeft;
  }

  // 其它文档（复盘、方案…）只列名字：内容可能很长，能读文件的 agent 自己按需打开
  const others = (() => { try { return readdirSync(dir).filter((f) => DOC_FILE_RE.test(f) && !CORE_DOCS.has(f)).sort(); } catch { return []; } })();
  if (others.length) parts.push(`#### 其它文档\n${others.slice(0, 20).map((f) => `- ${f}`).join("\n")}${others.length > 20 ? `\n- …还有 ${others.length - 20} 份` : ""}`);

  if (!parts.length) {
    // README 是空骨架且一条日志都没有：如实说一句，比静默不出段落更好查（主项目尤其）
    if (!readme) return "";
    parts.push("（README 还是空模板，也还没有工作日志——这个项目的记忆是空的）");
  }
  if (opts.pointer) parts.push(`（完整记忆在 ${dir}/ ——log/ 按月归档；需要细节直接读，只读：结论写进最后的回复，别改这些文件）`);
  return `### ${opts.label}：${slug}\n${parts.join("\n\n")}`;
}
