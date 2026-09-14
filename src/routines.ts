// 周期性职责（routine）：到点前自动从 vault/feed/任务记录聚合生成文档草稿，
// 人审后派引擎任务（claude + lark-cli）精准写进飞书文档对应格子。
// 状态机：pending(今天该做还没到生成点) → draft(草稿待审) → writing(agent 写入中)
//        → written / skipped；手动已填过就点 skip。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { openAction, resolveAction } from "./actions.ts";
import { llmJson } from "./llm.ts";
import { archiveMeetingSource, meetingSourceHash, readBoundedFile, readMeetingArchive, type MeetingSource } from "./meeting-archive.ts";
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
  window: "yesterday" | "week" | "month";
  guide: string;           // 草稿生成的格式说明（对应文档格子结构）
  project?: string;        // 可选：关联项目 slug，草稿会注入该项目的 README 记忆
  enabled: boolean;
  cadence?: "weekly" | "monthly";
  /** 可选：把别的 routine 对应的飞书文档（晨会/周会表）当素材读进来，按取材窗口抽周、按 people 抽行。
   *  月度复盘用：晨会/周会是经过人整理的一手记录，比 commit 日志更接近产品/运营口径。 */
  refRoutines?: string[];
  /** 可选：草稿要覆盖的人（飞书显示名子串，"李四" 能匹配 "Blair 李四"）。不填=只写本人。
   *  填了多人时草稿按项目合写、不按人分组——读者是领导，看的是项目进展，不是谁干了什么。 */
  people?: string[];
  allowMissingSources?: boolean;
}

// 默认没有 routine——晨会/周报这类职责因团队而异。
// 参考 examples/routines.json 的三个样例，编辑 data/routines.json 添加（首次启动会写一份空数组便于编辑）
const DEFAULTS: Routine[] = [];

const CONF_FILE = join(DATA, "routines.json");
const STATE_DIR = join(DATA, "routines");

export function listRoutines(readOnly = false): Routine[] {
  try { return JSON.parse(readFileSync(CONF_FILE, "utf8")); } catch { /* 首次落默认 */ }
  if (readOnly) return [];
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
  if (patch.window !== undefined) { if (patch.window !== "yesterday" && patch.window !== "week" && patch.window !== "month") throw new Error("取材窗口只能是 yesterday、week 或 month"); r.window = patch.window; }
  if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
  if (patch.aheadMin !== undefined) { const a = Number(patch.aheadMin); if (!Number.isFinite(a) || a < 0 || a > 1440) throw new Error("提前量分钟数无效"); r.aheadMin = Math.round(a); }
  if (patch.name !== undefined) r.name = String(patch.name).slice(0, 100);
  if (patch.docUrl !== undefined) r.docUrl = String(patch.docUrl).slice(0, 500);
  if (patch.guide !== undefined) r.guide = String(patch.guide).slice(0, 4000);
  validateRoutineMaterialPatch(patch, rules, id);
  if (patch.cadence !== undefined) r.cadence = patch.cadence;
  if (patch.people !== undefined) r.people = patch.people.map((x) => x.trim());
  if (patch.refRoutines !== undefined) r.refRoutines = [...patch.refRoutines];
  ensureDir(DATA);
  writeFileSync(CONF_FILE, JSON.stringify(rules, null, 2));
  log(`routine rule updated: ${id}`);
  return rules;
}

export function validateRoutineMaterialPatch(patch: Partial<Routine>, rules: Routine[], id: string) {
  if (patch.cadence !== undefined && patch.cadence !== "weekly" && patch.cadence !== "monthly") throw new Error("频率只能是 weekly 或 monthly");
  if ("monthDay" in patch) throw new Error("月度固定为首个周一前的周日，不支持 monthDay");
  if (patch.people !== undefined && (!Array.isArray(patch.people) || patch.people.length > 20 || patch.people.some((p) => typeof p !== "string" || !p.trim() || p.length > 100) || new Set(patch.people.map((p) => p.trim())).size !== patch.people.length)) throw new Error("人员应为最多 20 个不重复的非空姓名");
  if (patch.refRoutines !== undefined && (!Array.isArray(patch.refRoutines) || patch.refRoutines.length > 8 || new Set(patch.refRoutines).size !== patch.refRoutines.length || patch.refRoutines.some((ref) => typeof ref !== "string" || ref === id || !rules.some((r) => r.id === ref && r.docUrl)))) throw new Error("会议来源应为最多 8 个不重复且已配置文档的其他职责");
}

