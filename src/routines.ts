// 周期性职责（routine）：到点前自动从 vault/feed/任务记录聚合生成文档草稿，
// 人审后派引擎任务（claude + lark-cli）精准写进飞书文档对应格子。
// 状态机：pending(今天该做还没到生成点) → draft(草稿待审) → writing(agent 写入中)
//        → written / skipped；手动已填过就点 skip。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { openAction, resolveAction } from "./actions.ts";
import { llmJson } from "./llm.ts";
import { notify } from "./notify.ts";
import { STAGING_DIR, inboxDir } from "./paths.ts";
import { DATA, cfg, ensureDir, fmt, log } from "./util.ts";

export interface Routine {
  id: string;
  name: string;
  docUrl: string;
  days: number[];          // 1=周一 … 5=周五
  time: string;            // 截止（开会时间）"HH:MM"
  aheadMin: number;        // 提前多久生成草稿
  window: "yesterday" | "week";
  guide: string;           // 草稿生成的格式说明（对应文档格子结构）
  project?: string;        // 可选：关联项目 slug，草稿会注入该项目的 README 记忆
  enabled: boolean;
}

// 默认没有 routine——晨会/周报这类职责因团队而异。
// 参考 examples/routines.json 的三个样例，编辑 data/routines.json 添加（首次启动会写一份空数组便于编辑）
const DEFAULTS: Routine[] = [];

const CONF_FILE = join(DATA, "routines.json");
const STATE_DIR = join(DATA, "routines");

export function listRoutines(): Routine[] {
  try { return JSON.parse(readFileSync(CONF_FILE, "utf8")); } catch { /* 首次落默认 */ }
  ensureDir(DATA);
  writeFileSync(CONF_FILE, JSON.stringify(DEFAULTS, null, 2));
  return DEFAULTS;
}

/** 从设置页结构化编辑 routine 规则（时间/星期/窗口/启用/提前量/名称/文档）。逐字段校验后写回 routines.json。 */
export function updateRoutineRule(id: string, patch: Partial<Routine>): Routine[] {
  const rules = listRoutines();
  const r = rules.find((x) => x.id === id);
  if (!r) throw new Error("找不到该 routine");
  if (patch.time !== undefined) { if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(patch.time))) throw new Error("时间格式应为 HH:MM"); r.time = String(patch.time); }
  if (patch.days !== undefined) { const d = patch.days as number[]; if (!Array.isArray(d) || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) throw new Error("星期应为 0–6 的数组"); r.days = [...new Set(d)].sort((a, b) => a - b); }
  if (patch.window !== undefined) { if (patch.window !== "yesterday" && patch.window !== "week") throw new Error("取材窗口只能是 yesterday 或 week"); r.window = patch.window; }
  if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
  if (patch.aheadMin !== undefined) { const a = Number(patch.aheadMin); if (!Number.isFinite(a) || a < 0 || a > 1440) throw new Error("提前量分钟数无效"); r.aheadMin = Math.round(a); }
  if (patch.name !== undefined) r.name = String(patch.name).slice(0, 100);
  if (patch.docUrl !== undefined) r.docUrl = String(patch.docUrl).slice(0, 500);
  if (patch.guide !== undefined) r.guide = String(patch.guide).slice(0, 4000);
  ensureDir(DATA);
  writeFileSync(CONF_FILE, JSON.stringify(rules, null, 2));
  log(`routine rule updated: ${id}`);
  return rules;
}

interface OccState {
  status: "draft" | "writing" | "written" | "skipped";
  draft: string;
  updatedAt: string;
  taskId?: string;
  sourceSig?: string;   // 生成草稿那一刻的素材指纹，用来发现「草稿写完后素材又变了」（见 materialSig）
}

function occFile(id: string, date: string) { return join(STATE_DIR, `${id}-${date}.json`); }

export function occState(id: string, date: string): OccState | null {
  try { return JSON.parse(readFileSync(occFile(id, date), "utf8")); } catch { return null; }
}

function saveOcc(id: string, date: string, s: OccState) {
  ensureDir(STATE_DIR);
  writeFileSync(occFile(id, date), JSON.stringify(s, null, 2));
}

/** 草稿是否已过期（生成后素材又变了）。只对【今天的待审草稿】有意义：
 *  · writing/written/skipped 已落定，再提示只是噪音；
 *  · 逾期 occurrence 的取材窗口本身已经随今天漂走，指纹没有可比性（而且卡片已标了「逾期」）；
 *  · 没存指纹的历史草稿一律当新鲜——宁可不提示也不误报。 */
