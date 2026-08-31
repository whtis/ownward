// Session 身份仓库。阶段 1 只收口稳定身份、Task 关联和恢复引用；消息正文仍由 Provider 持有。
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { dirname, isAbsolute, join } from "path";
import { expandCodexHome } from "./provider-home.ts";
import { inventoryLegacySessions, type SessionInventoryEntry } from "../session-contract.ts";
import { kernelSessionsFile, legacySessionsFile } from "../storage/layout.ts";
import { DEFAULT_CODEX_MODEL } from "../session-options.ts";

export type SessionProviderId = "claude" | "codex" | "codebuddy";

export const SESSION_STORE_MIGRATION_ID = "stage6-kernel-sessions-v1";
export interface ArchivedSessionProvenance {
  state: "orphaned-task-link";
  originalTaskRefs: string[];
  migrationId: typeof SESSION_STORE_MIGRATION_ID;
  reason: "task-record-missing";
  sourceAggregateSha256: string;
}

export interface SessionRecord {
  id: string;
  providerId: SessionProviderId;
  providerHome?: string;
  nativeRef: string | null;
  previousRefs?: string[];
  cwd: string;
  control: "ownward" | "observing" | "external";
  taskIds: string[];
  recoverable: boolean;
  source: "legacy" | "native" | "adopted";
  createdAt: string;
  updatedAt: string;
  access?: "workspace" | "full-access" | "bypass";
  extraDirs?: string[];
  model?: string;
  effort?: string;
  legacy?: { metaFiles: string[] };
  archive?: ArchivedSessionProvenance;
  isolated?: "invalid-codex-native-ref";
  historyResetCommandId?: string;
  pendingHistoryReset?: { commandId: string; previousNativeRef: string | null; startedAt: string };
  handoff?: { predecessorId?: string; successorId?: string; at: string; reason?: string; status: "active" | "superseded" | "failed"; confirmedUnknownRunId?: string };
  confirmedUnknownRunId?: string;
}

export interface SessionCreateOptions {
  taskId: string;
  providerId: SessionProviderId;
  cwd: string;
  control?: SessionRecord["control"];
  providerHome?: string;
  access?: SessionRecord["access"];
  extraDirs?: string[];
  model?: string;
  effort?: string;
}

export interface SessionStore {
  schemaVersion: 1;
  sessions: SessionRecord[];
}

export interface MigrationConflict {
  key: string;
  reason: string;
}

export interface SessionMigrationReport {
  dryRun: boolean;
  legacyCandidates: number;
  plannedCreates: number;
  plannedUpdates: number;
  plannedMerges: number;
  plannedWrites: number;
  fallbackCanonicalIds: number;
  conflicts: MigrationConflict[];
  invalidFiles: string[];
  wrote: boolean;
}

export class SessionRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRepositoryError";
  }
}

const fileFor = kernelSessionsFile;
const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

