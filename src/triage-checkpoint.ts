// Triage consumer checkpoint：补上“副作用全部完成、processing 尚未 ack”这个窄崩溃窗口。
// 它不提供 exactly-once：若副作用执行到一半就崩溃，事件仍会重放，通知仍可能重复。
import { createHash } from "crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { OwnwardEvent, QueueClaim } from "./spool.ts";
import { DATA, ensureDir, log } from "./util.ts";

interface Entry { key: string; completedAt: string }
interface Checkpoint { version: 1; completed: Entry[] }
const MAX_COMPLETED = 20_000;

function file(dataRoot: string): string { return join(dataRoot, "triage-checkpoint.json"); }

export function triageEventKey(event: OwnwardEvent, rawLine: string): string {
  return event.id ? `id:${event.id}` : `legacy:${createHash("sha256").update(rawLine).digest("hex")}`;
}

function load(dataRoot: string): Checkpoint {
  if (!existsSync(file(dataRoot))) return { version: 1, completed: [] };
  try {
    const parsed = JSON.parse(readFileSync(file(dataRoot), "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.completed) ||
      parsed.completed.some((e: any) => typeof e?.key !== "string" || typeof e?.completedAt !== "string")) {
      throw new Error("shape invalid");
    }
    return parsed;
  } catch (e) {
    // Checkpoint 是去重优化，不是事件真相；损坏时宁可重放，也不能丢掉关键事件。
    log(`triage checkpoint unreadable; events may repeat: ${e}`);
    return { version: 1, completed: [] };
  }
}

export function pendingClaimEvents(claim: QueueClaim, dataRoot = DATA): OwnwardEvent[] {
  const done = new Set(load(dataRoot).completed.map((e) => e.key));
  const seen = new Set<string>();
  return claim.events.filter((event, i) => {
    const key = triageEventKey(event, claim.claimedLines[i]);
    if (done.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 副作用完成后、ack 前原子记录整份 claim；崩溃重投会先被 pendingClaimEvents 过滤。 */
export function markClaimCompleted(claim: QueueClaim, dataRoot = DATA): void {
  const cp = load(dataRoot);
  const byKey = new Map(cp.completed.map((e) => [e.key, e]));
  const completedAt = new Date().toISOString();
  claim.events.forEach((event, i) => {
    const key = triageEventKey(event, claim.claimedLines[i]);
    byKey.set(key, { key, completedAt });
  });
  const next: Checkpoint = { version: 1, completed: [...byKey.values()].slice(-MAX_COMPLETED) };
  ensureDir(dataRoot);
  const tmp = `${file(dataRoot)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
    renameSync(tmp, file(dataRoot));
  } finally {
    try { rmSync(tmp); } catch { /* rename 成功或临时文件未建立 */ }
  }
}