export function isDraftStale(r: Routine, s: OccState | null, date: string): boolean {
  if (!s || s.status !== "draft" || !s.sourceSig) return false;
  if (date !== fmt(new Date(), "date")) return false;
  return s.sourceSig !== materialSig(r.window);
}

/** 职责总览：今天该做的可操作，非今天的显示下次触发时间——功能不因今天为空而隐身。
 *  逾期补做：最近几天里 draft/writing 还没收尾（没写入也没跳过）的 occurrence 继续端出来带完整控件，
 *  这样错过的晨会/周报可以晚点补写或正经跳过，不再掉进「需要我」只剩一个 x（见 routine 逾期问题）。 */
export function todayRoutines() {
  const today = fmt(new Date(), "date");
  const dow = new Date().getDay();
  const wd = ["日", "一", "二", "三", "四", "五", "六"];
  const routines = listRoutines().filter((r) => r.enabled);

  const cards = routines
    .map((r) => {
      const isToday = r.days.includes(dow);
      // 下一个触发日（不含今天时往后找）
      let next = "";
      let daysUntil = 0;
      if (!isToday) {
        for (let i = 1; i <= 7; i++) {
          if (r.days.includes((dow + i) % 7)) {
            next = i === 1 ? "明天" : `周${wd[(dow + i) % 7]}`;
            daysUntil = i;
            break;
          }
        }
      }
      const s = isToday ? occState(r.id, today) : null;
      return {
        id: r.id, name: r.name, docUrl: r.docUrl, time: r.time, date: today,
        isToday, overdue: false, nextLabel: next, daysUntil,
        status: isToday ? (s?.status || "pending") : "upcoming",
        hasDraft: !!s?.draft,
        taskId: s?.taskId,
        stale: isDraftStale(r, s, today),
      };
    })
    .sort((a, b) => a.daysUntil - b.daysUntil || a.time.localeCompare(b.time));

  // 逾期补做卡：扫最近 7 天 STATE_DIR 里 draft/writing 没收尾、且不是今天的 occurrence
  const overdue: typeof cards = [];
  const cutoff = fmt(new Date(Date.now() - 7 * 86_400_000), "date");
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR)) {
      const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const [, id, date] = m;
      if (date === today || date < cutoff) continue;      // 今天的已在 cards 里；太老的不追（ISO 串按字典序=按时间序）
      const r = routines.find((x) => x.id === id);
      if (!r) continue;                                    // routine 已删/停用：不再纠缠
      const s = occState(id, date);
      if (!s || (s.status !== "draft" && s.status !== "writing")) continue;  // 只补未收尾的
      overdue.push({
        id: r.id, name: r.name, docUrl: r.docUrl, time: r.time, date,
        isToday: false, overdue: true, nextLabel: "", daysUntil: -1,
        status: s.status, hasDraft: !!s.draft, taskId: s.taskId,
        stale: isDraftStale(r, s, date),
      });
    }
  }
  overdue.sort((a, b) => a.date.localeCompare(b.date));    // 最旧的最前，先清理
  return [...overdue, ...cards];                           // 逾期置顶
}

// ---- 草稿生成 ----

/** 取材窗口覆盖的日期列表（gatherMaterial 与 materialSig 必须用同一份，否则指纹对不上素材） */
function materialDays(window: "yesterday" | "week"): string[] {
  const days: string[] = [];
  // 以 cfg.timezone 下的「今天」为基准锚点：getDay()/setDate 与 fmt() 产出的日期必须同源，
  // 否则系统时区 ≠ cfg.timezone 时会跨零点错位（对齐 daily-digest.ts 从 fmt 日期派生 dow 的做法）。
  // 取正午避免任意时区偏移把锚点推到相邻日。
  const now = new Date(`${fmt(new Date(), "date")}T12:00:00`);
  if (window === "yesterday") {
    // 上一个工作日（周一的昨天=上周五）
    const d = new Date(now);
    do { d.setDate(d.getDate() - 1); } while ([0, 6].includes(d.getDay()));
    days.push(fmt(d, "date"));
  } else {
    // 本周一到今天（周一的周报取上周一~上周五）
    const d = new Date(now);
    const isMonday = d.getDay() === 1;
    const start = new Date(d);
    start.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (isMonday ? 7 : 0));
    const end = isMonday ? 5 : ((now.getDay() + 6) % 7) + 1;
    for (let i = 0; i < end; i++) {
      const x = new Date(start);
      x.setDate(start.getDate() + i);
      days.push(fmt(x, "date"));
    }
  }
  return days;
}

