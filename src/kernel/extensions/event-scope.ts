import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync } from "fs";
import { fsyncSync, writeFileAtomic } from "../../fs-durable.ts";
import { join } from "path";
import type { VerticalEvent } from "./contracts.ts";
import { ExtensionPolicyError } from "./services.ts";

export interface EventScopePort {
  /** Kernel 关键事件队列（spool.appendEvents）：整批一次写、一次 fsync，返回即已入队。 */
  append(events: { id: string; source: `vertical:${string}`; key: string; ts: string; payload: Record<string, unknown> }[]): void;
}
export interface EventScopeOptions { dataRoot: string; perHour?: number; now?: () => number }

const FIELDS = new Set(["id", "type", "occurredAt", "payload"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const TYPE = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_BATCH = 50, MAX_PAYLOAD_BYTES = 16 * 1024, HOUR = 3_600_000, LEDGER_MAX = 50_000, LEDGER_KEEP = 40_000;
const invalid = (message: string) => new ExtensionPolicyError("VERTICAL_EVENTS_INVALID", message);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, /(?:token|secret|password|authorization|cookie|credential)/i.test(k) ? "[REDACTED]" : redact(v)]));
  return value;
}
function plainObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function durableAppend(path: string, value: string): void { appendFileSync(path, value, { mode: 0o600 }); const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** 已受理 id 的持久账本。放在 data/kernel 下而不是 Vertical 的 scoped storage 里——Vertical 改不动自己的去重真相。
 *  入队与记账不能跨文件原子提交：启动时再从 ready/processing/近两天归档里捞回本 Vertical 前缀的 id，
 *  崩在两步之间时，重启后重发同一 id 仍然只算 duplicate。 */
export class VerticalEventLedger {
  private readonly file: string;
  private seen = new Set<string>();
  constructor(dataRoot: string, verticalId: string) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(verticalId)) throw new ExtensionPolicyError("VERTICAL_ID_INVALID", "扩展 id 非法");
    const dir = join(dataRoot, "kernel", "vertical-events", verticalId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "accepted-ids.jsonl");
    try { for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-LEDGER_MAX)) this.seen.add(line); } catch {}
    const prefix = `vertical:${verticalId}:`, evidence = [join(dataRoot, "queue.jsonl")];
    try { evidence.push(...readdirSync(dataRoot).filter((f) => f.startsWith("queue.processing.") && f.endsWith(".jsonl")).map((f) => join(dataRoot, f))); } catch {}
    try { evidence.push(...readdirSync(join(dataRoot, "events")).filter((f) => f.endsWith(".jsonl")).sort().slice(-2).map((f) => join(dataRoot, "events", f))); } catch {}
    for (const file of evidence) try {
      for (const line of readFileSync(file, "utf8").split("\n")) try {
        const id = JSON.parse(line)?.id;
        if (typeof id === "string" && id.startsWith(prefix)) this.seen.add(id.slice(prefix.length));
      } catch {}
    } catch {}
  }
  has(id: string): boolean { return this.seen.has(id); }
  /** 整批记账，一次 fsync。先记内存再落盘：已入队但账本写失败时，本进程内重试仍判 duplicate；重启后由队列证据兜底。 */
  acceptAll(ids: readonly string[]): void {
    if (!ids.length) return;
    for (const id of ids) this.seen.add(id);
    durableAppend(this.file, ids.join("\n") + "\n");
    if (this.seen.size > LEDGER_MAX) {
      // 压缩落盘成功之前不动内存：写失败时内存仍是全集，磁盘仍是旧的完整文件
      const kept = new Set([...this.seen].slice(-LEDGER_KEEP));
      writeFileAtomic(this.file, [...kept].join("\n") + "\n", { mode: 0o600 });
      this.seen = kept;
    }
  }
}

/** 将 Kernel 事件队列收成受限门面（ADR 0003）：id/source 强制带本 Vertical 前缀；整批先校验后入队；
 *  持久去重；按 Vertical 限流。定级由 triage 决定，Vertical 指定不了。 */
export function createScopedEvents(verticalId: string, port: EventScopePort, options: EventScopeOptions): { publish(events: readonly VerticalEvent[]): { accepted: number; duplicates: number } } {
  const source = `vertical:${verticalId}` as const, now = options.now ?? Date.now, perHour = options.perHour ?? 120;
  const ledger = new VerticalEventLedger(options.dataRoot, verticalId), acceptedAt: number[] = [];
  return Object.freeze({
    publish(events: readonly VerticalEvent[]) {
      if (!Array.isArray(events) || !events.length || events.length > MAX_BATCH) throw invalid(`每批 1–${MAX_BATCH} 条`);
      const batch = events.map((event) => {
        if (!plainObject(event) || Object.keys(event).some((k) => !FIELDS.has(k))) throw invalid("事件字段非法");
        if (typeof event.id !== "string" || !ID.test(event.id)) throw invalid("id 非法");
        if (typeof event.type !== "string" || !TYPE.test(event.type)) throw invalid("type 非法");
        if (event.occurredAt !== undefined && (typeof event.occurredAt !== "string" || event.occurredAt.length > 64 || !Number.isFinite(Date.parse(event.occurredAt)))) throw invalid("occurredAt 非法");
        if (!plainObject(event.payload)) throw invalid("payload 必须是 JSON 对象");
        let encoded: string;
        try { encoded = JSON.stringify(event.payload); } catch { throw invalid("payload 不可序列化"); }
        if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) throw invalid("payload 超过 16KB");
        return { id: event.id, type: event.type, occurredAt: event.occurredAt, payload: JSON.parse(encoded) as Record<string, unknown> };
      });
      const fresh = new Set(batch.map((e) => e.id).filter((id) => !ledger.has(id))), t = now();
      while (acceptedAt.length && t - acceptedAt[0]! >= HOUR) acceptedAt.shift();
      if (acceptedAt.length + fresh.size > perHour) throw new ExtensionPolicyError("VERTICAL_EVENTS_RATE_LIMITED", "事件过于频繁");
      const seenInBatch = new Set<string>(), queued = batch.filter((event) => {
        if (ledger.has(event.id) || seenInBatch.has(event.id)) return false;
        seenInBatch.add(event.id);
        return true;
      });
      port.append(queued.map((event) => ({
        id: `${source}:${event.id}`, source, key: event.type, ts: new Date(t).toISOString(),
        payload: redact({ ...event.payload, ...(event.occurredAt ? { _occurredAt: event.occurredAt } : {}) }) as Record<string, unknown>,
      })));
      ledger.acceptAll(queued.map((event) => event.id));
      for (const _ of queued) acceptedAt.push(t);
      return Object.freeze({ accepted: queued.length, duplicates: batch.length - queued.length });
    },
  });
}
