import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { basename, dirname, join } from "path";
import { DurableJsonlJournal, stableJson, withRunnerFileLock, type JournalDiagnostic, type JournalRead, type JournalTailRepair } from "./durable-journal.ts";
import { RUNNER_MAX_BLOB_BYTES } from "./protocol.ts";

export const RUNNER_JOURNAL_SCHEMA_VERSION = 1 as const;
export type RunnerCommandKind = "start-run" | "resume-run" | "send-input" | "interrupt" | "approval-response" | "add-dir" | "set-access" | "new-session";
export interface RunnerCommandRecord {
  schemaVersion: 1; commandId: string; kind: RunnerCommandKind; acceptedAt: string;
  runId: string; sessionId: string; providerId: string;
  inputRef?: string; inputSha256?: string; inputBytes?: number;
  approvalRequestId?: string;
}
export type RunnerEventType = "dispatching" | "started" | "delta" | "message-completed" | "usage" | "provider-notice" | "session-updated" | "approval-requested" | "completed" | "failed" | "interrupted" | "unknown-outcome";
export type RunnerReasonCode = "provider_exit" | "provider_protocol_error" | "provider_result_error" | "provider_unavailable" | "provider_busy" | "provider_input_invalid" | "approval_stale" | "run_not_active" | "provider_no_ack" | "provider_no_progress" | "unsupported_command" | "approval_denied" | "user_interrupt" | "runner_lost_ownership" | "test_fixture";
export interface RunnerEventRecord {
  schemaVersion: 1; eventId: string; sequence: number; type: RunnerEventType; at: string;
  commandId: string; runId: string; sessionId: string; providerId: string;
  nativeRef?: string; approvalRequestId?: string; reason?: RunnerReasonCode; exitCode?: number;
  payloadRef?: string; payloadSha256?: string; payloadBytes?: number;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strictIso = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && new Date(s).toISOString() === s;
const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
function requiredId(v: unknown, key: string): asserts v is string { if (typeof v !== "string" || !idPattern.test(v)) throw new Error(`${key} 非法`); }
function optionalString(v: unknown, key: string): asserts v is string | undefined { if (v !== undefined && (typeof v !== "string" || !v || v.length > 512)) throw new Error(`${key} 非法`); }
function strictObject(raw: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!plain(raw)) throw new Error("journal record 不是对象");
  if (Object.keys(raw).some((k) => !allowed.has(k))) throw new Error("journal record 含未知字段");
  if (raw.schemaVersion !== 1) throw Object.assign(new Error(`不支持 schemaVersion=${String(raw.schemaVersion)}`), { code: "unsupported-schema" });
  return raw;
}
const commandKeys = new Set(["schemaVersion", "commandId", "kind", "acceptedAt", "runId", "sessionId", "providerId", "inputRef", "inputSha256", "inputBytes", "approvalRequestId"]);
const eventKeys = new Set(["schemaVersion", "eventId", "sequence", "type", "at", "commandId", "runId", "sessionId", "providerId", "nativeRef", "approvalRequestId", "reason", "exitCode", "payloadRef", "payloadSha256", "payloadBytes"]);
const commandKinds = new Set<RunnerCommandKind>(["start-run", "resume-run", "send-input", "interrupt", "approval-response", "add-dir", "set-access", "new-session"]);
const eventTypes = new Set<RunnerEventType>(["dispatching", "started", "delta", "message-completed", "usage", "provider-notice", "session-updated", "approval-requested", "completed", "failed", "interrupted", "unknown-outcome"]);
const reasonCodes = new Set<RunnerReasonCode>(["provider_exit", "provider_protocol_error", "provider_result_error", "provider_unavailable", "provider_busy", "provider_input_invalid", "approval_stale", "run_not_active", "provider_no_ack", "provider_no_progress", "unsupported_command", "approval_denied", "user_interrupt", "runner_lost_ownership", "test_fixture"]);