/** 素材指纹：日志文件的 size + 任务的 id/状态。草稿生成时冻结一份，人审时重算比对——
 *  草稿从生成到批准可能隔几小时甚至几天（逾期补做卡最多追 7 天），期间 vault 会继续长，
 *  拿一份过期草稿去写飞书文档是静默的错。只做提示，重不重新生成由人定。
 *  用 size 而非 mtime：vault git 同步/编辑器 touch 会动 mtime 但内容没变，那种"变化"提示了只会狼来了。 */
export function materialSig(window: "yesterday" | "week"): string {
  const inbox = inboxDir();
  const parts: string[] = [];
  for (const day of materialDays(window)) {
    for (const f of [join(inbox, `${day}.md`), join(STAGING_DIR, `${day}.md`)]) {
      try { parts.push(`${day}:${statSync(f).size}`); } catch { /* 该来源当天没文件 */ }
    }
  }
  try {
    const days = materialDays(window);
    const tasks = JSON.parse(readFileSync(join(DATA, "tasks.json"), "utf8"))
      .filter((t: any) => days.some((d) => t.startedAt?.startsWith(d)))
      .map((t: any) => `${t.id}${t.status}`);
    parts.push(`tasks:${tasks.sort().join(",")}`);
  } catch { /* 无任务表 */ }
  return parts.join("|");
}

/** 取材：inbox 收割记录优先（分流开着时只含工作 scope），legacy staging 兜底过渡 */
function gatherMaterial(window: "yesterday" | "week"): string {
  const inbox = inboxDir();
  const staging = STAGING_DIR;
  const days = materialDays(window);
  const parts: string[] = [];
  for (const day of days) {
    const nf = join(inbox, `${day}.md`);
    const lf = join(staging, `${day}.md`);
    if (existsSync(nf)) parts.push(`===== ${day} 工作日志 =====\n${readFileSync(nf, "utf8").slice(0, 12_000)}`);
    if (existsSync(lf)) parts.push(`===== ${day} 工作日志(legacy) =====\n${readFileSync(lf, "utf8").slice(0, 12_000)}`);
  }
  // 兜底：ownward 任务记录
  try {
    const tasks = JSON.parse(readFileSync(join(DATA, "tasks.json"), "utf8"))
      .filter((t: any) => days.some((d) => t.startedAt?.startsWith(d)))
      .map((t: any) => `- [${t.project}] ${String(t.task).split("\n")[0].slice(0, 80)} (${t.status})`);
    if (tasks.length) parts.push(`===== 期间 Ownward 任务 =====\n${tasks.join("\n")}`);
  } catch { /* 无任务 */ }
  return parts.join("\n\n").slice(0, 40_000) || "(窗口内没有找到工作记录)";
}

