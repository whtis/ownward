// Action 状态层：ownward 的一等对象——「需要 owner 行动的事」。
// 只做确定性准入（不让 AI 猜）；打开≠完成，来源动作真正发生才 resolve。
// 状态机: open → snoozed(到时回 open) / processing → resolved / dismissed
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { fsyncSync } from "./fs-durable.ts";
import { join } from "path";
import { DATA, ensureDir, log } from "./util.ts";

export type ActionKind = "reply" | "review" | "approve" | "follow_up" | "decide";
export type ActionState = "open" | "snoozed" | "processing" | "resolved" | "dismissed";

export type StageStatus = "queued" | "running" | "ready" | "failed" | "stale";
export type StageError = "llm_unavailable" | "context_unavailable" | "parse" | "budget";

/** 预处理阶段的摘要状态，挂在 Action 上；正文另存 data/stages/，避免 actions.json 膨胀 */
export interface ActionStage {
  status: StageStatus;
  kind: "reply_draft" | "review_brief";
  inputSig?: string;       // 生成时的输入签名，CAS 写回用
  attempt: number;
  updatedAt: string;
  error?: StageError;
  preview?: string;
  outcome?: "sent_as_is" | "edited" | "discarded";
}

export interface StageArtifact {
  v: 1;
  actionId: string;
  kind: ActionStage["kind"];
  inputSig: string;
  createdAt: string;
  engine: string;
  model: string;
  body: string;
  caveats: string[];
  basis: { label: string; at?: string }[];
}

export interface Action {
  id: string;              // 确定性 id：来源+实体，天然去重
  kind: ActionKind;
  source: string;          // 来源标签：lark/github/gmail/dispatch/evolve，Vertical 也可以用自己的。
  title: string;
  reason: string;          // 为什么出现在这里——必须展示，误判会摧毁信任
  state: ActionState;
  createdAt: string;
  updatedAt: string;
  snoozedUntil?: string;
  resolution?: string;     // 怎么完成的（replied/reviewed/applied/harvested/manual）
  /** mail_id 可写成 `<账号邮箱>:<message id>` 指定 Gmail 账号；investigated_at = task_id 是「一键排查」派的 */
  ref: { chat_id?: string; task_id?: string; url?: string; mail_id?: string; note?: string; investigated_at?: string };
  stage?: ActionStage;
  /** 没有来源巡检替它收尾的行动（货架采纳开的那种）到点自动收掉，不然会永远挂着 */
  expiresAt?: string;
}

const FILE = join(DATA, "actions.json");
let cache: Action[] | null = null;

