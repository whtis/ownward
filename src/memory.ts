// Memory 层：可审计的事实库。原则：少、准、有来源、能过期。
// 主存储 = vault 的 memory/ markdown（用户在笔记 tab / Obsidian 直接看改，文件即真相）；
// LLM 只能写 _candidates/ 候选（带证据），正式记忆由人合并。
// 读取按环节给最小 memory pack，不全量注入。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { llmJson } from "./llm.ts";
import { ALL_SCOPES, memoryDir, projectDir, WORK_SCOPE } from "./paths.ts";
import { fmt, loadState, log, updateState } from "./util.ts";

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

/** 决策候选按项目分流（纯函数）：属于某个有负责角色的项目（项目 Owner / 领域角色的主项目）就进那个项目的
 *  候选——在角色页审，审的时候有那个项目的上下文；人物/承诺/目标和说不清归属的决策留在当日这份。
 *  2026-10 生产数据：memory/_candidates 积了 33 天 73 条没人合，其中 49 条决策大多写明了该进哪个项目。 */
export function routeCandidates(cands: any[], owned: Set<string>): { toProject: Array<{ slug: string; c: any }>; rest: any[] } {
  const toProject: Array<{ slug: string; c: any }> = [], rest: any[] = [];
  for (const c of cands) {
    const slug = String(c?.project ?? "").trim().toLowerCase();
    if (c?.type === "decision" && owned.has(slug)) toProject.push({ slug, c });
    else rest.push(c);
  }
  return { toProject, rest };
}

/** 日报后跑：从当天工作记录提取候选记忆（只进 _candidates，人工确认后合并）。
 *  返回当日候选文件（没有就 null）和分进项目候选的条数——两处都要人审，通知时都得说 */