interface OccState {
  status: "draft" | "writing" | "written" | "skipped" | "failed";
  draft: string;
  updatedAt: string;
  error?: string;       // failed 时的原因，直接端到今日页卡片——只写日志等于没通知
  attempts?: number;    // failed 已自动重试次数，见 recordDraftFailure
  taskId?: string;
  sourceSig?: string;   // 生成草稿那一刻的素材指纹，用来发现「草稿写完后素材又变了」（见 materialSig）
  materialDays?: string[];
  sources?: MeetingSource[];
  ruleSig?: string;
  warnings?: string[];
  materialPeople?: string[];
}

function occFile(id: string, date: string) { return join(STATE_DIR, `${id}-${date}.json`); }

export function occurrenceKey(r: Routine, now = new Date()): string {
  if (r.cadence !== "monthly") return fmt(now, "date");
  return materialDays("month", now)[0].slice(0, 7);
}

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
  if (!s || s.status !== "draft" || typeof s.sourceSig !== "string") return false;
  if (!s.materialDays && date !== fmt(new Date(), "date")) return false;
  return s.sourceSig !== materialSig(r.window, s.materialDays)
    || !!s.ruleSig && s.ruleSig !== routineMaterialRuleSig(r)
    || !!s.sources?.some((source) => meetingSourceHash(source.url) !== source.hash);
}

function routineMaterialRuleSig(r: Routine) {
  return JSON.stringify([r.window, r.cadence, r.people, r.refRoutines, r.guide, r.project, r.docUrl,
    listRoutines(true).filter((ref) => r.refRoutines?.includes(ref.id)).map((ref) => [ref.id, ref.docUrl])]);
}

/** 职责总览：今天该做的可操作，非今天的显示下次触发时间——功能不因今天为空而隐身。
 *  逾期补做：最近几天里 draft/writing 还没收尾（没写入也没跳过）的 occurrence 继续端出来带完整控件，
 *  这样错过的晨会/周报可以晚点补写或正经跳过，不再掉进「需要我」只剩一个 x（见 routine 逾期问题）。 */
