// Agent Run 的 append-only 事件仓库。当前仅作为旁路地基，不接生产 Provider。
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { dirname, join } from "path";

export type RunTerminalType = "run-completed" | "run-failed" | "run-interrupted" | "run-unknown-outcome";
export type RunEventType = "command-accepted" | "run-dispatching" | "run-started" | RunTerminalType;

interface RunEventBase { schemaVersion: 1; eventId: string; type: RunEventType; at: string; commandId: string; runId: string; taskId: string; sessionId: string; providerId: string; }
export interface CommandAcceptedEvent extends RunEventBase { type: "command-accepted"; inputRef?: string; }
export interface RunDispatchingEvent extends RunEventBase { type: "run-dispatching"; runnerGeneration?: string; daemonGeneration?: string; }
export interface RunStartedEvent extends RunEventBase { type: "run-started"; nativeRef?: string; runnerGeneration?: string; daemonGeneration?: string; }
export interface RunTerminalEvent extends RunEventBase { type: RunTerminalType; reason?: string; providerExitCode?: number; usage?: { inputTokens?: number; outputTokens?: number }; }
export type RunEvent = CommandAcceptedEvent | RunDispatchingEvent | RunStartedEvent | RunTerminalEvent;

export type RunDiagnosticCode = "invalid-json" | "unsupported-schema" | "invalid-shape" | "missing-newline";
export interface RunJournalDiagnostic { line: number; code: RunDiagnosticCode; reason: string; fingerprint: string; unterminated: boolean; }
export interface RunJournalRead { events: RunEvent[]; diagnostics: RunJournalDiagnostic[]; }
export interface RunSnapshot { runId: string; commandId: string; taskId: string; sessionId: string; providerId: string; status: "accepted" | "dispatching" | "running" | "completed" | "failed" | "interrupted" | "unknown_outcome"; acceptedAt?: string; dispatchingAt?: string; startedAt?: string; endedAt?: string; terminal?: RunTerminalEvent; firstSequence: number; }
export interface RunTailRepair { repaired: boolean; backup?: string; removedFingerprint?: string; }
export interface RunWriteLock { pid: number; token: string; at: number; }