function normalizeRecord(raw: unknown, index: number): SessionRecord {
  if (!raw || typeof raw !== "object") throw new SessionRepositoryError(`sessions.json sessions[${index}] 不是对象`);
  const r = raw as any;
  if (typeof r.id !== "string" || !r.id) throw new SessionRepositoryError(`sessions.json sessions[${index}] 缺少 id`);
  if (r.providerId !== "claude" && r.providerId !== "codex" && r.providerId !== "codebuddy") throw new SessionRepositoryError(`session ${r.id} providerId 非法`);
  if (r.providerHome !== undefined && (r.providerId !== "codex" || typeof r.providerHome !== "string" || !r.providerHome)) {
    throw new SessionRepositoryError(`session ${r.id} providerHome 非法`);
  }
  if (r.nativeRef !== null && (typeof r.nativeRef !== "string" || !r.nativeRef)) throw new SessionRepositoryError(`session ${r.id} nativeRef 非法`);
  if (r.previousRefs !== undefined && (!Array.isArray(r.previousRefs) || r.previousRefs.some((x: unknown) => typeof x !== "string" || !x))) {
    throw new SessionRepositoryError(`session ${r.id} previousRefs 非法`);
  }
  const codexRef=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if(r.providerId==="codex"&&((r.nativeRef!==null&&!codexRef(r.nativeRef))||(r.previousRefs??[]).some((ref:unknown)=>!codexRef(ref))))throw new SessionRepositoryError(`session ${r.id} Codex nativeRef 非法`);
  if (typeof r.cwd !== "string" || !isAbsolute(r.cwd)) throw new SessionRepositoryError(`session ${r.id} cwd 必须是绝对路径`);
  if (r.control !== "ownward" && r.control !== "observing" && r.control !== "external") throw new SessionRepositoryError(`session ${r.id} control 非法`);
  if (!Array.isArray(r.taskIds) || r.taskIds.some((x: unknown) => typeof x !== "string" || !x)) throw new SessionRepositoryError(`session ${r.id} taskIds 非法`);
  const createdAt = iso(r.createdAt), updatedAt = iso(r.updatedAt);
  if (!createdAt || !updatedAt) throw new SessionRepositoryError(`session ${r.id} 时间非法`);
  if (!(["legacy", "native", "adopted"] as unknown[]).includes(r.source)) throw new SessionRepositoryError(`session ${r.id} source 非法`);
  if (r.access !== undefined && r.access !== "workspace" && r.access !== "full-access" && r.access !== "bypass") throw new SessionRepositoryError(`session ${r.id} access 非法`);
  if (r.extraDirs !== undefined && (!Array.isArray(r.extraDirs) || r.extraDirs.some((x: unknown) => typeof x !== "string" || !isAbsolute(x)))) throw new SessionRepositoryError(`session ${r.id} extraDirs 非法`);
  if (r.model !== undefined && !validOptionText(r.model, 128)) throw new SessionRepositoryError(`session ${r.id} model 非法`);
  if (r.effort !== undefined && !validOptionText(r.effort, 64)) throw new SessionRepositoryError(`session ${r.id} effort 非法`);
  if(r.isolated!==undefined)throw new SessionRepositoryError(`session ${r.id} isolated 仅允许内存投影`);
  if (r.historyResetCommandId !== undefined && (typeof r.historyResetCommandId !== "string" || !r.historyResetCommandId)) throw new SessionRepositoryError(`session ${r.id} history reset 非法`);
  if (r.pendingHistoryReset !== undefined && (!r.pendingHistoryReset || typeof r.pendingHistoryReset !== "object" ||
    typeof r.pendingHistoryReset.commandId !== "string" || !r.pendingHistoryReset.commandId ||
    (r.pendingHistoryReset.previousNativeRef !== null && (typeof r.pendingHistoryReset.previousNativeRef !== "string" || !r.pendingHistoryReset.previousNativeRef)) ||
    !iso(r.pendingHistoryReset.startedAt))) throw new SessionRepositoryError(`session ${r.id} pending history reset 非法`);
  if (r.handoff !== undefined && (!r.handoff || typeof r.handoff !== "object" || !iso(r.handoff.at) ||
    !["active", "superseded", "failed"].includes(r.handoff.status) ||
    (r.handoff.predecessorId !== undefined && (typeof r.handoff.predecessorId !== "string" || !r.handoff.predecessorId)) ||
    (r.handoff.successorId !== undefined && (typeof r.handoff.successorId !== "string" || !r.handoff.successorId)) ||
    (r.handoff.confirmedUnknownRunId !== undefined && (typeof r.handoff.confirmedUnknownRunId !== "string" || !r.handoff.confirmedUnknownRunId)) ||
    (r.handoff.reason !== undefined && !validOptionText(r.handoff.reason, 512)))) throw new SessionRepositoryError(`session ${r.id} handoff 非法`);
  if(r.confirmedUnknownRunId!==undefined&&!validOptionText(r.confirmedUnknownRunId,128))throw new SessionRepositoryError(`session ${r.id} unknown confirmation 非法`);
  const metaFiles = r.legacy?.metaFiles;
  if (metaFiles !== undefined && (!Array.isArray(metaFiles) || metaFiles.some((x: unknown) => typeof x !== "string"))) {
    throw new SessionRepositoryError(`session ${r.id} legacy.metaFiles 非法`);
  }
  let archive: ArchivedSessionProvenance | undefined;
  if (r.archive !== undefined) {
    if (!r.archive || typeof r.archive !== "object" || Array.isArray(r.archive) ||
      JSON.stringify(Object.keys(r.archive).sort()) !== JSON.stringify(["migrationId", "originalTaskRefs", "reason", "sourceAggregateSha256", "state"]) ||
      r.archive.state !== "orphaned-task-link" || r.archive.migrationId !== SESSION_STORE_MIGRATION_ID ||
      r.archive.reason !== "task-record-missing" ||
      !Array.isArray(r.archive.originalTaskRefs) || !r.archive.originalTaskRefs.length ||
      r.archive.originalTaskRefs.some((x: unknown) => typeof x !== "string" || !x) ||
      typeof r.archive.sourceAggregateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.archive.sourceAggregateSha256)) {
      throw new SessionRepositoryError(`session ${r.id} archive provenance 非法`);
    }
    if (r.taskIds.length) throw new SessionRepositoryError(`session ${r.id} 归档后不得保留 active taskIds`);
    archive = { ...r.archive, originalTaskRefs: [...new Set(r.archive.originalTaskRefs)].sort() };
  }
  const previousRefs = [...new Set((r.previousRefs ?? []).filter((x: string) => x !== r.nativeRef))].sort();
  return { ...r, ...(r.providerHome?{providerHome:expandCodexHome(r.providerHome)}:{}), previousRefs, taskIds: [...new Set(r.taskIds)].sort(), recoverable: !!r.recoverable,
    ...(r.extraDirs ? { extraDirs: [...new Set(r.extraDirs)].sort() } : {}),
    ...(metaFiles ? { legacy: { metaFiles: [...new Set(metaFiles)].sort() } } : {}),
    ...(archive ? { archive } : {}) } as SessionRecord;
}

function validateStore(raw: unknown, isolateLegacyCodex?: (conflict: MigrationConflict) => void): SessionStore {
  if (!raw || typeof raw !== "object" || (raw as any).schemaVersion !== 1 || !Array.isArray((raw as any).sessions)) {
    throw new SessionRepositoryError("sessions.json 必须是 schemaVersion=1 的合法仓库");
  }
  const sessions: SessionRecord[] = [];
  for (const [index, record] of (raw as any).sessions.entries()) {
    try { sessions.push(normalizeRecord(record, index)); }
    catch (error) {
      const id = record && typeof record === "object" && typeof record.id === "string" ? record.id : `sessions[${index}]`;
      if (isolateLegacyCodex && error instanceof SessionRepositoryError && /Codex nativeRef 非法/.test(error.message)) {
        isolateLegacyCodex({ key: id, reason: "legacy-codex-native-ref-invalid-read-only-skipped" });
        continue;
      }
      throw error;
    }
  }
  const ids = new Set<string>(), tasks = new Set<string>(), native = new Set<string>();
  for (const s of sessions) {
    if (ids.has(s.id)) throw new SessionRepositoryError(`重复 session id: ${s.id}`);
    ids.add(s.id);
    for (const taskId of s.taskIds) {
      if (tasks.has(taskId)) throw new SessionRepositoryError(`taskId 被多个 session 占用: ${taskId}`);
      tasks.add(taskId);
    }
    for (const ref of [s.nativeRef, ...(s.previousRefs ?? [])].filter((x): x is string => !!x)) {
      const key = `${s.providerId}\0${ref}`;
      if (native.has(key)) throw new SessionRepositoryError(`原生会话被多个 session 占用: ${s.providerId}`);
      native.add(key);
    }
  }
  return { schemaVersion: 1, sessions };
}

type SessionStoreView = { store: SessionStore; diagnostics: MigrationConflict[]; rawRows: unknown[]; isolatedIndexes: Set<number> };
function readStoreViewAt(file: string): SessionStoreView {
  if (!existsSync(file)) return { store: { schemaVersion: 1, sessions: [] }, diagnostics: [], rawRows: [], isolatedIndexes: new Set() };
  try {
    const diagnostics: MigrationConflict[] = [], raw = JSON.parse(readFileSync(file, "utf8"));
    const isolatedIndexes = new Set<number>();
    const store = validateStore(raw, (conflict) => { diagnostics.push(conflict); const index = raw.sessions.findIndex((row: any) => row?.id === conflict.key); if (index >= 0) isolatedIndexes.add(index); });
    for(const index of isolatedIndexes){const row=raw.sessions[index];const projected=normalizeRecord({...row,nativeRef:null,previousRefs:[],recoverable:false},index);projected.isolated="invalid-codex-native-ref";store.sessions.push(projected);}
    return { store, diagnostics, rawRows: raw.sessions, isolatedIndexes };
  } catch (e) {
    if (e instanceof SessionRepositoryError) throw e;
    throw new SessionRepositoryError(`sessions.json 无法读取：${e}`);
  }
}