export function todayRoutines() {
  const today = fmt(new Date(), "date");
  const wd = ["日", "一", "二", "三", "四", "五", "六"];
  const routines = listRoutines().filter((r) => r.enabled);

  const cards = routines
    .map((r) => {
      const isToday = routineDueToday(r, new Date());
      // 下一个触发日（不含今天时往后找）。月度的按真实触发日算——否则 days:[0] 每周都显示「周日」、还排进本周
      let next = "";
      let daysUntil = 0;
      if (!isToday) {
        for (let i = 1; i <= 42; i++) {
          const d = new Date(Date.now() + i * 86_400_000);
          if (!routineDueToday(r, d)) continue;
          const civil = new Date(`${fmt(d, "date")}T00:00:00Z`);
          next = i === 1 ? "明天" : i <= 6 ? `周${wd[civil.getUTCDay()]}` : `${civil.getUTCMonth() + 1}/${civil.getUTCDate()}`;
          daysUntil = i;
          break;
        }
      }
      const occDate = occurrenceKey(r);
      // 月度 occurrence 的 key 是 YYYY-MM，下面的逾期扫描（按 YYYY-MM-DD 匹配文件名）永远捞不到它。
      // 所以非触发日也要读一次状态：否则某期生成失败，第二天卡片就退回「下次 …」，失败彻底看不见了。
      const s = isToday || r.cadence === "monthly" ? occState(r.id, occDate) : null;
      return {
        id: r.id, name: r.name, docUrl: r.docUrl, time: r.time, date: occDate,
        period: r.cadence === "monthly" ? occDate : undefined,
        isToday, overdue: false, nextLabel: next, daysUntil,
        status: isToday ? (s?.status || "pending") : s?.status === "failed" ? "failed" : "upcoming",
        hasDraft: !!s?.draft,
        error: s?.status === "failed" ? s.error : undefined,
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
      // 只补未收尾的；failed 也算——那期草稿压根没出来，比没审的草稿更需要人看见
      if (!s || (s.status !== "draft" && s.status !== "writing" && s.status !== "failed")) continue;
      overdue.push({
        id: r.id, name: r.name, docUrl: r.docUrl, time: r.time, date,
        period: r.cadence === "monthly" ? date : "",
        isToday: false, overdue: true, nextLabel: "", daysUntil: -1,
        status: s.status, hasDraft: !!s.draft, taskId: s.taskId,
        error: s.status === "failed" ? s.error : undefined,
        stale: isDraftStale(r, s, date),
      });
    }
  }
  overdue.sort((a, b) => a.date.localeCompare(b.date));    // 最旧的最前，先清理
  return [...overdue, ...cards];                           // 逾期置顶
}

// ---- 草稿生成 ----

/** 取材窗口覆盖的日期列表（gatherMaterial 与 materialSig 必须用同一份，否则指纹对不上素材） */
export function materialDays(window: "yesterday" | "week" | "month", anchor = new Date()): string[] {
  const days: string[] = [];
  // 以 cfg.timezone 下的「今天」为基准锚点：getDay()/setDate 与 fmt() 产出的日期必须同源，
  // 否则系统时区 ≠ cfg.timezone 时会跨零点错位（对齐 daily-digest.ts 从 fmt 日期派生 dow 的做法）。
  // 取正午避免任意时区偏移把锚点推到相邻日。anchor 参数只给测试用。
  const now = new Date(`${fmt(anchor, "date")}T00:00:00Z`);
  if (window === "yesterday") {
    // 上一个工作日（周一的昨天=上周五）
    const d = new Date(now);
    do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(d.getUTCDay()));
    days.push(d.toISOString().slice(0, 10));
  } else if (window === "week") {
    // 本周一到今天（周一的周报取上周一~上周五）
    const d = new Date(now);
    const isMonday = d.getUTCDay() === 1;
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - (isMonday ? 7 : 0));
    const end = isMonday ? 5 : ((now.getUTCDay() + 6) % 7) + 1;
    for (let i = 0; i < end; i++) {
      const x = new Date(start);
      x.setUTCDate(start.getUTCDate() + i);
      days.push(x.toISOString().slice(0, 10));
    }
  } else {
    // 月度复盘草稿在「目标月第一个周一」的前一个周日生成，取材是目标月的上一个自然月。
    // 目标月 = 明天（那个周一）所在的月：周日 9/6 → 目标 9 月 → 取 8 月；周日 5/31 → 目标 6 月 → 取 5 月。
    // 其他日子手动重生成（比如周一补做）就按今天所在月往前推一个月。
    const tomorrow = new Date(now); tomorrow.setUTCDate(now.getUTCDate() + 1);
    const target = now.getUTCDay() === 0 && tomorrow.getUTCDate() <= 7 ? tomorrow : now;
    const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 0));
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/** 素材指纹：日志文件的 size + 任务的 id/状态。草稿生成时冻结一份，人审时重算比对——
 *  草稿从生成到批准可能隔几小时甚至几天（逾期补做卡最多追 7 天），期间 vault 会继续长，
 *  拿一份过期草稿去写飞书文档是静默的错。只做提示，重不重新生成由人定。
 *  用 size 而非 mtime：vault git 同步/编辑器 touch 会动 mtime 但内容没变，那种"变化"提示了只会狼来了。 */
export function materialSig(window: "yesterday" | "week" | "month", days = materialDays(window)): string {
  const inbox = inboxDir();
  const parts: string[] = [];
  for (const day of days) {
    for (const f of [join(inbox, `${day}.md`), join(STAGING_DIR, `${day}.md`)]) {
      try { const stat = statSync(f); parts.push(`${f}:${stat.size}:${stat.mtimeMs}`); } catch { /* 该来源当天没文件 */ }
    }
  }
  try {
    const tasks = JSON.parse(readFileSync(join(DATA, "tasks.json"), "utf8"))
      .filter((t: any) => days.some((d) => t.startedAt?.startsWith(d)))
      .map((t: any) => `${t.id}${t.status}`);
    parts.push(`tasks:${tasks.sort().join(",")}`);
  } catch { /* 无任务表 */ }
  return parts.join("|");
}