const terminalTypes = new Set<RunEventType>(["run-completed", "run-failed", "run-interrupted", "run-unknown-outcome"]);
const baseKeys = ["schemaVersion", "eventId", "type", "at", "commandId", "runId", "taskId", "sessionId", "providerId"];
const allowed: Record<RunEventType, Set<string>> = {
  "command-accepted": new Set([...baseKeys, "inputRef"]),
  "run-dispatching": new Set([...baseKeys, "runnerGeneration", "daemonGeneration"]),
  "run-started": new Set([...baseKeys, "nativeRef", "runnerGeneration", "daemonGeneration"]),
  "run-completed": new Set([...baseKeys, "reason", "providerExitCode", "usage"]),
  "run-failed": new Set([...baseKeys, "reason", "providerExitCode", "usage"]),
  "run-interrupted": new Set([...baseKeys, "reason", "providerExitCode", "usage"]),
  "run-unknown-outcome": new Set([...baseKeys, "reason", "providerExitCode", "usage"]),
};
const journalFile = (root: string) => join(root, "runs.jsonl");
const lockFile = (root: string) => join(root, ".runs.write.lock");
const gateFile = (root: string) => join(root, ".runs.recovery.gate");
// 死 PID 仍留短 grace，避免 owner 刚退出、finally 尚在清理时被抢；活 PID/EPERM 永不回收。
export const RUN_LOCK_STALE_MS = 5_000;
export const RUN_LOCK_WAIT_MS = 50;
export class RunRepositoryBusyError extends Error {
  readonly code = "RUN_REPOSITORY_BUSY";
  constructor(message = "runs.jsonl 正由其他进程写入，请稍后重试") { super(message); this.name = "RunRepositoryBusyError"; }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function semantic(event: RunEvent): string { const { eventId: _id, at: _at, ...content } = event; return stable(content); }
function fingerprint(line: string): string { return new Bun.CryptoHasher("sha256").update(line).digest("hex").slice(0, 16); }
function strictIso(s: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && new Date(s).toISOString() === s; }
function plainObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function optionalString(e: any, key: string) { if (e[key] !== undefined && (typeof e[key] !== "string" || !e[key])) throw new Error(`${key} 非法`); }

function parseEvent(raw: unknown): RunEvent {
  if (!plainObject(raw)) throw new Error("事件不是对象");
  const e = raw as any;
  if (e.schemaVersion !== 1) throw Object.assign(new Error(`不支持 schemaVersion=${String(e.schemaVersion)}`), { code: "unsupported-schema" });
  if (typeof e.type !== "string" || !Object.hasOwn(allowed, e.type)) throw new Error("未知 event type");
  const extra = Object.keys(e).filter((k) => !allowed[e.type as RunEventType].has(k));
  if (extra.length) throw new Error(`包含 ${extra.length} 个未知字段`);
  for (const key of ["eventId", "at", "commandId", "runId", "taskId", "sessionId", "providerId"]) if (typeof e[key] !== "string" || !e[key]) throw new Error(`缺少 ${key}`);
  if (!strictIso(e.at)) throw new Error("at 必须是毫秒精度 UTC ISO 时间");
  for (const key of ["inputRef", "nativeRef", "runnerGeneration", "daemonGeneration", "reason"]) optionalString(e, key);
  if (e.providerExitCode !== undefined && !Number.isInteger(e.providerExitCode)) throw new Error("providerExitCode 非整数");
  if (e.usage !== undefined) {
    if (!plainObject(e.usage) || Object.keys(e.usage).some((k) => k !== "inputTokens" && k !== "outputTokens")) throw new Error("usage 字段非法");
    for (const k of ["inputTokens", "outputTokens"]) if (e.usage[k] !== undefined && (!Number.isSafeInteger(e.usage[k]) || e.usage[k] < 0)) throw new Error(`usage.${k} 非有限非负安全整数`);
  }
  return structuredClone(e) as RunEvent;
}

export function readRunJournal(dataRoot: string): RunJournalRead {
  const file = journalFile(dataRoot); if (!existsSync(file)) return { events: [], diagnostics: [] };
  return parseJournalSnapshot(readFileSync(file, "utf8"));
}
function parseJournalSnapshot(raw: string): RunJournalRead {
  const lines = raw.split("\n"), events: RunEvent[] = [], diagnostics: RunJournalDiagnostic[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { events.push(parseEvent(JSON.parse(line))); }
    catch (error: any) {
      const code: RunDiagnosticCode = error?.code === "unsupported-schema" ? "unsupported-schema" : error instanceof SyntaxError ? "invalid-json" : "invalid-shape";
      diagnostics.push({ line: i + 1, code, reason: error instanceof Error ? error.message : String(error), fingerprint: fingerprint(line), unterminated: i === lines.length - 1 && !raw.endsWith("\n") });
    }
  });
  // 合法 JSON 也必须以换行完成 durable record；否则 append 会把下一条粘在后面。
  if (raw.length && !raw.endsWith("\n") && !diagnostics.some((d) => d.line === lines.length)) {
    diagnostics.push({ line: lines.length, code: "missing-newline", reason: "最后一条事件缺少行尾换行", fingerprint: fingerprint(lines.at(-1)!), unterminated: true });
  }
  return { events, diagnostics };
}
export function readRunJournalStrict(dataRoot: string): RunEvent[] {
  const result = readRunJournal(dataRoot);
  if (result.diagnostics.length) throw new Error(`runs.jsonl 有 ${result.diagnostics.length} 个损坏或不支持的事件`);
  return result.events;
}
type RunIndexCache={dev:number;ino:number;size:number;events:RunEvent[]};
const runIndexCache=new Map<string,RunIndexCache>();
/** 热路径增量索引：同 inode append 只解析新增完整记录；rotate/truncate 全量重建，坏尾不推进 offset。 */
export function readRunJournalStrictIndexed(dataRoot:string,afterSnapshot?:()=>void):RunEvent[]{const file=journalFile(dataRoot);let fd:number;try{fd=openSync(file,"r");}catch(error:any){if(error?.code==="ENOENT"){runIndexCache.delete(file);return[];}throw error;}try{const st=fstatSync(fd),prior=runIndexCache.get(file);afterSnapshot?.();if(prior&&prior.dev===st.dev&&prior.ino===st.ino&&prior.size===st.size)return structuredClone(prior.events);const offset=prior&&prior.dev===st.dev&&prior.ino===st.ino&&st.size>prior.size?prior.size:0,bytes=Buffer.alloc(st.size-offset);let read=0;while(read<bytes.length){const count=readSync(fd,bytes,read,bytes.length-read,offset+read);if(count<=0)throw new Error("runs.jsonl snapshot 短读取");read+=count;}const parsed=parseJournalSnapshot(bytes.toString("utf8"));if(parsed.diagnostics.length)throw new Error(`runs.jsonl 有 ${parsed.diagnostics.length} 个损坏或不支持的${offset?"增量":""}事件`);const events=offset&&prior?[...prior.events,...parsed.events]:parsed.events;runIndexCache.set(file,{dev:st.dev,ino:st.ino,size:st.size,events});return structuredClone(events);}finally{closeSync(fd);}}