function mutableView(dataRoot: string): SessionStoreView {
  const primary = fileFor(dataRoot), legacy = legacySessionsFile(dataRoot);
  if (existsSync(primary)) return readStoreViewAt(primary);
  if (existsSync(legacy)) return readStoreViewAt(legacy);
  return { store: { schemaVersion: 1, sessions: [] }, diagnostics: [], rawRows: [], isolatedIndexes: new Set() };
}
function assertNotIsolated(view: SessionStoreView, id: string): void {
  for(const index of view.isolatedIndexes){const row:any=view.rawRows[index];if(row?.id===id||(Array.isArray(row?.taskIds)&&row.taskIds.includes(id))||row?.nativeRef===id||(Array.isArray(row?.previousRefs)&&row.previousRefs.includes(id)))throw new SessionRepositoryError("SESSION_RECORD_UNOPERABLE: 历史 Codex nativeRef 非法");}
}
function mutationPayload(view: SessionStoreView, store: SessionStore): { schemaVersion: 1; sessions: unknown[] } {
  const healthy={schemaVersion:1 as const,sessions:store.sessions.filter((session)=>!session.isolated)};validateStore(healthy);
  if (!view.isolatedIndexes.size) return healthy;
  const remaining = new Map(healthy.sessions.map((session) => [session.id, session]));
  const sessions: unknown[] = [];
  for (const [index, raw] of view.rawRows.entries()) {
    if (view.isolatedIndexes.has(index)) { sessions.push(raw); continue; }
    const id = raw && typeof raw === "object" && typeof (raw as any).id === "string" ? (raw as any).id : "";
    const current = remaining.get(id); if (current) { sessions.push(current); remaining.delete(id); }
  }
  sessions.push(...remaining.values());
  return { schemaVersion: 1, sessions };
}

function readStoreAt(file: string): SessionStore | null {
  if (!existsSync(file)) return null;
  try { return validateStore(JSON.parse(readFileSync(file, "utf8"))); }
  catch (e) {
    if (e instanceof SessionRepositoryError) throw e;
    throw new SessionRepositoryError(`sessions.json 无法读取：${e}`);
  }
}

function readStore(dataRoot: string): SessionStore | null {
  const primary = fileFor(dataRoot);
  if (existsSync(primary)) return readStoreAt(primary);
  return readStoreAt(legacySessionsFile(dataRoot));
}

export function sessionStoreStatus(dataRoot: string): { primary: boolean; legacyFallback: boolean; archivedOrphans: number } {
  const primary = existsSync(fileFor(dataRoot)), legacyFallback = !primary && existsSync(legacySessionsFile(dataRoot));
  const archivedOrphans = (readStore(dataRoot)?.sessions ?? []).filter((session) => session.archive?.state === "orphaned-task-link").length;
  return { primary, legacyFallback, archivedOrphans };
}

function assertMutable(session: SessionRecord): void {
  if(session.isolated)throw new SessionRepositoryError("SESSION_RECORD_UNOPERABLE");
  if (session.archive) throw new SessionRepositoryError("SESSION_ARCHIVED_READ_ONLY");
}

type LegacyTask = { id: string; startedAt?: string };

function readLegacyTasks(dataRoot: string): LegacyTask[] {
  const file = join(dataRoot, "tasks.json");
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === "string") : [];
  } catch { return []; } // inventory 会把损坏文件列入 invalidFiles，apply 会整批拒绝。
}

