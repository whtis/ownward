// Staged Actions：Action 打开后、owner 动手前，后台先把「回复草稿 / review 简报」备好。
// 每 tick 只处理一条：选候选 → 标 running → 取上下文 → llmJson → CAS 写回 ready（正文另存 data/stages/）。
// 期间 Action 被处理掉或输入变了，结果直接作废；守住日预算，失败按次数封顶，不会无限烧额度。
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  listActions, saveStageArtifact, setActionStage,
  type Action, type ActionStage, type StageArtifact, type StageError,
} from "./actions.ts";
import { prDetail, prDiff, type PrDetail } from "./github-pr.ts";
import { parseLarkTs, previewText } from "./lark-state.ts";
import { llmJson } from "./llm.ts";
import { ROOT, cfg, fmt, loadState, log, run, updateState, type RunResult } from "./util.ts";

export interface StagingConfig {
  enabled: boolean;
  settleMin: number;       // Action 打开后先等一会儿：对方可能还在连发、owner 可能顺手就回了
  dailyBudget: number;     // 每天最多几次 LLM 调用（含失败重试）
  model: string;
  maxInputChars: number;   // 会话记录 / diff 喂给模型的上限
  kinds: string[];         // `${source}.${kind}`
  maxAttempts: number;     // 失败几次后不再自动重试（输入变了 → stale 会重新排队）
}

export const STAGING_DEFAULTS: StagingConfig = {
  enabled: false,
  settleMin: 10,
  dailyBudget: 30,
  model: "sonnet",
  maxInputChars: 24_000,
  kinds: ["lark.reply", "github.review", "gmail.reply"],
  maxAttempts: 3,
};

export function stagingConfig(raw: any = cfg.staging): StagingConfig {
  const c = { ...STAGING_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const num = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    enabled: c.enabled === true,
    settleMin: num(c.settleMin, STAGING_DEFAULTS.settleMin),
    dailyBudget: num(c.dailyBudget, STAGING_DEFAULTS.dailyBudget),
    model: typeof c.model === "string" && c.model ? c.model : STAGING_DEFAULTS.model,
    maxInputChars: num(c.maxInputChars, STAGING_DEFAULTS.maxInputChars) || STAGING_DEFAULTS.maxInputChars,
    kinds: Array.isArray(c.kinds) ? c.kinds.map(String) : STAGING_DEFAULTS.kinds,
    maxAttempts: num(c.maxAttempts, STAGING_DEFAULTS.maxAttempts) || STAGING_DEFAULTS.maxAttempts,
  };
}

/** 带分类的失败：gatherer 抛它，runner 照 code 写进 ActionStage.error */
export class StagingError extends Error {
  constructor(readonly code: StageError, message: string) { super(message); }
}

const STAGE_KIND: Record<string, ActionStage["kind"]> = { "lark.reply": "reply_draft", "github.review": "review_brief", "gmail.reply": "reply_draft" };
const actionKey = (a: Action) => `${a.source}.${a.kind}`;

// ── 纯函数 ─────────────────────────────────────────────

export function isActionEligible(action: Action, c: StagingConfig, now: Date): boolean {
  if (action.state !== "open" && action.state !== "snoozed") return false;
  const key = actionKey(action);
  if (!c.kinds.includes(key) || !STAGE_KIND[key]) return false;
  const settleMs = c.settleMin * 60_000, st = action.stage;
  if (st?.status === "running" || st?.status === "ready") return false;
  // 失败的按次数封顶，并且同样等一个 settle 再重试，别每 tick 都撞同一堵墙
  if (st?.status === "failed" && (st.attempt >= c.maxAttempts || now.getTime() - Date.parse(st.updatedAt) < settleMs)) return false;
  return now.getTime() - new Date(action.createdAt).getTime() >= settleMs;
}

/** 手动重做：只要求 Action 还在待办、类型支持、不在跑；ready / failed 都可以重来 */
export function isManualEligible(action: Action): boolean {
  if (action.state !== "open" && action.state !== "snoozed") return false;
  return !!STAGE_KIND[actionKey(action)] && action.stage?.status !== "running";
}

export function checkDailyBudget(state: any, todayStr: string, limit: number): { allowed: boolean; count: number } {
  const b = state?.staging;
  const count = b?.date === todayStr && Number.isFinite(b?.count) ? b.count : 0;   // 跨天自然清零
  return { allowed: count < limit, count };
}

