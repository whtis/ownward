// 助理货架（Assistant Shelf）：心跳顺手看出来的「建议 / 风险 / 规律」，不够格当提醒，又值得让 owner 瞄一眼。
// 只放 5 条、72 小时自然过期；采纳 = 人点了才派任务 / 开 Action（AI 不替人动手）。
// 忽略或采纳过的同一条观察 72 小时内不再上架——不然下一轮心跳换个时间戳又摆回来。
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { fsyncSync } from "./fs-durable.ts";
import type { Action, ActionKind } from "./actions.ts";
import { DATA, ensureDir, log } from "./util.ts";

export type ShelfCategory = "suggestion" | "risk" | "pattern";
export interface ShelfActionSuggestion {
  kind: "task" | "action";
  label: string;
  dir?: string;
  prompt?: string;
  actionPayload?: any;
}
export interface ShelfItem {
  id: string;               // sha16(category + ":" + title)：同一条观察天然去重
  category: ShelfCategory;
  title: string;
  detail: string;
  actionSuggestion?: ShelfActionSuggestion;
  createdAt: string;
  expiresAt: string;        // createdAt + 72h
}
export type ShelfInput = Omit<ShelfItem, "createdAt" | "expiresAt" | "id"> & { id?: string };

export const SHELF_MAX = 5;
export const SHELF_TTL_MS = 72 * 3_600_000;
const CATEGORIES: readonly ShelfCategory[] = ["suggestion", "risk", "pattern"];
const ACTION_KINDS: readonly ActionKind[] = ["reply", "review", "approve", "follow_up", "decide"];

interface ShelfFile { v: 1; items: ShelfItem[]; suppressed: Record<string, string> }   // suppressed: id → 到期时间

const FILE = join(DATA, "shelf.json");

export const shelfItemId = (category: string, title: string) => createHash("sha256").update(`${category}:${title}`).digest("hex").slice(0, 16);

function load(): ShelfFile {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (Array.isArray(raw)) return { v: 1, items: raw, suppressed: {} };
    return { v: 1, items: Array.isArray(raw?.items) ? raw.items : [], suppressed: raw?.suppressed && typeof raw.suppressed === "object" ? raw.suppressed : {} };
  } catch { return { v: 1, items: [], suppressed: {} }; }
}

function save(f: ShelfFile) {
  ensureDir(DATA);
  const temp = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(f, null, 2));
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, FILE);
  const dfd = openSync(DATA, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 模型输出当外部输入：类别不认识、没标题的整条丢；建议缺必填字段只丢建议 */
export function normalizeSuggestion(raw: any): ShelfActionSuggestion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const label = str(raw.label, 40);
  if (raw.kind === "task") {
    const prompt = str(raw.prompt, 4000);
    if (!label || !prompt) return undefined;
    const dir = str(raw.dir, 500);
    return { kind: "task", label, prompt, ...(dir ? { dir } : {}) };
  }
  if (raw.kind === "action") {
    if (!label) return undefined;
    const p = raw.actionPayload && typeof raw.actionPayload === "object" ? raw.actionPayload : {};
    const payload = {
      ...(ACTION_KINDS.includes(p.kind) ? { kind: p.kind } : {}),
      ...(str(p.title, 120) ? { title: str(p.title, 120) } : {}),
      ...(str(p.reason, 500) ? { reason: str(p.reason, 500) } : {}),
      ...(/^https?:\/\//.test(str(p.url, 1000)) ? { url: str(p.url, 1000) } : {}),
      ...(str(p.relatesTo, 200) ? { relatesTo: str(p.relatesTo, 200) } : {}),
    };
    return { kind: "action", label, ...(Object.keys(payload).length ? { actionPayload: payload } : {}) };
  }
  return undefined;
}

function live(f: ShelfFile, now: Date): ShelfFile {
  const t = now.getTime();
  return {
    v: 1,
    items: f.items.filter((x) => x && typeof x.id === "string" && Date.parse(x.expiresAt) > t),
    suppressed: Object.fromEntries(Object.entries(f.suppressed).filter(([, until]) => Date.parse(until) > t)),
  };
}

export function listShelfItems(now = new Date()): ShelfItem[] {
  return live(load(), now).items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function recordShelfItems(items: ShelfInput[], now = new Date()): void {
  if (!Array.isArray(items) || !items.length) return;
  const f = live(load(), now), at = now.toISOString(), exp = new Date(now.getTime() + SHELF_TTL_MS).toISOString();
  let added = 0;
  for (const raw of items) {
    const category = CATEGORIES.includes(raw?.category as ShelfCategory) ? raw.category : null;
    const title = str(raw?.title, 120);
    if (!category || !title) continue;
    const id = str(raw.id, 64) || shelfItemId(category, title);
    if (f.suppressed[id]) continue;
    const actionSuggestion = normalizeSuggestion(raw.actionSuggestion);
    const next = { category, title, detail: str(raw.detail, 1000), ...(actionSuggestion ? { actionSuggestion } : {}) };
    const cur = f.items.find((x) => x.id === id);
    // 已在架上：只刷新内容，不续期——同一件事挂满 72 小时没人理，就该自己下架
    if (cur) { Object.assign(cur, next); if (!actionSuggestion) delete cur.actionSuggestion; continue; }
    f.items.push({ id, ...next, createdAt: at, expiresAt: exp });
    added++;
  }
  f.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  f.items = f.items.slice(0, SHELF_MAX);   // 超额挤掉最老的
  save(f);
  if (added) log(`shelf: +${added} observation(s)`);
}

/** 标题去掉会过期的数字（「（43 条）」「挂了 6 小时」）和空白，只比事情本身 */
const sameThing = (t: string) => t.replace(/[（(][^）)]*\d[^）)]*[）)]/g, "").replace(/\s+/g, "");

