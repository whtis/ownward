import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { dirname, join } from "path";
import type { DevImage } from "./types.ts";

// 忙时输入队列：agent 在跑时用户发来的消息先存这里，本轮结束合并发出。
// btw=true 表示 /btw 补充——不打断当前轮，仅作为下一轮的前置背景。
// id 是这条排队消息的稳定身份。客户端手里的队列是轮询快照，撤回只能按 id 认人：
// 按下标撤会在快照过期时删掉另一条，而且神不知鬼不觉。
// clientMutationId 只用来防重复入队（客户端重试同一条消息），不带进下发的 turn——
// 一次 flush 会把多条合并成一帧，多个 id 无法对应到同一个 command。
export interface QueuedItem { id: string; text: string; images: DevImage[]; btw: boolean; clientMutationId?: string; }
// 回传客户端的精简视图（不含 base64 图片体，只给张数）
export interface QueuedView { id: string; text: string; btw: boolean; images: number; }

let queuedSeq = 0;
/** 队列项 id：进程内唯一即可（legacy 队列只活在内存；Runner 队列落盘但 id 只需在存活期唯一） */
export function newQueuedId(): string { return `q${Date.now().toString(36)}-${(queuedSeq++).toString(36)}`; }

/** 忙时消息进队列的统一处理：识别 /btw 前缀（去前缀 + 打标记），并发一个稳定 id */
export function parseQueued(text: string, images: DevImage[] = [], clientMutationId?: string): QueuedItem {
  const btw = /^\/btw\s+/i.test(text);
  return { id: newQueuedId(), text: btw ? text.replace(/^\/btw\s+/i, "") : text, images, btw, ...(clientMutationId ? { clientMutationId } : {}) };
}

/** 从队列头切出「这一轮要发的一段」。
 *  斜杠命令必须独占一帧——CC 只在整条消息就是命令时才解释它，混进合并文本里就退化成普通文字。
 *  切法：队首是命令就只发它；否则发到下一条命令之前为止。剩下的留在队列里，下一轮继续发。 */
export function sliceQueue(items: QueuedItem[]): { batch: QueuedItem[]; rest: QueuedItem[] } {
  const isCmd = (i: QueuedItem) => !i.btw && /^\/\S/.test(i.text.trim());
  if (!items.length) return { batch: [], rest: [] };
  if (isCmd(items[0])) return { batch: [items[0]], rest: items.slice(1) };
  const n = items.findIndex(isCmd);
  return n < 0 ? { batch: items, rest: [] } : { batch: items.slice(0, n), rest: items.slice(n) };
}

/** 合并队列为一条 user 帧：/btw 内容作为「补充背景」前置，普通消息顺序拼接 */
export function mergeQueued(items: QueuedItem[]): { text: string; images: DevImage[] } {
  const btw = items.filter((i) => i.btw).map((i) => i.text.trim()).filter(Boolean);
  const normal = items.filter((i) => !i.btw).map((i) => i.text.trim()).filter(Boolean);
  const images = items.flatMap((i) => i.images);
  let text = normal.join("\n\n");
  if (btw.length) {
    const bg = "（用户补充背景，供参考）\n" + btw.map((t) => "- " + t).join("\n");
    text = text ? `${bg}\n\n${text}` : bg;
  }
  return { text, images };
}

export const QUEUE_VIEW = (items: readonly QueuedItem[]): QueuedView[] =>
  items.map((i) => ({ id: i.id, text: i.text, btw: i.btw, images: i.images.length }));

/** 单会话排队上限：正常人排不到这个数，到了多半是客户端在打转，宁可报错也不无声吃掉 */
export const QUEUE_MAX_ITEMS = 100;

interface QueueFile { schemaVersion: 1; queues: { sessionId: string; items: QueuedItem[] }[] }
const pathFor = (root: string) => join(root, "session-input-queue.json");

/**
 * Runner 会话的忙时输入队列（落盘）。
 *
 * 为什么不像 legacy 那样只放内存：legacy 的 Provider 是 daemon 的子进程，daemon 一死那轮也死了，
 * 队列跟着没了正好。Runner 不是——turn 跑在 runner 进程里，daemon 重启它照样在跑，
 * 内存队列这时会把用户排着的话悄悄丢掉，而且丢的正是「轮次很长」这种最需要排队的场景。
 */