export function computeInputSig(inputs: string | object): string {
  return createHash("sha256").update(typeof inputs === "string" ? inputs : JSON.stringify(inputs)).digest("hex");
}

/** daemon 重启时，上一个进程留下的 running 已无人认领——退回 queued 让下一 tick 重做 */
export function recoverOrphanedRunning(actions: Action[]): void {
  const now = new Date().toISOString();
  for (const a of actions) if (a.stage?.status === "running") { a.stage.status = "queued"; a.stage.updatedAt = now; }
}

/** 启动时调用：把孤儿 running 落盘恢复 */
export function recoverOrphanedStages(deps: { listActions?: typeof listActions; setActionStage?: typeof setActionStage } = {}): number {
  const list = (deps.listActions || listActions)(false), set = deps.setActionStage || setActionStage;
  const orphans = list.filter((a) => a.stage?.status === "running").map((a) => ({ ...a, stage: { ...a.stage! } }));
  recoverOrphanedRunning(orphans);
  for (const a of orphans) set(a.id, a.stage!);
  return orphans.length;
}

// ── 上下文采集 ─────────────────────────────────────────

export interface StageContext {
  text: string;                                // 拼进 prompt 的上下文
  basis: { label: string; at?: string }[];     // 模型没给 basis 时的兜底
  caveats: string[];                           // 采集阶段就知道的局限（截断等）
}