/** 这条观察说的是不是行动队列里已经挂着的那件事：模型点名了 relatesTo，或采纳后要开的标题和某条在办的一样。
 *  只认这两条确定性线索，不做语义相似度（猜错了会把真建议吞掉） */
export function queuedActionFor(s: ShelfActionSuggestion | undefined, open: readonly Pick<Action, "id" | "title">[]): string | null {
  if (s?.kind !== "action") return null;
  const p = s.actionPayload || {};
  if (p.relatesTo && open.some((a) => a.id === p.relatesTo)) return p.relatesTo;
  const t = typeof p.title === "string" ? sameThing(p.title) : "";
  return (t && open.find((a) => sameThing(a.title) === t)?.id) || null;
}

/** 心跳用：行动队列里已有的事不进货架——催它是 message 的活。上过一次货架的「集中审核 X」被采纳后
 *  会和 X 本身并排挂着，下一轮心跳看到两条相似的又建议「合并处理」，自己喂自己 */
export function dropQueuedObservations<T extends { actionSuggestion?: unknown }>(items: T[], open: readonly Pick<Action, "id" | "title">[]): { kept: T[]; dropped: number } {
  const kept = items.filter((x) => !queuedActionFor(normalizeSuggestion(x?.actionSuggestion), open));
  return { kept, dropped: items.length - kept.length };
}

/** 下架并在 TTL 内压住同一条观察 */
function takeOff(id: string, now = new Date()): ShelfItem | null {
  const f = live(load(), now), item = f.items.find((x) => x.id === id);
  if (!item) return null;
  f.items = f.items.filter((x) => x.id !== id);
  f.suppressed[id] = new Date(now.getTime() + SHELF_TTL_MS).toISOString();
  save(f);
  return item;
}

export function dismissShelfItem(id: string): boolean {
  return !!takeOff(id);
}

export interface AdoptDeps {
  dispatchTask?: (input: { dir?: string; prompt: string }) => Promise<{ id: string }>;
  openAction?: typeof import("./actions.ts").openAction;
}

export async function adoptShelfItem(id: string, deps: AdoptDeps = {}): Promise<{ ok: boolean; taskId?: string; actionId?: string; linked?: boolean; gone?: boolean; msg?: string }> {
  const item = listShelfItems().find((x) => x.id === id);
  if (!item) return { ok: false, msg: "这条观察已过期或不存在" };
  const s = item.actionSuggestion;
  if (!s) return { ok: false, msg: "这条观察没有可采纳的建议" };
  if (s.kind === "task") {
    if (!s.prompt) return { ok: false, msg: "建议缺任务描述" };
    let task: { id: string };
    try { task = await (deps.dispatchTask || (await import("./dispatch.ts")).dispatchTask)({ dir: s.dir, prompt: s.prompt }); }
    catch (e) { return { ok: false, msg: String((e as Error)?.message || e) }; }   // 派发失败不下架，人可以改配置再点
    takeOff(id);
    log(`shelf: adopted ${id} → task ${task.id}`);
    return { ok: true, taskId: task.id };
  }
  const p = s.actionPayload || {};
  const A = await import("./actions.ts");
  // 说的是已经挂着的那件事：不另开一条（另开的是冻结副本——标题里的条数不会再变，来源巡检也不会替它收尾）
  const queued = queuedActionFor(s, A.listActions(false));
  if (queued) {
    takeOff(id);
    log(`shelf: adopted ${id} → 已有行动 ${queued}（不另开）`);
    return { ok: true, actionId: queued, linked: true };
  }
  if (p.relatesTo) {
    takeOff(id);
    return { ok: false, gone: true, msg: "它说的那件事已经处理完了，这条建议过时，已下架" };
  }
  const actionId = `shelf:${item.id}`;
  (deps.openAction || A.openAction)({
    id: actionId, kind: ACTION_KINDS.includes(p.kind) ? p.kind : "follow_up", source: "assistant",
    title: p.title || item.title, reason: p.reason || item.detail || item.title,
    ref: typeof p.url === "string" ? { url: p.url } : {},
    // 没有来源巡检会替它收尾，和货架同一个 TTL：72 小时没处理就当这条建议过时了
    expiresAt: new Date(Date.now() + SHELF_TTL_MS).toISOString(),
  }, { revive: true });
  takeOff(id);
  log(`shelf: adopted ${id} → action ${actionId}`);
  return { ok: true, actionId };
}
