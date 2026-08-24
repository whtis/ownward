// Memory 层：可审计的事实库。原则：少、准、有来源、能过期。
// 主存储 = vault 的 memory/ markdown（用户在笔记 tab / Obsidian 直接看改，文件即真相）；
// LLM 只能写 _candidates/ 候选（带证据），正式记忆由人合并。
// 读取按环节给最小 memory pack，不全量注入。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { llmJson } from "./llm.ts";
import { ALL_SCOPES, memoryDir, projectDir } from "./paths.ts";
import { fmt, log } from "./util.ts";

const MEM = memoryDir();

/** 项目知识主页：所有 scope 下找（README 是项目唯一真相，routine/agent 注入用） */
export function projectReadme(slug: string): string {
  for (const scope of ALL_SCOPES) {
    const f = join(projectDir(slug, scope), "README.md");
    if (existsSync(f)) {
      const t = readFileSync(f, "utf8").trim();
      return t.length > 3000 ? t.slice(0, 3000) + "\n…(截断)" : t;
    }
  }
  return "";
}

function readCap(file: string, cap = 4000): string {
  try {
    const t = readFileSync(join(MEM, file), "utf8").trim();
    return t.length > cap ? t.slice(0, cap) + "\n…(截断)" : t;
  } catch { return ""; }
}

