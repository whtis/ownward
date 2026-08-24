// 关键事件 spool：ready queue → processing claim → ack/release。
// processing 在 ack 前绝不删除；任一崩溃窗口最多导致重复投递，不会静默丢事件。
// 这是至少一次投递，不是 exactly-once：通知等外部副作用在 ack 前崩溃后可能重复。
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { fsyncSync } from "./fs-durable.ts";
import { join } from "path";
import { DATA, ensureDir, fmt, log } from "./util.ts";

export interface OwnwardEvent {
  id?: string;            // 新事件写入时生成；旧 JSONL 没有 id 仍可读取，不强制迁移
  source: "lark" | "github" | "gmail" | "stock";
  ts: string;             // ISO
  key?: string;           // 事件类型标识（如 lark EventKey）
  payload: unknown;
}

export interface QueueClaim {
  id: string;
  path: string;
  events: OwnwardEvent[];
  /** 与 events 一一对应的原始 JSONL 行；release 时原样回队。 */
  claimedLines: string[];
  /** 超出 maxBatch 的合法原始行；ack/release 都须原样回队。 */
  overflowLines: string[];
}

function queueFile(dataRoot: string): string { return join(dataRoot, "queue.jsonl"); }
function processingFiles(dataRoot: string): string[] {
  try {
    return readdirSync(dataRoot)
      .filter((f) => /^queue\.processing\..+\.jsonl$/.test(f))
      .sort()
      .map((f) => join(dataRoot, f));
  } catch { return []; }
}

function rawLines(raw: string): string[] {
  // 仅剥行尾换行，JSON 本身的空白和字段顺序保留，回队不重新序列化。
  return raw.split("\n").map((l) => l.endsWith("\r") ? l.slice(0, -1) : l).filter((l) => l.trim());
}

function parseEvent(line: string): OwnwardEvent | null {
  try {
    const e = JSON.parse(line);
    return e && typeof e === "object" && typeof e.source === "string" && typeof e.ts === "string" && "payload" in e
      ? e as OwnwardEvent : null;
  } catch { return null; }
}

function appendRaw(dataRoot: string, lines: string[]): void {
  if (!lines.length) return;
  ensureDir(dataRoot);
  durableAppend(queueFile(dataRoot), lines.join("\n") + "\n");
}

function durableAppend(path:string,value:string):void{appendFileSync(path,value);const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}

function quarantine(dataRoot: string, claimId: string, line: string, reason: string): void {
  const dir = join(dataRoot, "quarantine");
  ensureDir(dir);
  appendFileSync(join(dir, "queue-invalid.jsonl"), JSON.stringify({
    at: new Date().toISOString(), claimId, reason, raw: line,
  }) + "\n");
  log(`spool quarantine: claim=${claimId} ${reason}`);
}

export function appendEvent(ev: OwnwardEvent, dataRoot = DATA): OwnwardEvent {
  ensureDir(dataRoot);
  const stored: OwnwardEvent = ev.id ? ev : { ...ev, id: crypto.randomUUID() };
  const line = JSON.stringify(stored) + "\n";
  // 关键通道先入队；原始日归档失败会留痕，但不能把已经确定性排队的事件伪装成失败再诱发重投。
  durableAppend(queueFile(dataRoot), line);
  try {
    const dir = join(dataRoot, "events");
    ensureDir(dir);
    appendFileSync(join(dir, `${fmt(new Date(), "date")}.jsonl`), line);
  } catch (e) { log(`event archive failed (already queued id=${stored.id}): ${e}`); }
  log(`event queued: ${stored.source}${stored.key ? "/" + stored.key : ""} id=${stored.id}`);
  return stored;
}

/** 原子 claim 当前 ready queue。processing 文件在 ack/release 前保持原样。 */
export function claimBatch(maxBatch: number, dataRoot = DATA): QueueClaim | null {
  if (maxBatch <= 0) throw new Error("maxBatch 必须大于 0");
  const queue = queueFile(dataRoot);
  if (!existsSync(queue)) return null;
  const id = `${Date.now()}.${process.pid}.${crypto.randomUUID()}`;
  const path = join(dataRoot, `queue.processing.${id}.jsonl`);
  try { renameSync(queue, path); }
  catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }

  try {
    const claimedLines: string[] = [];
    const overflowLines: string[] = [];
    const events: OwnwardEvent[] = [];
    for (const line of rawLines(readFileSync(path, "utf8"))) {
      const event = parseEvent(line);
      if (!event) { quarantine(dataRoot, id, line, "invalid event JSON/shape"); continue; }
      if (events.length < maxBatch) { events.push(event); claimedLines.push(line); }
      else overflowLines.push(line);
    }
    const claim = { id, path, events, claimedLines, overflowLines };
    if (!events.length) {
      // 全是坏行或仅 overflow（后者在 maxBatch>0 时不可能）：坏行已隔离，可确定性 ack。
      ackBatch(claim, dataRoot);
      return null;
    }
    return claim;
  } catch (e) {
    // rename 已发生但 claim 尚未交给调用方：尽力把原始证据放回 ready；若磁盘仍故障，
    // processing 保持不删，下一次 daemon 启动由 recoverClaims 接回，绝不假装成功。
    try {
      appendRaw(dataRoot, rawLines(readFileSync(path, "utf8")));
      unlinkSync(path);
    } catch (releaseError) {
      log(`spool claim failed; processing retained ${id}: ${releaseError}`);
    }
    throw e;
  }
}

/** 成功或确定性过滤后确认消费；先回放 overflow，最后才删 processing。 */
export function ackBatch(claim: QueueClaim, dataRoot = DATA): void {
  appendRaw(dataRoot, claim.overflowLines);
  unlinkSync(claim.path);
}

/** 处理失败：所有合法行（含 overflow）按原文回 ready，最后才删 processing。 */
export function releaseBatch(claim: QueueClaim, dataRoot = DATA): void {
  appendRaw(dataRoot, [...claim.claimedLines, ...claim.overflowLines]);
  unlinkSync(claim.path);
}

/** daemon 启动恢复所有未 ack claim。崩在“回队后、删除前”会重复，但不会丢。 */
export function recoverClaims(dataRoot = DATA): number {
  let recovered = 0;
  for (const path of processingFiles(dataRoot)) {
    const claimId = path.split("queue.processing.")[1]?.replace(/\.jsonl$/, "") || "unknown";
    try {
      const valid: string[] = [];
      for (const line of rawLines(readFileSync(path, "utf8"))) {
        if (parseEvent(line)) valid.push(line);
        else quarantine(dataRoot, claimId, line, "invalid event JSON/shape during recovery");
      }
      appendRaw(dataRoot, valid);
      unlinkSync(path);
      recovered += valid.length;
    } catch (e) {
      // 一份坏 claim 不能阻止其余恢复或拖 daemon 进入 crash loop；原文件不删，留待下次重试/人工诊断。
      log(`spool recovery failed: claim=${claimId} processing retained: ${e}`);
    }
  }
  if (recovered) log(`spool recovered: ${recovered} event(s) from unacked claims`);
  return recovered;
}

/** 兼容现有 API 的 number；ready 与所有 processing 都计入（坏行在下次 claim/recover 时隔离）。 */
export function queueSize(dataRoot = DATA): number {
  const files = [queueFile(dataRoot), ...processingFiles(dataRoot)];
  let n = 0;
  for (const file of files) {
    try { n += rawLines(readFileSync(file, "utf8")).length; } catch { /* 并发 ack/claim 后文件消失 */ }
  }
  return n;
}