function load(): Action[] {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = []; }
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  const temp=`${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(cache,null,2));const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,FILE);const dfd=openSync(DATA,"r");try{fsyncSync(dfd);}finally{closeSync(dfd);}
}

const STAGES = join(DATA, "stages");
/** id 来自外部来源，可能含 / 等字符——哈希成定长文件名 */
const stageFile = (actionId: string) => join(STAGES, `${createHash("sha256").update(actionId).digest("hex").slice(0, 16)}.json`);

export function getStageArtifact(actionId: string): StageArtifact | null {
  try {
    const a = JSON.parse(readFileSync(stageFile(actionId), "utf8")) as StageArtifact;
    return a?.actionId === actionId ? a : null;   // 哈希截断碰撞时不认别人的产物
  } catch { return null; }
}

export function saveStageArtifact(artifact: StageArtifact): void {
  ensureDir(STAGES);
  const file = stageFile(artifact.actionId), temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(artifact, null, 2));
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dfd = openSync(STAGES, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

export function deleteStageArtifact(actionId: string): void {
  rmSync(stageFile(actionId), { force: true });
}

/** 开启（或复活确认）一条行动。相同 id 已 open/snoozed 时只更新内容；已 resolved/dismissed 的不复活（新一轮事件应带新 id）。 */
export function openAction(a: Omit<Action, "state" | "createdAt" | "updatedAt">, options:{revive?:boolean}={}) {
  const list = load();
  const cur = list.find((x) => x.id === a.id);
  const now = new Date().toISOString();
  if (cur) {
    const terminal=cur.state==="resolved"||cur.state==="dismissed";
    if (cur.state === "open" || cur.state === "snoozed" || (options.revive&&terminal)) {
      if(options.revive&&terminal){cur.state="open";delete cur.resolution;delete cur.snoozedUntil;delete cur.expiresAt;}   // 复活=重新开始，旧的过期时刻不能带过来，否则下一次 sweep 立刻又收掉
      if (a.expiresAt) cur.expiresAt = a.expiresAt;
      // 输入变了（reason 换了 / 新一轮复活），已备好的预处理不再可信
      if ((cur.reason !== a.reason || options.revive) && cur.stage?.status === "ready") { cur.stage.status = "stale"; cur.stage.updatedAt = now; }
      cur.title = a.title; cur.reason = a.reason; cur.updatedAt = now;
      save();
    }
    return;
  }
  list.push({ ...a, state: "open", createdAt: now, updatedAt: now });
  save();
  log(`action opened: [${a.kind}] ${a.title}`);
}

/** 来源动作真实发生 → 完成。findBy 用前缀匹配支持"该实体的所有行动"。 */
export function resolveAction(idPrefix: string, resolution: string) {
  const list = load();
  let n = 0;
  for (const a of list) {
    if (!a.id.startsWith(idPrefix)) continue;
    if (a.state === "resolved" || a.state === "dismissed") continue;
    a.state = "resolved";
    a.resolution = resolution;
    a.updatedAt = new Date().toISOString();
    n++;
  }
  if (n) { save(); log(`action resolved (${resolution}): ${idPrefix} ×${n}`); }
}

/** Scoped Vertical 只能按精确 id 完成已授权来源的 Action，禁止前缀扩大影响面。 */
export function resolveActionExact(id: string, resolution: string): boolean {
  const action = load().find((item) => item.id === id);
  if (!action || action.state === "resolved" || action.state === "dismissed") return false;
  action.state = "resolved";
  action.resolution = resolution;
  action.updatedAt = new Date().toISOString();
  save();
  log(`action resolved (${resolution}): ${id}`);
  return true;
}

/** 写回预处理阶段。expect.inputSig 做 CAS：期间输入已变（签名不符）就丢弃这次结果。终态 Action 不再接受写入。 */
export function setActionStage(id: string, stage: ActionStage, expect?: { inputSig?: string }): boolean {
  const cur = load().find((x) => x.id === id);
  if (!cur || cur.state === "resolved" || cur.state === "dismissed") return false;
  if (expect?.inputSig && cur.stage?.inputSig && cur.stage.inputSig !== expect.inputSig) return false;
  cur.stage = { ...stage };
  cur.updatedAt = new Date().toISOString();
  save();
  return true;
}

/** 合并改 ref（一键排查回填 task_id 等）。终态 Action 不再接受。 */
export function patchActionRef(id: string, patch: Partial<Action["ref"]>): boolean {
  const cur = load().find((x) => x.id === id);
  if (!cur || cur.state === "resolved" || cur.state === "dismissed") return false;
  cur.ref = { ...cur.ref, ...patch };
  cur.updatedAt = new Date().toISOString();
  save();
  return true;
}

/** 记下 owner 怎么用了这份预处理。发出回复往往紧跟着 resolve，所以终态 Action 也接受（不动 updatedAt，免得拖慢 7 天清理）。 */
export function setStageOutcome(id: string, outcome: NonNullable<ActionStage["outcome"]>): boolean {
  const cur = load().find((x) => x.id === id);
  if (!cur?.stage) return false;
  cur.stage.outcome = outcome;
  save();
  return true;
}

/** 纯改字段，不落盘——单条与批量共用，批量只在末尾 save 一次。 */
function applyActionState(a: Action, state: "snoozed" | "dismissed" | "resolved", snoozeMin: number): void {
  a.state = state;
  a.updatedAt = new Date().toISOString();
  if (state === "snoozed") a.snoozedUntil = new Date(Date.now() + snoozeMin * 60_000).toISOString();
  if (state === "resolved") a.resolution = "manual";
}

export function setActionState(id: string, state: "snoozed" | "dismissed" | "resolved", snoozeMin = 120): boolean {
  const list = load();
  const a = list.find((x) => x.id === id);
  if (!a) return false;
  applyActionState(a, state, snoozeMin);
  save();
  return true;
}

/** 今天页多选批处理：一次 save 收敛 N 条，避免 N 次全量写盘。
 *  返回真正改到的条数——列表每 60s 刷新，用户勾选后某条可能已被别处收掉，认不到的静默跳过。 */
export function setActionStates(ids: readonly string[], state: "snoozed" | "dismissed" | "resolved", snoozeMin = 120): number {
  const wanted = new Set(ids);
  if (!wanted.size) return 0;
  const list = load();
  let n = 0;
  for (const a of list) { if (!wanted.has(a.id)) continue; applyActionState(a, state, snoozeMin); n++; }
  if (n) { save(); log(`action ${state} (batch): ×${n}`); }
  return n;
}

/** 到期的 snoozed 回到 open；带 expiresAt 的到点收掉；清理 7 天前的终态记录 */
export function sweepActions() {
  const list = load();
  const now = Date.now();
  let dirty = false;
  for (const a of list) {
    if ((a.state === "open" || a.state === "snoozed") && a.expiresAt && Date.parse(a.expiresAt) <= now) {
      a.state = "resolved"; a.resolution = "expired"; a.updatedAt = new Date().toISOString(); dirty = true;
      log(`action resolved (expired): ${a.id}`);
      continue;
    }
    if (a.state === "snoozed" && a.snoozedUntil && Date.parse(a.snoozedUntil) <= now) {
      a.state = "open"; a.updatedAt = new Date().toISOString(); dirty = true;
    }
  }
  const before = list.length;
  const expired = (a: Action) => ["resolved", "dismissed"].includes(a.state) && now - Date.parse(a.updatedAt) > 7 * 86_400_000;
  for (const a of list) if (expired(a)) deleteStageArtifact(a.id);
  cache = list.filter((a) => !expired(a));
  if (dirty || cache.length !== before) save();
}

/** 「一键排查」只给像故障的行动项：助理货架开的（AI 的建议，不是故障）不算；其余要么是 follow_up，
 *  要么标题/原因里说了 CI·失败·crash。审核/决定类（记忆候选、PR review、草稿）是要人处理的活，派 agent 查「根因」只会空转。
 *  web/today.js 的 tdInvestigable 是同一条规则的前端副本，改要一起改 */
export function isInvestigable(a: Pick<Action, "kind" | "source" | "title" | "reason">): boolean {
  if (a.source === "assistant") return false;
  const text = `${a.title || ""} ${a.reason || ""}`;
  return a.kind === "follow_up" || /\bCI\b/.test(text) || /失败|crash/i.test(text);
}

export function listActions(includeRecentDone = true): Action[] {
  // sweep 由 daemon 的 60s 定时器负责，读路径不做写 I/O
  const list = load();
  const open = list.filter((a) => a.state === "open" || a.state === "snoozed");
  open.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!includeRecentDone) return open;
  const dayAgo = Date.now() - 86_400_000;
  const done = list.filter((a) => ["resolved", "dismissed"].includes(a.state) && Date.parse(a.updatedAt) > dayAgo);
  done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...open, ...done];
}
