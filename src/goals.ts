// 本周长效目标（Active Goals）：memory/goals.md 里的 markdown 待办就是真相，这里只做读、勾选、给模型的摘要。
// 文件由人维护、sweepMemoryChores 每周原地滚动（见 memory.ts）——这里绝不改目标正文，只翻 [ ] ↔ [x]。
// 只认「当前周」那一段：「## 历史」以下是冻结的往周目标，勾了也没意义，解析时整段跳过。
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "./fs-durable.ts";
import { memoryDir } from "./paths.ts";
import { fmt, log } from "./util.ts";

export interface ActiveGoal {
  id: string;          // g-<文本哈希>：文件在别处被改过时，旧 id 找不到就失败，而不是按序号勾错一条
  text: string;
  done: boolean;
  project?: string;    // 「[项目] 目标」写法的项目标签
}
export interface GoalsSummary {
  week: string;
  updatedAt?: string;
  goals: ActiveGoal[];
}

let fileOverride: string | null = null;
/** 单测注入临时文件；传 null 恢复真实 vault。业务代码永远不要调用。 */
export function useGoalsFileForTest(file: string | null) { fileOverride = file; }
const goalsFile = () => fileOverride || join(memoryDir(), "goals.md");

const FRONT_RE = /^---\n([\s\S]*?)\n---\n?/;
const ITEM_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*\S)\s*$/;

interface Parsed extends GoalsSummary { lines: string[]; lineOf: Map<string, number> }

function parse(body: string): Parsed {
  const fm = body.match(FRONT_RE), front = fm?.[1] || "";
  const field = (k: string) => front.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, "m"))?.[1] || "";
  const lines = body.split("\n");
  const start = fm ? fm[0].split("\n").length - 1 : 0;
  const goals: ActiveGoal[] = [], lineOf = new Map<string, number>(), seen = new Map<string, number>();
  let fenced = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^##\s+历史\s*$/.test(line)) break;
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const raw = m[4].trim();
    const base = `g-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    const id = n > 1 ? `${base}-${n}` : base;   // 同一句目标写了两遍：各自一个 id，勾哪条就是哪条
    const tag = raw.match(/^\[([^\]]+)\]\s*(.+)$/);
    goals.push({ id, text: tag ? tag[2] : raw, done: m[2] !== " ", ...(tag ? { project: tag[1].trim() } : {}) });
    lineOf.set(id, i);
  }
  const updatedAt = field("updated_at");
  return { week: field("week"), ...(updatedAt ? { updatedAt } : {}), goals, lines, lineOf };
}

/** 纯函数：解析 goals.md 正文（单测与 getActiveGoals 共用） */
export function parseGoals(body: string): GoalsSummary {
  const { week, updatedAt, goals } = parse(body);
  return { week, ...(updatedAt ? { updatedAt } : {}), goals };
}

function readBody(): string | null {
  const f = goalsFile();
  if (!existsSync(f)) return null;
  try { return readFileSync(f, "utf8"); } catch { return null; }
}

export function getActiveGoals(): GoalsSummary | null {
  const body = readBody();
  if (!body?.trim()) return null;
  return parseGoals(body);
}

export function toggleGoal(goalId: string, done: boolean): boolean {
  const body = readBody();
  if (!body || typeof goalId !== "string") return false;
  const p = parse(body), i = p.lineOf.get(goalId);
  if (i === undefined) return false;   // 文件在别处被改过、这条已经不在了：如实失败，不猜
  if (p.goals.find((g) => g.id === goalId)!.done === done) return true;
  const lines = [...p.lines];
  lines[i] = lines[i].replace(ITEM_RE, (_, a, _mark, b, rest) => `${a}${done ? "x" : " "}${b}${rest}`);
  let next = lines.join("\n");
  const today = fmt(new Date(), "date");
  const front = next.match(FRONT_RE);
  if (front) {
    const inner = /^updated_at:.*$/m.test(front[1])
      ? front[1].replace(/^updated_at:.*$/m, `updated_at: ${today}`)
      : `${front[1]}\nupdated_at: ${today}`;
    next = next.replace(FRONT_RE, () => `---\n${inner}\n---\n`);   // 函数形式：frontmatter 里的 $ 不被当替换模式
  }
  writeFileAtomic(goalsFile(), next);
  log(`goals: ${goalId} → ${done ? "done" : "open"}`);
  return true;
}

/** 给心跳/triage 的精简版：只列目标与完成态，不带 frontmatter/提示行/历史 */
export function formatGoalsForPrompt(): string {
  const s = getActiveGoals();
  if (!s?.goals.length) return "";
  const done = s.goals.filter((g) => g.done).length;
  return [
    `本周目标${s.week ? `（${s.week}）` : ""}：已完成 ${done}/${s.goals.length}`,
    ...s.goals.map((g) => `- [${g.done ? "x" : " "}] ${g.project ? `[${g.project}] ` : ""}${g.text}`),
  ].join("\n");
}