export async function generateDraft(routineId: string): Promise<string> {
  const r = listRoutines().find((x) => x.id === routineId);
  if (!r) throw new Error("routine 不存在");
  const today = fmt(new Date(), "date");
  const { memoryPack, projectScope, stripPersonal } = await import("./memory.ts");
  // 公司文档红线：私人项目段落先确定性剔除，再在 prompt 里下禁令双保险
  const material = stripPersonal(gatherMaterial(r.window));
  const { personal } = projectScope();
  const res = await llmJson([
    `你是${cfg.owner?.name || "用户"}的工作总结代笔。根据工作记录为「${r.name}」生成文档草稿。`,
    "",
    "=== 读者 ===",
    "读者是产品、业务和老板，不是接手代码的人。他们关心「做了什么事、到哪一步、什么结论」，不关心怎么实现的。",
    "写完自己读一遍：一个不看代码的同事能不能看懂每一条。看不懂就是没写完。",
    "",
    "=== 素材是原料，不是成品 ===",
    "素材来自 commit 记录和排障日志，天生全是技术细节。你的活是把它翻译成人话，不是摘抄。",
    "反例（照抄素材）：定位 audio_id 唯一约束线上残留为 UNIQUE CONSTRAINT，AutoMigrate 执行 DROP CONSTRAINT 报 SQLSTATE 42704",
    "正例（翻译过）：排查出周日服务部署失败的原因是线上数据库表结构和代码对不上，调整后已可重新部署",
    "同一件事的多条 commit 合成一条；顺手的小修小补并进它服务的那件事，不单独成条。",
    "但要砍的是技术细节，不是事情本身：素材里各自独立的事各成一条，宁可多一条也别笼统合并掉。",
    "不许写空心话——「优化了 X」「完善了 Y」「推进了 Z」后面必须说清到底什么变了、变成什么样。",
    "翻译不等于脑补：素材里没有的原因、数字、比例一律不许补，宁可写得笼统也不能编具体细节。",
    "",
    "=== 不许出现 ===",
    "commit hash、PR/issue 编号、文件名与路径、函数名类名、分支名、改动行数、错误码、",
    "数据库表名字段名、SQL、接口路径、代码符号，以及服务/模块的内部英文代号（例如 order_sync，改说「订单同步服务」）。",
    "项目名、产品名、用户熟悉的工具名可以照常写；不要为了「去技术」把它们模糊成「某工具」「相关系统」。",
    "",
    "=== 别写出 AI 腔 ===",
    "不写「本周主要围绕…展开」「持续推进」「深度赋能」「形成闭环」「打通全链路」这类套话；",
    "不用破折号排比；不给每条加一句总结性的尾巴。就像口头跟同事汇报，一句话说完一件事。",
    "状态用大白话：已上线 / 还在测 / 明天上线 / 待反馈 / 效果待回收 / 暂时不推进了。",
    "",
    "=== 组织 ===",
    "条目跨三个以上项目时按项目分组（项目名做小标题），组内一条一件事；三五条以内不用分组。",
    "结合「本周目标」组织内容（达成了哪个目标要点明），不要写成无主线流水账。",
    "只写事实和产出，不加浮夸形容词。",
    `【红线】这是公司文档，只写公司工作。以下私人项目即使出现在素材里也绝对不能写：${personal.join("、")}。`,
    memoryPack("routine", r.project || undefined),
    "",
    "=== 目标文档格式 ===",
    r.guide,
    "",
    "=== 工作记录素材 ===",
    material,
    "",
    `输出严格 JSON（不要代码块）：{"draft": "<按上述格式的完整草稿，markdown>"}`,
  ].join("\n"));
  if (!res?.draft) throw new Error("草稿生成失败");
  const draft = String(res.draft);
  saveOcc(r.id, today, { status: "draft", draft, updatedAt: new Date().toISOString(), sourceSig: materialSig(r.window) });
  openAction({
    id: `routine:${r.id}:${today}`,
    kind: "decide",
    source: "dispatch",
    title: `${r.name}——草稿已备好`,
    reason: `${r.time} 截止；今日页审核后一键写入文档，已手动填过就点跳过`,
    ref: { url: r.docUrl },
  });
  // 草稿就绪：横幅+feed（低打扰），飞书发可直接点「写入/跳过」的互动卡片
  await notify(`📋 ${r.name} 草稿已生成（${r.time} 截止），今日页审核写入`, { source: "heartbeat", link: r.docUrl, noLark: true });
  import("./lark-cards.ts").then((m) =>
    m.sendRoutineCard(r.id, today, r.name, r.time, draft.slice(0, 600)),
  ).catch(() => {});
  return draft;
}

// 注意：date 必须用客户端正在编辑的 occurrence 日期（= GET 草稿时传的 date），
// 不能重算 fmt(now)——否则跨天/时区差会让存/读命中不同文件，导致「编辑不生效」。
export function saveDraft(id: string, date: string, content: string) {
  const s = occState(id, date);
  if (!s) throw new Error("没有草稿");
  // 人改过并保存 = 已经看过当前素材并做了取舍：重新盖指纹，别再拿旧提示反复烦人
  const r = listRoutines().find((x) => x.id === id);
  const sourceSig = r ? materialSig(r.window) : s.sourceSig;
  saveOcc(id, date, { ...s, draft: content, sourceSig, updatedAt: new Date().toISOString() });
}

/** 草稿详情（客户端打开审阅面板用）：正文 + 状态 + 素材是否已变 */
export function draftView(id: string, date: string) {
  const s = occState(id, date);
  if (!s) return null;
  const r = listRoutines().find((x) => x.id === id);
  return { draft: s.draft, status: s.status, stale: r ? isDraftStale(r, s, date) : false };
}

export function skipRoutine(id: string, date: string) {
  const s = occState(id, date) || { status: "draft" as const, draft: "", updatedAt: "" };
  saveOcc(id, date, { ...s, status: "skipped", updatedAt: new Date().toISOString() });
  resolveAction(`routine:${id}:${date}`, "skipped");
}