/** ISO 周编号（goals 文件名用） */
export function isoWeek(d = new Date()): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((x.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** 各环节的最小记忆包 */
export function memoryPack(kind: "triage" | "heartbeat" | "routine" | "chat" | "digest" | "agent", project?: string): string {
  ensureSeed();
  const parts: string[] = [];
  const add = (label: string, file: string, cap?: number) => {
    const t = readCap(file, cap);
    if (t) parts.push(`### ${label}\n${t}`);
  };
  const goals = "goals.md";   // 单文件滚动（不再按周攒 goals/YYYY-Www.md）
  switch (kind) {
    case "triage":
      add("人物（谁重要）", "people.md", 2500);
      add("通知偏好", "preferences.md", 1500);
      add("进行中的承诺", "commitments.md", 2000);
      add("本周目标", goals, 1500);
      break;
    case "heartbeat":
      add("进行中的承诺（到期要催）", "commitments.md", 2500);
      add("本周目标", goals, 1500);
      break;
    case "routine": {
      add("本周目标", goals, 2000);
      if (project) {
        const readme = projectReadme(project);
        if (readme) parts.push(`### 项目记忆：${project}\n${readme}`);
      }
      add("写作偏好", "preferences.md", 1200);
      add("进行中的承诺", "commitments.md", 1500);
      break;
    }
    case "chat":
      add("用户偏好", "preferences.md", 1200);
      add("本周目标", goals, 1000);
      add("进行中的承诺", "commitments.md", 1000);
      break;
    case "digest":
      add("本周目标（日报围绕目标组织）", goals, 1500);
      add("进行中的承诺", "commitments.md", 1500);
      break;
    case "agent": {
      if (project) {
        const readme = projectReadme(project);
        if (readme) parts.push(`### 项目记忆：${project}\n${readme}`);
      }
      add("工程偏好", "preferences.md", 1000);
      break;
    }
  }
  return parts.length ? `\n=== 记忆（vault memory/，可能过时，与事实冲突以事实为准）===\n${parts.join("\n\n")}\n` : "";
}

/** 日报后跑：从当天工作记录提取候选记忆（只进 _candidates，人工确认后合并） */
export async function extractCandidates(material: string): Promise<string | null> {
  ensureSeed();
  const today = fmt(new Date(), "date");
  const file = join(MEM, "_candidates", `${today}.md`);
  if (existsSync(file)) return null; // 每天一份

  const res = await llmJson([
    "从下面的当日工作记录中提取值得长期记住的候选记忆。宁缺毋滥，只要会影响未来判断的稳定事实：",
    "- 新的承诺（谁答应了谁什么、什么时候要）",
    "- 新的本周/项目目标或目标变化",
    "- 新认识的关键人物/角色关系",
    "- 重要决策及理由",
    "严格要求：每条必须带原文证据（记录里明确说了的），禁止推断和脑补；没有值得记的就输出空数组。",
    `输出严格 JSON：{"candidates": [{"type": "commitment|goal|person|decision", "text": "<一句话>", "evidence": "<原文引用>", "suggest": "<建议写进哪个文件>"}]}`,
    "",
    "=== 当日记录 ===",
    material.slice(0, 30_000),
    "",
    "=== 已有记忆（避免重复提取）===",
    readCap("commitments.md", 1500),
    readCap("goals.md", 1000),
  ].join("\n"));

  const cands = res?.candidates;
  if (!Array.isArray(cands) || !cands.length) { log("memory: 今天没有候选记忆"); return null; }

  const md = [
    "---", `date: ${today}`, "status: pending_review", "---", "",
    `# ${today} 记忆候选（待确认）`, "",
    "> 确认后把内容合并进对应正式文件，然后删掉本文件（或整段删掉不要的）。",
    "",
    ...cands.slice(0, 8).flatMap((c: any) => [
      `## [${c.type}] ${String(c.text).slice(0, 100)}`,
      `- 证据：「${String(c.evidence).slice(0, 200)}」`,
      `- 建议写入：${c.suggest || "?"}`,
      "",
    ]),
  ].join("\n");
  mkdirSync(join(MEM, "_candidates"), { recursive: true });
  writeFileSync(file, md);
  log(`memory: ${cands.length} 条候选 → ${file}`);
  return file;
}

/** 工作/私人项目范围：公司文档（站会/周会/owner 周报/日报）绝不能出现私人项目。
 *  真相在 memory/scope.md（人可改）；返回私人项目名列表用于确定性过滤 + prompt 禁令。 */
export function projectScope(): { work: string[]; personal: string[] } {
  ensureScope();
  const text = readCap("scope.md", 4000);
  const section = (name: string) =>
    (text.split(`## ${name}`)[1] || "").split(/\n## /)[0]
      .split("\n").map((l) => l.replace(/^-\s*/, "").split(/[（(]/)[0].trim())
      .filter((l) => l && !l.startsWith(">") && !l.startsWith("#"));
  return { work: section("工作"), personal: section("私人") };
}

/** 从素材文本里剔除私人项目的段落（staging 的 `## HH:MM | 项目 |` 结构） */
export function stripPersonal(material: string): string {
  const { personal } = projectScope();
  if (!personal.length) return material;
  const isPersonal = (s: string) => personal.some((p) => p && s.toLowerCase().includes(p.toLowerCase()));
  return material
    .split(/\n(?=## )/)
    .filter((sec) => !isPersonal(sec.split("\n")[0]))
    .join("\n");
}

function ensureScope() {
  const f = join(MEM, "scope.md");
  if (existsSync(f)) return;
  mkdirSync(MEM, { recursive: true });
  writeFileSync(f, [
    "---", "type: project_scope", `updated_at: ${fmt(new Date(), "date")}`, "---", "",
    "# 项目范围（工作/私人分离）", "",
    "> 公司文档（站会/周会/周报）和日报只写「工作」项目；「私人」项目绝不出现。",
    "> 项目名按 vault 里的写法（匹配不区分大小写），每行一个，直接列在对应小节下。", "",
    "## 工作", "- （在这里列工作项目名）", "",
    "## 私人", "- （在这里列私人项目名）", "",
  ].join("\n"));
  log("memory: scope.md 已落（工作/私人项目分类，可编辑）");
}

/** 记忆杂务巡检（daemon 每 10min 调）：需要人参与的事浮到今日页收件箱，不靠人记得来翻。
 *  1) _candidates 有待确认文件 → Action（处理完自动消掉）
 *  2) 新的一周还没定目标 → 从上周目标播种新文件 + Action 让人确认 */
export async function sweepMemoryChores() {
  ensureSeed();
  const { openAction, resolveAction } = await import("./actions.ts");
  const { readdirSync, statSync } = await import("fs");

  // 1) 候选记忆待确认
  const candDir = join(MEM, "_candidates");
  const cands = existsSync(candDir) ? readdirSync(candDir).filter((f) => f.endsWith(".md")) : [];
  if (cands.length) {
    openAction({
      id: "memory:candidates",
      kind: "decide",
      source: "dispatch",
      title: `记忆候选待确认（${cands.length} 份）`,
      reason: "值得的并进正式记忆文件，不要的整段删掉；处理完删除候选文件即消",
      ref: { note: join(candDir, cands.sort().pop()!) },
    });
  } else {
    resolveAction("memory:candidates", "processed");
  }

  // 2) 每周目标：单文件 goals.md 原地滚动（不再按周攒文件）。
  //    新的一周把 week 字段翻新、上周目标留作编辑基线、置顶提示；删掉提示行即算确认。
  const dow = new Date().getDay();
  if (dow >= 1 && dow <= 5) {
    const week = isoWeek();
    const goalsFile = join(MEM, "goals.md");
    const PROMPT = "> 新的一周：确认/改写下面的目标（周会定了就同步过来），删掉这行即完成。";
    const body = existsSync(goalsFile) ? readFileSync(goalsFile, "utf8") : "";
    const fileWeek = body.match(/^week:\s*(\S+)/m)?.[1];
    if (fileWeek !== week) {
      // 拆出「本周目标正文」和已有「## 历史」段
      const afterFront = body.replace(/^---[\s\S]*?---\n/, "");
      const [curPart, histPart = ""] = afterFront.split(/^##\s+历史\s*$/m);
      const outgoing = curPart                       // 上周目标：剥掉标题/提示，作基线 + 归档
        .replace(/^#\s+.*本周目标.*$/gm, "")
        .replace(/^>.*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // 冻结上周进历史（最新在上），按 "### <周>" 分块，最多留 8 周
      const archived = fileWeek && outgoing ? [`### ${fileWeek}`, outgoing, ""].join("\n") : "";
      const histBlocks = (archived + histPart.trim())
        .split(/(?=^###\s)/m).map((s) => s.trim()).filter(Boolean).slice(0, 8);
      const history = histBlocks.length ? ["## 历史", "", ...histBlocks.map((b) => b + "\n")].join("\n") : "";
      writeFileSync(goalsFile, [
        "---", "type: weekly_goals", `week: ${week}`, `updated_at: ${fmt(new Date(), "date")}`, "---", "",
        `# 本周目标（${week}）`, "",
        PROMPT, "",
        outgoing || "- ", "",
        history,
      ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
      openAction({
        id: `memory:goals:${week}`, kind: "decide", source: "dispatch",
        title: "新的一周：确认本周目标",
        reason: "沿用上周目标作基线，周会定了就改这里——routine 和 triage 都靠它组织",
        ref: { note: goalsFile },
      });
      log(`memory: rolled goals to ${week}`);
    } else if (!body.includes("删掉这行即完成")) {
      resolveAction(`memory:goals:${week}`, "confirmed");
    }
  }
}

/** 一键确认本周目标（沿用上周、周会没调整时）：删掉「删掉这行即完成」提示行 + 消掉 action，
 *  不用进编辑器手删那行。改了目标的走编辑器存盘（同样删了提示行就自动消，见 sweepMemoryChores）。 */
export async function confirmGoals(): Promise<{ ok: boolean; msg: string }> {
  const goalsFile = join(MEM, "goals.md");
  if (!existsSync(goalsFile)) return { ok: false, msg: "还没有本周目标文件" };
  let body = readFileSync(goalsFile, "utf8");
  const week = body.match(/^week:\s*(\S+)/m)?.[1] || isoWeek();
  if (body.includes("删掉这行即完成")) {
    body = body.split("\n").filter((l) => !l.includes("删掉这行即完成")).join("\n").replace(/\n{3,}/g, "\n\n");
    writeFileSync(goalsFile, body);
  }
  const { resolveAction } = await import("./actions.ts");
  resolveAction(`memory:goals:${week}`, "confirmed");
  log(`memory: goals ${week} confirmed`);
  return { ok: true, msg: "本周目标已确认" };
}

/** 首次落骨架：让用户知道每个文件长什么样、该填什么 */
function ensureSeed() {
  if (existsSync(join(MEM, "preferences.md"))) return;
  mkdirSync(join(MEM, "_candidates"), { recursive: true });

  writeFileSync(join(MEM, "preferences.md"), [
    "---", "type: user_preferences", `updated_at: ${fmt(new Date(), "date")}`, "---", "",
    "# 偏好", "",
    "## 通知",
    "- 只有需要行动的事才打扰；FYI 静默进流水",
    "- 深夜（quietHours）不推送", "",
    "## 写作（routine 草稿/日报）",
    "- 中文、直接说结论、条目化、写事实和产出，不要浮夸形容词", "",
    "## 工程",
    "- Ownward 是个人工具：无外部依赖、可维护性优先、人类可读的文件当真相", "",
  ].join("\n"));

  writeFileSync(join(MEM, "people.md"), [
    "---", "type: people_memory", `updated_at: ${fmt(new Date(), "date")}`, "---", "",
    "# 人物（triage 判断谁重要的依据）", "",
    "## （示例）张三",
    "- relation: 某项目协作方",
    "- priority: high", "",
    "> 按这个格式补充：老板、关键协作人、客户方。priority: high 的人的消息优先通知。", "",
  ].join("\n"));

  writeFileSync(join(MEM, "commitments.md"), [
    "---", "type: commitments", `updated_at: ${fmt(new Date(), "date")}`, "---", "",
    "# 进行中的承诺", "",
    "> 格式：- [ ] 内容（对谁 · due YYYY-MM-DD · 来源）；完成改 [x]，heartbeat 会催快到期的。", "",
  ].join("\n"));

  writeFileSync(join(MEM, "goals.md"), [
    "---", "type: weekly_goals", `week: ${isoWeek()}`, `updated_at: ${fmt(new Date(), "date")}`, "---", "",
    `# 本周目标（${isoWeek()}）`, "",
    "- （在这里写本周要推进的事，routine 草稿和 triage 都以此组织内容）", "",
    "> 周会确认的目标同步到这里；每周原地更新，不新建文件。", "",
  ].join("\n"));

  log("memory: 骨架已落 vault memory/（笔记 tab 可直接编辑）");
}