function projectLegacy(dataRoot: string): { store: SessionStore; report: Pick<SessionMigrationReport, "legacyCandidates" | "plannedMerges" | "fallbackCanonicalIds" | "invalidFiles"> } {
  const inv = inventoryLegacySessions(dataRoot);
  const started = new Map(readLegacyTasks(dataRoot).map((t) => [t.id, iso(t.startedAt)]));
  const groups = new Map<string, SessionInventoryEntry[]>();
  for (const s of inv.sessions) {
    const key = s.nativeRef ? `${s.providerId}\0${s.nativeRef}` : `task\0${s.sessionId}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  let fallbackCanonicalIds = 0, plannedMerges = 0;
  const sessions: SessionRecord[] = [];
  for (const entries of groups.values()) {
    const ranked = [...entries].sort((a, b) => {
      const at = started.get(a.sessionId), bt = started.get(b.sessionId);
      if (at && bt && at !== bt) return bt.localeCompare(at); // 最新 Task 与现有 recent 去重一致。
      if (at !== bt) return at ? -1 : 1;
      return a.sessionId.localeCompare(b.sessionId); // 缺 startedAt 或完全并列时，字典序是明确稳定 fallback。
    });
    if (!started.get(ranked[0].sessionId)) fallbackCanonicalIds++;
    if (entries.length > 1) plannedMerges += entries.length - 1;
    const canonical = ranked[0];
    const times = entries.map((e) => started.get(e.sessionId)).filter((x): x is string => !!x).sort();
    const stamp = times.at(-1) ?? "1970-01-01T00:00:00.000Z";
    sessions.push({
      id: canonical.sessionId, providerId: canonical.providerId, nativeRef: canonical.nativeRef, previousRefs: [],
      ...(canonical.providerId === "codex" && canonical.providerHome ? { providerHome: canonical.providerHome } : {}),
      // 输入权不能聚合：旧 alias 不得把 canonical 的 observing 静默升级成 ownward。
      cwd: canonical.cwd, control: canonical.control,
      ...(canonical.access ? { access: canonical.access } : {}), ...(canonical.extraDirs?.length ? { extraDirs: canonical.extraDirs } : {}),
      taskIds: entries.map((e) => e.sessionId).sort(), recoverable: !!canonical.nativeRef,
      source: "legacy", createdAt: times[0] ?? stamp, updatedAt: stamp,
      legacy: { metaFiles: entries.map((e) => e.metaFile).filter((x): x is string => !!x).sort() },
    });
  }
  sessions.sort((a, b) => a.id.localeCompare(b.id));
  return { store: validateStore({ schemaVersion: 1, sessions }), report: {
    legacyCandidates: inv.sessions.length, plannedMerges, fallbackCanonicalIds, invalidFiles: inv.invalidFiles,
  } };
}

/** 新仓库优先；文件不存在时只读投影 legacy。文件存在但损坏时拒绝降级，避免形成两个真相。 */
export class SessionRepository {
  private diagnostics: MigrationConflict[] = [];
  constructor(readonly dataRoot: string) {}
  private snapshot(): SessionStore {
    // Primary 一旦存在就是唯一读真相。legacy 的 drift/corruption 只能在显式
    // migrate/reconcile 路径被观测和处理，不得在普通 snapshot 中合并出 phantom Session。
    const primary = fileFor(this.dataRoot);
    if (existsSync(primary)) {
      const view = readStoreViewAt(primary);
      this.diagnostics = view.diagnostics;
      return view.store;
    }
    const legacy = legacySessionsFile(this.dataRoot);
    if (existsSync(legacy)) {
      const view = readStoreViewAt(legacy);
      this.diagnostics = view.diagnostics;
      return view.store;
    }
    this.diagnostics = [];
    return projectLegacy(this.dataRoot).store;
  }
  list(): SessionRecord[] { return this.snapshot().sessions.map((s) => structuredClone(s)); }
  getById(id: string): SessionRecord | null { return this.list().find((s) => s.id === id) ?? null; }
  getByTaskId(taskId: string): SessionRecord | null { return this.list().find((s) => s.taskIds.includes(taskId)) ?? null; }
  findByNative(providerId: SessionProviderId, nativeRef: string): SessionRecord | null {
    return this.list().find((s) => s.providerId === providerId && (s.nativeRef === nativeRef || s.previousRefs?.includes(nativeRef))) ?? null;
  }
  getDiagnostics(): MigrationConflict[] { this.snapshot(); return structuredClone(this.diagnostics); }

  setControl(id: string, control: SessionRecord["control"]): SessionRecord {
    if (control !== "ownward" && control !== "observing" && control !== "external") throw new SessionRepositoryError("control 非法");
    const file = fileFor(this.dataRoot), expected = existsSync(file) ? readFileSync(file, "utf8") : null;
    const view = mutableView(this.dataRoot), store = view.store; assertNotIsolated(view, id);
    const target = store.sessions.find((s) => s.id === id || s.taskIds.includes(id));
    if (!target) throw new SessionRepositoryError(`Session 不存在: ${id}`);
    assertMutable(target);
    if (target.control === control) return structuredClone(target);
    target.control = control; target.updatedAt = new Date().toISOString(); atomicWrite(this.dataRoot, mutationPayload(view, store), expected);
    return new SessionRepository(this.dataRoot).getById(target.id)!;
  }

  updateGrants(id: string, patch: { access?: SessionRecord["access"]; addDirectory?: string }): SessionRecord {
    const file = fileFor(this.dataRoot), expected = existsSync(file) ? readFileSync(file, "utf8") : null, view = mutableView(this.dataRoot), store = view.store; assertNotIsolated(view, id);
    const target = store.sessions.find((s) => s.id === id || s.taskIds.includes(id)); if (!target) throw new SessionRepositoryError(`Session 不存在: ${id}`);
    assertMutable(target);
    let changed = false;
    if (patch.access !== undefined && target.access !== patch.access) { target.access = patch.access; changed = true; }
    if (patch.addDirectory !== undefined) { if (!isAbsolute(patch.addDirectory)) throw new SessionRepositoryError("extra dir 非法"); const next = [...new Set([...(target.extraDirs ?? []), patch.addDirectory])].sort(); if (!same(target.extraDirs ?? [], next)) { target.extraDirs = next; changed = true; } }
    if (!changed) return structuredClone(target); target.updatedAt = new Date().toISOString(); atomicWrite(this.dataRoot, mutationPayload(view, store), expected); return new SessionRepository(this.dataRoot).getById(target.id)!;
  }

  clearNativeRef(id: string): SessionRecord {
    const file = fileFor(this.dataRoot), expected = existsSync(file) ? readFileSync(file, "utf8") : null, view = mutableView(this.dataRoot), store = view.store; assertNotIsolated(view, id);
    const target = store.sessions.find((s) => s.id === id || s.taskIds.includes(id)); if (!target) throw new SessionRepositoryError(`Session 不存在: ${id}`);
    assertMutable(target);
    if (target.nativeRef === null) return structuredClone(target);
    target.previousRefs = [...new Set([...(target.previousRefs ?? []), target.nativeRef])].sort(); target.nativeRef = null; target.recoverable = false; target.updatedAt = new Date().toISOString(); atomicWrite(this.dataRoot, mutationPayload(view, store), expected); return new SessionRepository(this.dataRoot).getById(target.id)!;
  }

  /** Provider 收到首轮输入前预留稳定 canonical id；native ref 稍后 bind 也不能换掉这个 id。 */
  reserve(input: SessionCreateOptions): SessionRecord {
    if (!input.taskId || !isAbsolute(input.cwd) ||
      (input.providerHome !== undefined && (input.providerId !== "codex" || !input.providerHome)) ||
      (input.access !== undefined && input.access !== "workspace" && input.access !== "full-access" && input.access !== "bypass") ||
      (input.extraDirs !== undefined && (!Array.isArray(input.extraDirs) || input.extraDirs.some((dir) => typeof dir !== "string" || !isAbsolute(dir)))) ||
      (input.model !== undefined && !validOptionText(input.model, 128)) ||
      (input.effort !== undefined && !validOptionText(input.effort, 64))) throw new SessionRepositoryError("reserve 参数非法");
    const model=input.model??(input.providerId==="codex"?DEFAULT_CODEX_MODEL:undefined),file = fileFor(this.dataRoot), expected = existsSync(file) ? readFileSync(file, "utf8") : null;
    // 第一次新写必须把完整 legacy store copy-forward 到 primary，不能只保留本次新 Session。
    const view = mutableView(this.dataRoot), store = view.store; assertNotIsolated(view, input.taskId);
    const existing = store.sessions.find((s) => s.taskIds.includes(input.taskId));
    if (existing) {
      if (existing.providerId !== input.providerId) throw new SessionRepositoryError("reserve 与已有 Session provider 冲突");
      return structuredClone(existing);
    }
    if (store.sessions.some((s) => s.archive?.originalTaskRefs.includes(input.taskId))) throw new SessionRepositoryError("SESSION_ARCHIVED_READ_ONLY");
    const stamp = new Date().toISOString();
    store.sessions.push({ id: input.taskId, providerId: input.providerId, nativeRef: null, previousRefs: [], cwd: input.cwd,
      ...(input.providerId === "codex" && input.providerHome ? { providerHome: input.providerHome } : {}),
      ...(input.access ? { access: input.access } : {}),
      ...(input.extraDirs?.length ? { extraDirs: [...new Set(input.extraDirs)].sort() } : {}),
      ...(model ? { model } : {}), ...(input.effort ? { effort: input.effort } : {}),
      control: input.control ?? "ownward", taskIds: [input.taskId], recoverable: false, source: "native", createdAt: stamp, updatedAt: stamp });
    atomicWrite(this.dataRoot, mutationPayload(view, store), expected);
    return new SessionRepository(this.dataRoot).getByTaskId(input.taskId)!;
  }

  /** legacy 写成功后的同步补写入口。迁移窗口内所有身份事实仍先落旧 meta，再由这里幂等收敛。 */
  reconcile(): SessionMigrationReport { return migrateLegacySessions(this.dataRoot, { dryRun: false }); }

  /** 延迟 native ref 到达时的通用入口；调用方也可不强耦合，随后 reconcile 会得到同一结果。 */
  bind(input: { taskId: string; providerId: SessionProviderId; nativeRef: string; providerHome?: string; cwd: string; control?: SessionRecord["control"]; source?: "native" | "adopted" }): SessionRecord {
    if (!input.taskId || !input.nativeRef || (input.providerId==="codex"&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.nativeRef)) || !isAbsolute(input.cwd) ||
      (input.providerHome !== undefined && (input.providerId !== "codex" || !input.providerHome))) throw new SessionRepositoryError("bind 参数非法");
    if(input.providerHome)input={...input,providerHome:expandCodexHome(input.providerHome)};const stamp = new Date().toISOString();
    const storeFile = fileFor(this.dataRoot);
    const expected = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null;
    const view = mutableView(this.dataRoot), persisted = view.store; assertNotIsolated(view, input.taskId);assertNotIsolated(view,input.nativeRef);
    const byTask = persisted.sessions.find((s) => s.taskIds.includes(input.taskId));
    const byNative = persisted.sessions.find((s) => s.providerId === input.providerId && (s.nativeRef === input.nativeRef || s.previousRefs?.includes(input.nativeRef)));
    if (persisted.sessions.some((s) => s.archive?.originalTaskRefs.includes(input.taskId))) throw new SessionRepositoryError("SESSION_ARCHIVED_READ_ONLY");
    let changed = false;
    if (byTask && byNative && byTask !== byNative) {
      if (byTask.providerId !== byNative.providerId) {
        throw new SessionRepositoryError("bind task/native 指向两个冲突 Session");
      }
      // 新 ref 已属于同 Provider 的另一条记录：合并到 task 所属稳定 Session。
      byTask.taskIds = [...new Set([...byTask.taskIds, ...byNative.taskIds])].sort();
      byTask.previousRefs = [...new Set([...(byTask.previousRefs ?? []), ...(byNative.previousRefs ?? []),
        ...(byTask.nativeRef ? [byTask.nativeRef] : [])].filter((r) => r !== input.nativeRef))].sort();
      persisted.sessions.splice(persisted.sessions.indexOf(byNative), 1);
      changed = true;
    }
    const target = byTask ?? byNative;
    if (target) {
      assertMutable(target);
      if (target.providerId !== input.providerId) {
        throw new SessionRepositoryError("bind 与已有 Session 身份冲突");
      }
      const taskIds = [...new Set([...target.taskIds, input.taskId])].sort();
      if (target.nativeRef !== input.nativeRef) {
        if (target.nativeRef) target.previousRefs = [...new Set([...(target.previousRefs ?? []), target.nativeRef])].sort();
        target.previousRefs = (target.previousRefs ?? []).filter((r) => r !== input.nativeRef);
        target.nativeRef = input.nativeRef; changed = true;
      }
      if (!target.recoverable) { target.recoverable = true; changed = true; }
      if (!same(target.taskIds, taskIds)) { target.taskIds = taskIds; changed = true; }
      // Provider meta 已成功落盘，cwd/control/home 的最新值应覆盖 repository；相同则保持零写。
      if (target.cwd !== input.cwd) { target.cwd = input.cwd; changed = true; }
      if (input.control && target.control !== input.control) { target.control = input.control; changed = true; }
      if (input.providerId === "codex" && input.providerHome && target.providerHome !== input.providerHome) {
        target.providerHome = input.providerHome; changed = true;
      }
      if (input.source === "adopted" && target.source !== "adopted") { target.source = "adopted"; changed = true; }
      if (changed) target.updatedAt = stamp;
    } else {
      persisted.sessions.push({ id: input.taskId, providerId: input.providerId, nativeRef: input.nativeRef, previousRefs: [],
        ...(input.providerId === "codex" && input.providerHome ? { providerHome: input.providerHome } : {}),
        cwd: input.cwd, control: input.control ?? "ownward", taskIds: [input.taskId], recoverable: true,
        source: input.source ?? "native", createdAt: stamp, updatedAt: stamp });
      changed = true;
    }
    if (!changed) return structuredClone(target!);
    const checked = validateStore({
      schemaVersion: 1,
      sessions: persisted.sessions.filter((session) => !session.isolated),
    });
    atomicWrite(this.dataRoot, mutationPayload(view, checked), expected);
    return new SessionRepository(this.dataRoot).getByTaskId(input.taskId)!;
  }

  resetHistory(id:string,commandId:string):SessionRecord{if(!commandId)throw new SessionRepositoryError("history reset command 非法");const file=fileFor(this.dataRoot),expected=existsSync(file)?readFileSync(file,"utf8"):null,view=mutableView(this.dataRoot),store=view.store;assertNotIsolated(view,id);const target=store.sessions.find((s)=>s.id===id||s.taskIds.includes(id));if(!target)throw new SessionRepositoryError(`Session 不存在: ${id}`);assertMutable(target);if(target.nativeRef)target.previousRefs=[...new Set([...(target.previousRefs??[]),target.nativeRef])].sort();target.nativeRef=null;target.recoverable=false;target.historyResetCommandId=commandId;target.updatedAt=new Date().toISOString();atomicWrite(this.dataRoot,mutationPayload(view,store),expected);return new SessionRepository(this.dataRoot).getById(target.id)!;}
  beginHistoryReset(id:string,commandId:string):SessionRecord{if(!commandId)throw new SessionRepositoryError("history reset command 非法");const file=fileFor(this.dataRoot),expected=existsSync(file)?readFileSync(file,"utf8"):null,view=mutableView(this.dataRoot),target=view.store.sessions.find((s)=>s.id===id||s.taskIds.includes(id));assertNotIsolated(view,id);if(!target)throw new SessionRepositoryError(`Session 不存在: ${id}`);assertMutable(target);if(target.pendingHistoryReset&&target.pendingHistoryReset.commandId!==commandId)throw new SessionRepositoryError("SESSION_HISTORY_RESET_PENDING");if(!target.pendingHistoryReset)target.pendingHistoryReset={commandId,previousNativeRef:target.nativeRef,startedAt:new Date().toISOString()};atomicWrite(this.dataRoot,mutationPayload(view,view.store),expected);return new SessionRepository(this.dataRoot).getById(target.id)!;}
  finishHistoryReset(id:string,commandId:string,completed:boolean):SessionRecord{const file=fileFor(this.dataRoot),expected=existsSync(file)?readFileSync(file,"utf8"):null,view=mutableView(this.dataRoot),target=view.store.sessions.find((s)=>s.id===id||s.taskIds.includes(id));assertNotIsolated(view,id);if(!target)throw new SessionRepositoryError(`Session 不存在: ${id}`);assertMutable(target);const pending=target.pendingHistoryReset;if(!pending){if(completed&&target.historyResetCommandId===commandId)return structuredClone(target);throw new SessionRepositoryError("SESSION_HISTORY_RESET_NOT_PENDING");}if(pending.commandId!==commandId)throw new SessionRepositoryError("SESSION_HISTORY_RESET_COMMAND_DRIFT");if(completed){if(pending.previousNativeRef)target.previousRefs=[...new Set([...(target.previousRefs??[]),pending.previousNativeRef])].sort();target.nativeRef=null;target.recoverable=false;target.historyResetCommandId=commandId;}else if(target.nativeRef!==pending.previousNativeRef)throw new SessionRepositoryError("SESSION_HISTORY_RESET_REF_DRIFT");delete target.pendingHistoryReset;target.updatedAt=new Date().toISOString();atomicWrite(this.dataRoot,mutationPayload(view,view.store),expected);return new SessionRepository(this.dataRoot).getById(target.id)!;}
  handoff(input:{taskId:string;expectedSessionId:string;providerId:SessionProviderId;model?:string;effort?:string;reason?:string}):{previous:SessionRecord;current:SessionRecord}{
    if(!input.taskId||!validOptionText(input.expectedSessionId,256)||input.model!==undefined&&!validOptionText(input.model,128)||input.effort!==undefined&&!validOptionText(input.effort,64)||input.reason!==undefined&&!validOptionText(input.reason,512))throw new SessionRepositoryError("handoff 参数非法");
    const file=fileFor(this.dataRoot),expected=existsSync(file)?readFileSync(file,"utf8"):null,view=mutableView(this.dataRoot),store=view.store;assertNotIsolated(view,input.taskId);const previous=store.sessions.find(s=>s.taskIds.includes(input.taskId));if(!previous)throw new SessionRepositoryError(`Session 不存在: ${input.taskId}`);assertMutable(previous);
    if(previous.id!==input.expectedSessionId)throw new SessionRepositoryError("SESSION_HANDOFF_STALE");
    const sameProvider=previous.providerId===input.providerId,requestedModel=input.model??(sameProvider?previous.model:undefined),effort=input.effort??(sameProvider?previous.effort:undefined);
    if(sameProvider&&requestedModel===previous.model&&effort===previous.effort)throw new SessionRepositoryError("SESSION_HANDOFF_SAME_PROVIDER");
    const model=requestedModel??(input.providerId==="codex"?DEFAULT_CODEX_MODEL:undefined);
    const at=new Date().toISOString(),id=`${input.taskId}:handoff:${crypto.randomUUID()}`;previous.taskIds=previous.taskIds.filter(x=>x!==input.taskId);previous.updatedAt=at;previous.handoff={...(previous.handoff?.predecessorId?{predecessorId:previous.handoff.predecessorId}:{}),successorId:id,at,...(input.reason?{reason:input.reason}:{}),status:"superseded"};store.sessions.push({id,providerId:input.providerId,nativeRef:null,previousRefs:[],cwd:previous.cwd,control:previous.control,taskIds:[input.taskId],recoverable:false,source:"native",createdAt:at,updatedAt:at,...(sameProvider&&previous.providerHome?{providerHome:previous.providerHome}:{}),...(previous.access?{access:previous.access}:{}),...(previous.extraDirs?.length?{extraDirs:[...previous.extraDirs]}:{}),...(model?{model}:{}),...(effort?{effort}:{}),handoff:{predecessorId:previous.id,at,...(input.reason?{reason:input.reason}:{}),status:"active"}});atomicWrite(this.dataRoot,mutationPayload(view,store),expected);const repo=new SessionRepository(this.dataRoot);return{previous:repo.getById(previous.id)!,current:repo.getByTaskId(input.taskId)!};
  }
  confirmHandoffUnknown(id:string,runId:string):SessionRecord{if(!runId)throw new SessionRepositoryError("unknown run id 非法");const file=fileFor(this.dataRoot),expected=existsSync(file)?readFileSync(file,"utf8"):null,view=mutableView(this.dataRoot),target=view.store.sessions.find(s=>s.id===id||s.taskIds.includes(id));if(!target)throw new SessionRepositoryError(`Session 不存在: ${id}`);assertMutable(target);target.confirmedUnknownRunId=runId;target.updatedAt=new Date().toISOString();atomicWrite(this.dataRoot,mutationPayload(view,view.store),expected);return new SessionRepository(this.dataRoot).getById(target.id)!;}
  rollbackHandoff(id:string):SessionRecord{const file=fileFor(this.dataRoot),expected=existsSync(file)?readFileSync(file,"utf8"):null,view=mutableView(this.dataRoot),store=view.store,current=store.sessions.find(s=>s.id===id),predecessor=current?.handoff?.predecessorId?store.sessions.find(s=>s.id===current.handoff!.predecessorId):undefined;if(!current||!predecessor||current.handoff?.status!=="active")throw new SessionRepositoryError("SESSION_HANDOFF_NOT_ACTIVE");const taskIds=[...current.taskIds],at=new Date().toISOString(),ancestor=predecessor.handoff?.predecessorId?store.sessions.find(s=>s.id===predecessor.handoff!.predecessorId):undefined;current.taskIds=[];current.handoff={...current.handoff,status:"failed"};current.updatedAt=at;predecessor.taskIds=[...new Set([...predecessor.taskIds,...taskIds])].sort();if(ancestor?.handoff?.successorId===predecessor.id)predecessor.handoff={predecessorId:ancestor.id,at:ancestor.handoff.at,...(ancestor.handoff.reason?{reason:ancestor.handoff.reason}:{}),status:"active"};else delete predecessor.handoff;predecessor.updatedAt=at;atomicWrite(this.dataRoot,mutationPayload(view,store),expected);return new SessionRepository(this.dataRoot).getById(predecessor.id)!;}
}

/** daemon/provider 共用的可重试补写；不吞错，由边界调用方决定记录日志还是终止运维命令。 */
export function reconcileLegacySessions(dataRoot: string): SessionMigrationReport {
  return new SessionRepository(dataRoot).reconcile();
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function validOptionText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && !!value.trim() && !value.includes("\0") && Buffer.byteLength(value) <= maxBytes;
}

/** 对 write(2) 短写进行完整重试；零进展视为 I/O 失败，避免留下可被 rename 的截断 JSON。 */
type SyncWriter = (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => number;
export function writeAllSync(fd: number, data: Uint8Array, writer: SyncWriter = writeSync): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writer(fd, data, offset, data.byteLength - offset, null);
    if (!Number.isInteger(written) || written <= 0) throw new SessionRepositoryError("sessions.json 临时文件写入无进展");
    offset += written;
  }
}

export interface SessionWriteLock { pid: number; token: string; at: number; }
export const SESSION_LOCK_STALE_MS = 5 * 60_000;
/** 纯判定供测试：只有足够老且 owner PID 已不存在的锁才允许回收。 */
export function canRecoverSessionLock(lock: SessionWriteLock, now: number, pidAlive: (pid: number) => boolean): boolean {
  return Number.isInteger(lock.pid) && typeof lock.token === "string" && !!lock.token &&
    Number.isFinite(lock.at) && now - lock.at >= SESSION_LOCK_STALE_MS && !pidAlive(lock.pid);
}

/** 非破坏认领 stale lock：硬链接后用 dev/ino 证明正式锁仍是同一 inode，才 unlink 旧名字。 */
export function claimStaleSessionLock(lockPath: string, recoveryPath: string, expectedToken: string): boolean {
  try { linkSync(lockPath, recoveryPath); }
  catch (e: any) {
    if (e?.code === "ENOENT" || e?.code === "EEXIST") return false;
    throw e;
  }
  try {
    const moved = JSON.parse(readFileSync(recoveryPath, "utf8")) as SessionWriteLock;
    if (moved.token !== expectedToken) return false;
    const a = statSync(lockPath), b = statSync(recoveryPath);
    if (a.dev !== b.dev || a.ino !== b.ino) return false;
    unlinkSync(lockPath); // 只解除已被本 recovery 硬链接 pin 住的同一 inode。
    return true;
  } catch {
    return false;
  }
}

export function mergeCopyForward(current: SessionStore, projected: SessionStore): { next: SessionStore; creates: number; updates: number; conflicts: MigrationConflict[] } {
  const next = structuredClone(current);
  const conflicts: MigrationConflict[] = [];
  let creates = 0, updates = 0;
  for (const incoming of projected.sessions) {
    const archivedCollision = next.sessions.find((s) => s.archive &&
      (s.id === incoming.id || s.archive.originalTaskRefs.some((id) => incoming.taskIds.includes(id))));
    if (archivedCollision) {
      conflicts.push({ key: incoming.id, reason: "legacy identity 命中只读归档 Session" });
      continue;
    }
    const hits = next.sessions.filter((s) => s.id === incoming.id || s.taskIds.some((id) => incoming.taskIds.includes(id)) ||
      (!!incoming.nativeRef && s.providerId === incoming.providerId &&
        (s.nativeRef === incoming.nativeRef || s.previousRefs?.includes(incoming.nativeRef))));
    if (hits.length > 1) {
      const taskTarget = hits.find((s) => s.taskIds.some((id) => incoming.taskIds.includes(id)));
      const nativeTarget = hits.find((s) => s !== taskTarget && incoming.nativeRef && s.providerId === incoming.providerId &&
        (s.nativeRef === incoming.nativeRef || s.previousRefs?.includes(incoming.nativeRef)));
      if (!taskTarget || !nativeTarget || taskTarget.providerId !== incoming.providerId) {
        conflicts.push({ key: incoming.id, reason: "legacy identity 同时命中多个 repository session" }); continue;
      }
      taskTarget.taskIds = [...new Set([...taskTarget.taskIds, ...nativeTarget.taskIds])].sort();
      taskTarget.previousRefs = [...new Set([...(taskTarget.previousRefs ?? []), ...(nativeTarget.previousRefs ?? []),
        ...(taskTarget.nativeRef ? [taskTarget.nativeRef] : [])].filter((r) => r !== incoming.nativeRef))].sort();
      next.sessions.splice(next.sessions.indexOf(nativeTarget), 1);
      updates++;
      hits.splice(0, hits.length, taskTarget);
    }
    if (!hits.length) { next.sessions.push(incoming); creates++; continue; }
    const target = hits[0];
    const linkedByTask = target.taskIds.some((id) => incoming.taskIds.includes(id));
    const linkedByNative = !!incoming.nativeRef && target.providerId === incoming.providerId &&
      (target.nativeRef === incoming.nativeRef || !!target.previousRefs?.includes(incoming.nativeRef));
    // id 相同但没有 Task/native 关联只是命名碰撞，尤其不能把 nativeRef=null 的坏 legacy 吞进无关 Session。
    if ((!linkedByTask && !linkedByNative) || target.providerId !== incoming.providerId) {
      conflicts.push({ key: incoming.id, reason: "repository 与 legacy 的 provider/nativeRef 冲突" }); continue;
    }
    const before = structuredClone(target);
    if (linkedByTask && incoming.nativeRef && target.nativeRef !== incoming.nativeRef) {
      if (target.nativeRef) target.previousRefs = [...new Set([...(target.previousRefs ?? []), target.nativeRef])].sort();
      target.previousRefs = (target.previousRefs ?? []).filter((r) => r !== incoming.nativeRef);
      target.nativeRef = incoming.nativeRef;
    } else target.nativeRef ||= incoming.nativeRef;
    if (target.providerId === "codex" && !target.providerHome && incoming.providerHome) target.providerHome = incoming.providerHome;
    target.recoverable = target.recoverable || incoming.recoverable;
    target.taskIds = [...new Set([...target.taskIds, ...incoming.taskIds])].sort();
    target.legacy = { metaFiles: [...new Set([...(target.legacy?.metaFiles ?? []), ...(incoming.legacy?.metaFiles ?? [])])].sort() };
    // cwd/control 等可变字段以 repository 为真相；copy-forward 只补身份，不静默覆盖。
    if (!same(before, target)) updates++;
  }
  next.sessions.sort((a, b) => a.id.localeCompare(b.id));
  try { validateStore(next); }
  catch (e) {
    conflicts.push({ key: "store", reason: String(e instanceof Error ? e.message : e) });
    // 临时 merge 视图不可信时，读侧只能退回已通过 schema 校验的持久化快照。
    return { next: structuredClone(current), creates, updates, conflicts };
  }
  return { next, creates, updates, conflicts };
}

function atomicWrite(dataRoot: string, store: { schemaVersion: 1; sessions: unknown[] }, expected?: string | null): void {
  const file = fileFor(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  const lock = join(dataRoot, "kernel", ".sessions.write.lock");
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let locked = false;
  const token = crypto.randomUUID();
  const recovery = `${lock}.recovery.${process.pid}.${token}`;
  try {
    // daemon/CLI 可能是两个进程；独占锁把 read-modify-write 冲突变成显式失败，随后 reconcile 可重试。
    const acquire = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: "wx", mode: 0o600 });
    try { acquire(); }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let stale: SessionWriteLock | null = null;
      try { stale = JSON.parse(readFileSync(lock, "utf8")); } catch { /* 坏锁也不贸然删除 */ }
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
      if (!stale || !canRecoverSessionLock(stale, Date.now(), alive)) throw new SessionRepositoryError("sessions.json 正由其他进程写入，请稍后 reconcile");
      if (!claimStaleSessionLock(lock, recovery, stale.token)) {
        throw new SessionRepositoryError("sessions 写锁已被其他回收者接管，请稍后 reconcile");
      }
      try { acquire(); }
      catch { throw new SessionRepositoryError("stale lock 已认领，但正式写锁被其他进程抢占，请稍后 reconcile"); }
    }
    locked = true;
    if (expected !== undefined) {
      const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (actual !== expected) throw new SessionRepositoryError("sessions.json 在本次写入前已被其他进程修改，请 reconcile 重试");
    }
    const payload = new TextEncoder().encode(JSON.stringify(store, null, 2) + "\n");
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeAllSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    // rename 只更新目录项；同步父目录后，掉电恢复才不会回到旧文件或丢失新文件名。
    const dirFd = openSync(dirname(file), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    try { rmSync(tmp); } catch { /* rename 已消费或写入失败 */ }
    if (locked) {
      try {
        const current = JSON.parse(readFileSync(lock, "utf8")) as SessionWriteLock;
        if (current.token === token) rmSync(lock); // 仅 owner 清自己的锁。
      } catch { /* 已清理或所有权变化 */ }
    }
    // recovery 路径带本次随机 token，只清自己的认领产物；从不直接删除正式 lock 来抢锁。
    try { rmSync(recovery); } catch { /* 未进入 recovery 或已放回 */ }
  }
}

/** copy-forward：从不改 legacy 文件；dry-run 与 apply 使用同一份规划。 */
export function migrateLegacySessions(dataRoot: string, opts: { dryRun?: boolean } = {}): SessionMigrationReport {
  const dryRun = opts.dryRun !== false;
  const projected = projectLegacy(dataRoot);
  const storeFile = fileFor(dataRoot);
  const expected = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null;
  const sourceFile = existsSync(storeFile) ? storeFile : legacySessionsFile(dataRoot);
  const view = existsSync(sourceFile) ? readStoreViewAt(sourceFile) : { store: { schemaVersion: 1 as const, sessions: [] }, diagnostics: [], rawRows: [], isolatedIndexes: new Set<number>() };
  const current = { schemaVersion: 1 as const, sessions: view.store.sessions.filter((session)=>!session.isolated) };
  const merged = mergeCopyForward(current, projected.store);
  const invalidFiles = projected.report.invalidFiles;
  const conflicts = [...view.diagnostics, ...merged.conflicts];
  const plannedWrites = merged.creates + merged.updates;
  const blocking=conflicts.filter((conflict)=>conflict.reason!=="legacy-codex-native-ref-invalid-read-only-skipped");
  if (!dryRun && (invalidFiles.length || blocking.length)) {
    throw new SessionRepositoryError(`session migration 拒绝部分写入：${invalidFiles.length} invalid, ${blocking.length} conflict (${blocking.map((c)=>c.reason).join(", ")})`);
  }
  let wrote = false;
  if (!dryRun && plannedWrites > 0) { atomicWrite(dataRoot, mutationPayload(view,merged.next), expected); wrote = true; }
  return { dryRun, legacyCandidates: projected.report.legacyCandidates,
    plannedCreates: merged.creates, plannedUpdates: merged.updates,
    plannedMerges: projected.report.plannedMerges, plannedWrites,
    fallbackCanonicalIds: projected.report.fallbackCanonicalIds,
    conflicts, invalidFiles, wrote };
}
