// Action 状态层：ownward 的一等对象——「需要 owner 行动的事」。
// 只做确定性准入（不让 AI 猜）；打开≠完成，来源动作真正发生才 resolve。
// 状态机: open → snoozed(到时回 open) / processing → resolved / dismissed
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { fsyncSync } from "./fs-durable.ts";
import { join } from "path";
import { DATA, ensureDir, log } from "./util.ts";

export type ActionKind = "reply" | "review" | "approve" | "follow_up" | "decide";
export type ActionState = "open" | "snoozed" | "processing" | "resolved" | "dismissed";

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
  ref: { chat_id?: string; task_id?: string; url?: string; mail_id?: string; note?: string };
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

/** 开启（或复活确认）一条行动。相同 id 已 open/snoozed 时只更新内容；已 resolved/dismissed 的不复活（新一轮事件应带新 id）。 */
export function openAction(a: Omit<Action, "state" | "createdAt" | "updatedAt">, options:{revive?:boolean}={}) {
  const list = load();
  const cur = list.find((x) => x.id === a.id);
  const now = new Date().toISOString();
  if (cur) {
    const terminal=cur.state==="resolved"||cur.state==="dismissed";
    if (cur.state === "open" || cur.state === "snoozed" || (options.revive&&terminal)) {
      if(options.revive&&terminal){cur.state="open";delete cur.resolution;delete cur.snoozedUntil;}
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

export function setActionState(id: string, state: "snoozed" | "dismissed" | "resolved", snoozeMin = 120): boolean {
  const list = load();
  const a = list.find((x) => x.id === id);
  if (!a) return false;
  a.state = state;
  a.updatedAt = new Date().toISOString();
  if (state === "snoozed") a.snoozedUntil = new Date(Date.now() + snoozeMin * 60_000).toISOString();
  if (state === "resolved") a.resolution = "manual";
  save();
  return true;
}

/** 到期的 snoozed 回到 open；清理 7 天前的终态记录 */
export function sweepActions() {
  const list = load();
  const now = Date.now();
  let dirty = false;
  for (const a of list) {
    if (a.state === "snoozed" && a.snoozedUntil && Date.parse(a.snoozedUntil) <= now) {
      a.state = "open"; a.updatedAt = new Date().toISOString(); dirty = true;
    }
  }
  const before = list.length;
  cache = list.filter((a) =>
    !(["resolved", "dismissed"].includes(a.state) && now - Date.parse(a.updatedAt) > 7 * 86_400_000));
  if (dirty || cache.length !== before) save();
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