function parseCommand(raw: unknown): RunnerCommandRecord {
  const r = strictObject(raw, commandKeys) as any;
  requiredId(r.commandId, "commandId"); requiredId(r.runId, "runId"); requiredId(r.sessionId, "sessionId"); requiredId(r.providerId, "providerId");
  if (!commandKinds.has(r.kind)) throw new Error("command kind 非法");
  if (typeof r.acceptedAt !== "string" || !strictIso(r.acceptedAt)) throw new Error("acceptedAt 非法");
  optionalString(r.inputRef, "inputRef"); optionalString(r.approvalRequestId, "approvalRequestId");
  if ((r.inputRef === undefined) !== (r.inputSha256 === undefined) || (r.inputRef === undefined) !== (r.inputBytes === undefined)) throw new Error("input ref/hash/bytes 必须一起出现");
  if (r.inputRef !== undefined && (!/^inputs\/[a-f0-9]{64}\.blob$/.test(r.inputRef) || !/^[a-f0-9]{64}$/.test(r.inputSha256) || !Number.isSafeInteger(r.inputBytes) || r.inputBytes < 0)) throw new Error("input blob 元数据非法");
  if ((r.kind !== "interrupt") !== (r.inputRef !== undefined)) throw new Error(`${r.kind} 输入契约非法`);
  if ((r.kind === "approval-response") !== (r.approvalRequestId !== undefined)) throw new Error("approval request 绑定非法");
  return structuredClone(r);
}
function parseEvent(raw: unknown): RunnerEventRecord {
  const r = strictObject(raw, eventKeys) as any;
  for (const k of ["eventId", "commandId", "runId", "sessionId", "providerId"]) requiredId(r[k], k);
  if (!eventTypes.has(r.type)) throw new Error("event type 非法");
  if (!Number.isSafeInteger(r.sequence) || r.sequence < 1) throw new Error("event sequence 非法");
  if (typeof r.at !== "string" || !strictIso(r.at)) throw new Error("event at 非法");
  for (const k of ["nativeRef", "approvalRequestId", "reason", "payloadRef"]) optionalString(r[k], k);
  if (r.exitCode !== undefined && !Number.isInteger(r.exitCode)) throw new Error("exitCode 非法");
  if (r.reason !== undefined && !reasonCodes.has(r.reason)) throw new Error("reason 必须是分类码；provider 详情请先写 provider-notice");
  if ((r.payloadRef === undefined) !== (r.payloadSha256 === undefined) || (r.payloadRef === undefined) !== (r.payloadBytes === undefined)) throw new Error("payload ref/hash/bytes 必须一起出现");
  if (r.payloadRef !== undefined && (!/^payloads\/[a-f0-9]{64}\.blob$/.test(r.payloadRef) || !/^[a-f0-9]{64}$/.test(r.payloadSha256) || !Number.isSafeInteger(r.payloadBytes) || r.payloadBytes < 0)) throw new Error("payload blob 元数据非法");
  if (["delta", "message-completed", "usage", "provider-notice", "session-updated"].includes(r.type) && r.payloadRef === undefined) throw new Error(`${r.type} 必须外置 payload`);
  if (["failed", "unknown-outcome"].includes(r.type) && r.payloadRef !== undefined) throw new Error(`${r.type} 不得携带 payload；详情应先发 provider-notice`);
  if (r.type === "approval-requested" && (!r.approvalRequestId || r.payloadRef === undefined)) throw new Error("approval-requested 缺 request id/payload");
  return structuredClone(r);
}

function without<T extends Record<string, unknown>>(record: T, keys: string[]): string { const copy = { ...record }; keys.forEach((k) => delete copy[k]); return stableJson(copy); }