/** 收割日志瘦身：去 frontmatter，去 Failed attempt / Files / hash / changed / stats / 来源 这些对总结无用的行，
 *  只留条目标题 + Problem + Solution + 其他正文。 */
export function compactLog(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body
    .split("\n")
    .filter((l) => !/^\s*-\s+\*\*(Failed attempt|Files|hash|changed|stats)\*\*/.test(l) && !/^\s*-\s+来源[:：]/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 取材：refRoutines 指到的晨会/周会文档排最前（人整理过的一手记录），
 *  然后是 inbox 收割记录（分流开着时只含工作 scope），legacy staging 兜底过渡。
 *  月窗口素材量是周的 4-5 倍：每天日志的切片收窄、总量上限放宽，否则 slice 会把月末几周整段吃掉。
 *  会议文档不进 materialSig——指纹在每次列表刷新时都要算，不能为它去拉两份几百 KB 的飞书文档。 */
export async function gatherMaterial(r: Routine, opts: { dryRun?: boolean; days?: string[]; sources?: MeetingSource[]; warnings?: string[]; archive?: boolean } = {}): Promise<string> {
  const window = r.window;
  const inbox = inboxDir();
  const staging = STAGING_DIR;
  const days = opts.days || materialDays(window);
  const monthly = window === "month";
  const perDay = monthly ? 1_000 : 2_000;
  const total = monthly ? 90_000 : 40_000;
  // 月窗口：每天日志先压缩再切片——收割条目里的 Failed attempt / Files / hash / changed / stats / 来源
  // 对复盘毫无用处，却占一半篇幅；砍掉它们再切 4k，才装得下整天的条目而不是前两条。
  const compact = (t: string) => monthly ? compactLog(t) : t;
  const parts: string[] = [];
  if (r.refRoutines?.length) {
    const { meetingNotesMaterial } = await import("./meeting-notes.ts");
    const people = r.people?.length ? r.people : [cfg.owner?.name || ""].filter(Boolean);
    if (!people.length) { log(`routine [${r.id}] refRoutines 配了但 people 为空且 owner 未配置，会议记录取不到任何行`); opts.warnings?.push("未配置取材人员或 owner，会议记录无法匹配人员"); }
    const all = listRoutines(true);
    if (r.refRoutines.length > 8) throw new Error("会议来源最多 8 个");
    for (const id of r.refRoutines) {
      const ref = all.find((x) => x.id === id);
      if (!ref?.docUrl) { opts.warnings?.push(`${id}：来源不存在或没配文档`); parts.push(`===== ${id} =====\n(routine 不存在或没配文档，跳过)`); continue; }
      parts.push(await meetingNotesMaterial(ref.name.split(/[：:]/)[0], ref.docUrl, days, people, Math.floor((monthly ? 20_000 : 10_000) / r.refRoutines.length), { ...opts, allowMissingSources: r.allowMissingSources }));
    }
  }
  for (const day of days) {
    const nf = join(inbox, `${day}.md`);
    const lf = join(staging, `${day}.md`);
    for (const [file, label] of [[nf, "工作日志"], [lf, "工作日志(legacy)"]]) {
      try {
        const text = compact(await readBoundedFile(file, 2 * 1024 * 1024));
        if (text.length > perDay) opts.warnings?.push(`${day} ${label}：当日素材已截断`);
        parts.push(`===== ${day} ${label} =====\n${text.slice(0, perDay)}${text.length > perDay ? "\n[当日素材已截断]" : ""}`);
      } catch (e: any) { if (e.code !== "ENOENT") { opts.warnings?.push(`${day} ${label}：读取失败`); parts.push(`===== ${day} ${label} =====\n[读取失败：${String(e.message).slice(0, 120)}]`); } }
    }
  }
  // 兜底：ownward 任务记录
  try {
    const tasks = JSON.parse(await readBoundedFile(join(DATA, "tasks.json"), 2 * 1024 * 1024))
      .filter((t: any) => days.some((d) => t.startedAt?.startsWith(d)))
      .map((t: any) => `- [${t.project}] ${String(t.task).split("\n")[0].slice(0, 80)} (${t.status})`);
    if (tasks.length) parts.push(`===== 期间 Ownward 任务 =====\n${tasks.join("\n")}`);
  } catch { /* 无任务 */ }
  const text = parts.join("\n\n");
  if (text.length > total) opts.warnings?.push("总素材已截断，请结合归档原文审核");
  return (text.length > total ? `${text.slice(0, total)}\n[总素材已截断，请结合归档原文审核]` : text) || "(窗口内没有找到工作记录)";
}

/** 显式刷新会议来源。月报生成只读已有快照，不会隐式拉取或覆盖归档。 */
export async function archiveRoutine(id: string, root?: string): Promise<MeetingSource[]> {
  const { fetchDocContent } = await import("./meeting-notes.ts");
  const r = listRoutines(true).find((x) => x.id === id);
  if (!r) throw new Error("routine 不存在");
  if (!r.refRoutines?.length || r.refRoutines.length > 8) throw new Error("请先配置 1–8 个会议来源");
  const sources: MeetingSource[] = [];
  for (const refId of r.refRoutines || []) {
    const ref = listRoutines(true).find((x) => x.id === refId);
    if (!ref?.docUrl) throw new Error(`会议来源 ${refId} 未配置文档`);
    const content = await fetchDocContent(ref.docUrl);
    sources.push(await archiveMeetingSource(ref.docUrl, content, root));
  }
  if (!sources.length) throw new Error("该 routine 没有配置会议来源");
  return sources;
}

/** 只读本地归档状态；查看状态不会联网、归档或生成草稿。 */
export async function routineArchiveStatus(id: string) {
  const rules = listRoutines(true);
  const r = rules.find((x) => x.id === id);
  if (!r) throw new Error("routine 不存在");
  if ((r.refRoutines?.length || 0) > 8) throw new Error("会议来源最多 8 个");
  return Promise.all((r.refRoutines || []).map(async (refId) => {
    const ref = rules.find((x) => x.id === refId);
    if (!ref?.docUrl) return { id: refId, name: refId, status: "unconfigured" };
    try {
      const source = await readMeetingArchive(ref.docUrl);
      return source ? { id: refId, name: ref.name, status: "ready", url: source.url, hash: source.hash, fetchedAt: source.fetchedAt }
        : { id: refId, name: ref.name, status: "missing", url: ref.docUrl };
    } catch { return { id: refId, name: ref.name, status: "unreadable", url: ref.docUrl }; }
  }));
}

/** 生成草稿。dryRun=true 只返回草稿正文，不落 occurrence、不开 action、不发通知——调 prompt/guide 时用。 */
export async function generateDraft(routineId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const r = listRoutines(!!opts.dryRun).find((x) => x.id === routineId);
  if (!r) throw new Error("routine 不存在");
  const today = occurrenceKey(r);
  const { memoryPack, projectScope, stripPersonal } = await import("./memory.ts");
  // 公司文档红线：私人项目段落先确定性剔除，再在 prompt 里下禁令双保险
  const days = materialDays(r.window);
  const sourceSig = materialSig(r.window, days);
  const ruleSig = routineMaterialRuleSig(r);
  const sources: MeetingSource[] = [];
  const warnings: string[] = [];
  const material = stripPersonal(await gatherMaterial(r, { dryRun: opts.dryRun, days, sources, warnings, archive: false }));
  if (r.refRoutines?.length && !r.allowMissingSources && warnings.some((w) => /无可用归档|取材失败/.test(w))) {
    throw new Error(`月度复盘「${r.name}」缺少会议素材：${warnings.filter((w) => /无可用归档|取材失败/.test(w)).join("；")}`);
  }
  const { personal } = projectScope();
  const owner = cfg.owner?.name || "用户";
  const team = r.people?.length ? r.people : [cfg.owner?.name || ""].filter(Boolean);
  const multi = team.length > 1;
  const res = await llmJson([
    multi
      ? `你是${owner}的工作总结代笔。「${r.name}」要涵盖 ${team.join("、")} 几个人的工作（${owner} 是其中之一），根据素材生成文档草稿。`
      : `你是${owner}的工作总结代笔。根据工作记录为「${r.name}」生成文档草稿。`,
    "",
    ...(r.refRoutines?.length ? [
      "=== 素材怎么用 ===",
      "素材开头的「晨会记录」「周会记录」是当事人自己在会议文档里填的计划/结果/达成情况，已经是人话，口径也最接近产品和运营；以它为主线组织内容。",
      "后面的「工作日志」是从 commit 和排障记录里自动收割的，只用来补细节和状态，不要让它把主线带偏成研发流水账。",
      "两边说的是同一件事时合成一条，以会议记录里的说法为准。",
      "",
    ] : []),
    ...(multi ? [
      "=== 多人合写 ===",
      `${team.join("、")} 在会议记录里各自的条目同等重要，都要覆盖，不能只写 ${owner} 的。`,
      "按项目/方向合写，不按人分组，也不写「某某做了…」；读者看的是这个项目推进到哪了，不是谁干了什么。",
      "同一方向两个人各推了一段（比如一个做接入、一个做推广），写成这个方向的一条完整进展。",
      "",
    ] : []),
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
  ].join("\n"), { timeoutMs: r.window === "month" ? 600_000 : 180_000, quiet: opts.dryRun });   // dryRun 的 Provider 降级也不能写状态/发通知
  if (!res?.draft) throw new Error("草稿生成失败");
  const draft = String(res.draft);
  if (opts.dryRun) return draft;
  saveOcc(r.id, today, { status: "draft", draft, updatedAt: new Date().toISOString(), sourceSig, materialDays: days, sources, ruleSig, warnings, materialPeople: team });
  resolveAction(`routine:${r.id}:${today}:failed`, "recovered");   // 之前几次失败的行动项就此了结
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

function resolveOccurrenceDate(r: Routine | undefined, date: string): string {
  if (!r || r.cadence !== "monthly" || /^\d{4}-\d{2}$/.test(date)) return date;
  const mapped = occurrenceKey(r, new Date(`${date}T12:00:00`));
  return occState(r.id, mapped) ? mapped : date;
}

// 注意：date 必须用客户端正在编辑的 occurrence 日期（= GET 草稿时传的 date），
// 不能重算 fmt(now)——否则跨天/时区差会让存/读命中不同文件，导致「编辑不生效」。
export function saveDraft(id: string, date: string, content: string) {
  const r = listRoutines().find((x) => x.id === id);
  const key = resolveOccurrenceDate(r, date);
  const s = occState(id, key);
  if (!s) throw new Error("没有草稿");
  // 编辑正文不代表重新取材；保留生成时的指纹和来源，避免把未读的新素材误标为已审。
  saveOcc(id, key, { ...s, draft: content, updatedAt: new Date().toISOString() });
}

/** 草稿详情（客户端打开审阅面板用）：正文 + 状态 + 素材是否已变 */
export function draftView(id: string, date: string) {
  const r = listRoutines().find((x) => x.id === id);
  const key = resolveOccurrenceDate(r, date);
  const s = occState(id, key);
  if (!s) return null;
  return { draft: s.draft, status: s.status, stale: r ? isDraftStale(r, s, key) : false, materialDays: s.materialDays || [], sources: s.sources || [], warnings: s.warnings || [], materialPeople: s.materialPeople || [] };
}

export function skipRoutine(id: string, date: string) {
  const r = listRoutines().find((x) => x.id === id);
  const key = resolveOccurrenceDate(r, date);
  const s = occState(id, key) || { status: "draft" as const, draft: "", updatedAt: "" };
  saveOcc(id, key, { ...s, status: "skipped", updatedAt: new Date().toISOString() });
  resolveAction(`routine:${id}:${key}`, "skipped");
}

/** 写入：派引擎任务，agent 用 lark-cli 做 block 级精准编辑并自检 */
export async function writeRoutine(id: string, date: string): Promise<string> {
  const r = listRoutines().find((x) => x.id === id);
  const key = resolveOccurrenceDate(r, date);
  const s = occState(id, key);
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
    r.window === "month"
      ? `2. 用 docs +fetch 定位格式说明指定的月度项目分节，取材期间为 ${s.materialDays?.[0] || "未记录"} 至 ${s.materialDays?.at(-1) || "未记录"}；按此期间和格式说明确定标题，期间不明则失败退出`
      : "2. 用 docs +fetch（先 simple 找到位置，再局部 with-ids 拿 block id）定位【本周的表格/分节】里【我的行/格子】",
    "3. 冲突检测：写入前先看目标格子现有内容——如果已经有人（我自己）填过实质内容且和要写的意思重合，"
      + "【停下不写】，输出「CONFLICT: 已有内容」+ 现有内容摘要，退出码非 0",
    "4. 定位必须精确：找不到格式说明指定的期间、归属与目标位置，【直接失败退出】报告原因，绝不写到'差不多'的位置",
    "5. 用 docs +update 的局部指令精准写入；【昨日结果】写进上一个工作日的格子，【今日计划】写进今天的格子（周会/周报按格式说明对应）",
    "6. 只动格式说明授权的我的格子或月度项目分节，绝不碰其他人的内容；已有部分内容（如'计划：'骨架）保留结构补全",
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
  saveOcc(id, key, { ...s, status: "writing", taskId: t.id, updatedAt: new Date().toISOString() });
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
const DRAFT_MAX_ATTEMPTS = 3;
const DRAFT_RETRY_MS = 5 * 60_000;

/** 自动生成失败必须留痕。只写一行日志的话卡片会一直停在「待生成」，
 *  owner 要等到截止时间才发现这期草稿压根没出来（月度复盘一个月才一次，代价尤其大）。
 *  前几次失败只落 occurrence（卡片显示失败、隔 5 分钟自动重试）——飞书导出这类瞬时错误
 *  不该立刻惊动人；重试次数耗尽才升级成通知 + 行动项。 */
async function recordDraftFailure(r: Routine, key: string, e: unknown) {
  const error = String(e instanceof Error ? e.message : e).slice(0, 300);
  const prev = occState(r.id, key);
  const attempts = (prev?.status === "failed" ? prev.attempts || 0 : 0) + 1;
  saveOcc(r.id, key, { status: "failed", draft: "", error, attempts, updatedAt: new Date().toISOString() });
  log(`routine [${r.id}] draft failed (${attempts}/${DRAFT_MAX_ATTEMPTS}): ${error}`);
  if (attempts < DRAFT_MAX_ATTEMPTS) return;
  openAction({
    id: `routine:${r.id}:${key}:failed`,
    kind: "decide",
    source: "dispatch",
    title: `${r.name}——草稿生成失败`,
    reason: `${attempts} 次自动生成都失败：${error}。今日页可重试；提示缺会议素材时先到设置页刷新会议归档`,
    ref: { url: r.docUrl },
  });
  await notify(`⚠️ ${r.name} 草稿生成失败：${error.slice(0, 120)}`, { source: "heartbeat", link: r.docUrl, noLark: true });
}

export function sweepRoutines() {
  const now = new Date();
  const today = fmt(now, "date");
  const [hour, minute] = fmt(now, "time").split(":").map(Number);
  const nowMin = hour * 60 + minute;
  for (const r of listRoutines()) {
    if (!r.enabled || !routineDueToday(r, now)) continue;
    const [h, m] = r.time.split(":").map(Number);
    const due = h * 60 + m;
    if (nowMin < due - r.aheadMin || nowMin > due + 60) continue; // 生成窗口：截止前 ahead ~ 截止后 1h
    const key = occurrenceKey(r, now);
    const cur = occState(r.id, key);
    // 失败过的隔 5 分钟再试、最多 DRAFT_MAX_ATTEMPTS 次：瞬时错误不该让整期草稿作废，
    // 但也不能每分钟重试一小时，把同一条错误刷 60 遍。
    const retryable = cur?.status === "failed" && (cur.attempts || 0) < DRAFT_MAX_ATTEMPTS
      && Date.now() - Date.parse(cur.updatedAt) >= DRAFT_RETRY_MS;
    if ((cur && !retryable) || generating.has(r.id)) continue;
    generating.add(r.id);
    generateDraft(r.id)
      .catch((e) => recordDraftFailure(r, key, e))
      .catch((e) => log(`routine [${r.id}] failure record failed: ${e}`))
      .finally(() => generating.delete(r.id));
  }
}

export function routineDueToday(r: Routine, now: Date): boolean {
  const civil = new Date(`${fmt(now, "date")}T00:00:00Z`);
  const dow = civil.getUTCDay();
  if (r.cadence === "monthly") {
    // 月度复盘固定在目标月第一个周一之前的周日下午生成。
    civil.setUTCDate(civil.getUTCDate() + 1);
    return dow === 0 && civil.getUTCDay() === 1 && civil.getUTCDate() <= 7;
  }
  return r.days.includes(dow);
}