function assertConsistent(events: RunEvent[], next: RunEvent): "append" | "duplicate" {
  const sameEvent = events.find((e) => e.eventId === next.eventId);
  if (sameEvent) { if (semantic(sameEvent) === semantic(next)) return "duplicate"; throw new Error(`eventId 冲突: ${next.eventId}`); }
  const sameCommand = events.filter((e) => e.commandId === next.commandId);
  if (sameCommand.some((e) => e.runId !== next.runId)) throw new Error(`commandId 已绑定其他 run: ${next.commandId}`);
  const sameRun = events.filter((e) => e.runId === next.runId);
  for (const e of sameRun) for (const key of ["commandId", "taskId", "sessionId", "providerId"] as const) if (e[key] !== next[key]) throw new Error(`run ${next.runId} 的 ${key} 冲突`);
  const prior = sameRun.find((e) => e.type === next.type);
  if (next.type === "command-accepted" && prior) { if (semantic(prior) === semantic(next)) return "duplicate"; throw new Error(`run ${next.runId} 的 accepted 内容冲突`); }
  if (next.type === "run-dispatching") {
    if (!sameRun.some((e) => e.type === "command-accepted")) throw new Error(`run ${next.runId} 尚未 accepted`);
    if (prior) { if (semantic(prior) === semantic(next)) return "duplicate"; throw new Error(`run ${next.runId} 的 dispatching 内容冲突`); }
    if (sameRun.some((e) => e.type === "run-started" || terminalTypes.has(e.type))) throw new Error(`run ${next.runId} 已越过 dispatching`);
  }
  if (next.type === "run-started") {
    if (!sameRun.some((e) => e.type === "command-accepted")) throw new Error(`run ${next.runId} 尚未 accepted`);
    if (sameRun.some((e) => terminalTypes.has(e.type))) throw new Error(`run ${next.runId} 已有 terminal event`);
    if (prior) { if (semantic(prior) === semantic(next)) return "duplicate"; throw new Error(`run ${next.runId} 的 started 内容冲突`); }
  }
  if (terminalTypes.has(next.type)) {
    const started = sameRun.some((e) => e.type === "run-started"), dispatching = sameRun.some((e) => e.type === "run-dispatching");
    if (!started && !(dispatching && (next.type === "run-failed" || next.type === "run-interrupted" || next.type === "run-unknown-outcome"))) throw new Error(`run ${next.runId} 尚未 started`);
    const terminal = sameRun.find((e) => terminalTypes.has(e.type));
    if (terminal) { if (terminal.type === next.type && semantic(terminal) === semantic(next)) return "duplicate"; throw new Error(`run ${next.runId} 已有 terminal event`); }
  }
  return "append";
}

export function canRecoverRunLock(lock: RunWriteLock, now: number, alive: (pid: number) => boolean): boolean {
  return Number.isInteger(lock.pid) && typeof lock.token === "string" && !!lock.token && Number.isFinite(lock.at) && now - lock.at >= RUN_LOCK_STALE_MS && !alive(lock.pid);
}
export function claimStaleRunLock(lock: string, recovery: string, token: string): boolean {
  // caller 必须先持有 recovery gate。token 不符说明协议外换代：致命留证，绝不恢复/继续争锁。
  try { renameSync(lock, recovery); } catch (e: any) { if (e?.code === "ENOENT" || e?.code === "EEXIST") return false; throw e; }
  const value = JSON.parse(readFileSync(recovery, "utf8"));
  if (value.token !== token) throw new Error("stale lock 在认领窗口发生换代；已 fail closed 并保留 recovery 证据");
  return true;
}