export class SessionInputQueueStore {
  constructor(readonly dataRoot: string) {}
  private read(): QueueFile {
    const file = pathFor(this.dataRoot);
    if (!existsSync(file)) return { schemaVersion: 1, queues: [] };
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.queues)) throw new Error("session input queue 文件非法");
    for (const q of raw.queues) {
      if (!q || typeof q.sessionId !== "string" || !q.sessionId || !Array.isArray(q.items)) throw new Error("session input queue 条目非法");
      for (const i of q.items) if (!i || typeof i.id !== "string" || !i.id || typeof i.text !== "string" || typeof i.btw !== "boolean"
        || (i.clientMutationId !== undefined && (typeof i.clientMutationId !== "string" || !i.clientMutationId))
        || !Array.isArray(i.images) || i.images.some((im: any) => !im || typeof im.media_type !== "string" || typeof im.data !== "string")) throw new Error("session input queue 消息非法");
    }
    return raw;
  }
  private write(value: QueueFile): void {
    value.queues = value.queues.filter((q) => q.items.length);
    const file = pathFor(this.dataRoot);
    // 全空就把文件删掉：绝大多数会话从不排队，empty() 一个 existsSync 就能在热路径上短路掉整次读盘
    if (!value.queues.length) { if (existsSync(file)) unlinkSync(file); return; }
    mkdirSync(this.dataRoot, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    // 0600：排队消息里带 base64 图片和用户原话，和 runner command journal 的输入同级敏感
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    const dfd = openSync(dirname(file), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
  }
  /** 热路径快速判空：整个 daemon 绝大多数时候一条都没排 */
  empty(): boolean { return !existsSync(pathFor(this.dataRoot)); }
  list(sessionId: string): QueuedItem[] {
    if (this.empty()) return [];
    return structuredClone(this.read().queues.find((q) => q.sessionId === sessionId)?.items ?? []);
  }
  view(sessionId: string): QueuedView[] { return QUEUE_VIEW(this.list(sessionId)); }
  sessions(): string[] { return this.empty() ? [] : this.read().queues.map((q) => q.sessionId); }
  push(sessionId: string, item: QueuedItem): void {
    const store = this.read(), queue = store.queues.find((q) => q.sessionId === sessionId) ?? (store.queues.push({ sessionId, items: [] }), store.queues.at(-1)!);
    // 客户端重试同一条消息不该排两遍（bridge 那边对已下发的 turn 也是按 clientMutationId 去重）
    if (item.clientMutationId && queue.items.some((i) => i.clientMutationId === item.clientMutationId)) return;
    if (queue.items.length >= QUEUE_MAX_ITEMS) throw Object.assign(new Error(`排队消息已达上限 ${QUEUE_MAX_ITEMS} 条`), { code: "SESSION_QUEUE_FULL" });
    queue.items.push(item); this.write(store);
  }
  /** 取出「这一轮要发的一段」并从存储里摘掉（发送失败由调用方 unshift 放回队首） */
  take(sessionId: string): QueuedItem[] {
    const store = this.read(), queue = store.queues.find((q) => q.sessionId === sessionId);
    if (!queue?.items.length) return [];
    const { batch, rest } = sliceQueue(queue.items);
    queue.items = rest; this.write(store); return batch;
  }
  /** 发送失败时原样放回队首：顺序是用户说话的顺序，不能因为一次失败被打乱 */
  unshift(sessionId: string, items: QueuedItem[]): void {
    if (!items.length) return;
    const store = this.read(), queue = store.queues.find((q) => q.sessionId === sessionId) ?? (store.queues.push({ sessionId, items: [] }), store.queues.at(-1)!);
    queue.items = [...items, ...queue.items]; this.write(store);
  }
  /** 撤回一条：找不到如实回 false，绝不静默当成撤成功。 */
  remove(sessionId: string, queueId: string): boolean {
    const store = this.read(), queue = store.queues.find((q) => q.sessionId === sessionId);
    const at = queue?.items.findIndex((i) => i.id === queueId) ?? -1;
    if (!queue || at < 0) return false;
    queue.items.splice(at, 1); this.write(store); return true;
  }
  clear(sessionId: string): void {
    const store = this.read(); const queue = store.queues.find((q) => q.sessionId === sessionId);
    if (!queue?.items.length) return;
    queue.items = []; this.write(store);
  }
}