export interface GatherDeps {
  maxInputChars: number;
  now: Date;
  runCommand?: (cmd: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
  prDetail?: (repo: string, number: number) => Promise<PrDetail>;
  prDiff?: (repo: string, number: number) => Promise<string>;
  gmailMessage?: (id: string, account?: string) => Promise<MailDetail>;
  myLarkId?: string;
}

type MailDetail = { from?: string; to?: string; subject?: string; date?: string; threadId?: string; body?: string };

export async function gatherLarkReply(action: Action, deps: GatherDeps): Promise<StageContext> {
  const chatId = action.ref?.chat_id;
  if (!chatId) throw new StagingError("context_unavailable", "action 缺 ref.chat_id");
  const r = await (deps.runCommand || run)(
    ["lark-cli", "im", "+chat-messages-list", "--as", "user", "--chat-id", chatId, "--format", "json"], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new StagingError("context_unavailable", `lark-cli 失败 (${r.code}): ${(r.stderr || r.stdout).slice(0, 200)}`);
  let d: any;
  try { d = JSON.parse(r.stdout); } catch { throw new StagingError("context_unavailable", "lark-cli 返回非 JSON"); }
  const raw: any[] = d?.data?.messages || d?.messages || d?.data?.items || d?.items || [];
  if (!raw.length) throw new StagingError("context_unavailable", "会话里没有消息");
  // API 是倒序（最新在前）：按时间正序排，再从最新往回装，装满 maxInputChars 为止
  const msgs = raw.map((m) => ({ m, ts: parseLarkTs(m.create_time) })).sort((a, b) => a.ts - b.ts);
  const lines: string[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const { m, ts } = msgs[i];
    const sender = deps.myLarkId && m.sender?.id === deps.myLarkId ? "我" : (m.sender?.name || m.sender?.id || "?");
    const line = `[${fmt(new Date(ts), "datetime")}] ${sender}: ${previewText(m.body?.content ?? m.content)}`;
    if (lines.length && used + line.length + 1 > deps.maxInputChars) break;
    lines.unshift(line.slice(0, deps.maxInputChars));
    used += line.length + 1;
  }
  const last = msgs[msgs.length - 1].ts, caveats: string[] = [];
  if (lines.length < msgs.length) caveats.push(`会话较长，只取了最近 ${lines.length} 条消息`);
  return {
    text: `## 最近的会话记录（共 ${lines.length} 条，时间正序）\n${lines.join("\n")}`,
    basis: [{ label: `${lines.length} 条消息，截至 ${fmt(new Date(last), "time")}`, at: new Date(last).toISOString() }],
    caveats,
  };
}

/** html（github.com/o/r/pull/42）与 api（api.github.com/repos/o/r/pulls/42）两种 URL 都认 */
export function parsePrRef(s: string | undefined): { repo: string; number: number } | null {
  const m = String(s || "").match(/github\.com\/(?:repos\/)?([^/\s]+\/[^/\s]+)\/pulls?\/(\d+)/) || String(s || "").match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export async function gatherGithubReview(action: Action, deps: GatherDeps): Promise<StageContext> {
  const ref = parsePrRef(action.ref?.url) || parsePrRef(action.ref?.note);
  if (!ref) throw new StagingError("context_unavailable", "action 里找不到 PR 地址");
  let detail: PrDetail, diff: string;
  try {
    [detail, diff] = await Promise.all([(deps.prDetail || prDetail)(ref.repo, ref.number), (deps.prDiff || prDiff)(ref.repo, ref.number)]);
  } catch (e) { throw new StagingError("context_unavailable", `gh 拉取失败: ${String((e as Error)?.message || e).slice(0, 200)}`); }
  const caveats: string[] = [], lineCount = diff.split("\n").length;
  if (diff.length > deps.maxInputChars) {
    diff = diff.slice(0, deps.maxInputChars) + "\n…(diff 已截断)";
    caveats.push(`diff 截断到 ${deps.maxInputChars} 字符，后半部分未看`);
  }
  const checks = detail.checks.map((c) => `${c.name}=${c.state}`).join(", ") || "无";
  const files = detail.files.map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`).join("\n") || "（无）";
  const comments = detail.comments.map((c) => `- ${c.author} @ ${c.at}: ${c.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "（无）";
  const text = [
    `## PR 元数据`,
    `${detail.repo}#${detail.number} ${detail.title}`,
    `作者 ${detail.author} · ${detail.branch} → ${detail.baseBranch} · +${detail.additions}/-${detail.deletions}`,
    `可合并: ${detail.mergeable} · review 状态: ${detail.reviewDecision || "无"} · CI: ${checks}`,
    `URL: ${detail.url}`,
    `### 描述\n${detail.body || "（空）"}`,
    `### 改动文件\n${files}`,
    `### 近期评论\n${comments}`,
    `## diff${caveats.length ? "（已截断）" : ""}\n${diff}`,
  ].join("\n");
  return { text, basis: [{ label: `PR #${detail.number} diff ${lineCount} 行`, at: deps.now.toISOString() }], caveats };
}

/** 邮件引用：ref.mail_id（可带账号前缀 `<邮箱>:<id>`）> ref.url 里的 Gmail 链接 > ref.note 的 `gmail:<id>` / 裸 id */
export function parseMailRef(ref: Action["ref"] | undefined): { id: string; account?: string } | null {
  const split = (s: string) => {
    const i = s.lastIndexOf(":");
    return i > 0 ? { id: s.slice(i + 1), account: s.slice(0, i) } : { id: s };
  };
  const mailId = String(ref?.mail_id || "").trim();
  if (mailId) { const r = split(mailId); return r.id ? r : null; }
  const fromUrl = String(ref?.url || "").match(/mail\.google\.com\/.*#[^/]+(?:\/[^/]+)*\/([A-Za-z0-9]{12,})\s*$/)?.[1];
  if (fromUrl) return { id: fromUrl };
  const note = String(ref?.note || "").trim().match(/^(?:gmail:)?([0-9a-f]{12,})$/i)?.[1];
  return note ? { id: note } : null;
}

export async function gatherGmailReply(action: Action, deps: GatherDeps): Promise<StageContext> {
  const ref = parseMailRef(action.ref);
  if (!ref) throw new StagingError("context_unavailable", "action 里找不到邮件 id");
  let m: MailDetail;
  try {
    m = await (deps.gmailMessage || (async (id: string, account?: string) => (await import("./sources/gmail.ts")).gmailMessageDetail(id, account)))(ref.id, ref.account);
  } catch (e) { throw new StagingError("context_unavailable", `Gmail 拉取失败: ${String((e as Error)?.message || e).slice(0, 200)}`); }
  let body = String(m?.body || "").trim();
  if (!m || (!body && !m.subject)) throw new StagingError("context_unavailable", "邮件内容为空");
  const caveats: string[] = [];
  if (body.length > deps.maxInputChars) {
    body = body.slice(0, deps.maxInputChars) + "\n…(正文已截断)";
    caveats.push(`邮件正文截断到 ${deps.maxInputChars} 字符`);
  }
  const at = m.date && !Number.isNaN(Date.parse(m.date)) ? new Date(m.date).toISOString() : undefined;
  const text = [
    `## 待回复的邮件`,
    `主题：${m.subject || "（无主题）"}`,
    `发件人：${m.from || "?"}`,
    ...(m.to ? [`收件人：${m.to}`] : []),
    ...(m.date ? [`时间：${m.date}`] : []),
    `### 正文（引用的历史往来可能附在末尾）\n${body || "（空）"}`,
  ].join("\n");
  return { text, basis: [{ label: `邮件「${(m.subject || "无主题").slice(0, 40)}」`, ...(at ? { at } : {}) }], caveats };
}

const GATHERERS: Record<string, (a: Action, d: GatherDeps) => Promise<StageContext>> = {
  "lark.reply": gatherLarkReply,
  "github.review": gatherGithubReview,
  "gmail.reply": gatherGmailReply,
};
const PROMPTS: Record<string, string> = { "lark.reply": "stage-reply.md", "github.review": "stage-review.md", "gmail.reply": "stage-mail-reply.md" };

// ── 结果解析 ──────────────────────────────────────────

export function parseStageOutput(raw: any, ctx: StageContext): { body: string; preview: string; caveats: string[]; basis: StageArtifact["basis"] } {
  if (!raw || typeof raw !== "object" || typeof raw.body !== "string" || !raw.body.trim())
    throw new StagingError("parse", "模型输出缺 body");
  const body = raw.body.trim();
  const preview = (typeof raw.preview === "string" && raw.preview.trim() ? raw.preview.trim() : body.replace(/\s+/g, " ")).slice(0, 160);
  const caveats = [...ctx.caveats, ...(Array.isArray(raw.caveats) ? raw.caveats.filter((x: any) => typeof x === "string" && x.trim()) : [])];
  const basis = Array.isArray(raw.basis)
    ? raw.basis.filter((b: any) => b && typeof b.label === "string").map((b: any) => (typeof b.at === "string" ? { label: b.label, at: b.at } : { label: b.label }))
    : [];
  return { body, preview, caveats: [...new Set(caveats)], basis: basis.length ? basis : ctx.basis };
}

// ── Runner ───────────────────────────────────────────

export interface StagingDeps {
  config?: Partial<StagingConfig>;
  now?: () => Date;
  listActions?: typeof listActions;
  setActionStage?: typeof setActionStage;
  saveArtifact?: (a: StageArtifact) => void;
  loadState?: () => any;
  updateState?: (mut: (s: any) => void) => void;
  llm?: (prompt: string, opts: { model?: string; quiet?: boolean }) => Promise<any | null>;
  readPrompt?: (file: string) => string;
  gather?: Omit<GatherDeps, "maxInputChars" | "now">;
  engine?: string;
  /** 手动触发：只处理这一条，跳过 enabled / settleMin / 重试封顶，日预算照守 */
  actionId?: string;
}

export type StagingResult = {
  stagedId?: string;
  status: "staged" | "skipped" | "budget_exceeded" | "no_candidates" | "failed";
  error?: string;
};

let inFlight = false;

export async function runStaging(deps: StagingDeps = {}): Promise<StagingResult> {
  if (inFlight) return { status: "skipped", error: "in_flight" };
  inFlight = true;
  try { return await stageOne(deps); }
  finally { inFlight = false; }
}

async function stageOne(deps: StagingDeps): Promise<StagingResult> {
  const c = stagingConfig({ ...(cfg.staging || {}), ...(deps.config || {}) });
  if (!c.enabled && !deps.actionId) return { status: "skipped", error: "disabled" };
  const now = (deps.now || (() => new Date()))();
  const list = deps.listActions || listActions, setStage = deps.setActionStage || setActionStage;

  const candidate = deps.actionId
    ? list(false).find((a) => a.id === deps.actionId && isManualEligible(a))
    : list(false).find((a) => isActionEligible(a, c, now));
  if (!candidate) return { status: "no_candidates" };
  const id = candidate.id, key = actionKey(candidate), stageKind = STAGE_KIND[key];
  const reason = candidate.reason;          // 记下快照：listActions 返回的是缓存里的活对象
  const prev = candidate.stage;
  const stamp = () => (deps.now || (() => new Date()))().toISOString();
  const attempt = (prev?.status === "failed" ? prev.attempt : 0) + 1;

  const today = fmt(now, "date");
  const budget = checkDailyBudget((deps.loadState || loadState)(), today, c.dailyBudget);
  if (!budget.allowed) {
    if (prev?.error !== "budget")
      setStage(id, { status: "queued", kind: stageKind, attempt: prev?.attempt ?? 0, updatedAt: stamp(), error: "budget", ...(prev?.inputSig ? { inputSig: prev.inputSig } : {}) });
    return { status: "budget_exceeded", stagedId: id, error: `今日预算 ${c.dailyBudget} 已用完` };
  }

  // 先占位：别的 tick / 进程看到 running 就不会重复处理
  if (!setStage(id, { status: "running", kind: stageKind, attempt, updatedAt: stamp(), ...(prev?.inputSig ? { inputSig: prev.inputSig } : {}) }, { inputSig: prev?.inputSig }))
    return { status: "skipped", stagedId: id, error: "action 已关闭或输入已变" };

  const fail = (code: StageError, msg: string): StagingResult => {
    log(`staging ${id} failed: ${code} ${msg}`);
    setStage(id, { status: "failed", kind: stageKind, attempt, updatedAt: stamp(), error: code });
    return { status: "failed", stagedId: id, error: code };
  };

  let ctx: StageContext;
  try {
    ctx = await GATHERERS[key](candidate, { ...(deps.gather || {}), myLarkId: deps.gather?.myLarkId ?? cfg.notify?.larkUserId, maxInputChars: c.maxInputChars, now });
  } catch (e) {
    return fail(e instanceof StagingError ? e.code : "context_unavailable", String((e as Error)?.message || e));
  }

  const inputSig = computeInputSig({ key, reason, context: ctx.text });
  if (!setStage(id, { status: "running", kind: stageKind, attempt, updatedAt: stamp(), inputSig }))
    return { status: "skipped", stagedId: id, error: "action 已关闭" };

  let prompt: string;
  try {
    const instructions = (deps.readPrompt || ((f) => readFileSync(join(ROOT, "prompts", f), "utf8")))(PROMPTS[key]);
    prompt = `${instructions}\n\n# 输入\n\n## Action\n标题：${candidate.title}\n原因：${reason}\n\n${ctx.text}`;
  } catch (e) { return fail("context_unavailable", `读 prompt 失败: ${e}`); }

  (deps.updateState || updateState)((s) => {   // 调用即计费，失败也算
    const b = checkDailyBudget(s, today, Infinity);
    s.staging = { date: today, count: b.count + 1 };
  });

  let raw: any;
  try { raw = await (deps.llm || llmJson)(prompt, { model: c.model, quiet: true }); }
  catch (e) { raw = null; log(`staging ${id} llm threw: ${e}`); }

  // CAS：等模型的这段时间里 Action 可能被处理、reason 可能变了，结果就不能用了
  const fresh = list(true).find((a) => a.id === id);
  if (!fresh || (fresh.state !== "open" && fresh.state !== "snoozed"))
    return { status: "skipped", stagedId: id, error: "discarded: action closed" };
  if (fresh.reason !== reason || fresh.stage?.status !== "running" || fresh.stage.inputSig !== inputSig) {
    if (fresh.stage?.status === "running" && fresh.stage.inputSig === inputSig)
      setStage(id, { ...fresh.stage, status: "stale", updatedAt: stamp() }, { inputSig });
    return { status: "skipped", stagedId: id, error: "discarded: input changed" };
  }

  if (raw === null || raw === undefined) return fail("llm_unavailable", "模型无输出");
  let out: ReturnType<typeof parseStageOutput>;
  try { out = parseStageOutput(raw, ctx); }
  catch (e) { return fail(e instanceof StagingError ? e.code : "parse", String((e as Error)?.message || e)); }

  const createdAt = stamp();
  (deps.saveArtifact || saveStageArtifact)({
    v: 1, actionId: id, kind: stageKind, inputSig, createdAt,
    engine: deps.engine || cfg.llm?.engine || "claude", model: c.model,
    body: out.body, caveats: out.caveats, basis: out.basis,
  });
  if (!setStage(id, { status: "ready", kind: stageKind, attempt, updatedAt: createdAt, inputSig, preview: out.preview }, { inputSig }))
    return { status: "skipped", stagedId: id, error: "discarded: action changed" };
  log(`staging ${id} ready (${stageKind})`);
  return { status: "staged", stagedId: id };
}