/** 公共锁绝不 unlink：先原子搬到本次私有 cleanup，校验 token 后只删除私有路径。 */
function releaseOwnedPath(path: string, cleanup: string, token: string): void {
  try { renameSync(path, cleanup); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
  const value = JSON.parse(readFileSync(cleanup, "utf8"));
  if (value.token !== token) throw new Error("锁在释放窗口发生换代；保留 cleanup 证据并 fail closed");
  unlinkSync(cleanup);
}

interface RunLockOptions { waitMs?: number; afterStaleClaimed?: () => void; }
function withWriteLock<T>(dataRoot: string, options: RunLockOptions, fn: (recheck: () => void) => T): T {
  mkdirSync(dataRoot, { recursive: true });
  const lock = lockFile(dataRoot), token = crypto.randomUUID(), recovery = `${lock}.recovery.${process.pid}.${token}`;
  const gate = gateFile(dataRoot), gateToken = crypto.randomUUID(), gateCleanup = `${gate}.cleanup.${process.pid}.${gateToken}`;
  const lockCleanup = `${lock}.cleanup.${process.pid}.${token}`;
  let owned = false, recoveryClaimed = false, preserveRecovery = false;
  const acquire = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: "wx" });
  try {
    const deadline = Date.now() + (options.waitMs ?? RUN_LOCK_WAIT_MS);
    for (;;) {
      let acquired = false;
      try { acquire(); acquired = true; } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        let old: RunWriteLock | null = null; try { old = JSON.parse(readFileSync(lock, "utf8")); } catch {}
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (x: any) { return x?.code === "EPERM"; } };
        if (old && canRecoverRunLock(old, Date.now(), alive)) {
          // 固定 gate 阻止其他正常 acquire 完成握手。拿到 gate 后必须重新读取 old token。
          try { writeFileSync(gate, JSON.stringify({ pid: process.pid, token: gateToken, at: Date.now() }), { flag: "wx" }); }
          catch (g: any) { if (g?.code === "EEXIST" && Date.now() < deadline) { Bun.sleepSync(2); continue; } throw new RunRepositoryBusyError("runs stale recovery 正在进行，请重试"); }
          try {
            let current: RunWriteLock | null = null;
            try { current = JSON.parse(readFileSync(lock, "utf8")) as RunWriteLock; } catch (readError: any) {
              if (readError?.code !== "ENOENT") throw readError;
            }
            // 尚未 rename 认领，看到 ENOENT/token 换代只是另一个恢复者/正常 acquire 赢了竞争。
            // 释放自己的 gate 后重试；此时没有移动任何他人的锁，无需留证停机。
            if (!current || current.token !== old.token) {
              releaseOwnedPath(gate, gateCleanup, gateToken);
              if (Date.now() >= deadline) throw new RunRepositoryBusyError();
              Bun.sleepSync(2); continue;
            }
            try {
              if (!claimStaleRunLock(lock, recovery, old.token)) {
                releaseOwnedPath(gate, gateCleanup, gateToken);
                if (Date.now() >= deadline) throw new RunRepositoryBusyError();
                Bun.sleepSync(2); continue;
              }
            } catch (claimError) {
              preserveRecovery = existsSync(recovery);
              throw claimError;
            }
            recoveryClaimed = true;
            options.afterStaleClaimed?.();
            // unique recovery 理论上只有本恢复者可写；若内容仍发生换代，属于认领后的真实歧义。
            // 保留 gate/recovery 证据，绝不能继续创建正式锁。
            const claimed = JSON.parse(readFileSync(recovery, "utf8")) as RunWriteLock;
            if (claimed.token !== old.token) throw new Error("stale lock 认领后 token 发生换代；fail closed");
            // gate 在位时，新 acquire 即使抢到 lock，也会在二次检查中退出；短等其退让。
            for (;;) {
              try { acquire(); owned = true; break; }
              catch (a: any) {
                if (a?.code !== "EEXIST") throw a;
                if (Date.now() >= deadline) {
                  // 已认领旧锁，但正式锁暂被 crossing acquirer 占用只是良性 busy：撤销自己的
                  // gate/recovery 后交给上层重试。公共正式锁属于对方，绝不触碰。
                  releaseOwnedPath(gate, gateCleanup, gateToken);
                  unlinkSync(recovery);
                  recoveryClaimed = false;
                  throw new RunRepositoryBusyError("继任 acquire 尚未退出 recovery gate，请重试");
                }
                Bun.sleepSync(2);
              }
            }
            // owned 必须先置 true：即使 gate cleanup 失败，外层 finally 也会释放正式锁。
            releaseOwnedPath(gate, gateCleanup, gateToken);
            break;
          } catch (fatal) {
            // 歧义时保留 gate/recovery 作为现场，不继续争锁。
            preserveRecovery ||= recoveryClaimed;
            throw fatal;
          }
        }
        // 正常 acquire 前后都观察 gate：跨过 gate 创建出的锁必须安全释放并重试。
        if (existsSync(gate)) { if (Date.now() >= deadline) throw new RunRepositoryBusyError("runs stale recovery 正在进行，请重试"); Bun.sleepSync(2); continue; }
        if (Date.now() >= deadline) throw new RunRepositoryBusyError();
        Bun.sleepSync(2);
      }
      if (!acquired) continue;
      if (existsSync(gate)) {
        releaseOwnedPath(lock, lockCleanup, token);
        if (Date.now() >= deadline) throw new RunRepositoryBusyError("runs stale recovery 正在进行，请重试");
        Bun.sleepSync(2); continue;
      }
      break;
    }
    owned = true;
    assertLockOwned(lock, token);
    return fn(() => assertLockOwned(lock, token));
  } finally {
    if (owned) releaseOwnedPath(lock, lockCleanup, token);
    // recovery 是本次已验证认领的旧锁私有路径；公共 lock/gate 从不 unlink。
    if (!preserveRecovery) { try { unlinkSync(recovery); } catch {} }
  }
}