function durableBlob(root: string, family: "inputs" | "payloads", content: string): { ref: string; sha256: string; bytes: number } {
  const sha256 = hash(content), bytes = Buffer.byteLength(content), runner = join(root, "runner"), dir = join(runner, family), file = join(dir, `${sha256}.blob`);
  mkdirSync(runner, { recursive: true, mode: 0o700 }); chmodSync(runner, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (bytes > RUNNER_MAX_BLOB_BYTES) throw new Error("Runner blob 超过大小上限");
  if (existsSync(file)) {
    const found = readFileSync(file, "utf8");
    if (hash(found) !== sha256) throw new Error("Runner blob hash 冲突或文件损坏");
    chmodSync(file, 0o600);
    return { ref: `${family}/${sha256}.blob`, sha256, bytes };
  }
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`), data = Buffer.from(content);
  const fd = openSync(tmp, "wx", 0o600);
  try { let offset = 0; while (offset < data.length) { const n = writeSync(fd, data, offset, data.length - offset); if (n <= 0) throw new Error("Runner blob 短写入"); offset += n; } fsyncSync(fd); }
  finally { closeSync(fd); }
  try { linkSync(tmp, file); } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  finally { unlinkSync(tmp); }
  chmodSync(file, 0o600);
  const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
  if (hash(readFileSync(file, "utf8")) !== sha256) throw new Error("Runner blob 落盘校验失败");
  return { ref: `${family}/${sha256}.blob`, sha256, bytes };
}

function readBlob(root: string, family: "inputs" | "payloads", ref: string, sha256: string, bytes: number): string {
  const match = new RegExp(`^${family}/([a-f0-9]{64})\\.blob$`).exec(ref);
  if (!match || match[1] !== sha256 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Runner blob 引用非法");
  const content = readFileSync(join(root, "runner", family, `${sha256}.blob`), "utf8");
  if (hash(content) !== sha256 || Buffer.byteLength(content) !== bytes) throw new Error("Runner blob hash/bytes 校验失败");
  return content;
}

export class RunnerCommandJournal {
  private readonly journal: DurableJsonlJournal<RunnerCommandRecord>;
  constructor(readonly dataRoot: string, private readonly testHooks: { afterBlobWritten?: () => void } = {}) {
    this.journal = new DurableJsonlJournal(join(dataRoot, "runner", "commands.jsonl"), parseCommand, (r) => r.commandId, (r) => without(r as any, ["acceptedAt"]));
  }
  read(): JournalRead<RunnerCommandRecord> { return this.journal.read(); }
  readStrict(): RunnerCommandRecord[] { return this.journal.readStrict(); }
  repairTruncatedTail(): JournalTailRepair { return this.journal.repairTruncatedTail(); }
  accept(command: Omit<RunnerCommandRecord, "schemaVersion" | "acceptedAt" | "inputRef" | "inputSha256" | "inputBytes"> & { input?: string }, now = new Date().toISOString()) {
    const { input, ...base } = command;
    if (input === undefined) return this.journal.append({ schemaVersion: 1, acceptedAt: now, ...base } as RunnerCommandRecord);
    return withRunnerBlobMaintenanceLock(this.dataRoot, () => {
      const blob = durableBlob(this.dataRoot, "inputs", input); this.testHooks.afterBlobWritten?.();
      return this.journal.append({ schemaVersion: 1, acceptedAt: now, ...base, inputRef: blob.ref, inputSha256: blob.sha256, inputBytes: blob.bytes } as RunnerCommandRecord);
    });
  }
  // accepted 只证明 durable 收到；无论 Runner 重启前是否处理，都不从 journal 自动 replay。
  find(commandId: string): RunnerCommandRecord | undefined { requiredId(commandId, "commandId"); return this.journal.get(commandId); }
  readInput(record: RunnerCommandRecord): string | undefined {
    const parsed = parseCommand(record);
    return parsed.inputRef ? readBlob(this.dataRoot, "inputs", parsed.inputRef, parsed.inputSha256!, parsed.inputBytes!) : undefined;
  }
}

export class RunnerEventJournal {
  private readonly journal: DurableJsonlJournal<RunnerEventRecord>;
  private readonly commands: RunnerCommandJournal;
  constructor(readonly dataRoot: string, private readonly testHooks: { afterBlobWritten?: () => void } = {}) {
    this.commands = new RunnerCommandJournal(dataRoot);
    this.journal = new DurableJsonlJournal(join(dataRoot, "runner", "events.jsonl"), parseEvent, (r) => r.eventId, (r) => without(r as any, ["at"]), undefined,
      (records, next) => {
        const command = this.commands.find(next.commandId);
        if (!command) throw new Error("event 对应 command 尚未 durable accepted");
        for (const key of ["runId", "sessionId", "providerId"] as const) if (command[key] !== next[key]) throw new Error(`event ${key} 与 command 冲突`);
        const state = eventState(records, next.commandId, next.runId), expected = state.count + 1;
        if (next.sequence !== expected) throw new Error(`event sequence 非连续，期望 ${expected}`);
        if (state.terminal) throw new Error("terminal 后拒绝追加 event");
        if (next.type === "dispatching" && state.count > 0) throw new Error("dispatching 必须是首个 event");
        if (next.type === "started" && state.started) throw new Error("started 只能出现一次");
        if (!state.started && next.type !== "dispatching" && next.type !== "started" && next.type !== "provider-notice" && !terminalBeforeStarted(next.type)) throw new Error("started 前拒绝该 event");
      }, (records, next) => updateEventState(records, next));
  }
  read(): JournalRead<RunnerEventRecord> {
    const result = this.journal.read(); if (result.diagnostics.length) return result;
    let commands: RunnerCommandRecord[];
    try { commands = this.commands.readStrict(); }
    catch (e) { return { records: result.records, diagnostics: [crossDiagnostic(0, "command-journal", e)] }; }
    const diagnostics = validateEventHistory(result.records, commands);
    return { records: result.records, diagnostics };
  }
  readStrict(): RunnerEventRecord[] {
    const result = this.read();
    if (result.diagnostics.length) throw new Error(`events.jsonl 有 ${result.diagnostics.length} 条跨 journal 或 lifecycle 损坏记录`);
    return result.records;
  }
  repairTruncatedTail(): JournalTailRepair { return this.journal.repairTruncatedTail(); }
  append(event: Omit<RunnerEventRecord, "schemaVersion" | "sequence" | "payloadRef" | "payloadSha256" | "payloadBytes"> & { sequence?: number; payload?: string }) {
    const { payload, ...base } = event;
    const append = (blob?: { ref: string; sha256: string; bytes: number }) => this.journal.appendWith((records, lookup) => ({ schemaVersion: 1, ...base, sequence: event.sequence ?? lookup(event.eventId)?.sequence ?? eventState(records, event.commandId, event.runId).count + 1, ...(blob ? { payloadRef: blob.ref, payloadSha256: blob.sha256, payloadBytes: blob.bytes } : {}) }));
    if (payload === undefined) return append();
    return withRunnerBlobMaintenanceLock(this.dataRoot, () => { const blob = durableBlob(this.dataRoot, "payloads", payload); this.testHooks.afterBlobWritten?.(); return append(blob); });
  }
  readPayload(record: RunnerEventRecord): string | undefined {
    const parsed = parseEvent(record);
    return parsed.payloadRef ? readBlob(this.dataRoot, "payloads", parsed.payloadRef, parsed.payloadSha256!, parsed.payloadBytes!) : undefined;
  }
}

const terminalEvent = (type: RunnerEventType) => type === "completed" || type === "failed" || type === "interrupted" || type === "unknown-outcome";
// Provider 可能在发出 started 前明确失败；Runner 重启也必须能把已接管但结果不可证的
// command 收敛为 unknown-outcome。其余事件仍需 started 作为严格前置条件。
const terminalBeforeStarted = (type: RunnerEventType) => type === "failed" || type === "unknown-outcome";
type EventState = { count: number; started: boolean; terminal: boolean };
const eventIndexes = new WeakMap<readonly RunnerEventRecord[], Map<string, EventState>>();
const eventKey = (commandId: string, runId: string) => `${commandId}\0${runId}`;
function eventIndex(records: readonly RunnerEventRecord[]): Map<string, EventState> {
  let index = eventIndexes.get(records); if (index) return index;
  index = new Map();
  for (const event of records) {
    const key = eventKey(event.commandId, event.runId), state = index.get(key) ?? { count: 0, started: false, terminal: false };
    state.count++; state.started ||= event.type === "started"; state.terminal ||= terminalEvent(event.type); index.set(key, state);
  }
  eventIndexes.set(records, index); return index;
}
function eventState(records: readonly RunnerEventRecord[], commandId: string, runId: string): EventState {
  return eventIndex(records).get(eventKey(commandId, runId)) ?? { count: 0, started: false, terminal: false };
}
function updateEventState(records: readonly RunnerEventRecord[], next: RunnerEventRecord): void {
  const index = eventIndex(records), key = eventKey(next.commandId, next.runId), prior = index.get(key) ?? { count: 0, started: false, terminal: false };
  // onAppended 收到的 records 已含 next；若 index 刚由该数组构建，状态已经包含本事件，不再重复加。
  if (prior.count >= next.sequence) return;
  index.set(key, { count: prior.count + 1, started: prior.started || next.type === "started", terminal: prior.terminal || terminalEvent(next.type) });
}

export interface RunnerBlobAudit { referenced: string[]; orphans: string[]; temporary: string[]; backups: string[]; }
export function auditRunnerBlobs(dataRoot: string): RunnerBlobAudit {
  const commandRepo = new RunnerCommandJournal(dataRoot), commands = commandRepo.readStrict(), events = new RunnerEventJournal(dataRoot).readStrict();
  const referenced = new Set([...commands.flatMap((r) => r.inputRef ? [r.inputRef] : []), ...events.flatMap((r) => r.payloadRef ? [r.payloadRef] : [])]);
  const collectAttachments = (value: unknown): void => { if (Array.isArray(value)) return value.forEach(collectAttachments); if (!plain(value)) return; if (plain(value.blob) && typeof value.blob.ref === "string" && /^attachments\/[a-f0-9]{64}\.blob$/.test(value.blob.ref)) referenced.add(value.blob.ref); Object.values(value).forEach(collectAttachments); };
  for (const command of commands) { try { const input = commandRepo.readInput(command); if (input) collectAttachments(JSON.parse(input)); } catch { /* strict command journal remains authoritative; non-JSON inputs simply have no attachment refs */ } }
  const runner = join(dataRoot, "runner"), files: string[] = [];
  for (const family of ["inputs", "payloads", "attachments"] as const) {
    const dir = join(runner, family); if (!existsSync(dir)) continue;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) files.push(`${family}/${name}`);
  }
  const blobs = files.filter((f) => /^(inputs|payloads|attachments)\/[a-f0-9]{64}\.blob$/.test(f));
  const otherRunnerFiles = existsSync(runner) ? readdirSync(runner) : [];
  const materialized = join(runner, "tmp"), crashMaterialized = existsSync(materialized) ? (readdirSync(materialized, { recursive: true }) as string[]).map((f) => `tmp/${f}`) : [];
  return { referenced: [...referenced].sort(), orphans: blobs.filter((f) => !referenced.has(f)).sort(), temporary: [...files.filter((f) => f.includes(".tmp")), ...otherRunnerFiles.filter((f) => f.includes(".tmp")), ...crashMaterialized].sort(), backups: otherRunnerFiles.filter((f) => f.includes(".backup.")).sort() };
}

const runnerBlobLockFile = (dataRoot: string) => join(dataRoot, "runner", ".blob-maintenance");
/** 锁序只能是 blob-maintenance → command/event journal；journal 持锁期间禁止反向获取 blob 锁。 */
export function withRunnerBlobMaintenanceLock<T>(dataRoot: string, fn: () => T): T {
  return withRunnerFileLock(runnerBlobLockFile(dataRoot), () => fn());
}

/** 显式隔离审计确认的 orphan；从不自动删除，且拒绝调用方提供未在最新审计中的路径。 */
export function quarantineRunnerOrphans(dataRoot: string, refs: readonly string[], testHooks: { afterAudit?: () => void } = {}): string[] {
  return withRunnerBlobMaintenanceLock(dataRoot, () => {
    // 调用方看到的旧 audit 不能作为依据；必须在维护锁内重新证明仍是 orphan。
    const audit = auditRunnerBlobs(dataRoot), allowed = new Set(audit.orphans), runner = join(dataRoot, "runner"); testHooks.afterAudit?.();
    if (refs.some((r) => !allowed.has(r))) throw new Error("只能隔离锁内最新审计确认的 orphan blob");
    if (!refs.length) return [];
    const quarantine = join(runner, "quarantine", new Date().toISOString().replaceAll(":", "-")); mkdirSync(quarantine, { recursive: true, mode: 0o700 }); chmodSync(quarantine, 0o700);
    const sourceDirs = new Set<string>(), moved: string[] = [];
    try {
      for (const ref of refs) { const sourceDir = join(runner, ref.split("/")[0]), source = join(runner, ref), target = join(quarantine, ref.replace("/", "--")); sourceDirs.add(sourceDir); renameSync(source, target); moved.push(target); }
    } finally {
      for (const dir of [...sourceDirs, quarantine]) { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    }
    return moved;
  });
}

function crossDiagnostic(line: number, identity: string, error: unknown): JournalDiagnostic {
  return { line, code: "invalid-shape", reason: error instanceof Error ? error.message : String(error), fingerprint: hash(identity).slice(0, 16), unterminated: false };
}
function validateEventHistory(events: readonly RunnerEventRecord[], commands: readonly RunnerCommandRecord[]): JournalDiagnostic[] {
  const byCommand = new Map(commands.map((c) => [c.commandId, c])), states = new Map<string, EventState>(), diagnostics: JournalDiagnostic[] = [];
  events.forEach((event, index) => {
    try {
      const command = byCommand.get(event.commandId); if (!command) throw new Error("event 对应 command 不存在");
      for (const key of ["runId", "sessionId", "providerId"] as const) if (command[key] !== event[key]) throw new Error(`event ${key} 与 command 冲突`);
      const key = eventKey(event.commandId, event.runId), state = states.get(key) ?? { count: 0, started: false, terminal: false };
      if (event.sequence !== state.count + 1) throw new Error(`event sequence 非连续，期望 ${state.count + 1}`);
      if (state.terminal) throw new Error("terminal 后存在 event");
      if (event.type === "started" && state.started) throw new Error("started 重复");
      if (event.type === "dispatching" && state.count > 0) throw new Error("dispatching 不是首个 event");
      if (!state.started && event.type !== "dispatching" && event.type !== "started" && event.type !== "provider-notice" && !terminalBeforeStarted(event.type)) throw new Error("started 前存在非法 event");
      states.set(key, { count: state.count + 1, started: state.started || event.type === "started", terminal: state.terminal || terminalEvent(event.type) });
    } catch (e) { diagnostics.push(crossDiagnostic(index + 1, event.eventId, e)); }
  });
  return diagnostics;
}