/** 写入：派引擎任务，agent 用 lark-cli 做 block 级精准编辑并自检 */
export async function writeRoutine(id: string, date: string): Promise<string> {
  const r = listRoutines().find((x) => x.id === id);
  const s = occState(id, date);
  if (!r || !s?.draft) throw new Error("没有可写入的草稿");

  const workDir = join(DATA, "routines-work");
  ensureDir(workDir);
  const task = [
    `把下面的内容写进飞书文档我的对应位置。${cfg.owner?.name ? `我是「${cfg.owner.name}」。` : ""}`,
    `文档：${r.docUrl}`,
    "",
    "=== 文档结构说明 ===",
    r.guide,
    "",
    "=== 要写入的内容 ===",
    s.draft,
    "",
    "操作要求（受控写入，逐条遵守）：",
    "1. 先执行 `lark-cli skills read lark-doc` 学习文档操作规范，再动手",
    "2. 用 docs +fetch（先 simple 找到位置，再局部 with-ids 拿 block id）定位【本周的表格/分节】里【我的行/格子】",
    "3. 冲突检测：写入前先看目标格子现有内容——如果已经有人（我自己）填过实质内容且和要写的意思重合，"
      + "【停下不写】，输出「CONFLICT: 已有内容」+ 现有内容摘要，退出码非 0",
    "4. 定位必须精确：找不到本周表格、我的行、目标格子中的任何一个，【直接失败退出】报告原因，绝不写到'差不多'的位置",
    "5. 用 docs +update 的局部指令精准写入；【昨日结果】写进上一个工作日的格子，【今日计划】写进今天的格子（周会/周报按格式说明对应）",
    "6. 只动我自己的格子/分节，绝不碰其他人的内容；已有部分内容（如'计划：'骨架）保留结构补全",
    "7. 写完 re-fetch 回读校验确实写进去了，报告写入位置和内容摘要",
  ].join("\n");

  const { startWork, updateTask } = await import("./dispatch.ts");
  // 人工审批门在「例行草稿写入」那一步（RoutineRow 的「写入」按钮）已经过了——用户批的就是这份草稿写进文档。
  // 派发后的写入 agent 只干一件受控的活（用 lark-cli 写我自己在飞书文档里的格子，prompt 里逐条约束、冲突/定位失败即中止），
  // 不该每条 lark-cli 命令再逐条弹审批（原来漏传 permission → 默认 safe → 高危 Bash 全走审批，例行任务变成要人盯着逐条批）。
  // 仅在开了 allowFullAccess 时用 bypass；没开就退回 safe（保持人工确认门）。
  const routinePermission = cfg.architecture?.allowFullAccess === true ? "bypass" as const : "safe" as const;
  const t = await startWork(workDir, task, { bg: true, worktree: false, permission: routinePermission });
  updateTask(t.id, { kind: "routine" });
  saveOcc(id, date, { ...s, status: "writing", taskId: t.id, updatedAt: new Date().toISOString() });
  return t.id;
}

/** 引擎任务收尾钩子：daemon reap 发现 routine 任务成功退出 → 标记 written */
export function onRoutineTaskDone(taskId: string, ok: boolean) {
  if (!existsSync(STATE_DIR)) return;
  for (const f of readdirSync(STATE_DIR)) {
    try {
      const s: OccState = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8"));
      if (s.taskId !== taskId || s.status !== "writing") continue;
      const [id, date] = [f.replace(/-\d{4}-\d{2}-\d{2}\.json$/, ""), f.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || ""];
      saveOcc(id, date, { ...s, status: ok ? "written" : "draft", updatedAt: new Date().toISOString() });
      if (ok) resolveAction(`routine:${id}:${date}`, "written");
      log(`routine [${id}] write task ${taskId} → ${ok ? "written" : "failed, back to draft"}`);
    } catch { /* skip */ }
  }
}

/** daemon 每分钟调：到生成点自动出草稿（每天每 routine 只生成一次） */
const generating = new Set<string>();

export function sweepRoutines() {
  const now = new Date();
  const dow = now.getDay();
  const today = fmt(now, "date");
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const r of listRoutines()) {
    if (!r.enabled || !r.days.includes(dow)) continue;
    const [h, m] = r.time.split(":").map(Number);
    const due = h * 60 + m;
    if (nowMin < due - r.aheadMin || nowMin > due + 60) continue; // 生成窗口：截止前 ahead ~ 截止后 1h
    if (occState(r.id, today) || generating.has(r.id)) continue;
    generating.add(r.id);
    generateDraft(r.id)
      .catch((e) => log(`routine [${r.id}] draft failed: ${e}`))
      .finally(() => generating.delete(r.id));
  }
}