function assertLockOwned(lock: string, token: string): void {
  try { if (JSON.parse(readFileSync(lock, "utf8")).token === token) return; } catch {}
  throw new RunRepositoryBusyError("runs 写锁所有权已变化，请重试");
}

function durableAppend(file: string, line: string) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a", 0o600);
  try {
    const bytes = Buffer.from(line); let offset = 0;
    while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error("runs.jsonl 短写入"); offset += n; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // 首次创建时同步父目录，确保目录项在掉电后也 durable。
  const dirfd = openSync(dirname(file), "r"); try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
}

type RunJournalCache = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; events: RunEvent[] };
// Sidecar 每个边界会构造短命 Repository；缓存必须按 dataRoot 跨实例共享才真正避免 O(n²)。
const journalCaches = new Map<string, RunJournalCache>();

export class RunRepository {
  constructor(readonly dataRoot: string, private readonly lockOptions: RunLockOptions = {}) {}
  read(): RunJournalRead { return readRunJournal(this.dataRoot); }
  readStrict(): RunEvent[] { return readRunJournalStrict(this.dataRoot); }
  append(raw: RunEvent): { appended: boolean; event: RunEvent } {
    const event = parseEvent(raw);
    return withWriteLock(this.dataRoot, this.lockOptions, (recheck) => {
      const file = journalFile(this.dataRoot);
      const cache = journalCaches.get(file);
      let current: RunJournalRead;
      if (cache && existsSync(file)) {
        const st = statSync(file);
        current = st.dev === cache.dev && st.ino === cache.ino && st.size === cache.size && st.mtimeMs === cache.mtimeMs && st.ctimeMs === cache.ctimeMs
          ? { events: cache.events, diagnostics: [] } : readRunJournal(this.dataRoot);
      } else current = readRunJournal(this.dataRoot);
      if (current.diagnostics.length) throw new Error(`runs.jsonl 有 ${current.diagnostics.length} 个损坏或不支持的事件，拒绝追加`);
      if (assertConsistent(current.events, event) === "duplicate") return { appended: false, event };
      recheck(); // validate 可能耗时；紧贴 durable append 再确认公共锁仍是自己的 token。
      durableAppend(file, JSON.stringify(event) + "\n");
      const st = statSync(file);
      journalCaches.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, events: [...current.events, event] });
      return { appended: true, event };
    });
  }
  /** 只修复崩溃留下的最后一条“无换行 + 非法 JSON”尾巴；先完整备份。中间坏行/schema 错误一律拒绝。 */
  repairTruncatedTail(): RunTailRepair {
    return withWriteLock(this.dataRoot, this.lockOptions, (recheck) => {
      const file = journalFile(this.dataRoot); if (!existsSync(file)) return { repaired: false };
      journalCaches.delete(file);
      // 单快照完成判定与切割，避免两次读取之间文件变化导致修错位置。
      const raw = readFileSync(file, "utf8"), result = parseJournalSnapshot(raw);
      if (!result.diagnostics.length) return { repaired: false };
      const d = result.diagnostics[0];
      if (result.diagnostics.length !== 1 || (d.code !== "invalid-json" && d.code !== "missing-newline") || !d.unterminated) throw new Error("只允许修复最后一条无换行的截断 JSON 或补齐合法事件换行；中间坏行或 schema 错误必须人工处理");
      const cut = raw.lastIndexOf("\n") + 1, repairedRaw = d.code === "missing-newline" ? raw + "\n" : raw.slice(0, cut);
      const backup = `${file}.backup.${Date.now()}.${crypto.randomUUID()}`;
      writeFileSync(backup, raw, { flag: "wx", mode: 0o600 });
      const bfd = openSync(backup, "r"); try { fsyncSync(bfd); } finally { closeSync(bfd); }
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, repairedRaw, { flag: "wx", mode: 0o600 });
        const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        recheck(); // 紧贴替换再确认锁所有权。
        renameSync(tmp, file);
        const dirfd = openSync(dirname(file), "r"); try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
        return { repaired: true, backup, removedFingerprint: d.fingerprint };
      } finally { try { rmSync(tmp); } catch {} }
    });
  }
}