export async function extractCandidates(material: string): Promise<{ file: string | null; routed: number }> {
  ensureSeed();
  const today = fmt(new Date(), "date");
  const file = join(MEM, "_candidates", `${today}.md`);
  // 每天只提一次：当日文件在、或者当天已经提过（全部分给了项目、一份当日文件都没写）都算。
  // 只认文件的话，全分出去的那天每次手动重跑日报都会再分一遍，项目候选里攒出一模一样的重复条目
  if (existsSync(file) || loadState().memoryCandidatesDay === today) return { file: null, routed: 0 };
  // 有负责角色的项目：决策直接分给它（候选门不变，只是换了个审的地方）
  const { listRoles } = await import("./roles.ts");
  const ownedRoles = listRoles().filter((r) => r.scope === WORK_SCOPE && r.type === "project" && !r.conflict && r.primaryProject);
  const owned = new Set(ownedRoles.map((r) => r.primaryProject));

  const res = await llmJson([
    "从下面的当日工作记录中提取值得长期记住的候选记忆。宁缺毋滥，只要会影响未来判断的稳定事实：",
    "- 新的承诺（谁答应了谁什么、什么时候要）",
    "- 新的本周/项目目标或目标变化",
    "- 新认识的关键人物/角色关系",
    "- 重要决策及理由",
    "严格要求：每条必须带原文证据（记录里明确说了的），禁止推断和脑补；没有值得记的就输出空数组。",
    `输出严格 JSON：{"candidates": [{"type": "commitment|goal|person|decision", "text": "<一句话>", "evidence": "<原文引用>", "suggest": "<建议写进哪个文件>", "project": "<决策属于下面哪个项目就填它的 slug；跨项目、说不清或不是决策就空串>"}]}`,
    ...(ownedRoles.length ? ["", "=== 有负责角色的项目（slug：角色）===", ...ownedRoles.map((r) => `- ${r.primaryProject}：${r.name}`)] : []),
    "",
    "=== 当日记录 ===",
    material.slice(0, 30_000),
    "",
    "=== 已有记忆（避免重复提取）===",
    readCap("commitments.md", 1500),
    readCap("goals.md", 1000),
  ].join("\n"));

  const all = res?.candidates;
  if (!Array.isArray(all)) { log("memory: 候选记忆没提出来（模型没给结果），下次日报再试"); return { file: null, routed: 0 }; }
  updateState((s) => { s.memoryCandidatesDay = today; });
  if (!all.length) { log("memory: 今天没有候选记忆"); return { file: null, routed: 0 }; }

  const { toProject, rest } = routeCandidates(all.slice(0, 8), owned);
  let routed = 0;
  const { createProjectCandidate } = await import("./project-memory.ts");
  for (const { slug, c } of toProject) {
    const r = createProjectCandidate(slug, WORK_SCOPE, {
      text: String(c.text ?? "").slice(0, 1000), evidence: String(c.evidence ?? "").slice(0, 2000), sourceChatId: `digest:${today}`,
    });
    if (r.ok) routed++;
    else { log(`memory: 决策候选分给 ${slug} 没成功，留在当日候选里：${(r as { msg: string }).msg}`); rest.push(c); }
  }
  if (routed) log(`memory: ${routed} 条决策候选分进了项目候选（角色页审）`);
  const cands = rest;
  if (!cands.length) return { file: null, routed };

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
  return { file, routed };
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
  const { openAction, resolveAction, resolveActionExact } = await import("./actions.ts");
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

  // 1b) 项目记忆候选（日报分给项目的决策、对话里存的项目候选）：在角色页审，同样浮到收件箱——
  //     分出去的候选没人看见，就等于又攒成了一个没人合的堆
  try {
    const { listRoles } = await import("./roles.ts");
    const { listProjectCandidates, isBackfilledCandidate } = await import("./project-memory.ts");
    let n = 0, newest = "", backfilled = 0;
    const names: string[] = [];
    for (const r of listRoles()) {
      if (r.type !== "project" || !r.primaryProject || r.conflict) continue;
      const c = listProjectCandidates(r.primaryProject, r.scope);
      if (!c.ok || !c.candidates.length) continue;
      n += c.candidates.length; names.push(r.name);
      backfilled += c.candidates.filter(isBackfilledCandidate).length;
      // 批次标记用最新一条的创建时刻（ISO，按字符串比就是按时间比）——候选 id 是「日期-随机串」，同一天的谁大谁小是随机的
      for (const x of c.candidates) if (x.createdAt > newest) newest = x.createdAt;
    }
    // 行动 id 跟着「高水位」走：来了比上次更新的候选才换新 id（已处理/忽略过的行动不会复活，新来的得能重新浮上来）；
    // 只处理掉一部分、最新的那条反而比水位旧时沿用当前 id——按「最新一条」算 id 会退回一个早就关掉的旧 id，提醒凭空消失
    const cur = (loadState().projectCandidatesAction || {}) as { id?: string; hwm?: string };
    if (!n) {
      if (cur.id) { resolveActionExact(cur.id, "processed"); updateState((s) => { delete s.projectCandidatesAction; }); }
    } else {
      let id = cur.id || "";
      if (!id || newest > (cur.hwm || "")) {
        if (id) resolveActionExact(id, "superseded");
        id = `memory:project-candidates:${newest.replace(/[^0-9]/g, "")}`;
        const next = { id, hwm: newest };
        updateState((s) => { s.projectCandidatesAction = next; });
      }
      openAction({
        id, kind: "decide", source: "dispatch",
        title: `项目记忆候选待审（${n} 条）`,
        // 回填的旧账单独点出来：混在日常计数里，看着像每天新攒了几十条，其实是一次性的历史，按来源日期筛出来批量丢就行
        reason: `在「角色」页对应角色下逐条晋升或丢弃：${names.slice(0, 5).join("、")}${names.length > 5 ? ` 等 ${names.length} 个角色` : ""}` +
          (backfilled ? `；其中 ${backfilled} 条是回填的旧日报决策，可在角色页筛「更早来源」批量丢弃` : ""),
        ref: {},
      });
    }
  } catch (e) { log(`memory: 项目记忆候选巡检失败：${e}`); }

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