export function reduceRuns(events: readonly RunEvent[]): RunSnapshot[] {
  const byId = new Map<string, RunSnapshot>();
  events.forEach((event, sequence) => {
    let run = byId.get(event.runId);
    if (!run) { run = { runId: event.runId, commandId: event.commandId, taskId: event.taskId, sessionId: event.sessionId, providerId: event.providerId, status: "accepted", firstSequence: sequence }; byId.set(event.runId, run); }
    if (run.terminal) return; // 乱序/重复输入不能把 terminal 状态回退。
    if (event.type === "command-accepted") { run.acceptedAt ||= event.at; }
    else if (event.type === "run-dispatching") { run.dispatchingAt ||= event.at; if (run.status === "accepted") run.status = "dispatching"; }
    else if (event.type === "run-started") { run.startedAt ||= event.at; run.status = "running"; }
    else { run.endedAt = event.at; run.terminal = event; run.status = event.type === "run-completed" ? "completed" : event.type === "run-failed" ? "failed" : event.type === "run-interrupted" ? "interrupted" : "unknown_outcome"; }
  });
  return [...byId.values()];
}

/** Runner/当前 Provider owner 启动时调用：投递尝试已经开始却没留下 started 的结果不可证明，绝不 replay。 */
export function recoverDispatchingRuns(dataRoot: string, reason = "runner_restarted_during_dispatch"): number {
  const repo = new RunRepository(dataRoot);
  const stuck = reduceRuns(repo.readStrict()).filter((run) => run.status === "dispatching");
  let recovered = 0;
  for (const run of stuck) {
    const event: RunTerminalEvent = {
      schemaVersion: 1, eventId: crypto.randomUUID(), type: "run-unknown-outcome", at: new Date().toISOString(),
      commandId: run.commandId, runId: run.runId, taskId: run.taskId, sessionId: run.sessionId,
      providerId: run.providerId, reason,
    };
    if (repo.append(event).appended) recovered++;
  }
  return recovered;
}

export function projectTaskRunState(events: readonly RunEvent[], taskId: string): { status: "none" | RunSnapshot["status"]; runId?: string; endedAt?: string } {
  const runs = reduceRuns(events).filter((r) => r.taskId === taskId).sort((a, b) => {
    const at = a.acceptedAt ?? "" , bt = b.acceptedAt ?? "";
    return at === bt ? a.firstSequence - b.firstSequence : at.localeCompare(bt);
  });
  if (!runs.length) return { status: "none" };
  const latest = runs.at(-1)!;
  return { status: latest.status, runId: latest.runId, ...(latest.endedAt ? { endedAt: latest.endedAt } : {}) };
}
