import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { ownedByCurrentUser } from "../../posix-owner.ts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import type { ScopedLlm, ScopedActions, ScopedScheduler, ScopedSessions, ScopedSources, ScopedStorage, ScopedTasks, VerticalContext, VerticalManifest } from "./contracts.ts";
import { LifecycleCapability } from "./lifecycle.ts";

export class ExtensionPolicyError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as any)) deepFreeze(child); } return value; }
function safeRelative(key: string): string {
  if (!key || isAbsolute(key) || key.includes("\\") || key.split("/").some((p) => !p || p === "." || p === "..")) throw new ExtensionPolicyError("VERTICAL_PATH_DENIED", "扩展路径非法");
  return key;
}
function contained(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); }
function assertNoSymlink(root: string, target: string): void {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ExtensionPolicyError("VERTICAL_PATH_SYMLINK", "扩展存储拒绝符号链接"); }
}
export function scopedStorageAt(rootInput:string,lifecycle?:LifecycleCapability):ScopedStorage {
  mkdirSync(rootInput,{recursive:true,mode:0o700});const root=realpathSync(rootInput),rst=lstatSync(root);if(!rst.isDirectory()||!ownedByCurrentUser(rst))throw new ExtensionPolicyError("VERTICAL_STORAGE_OWNER_INVALID","扩展存储所有者非法");chmodSync(root,0o700);
  const file = (key: string) => { const out = resolve(root, safeRelative(key)); if (!contained(root, out)) throw new ExtensionPolicyError("VERTICAL_PATH_DENIED", "扩展路径越界"); assertNoSymlink(root, out); return out; };
  return {
    readJson<T>(key: string): T | null { try { return JSON.parse(readFileSync(file(key), "utf8")); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; } },
    writeJson(key: string, value: unknown): void { lifecycle?.assertWrite();const dst = file(key), dir = dirname(dst); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); assertNoSymlink(root, dir); const tmp = `${dst}.${process.pid}.${crypto.randomUUID()}.tmp`; try { writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 }); const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } lifecycle?.assertWrite();renameSync(tmp, dst); chmodSync(dst, 0o600); const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } finally { rmSync(tmp, { force: true }); } },
    remove(key: string): void { lifecycle?.assertWrite();rmSync(file(key), { force: true }); },
  };
}
export function scopedStorage(dataRoot:string,id:string,lifecycle?:LifecycleCapability):ScopedStorage{if(!/^[a-z][a-z0-9-]{0,63}$/.test(id))throw new ExtensionPolicyError("VERTICAL_ID_INVALID","扩展 id 非法");mkdirSync(dataRoot,{recursive:true,mode:0o700});const canonicalDataRoot=realpathSync(dataRoot),root=resolve(canonicalDataRoot,"verticals",id);mkdirSync(root,{recursive:true,mode:0o700});assertNoSymlink(canonicalDataRoot,root);return scopedStorageAt(root,lifecycle);}
interface SchedulerJobState { timer?: ReturnType<typeof setTimeout>; abort: AbortController; intervalMs: number; running: boolean; consecutiveFailures: number; lastFailureAt?: string; lastSuccessAt?: string; nextRunAt?: string }
export class SchedulerScope implements ScopedScheduler {
  private controllers = new Map<string, SchedulerJobState>();
  private closed = false;
  constructor(private readonly owner: string, private readonly onError: (error: unknown) => void, private readonly options: { minIntervalMs?: number; maxBackoffMs?: number } = {}) {}
  every(id: string, intervalMs: number, job: (signal: AbortSignal) => Promise<void> | void): void {
    if (this.closed) throw new ExtensionPolicyError("VERTICAL_STOPPED", "扩展已停止，不能注册调度");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || intervalMs < (this.options.minIntervalMs ?? 1_000)) throw new ExtensionPolicyError("VERTICAL_SCHEDULE_INVALID", "调度声明非法");
    if (this.controllers.has(id)) throw new ExtensionPolicyError("VERTICAL_SCHEDULE_DUPLICATE", `${this.owner}/${id} 重复`);
    const state: SchedulerJobState = { abort: new AbortController(), intervalMs, running: false, consecutiveFailures: 0 };
    const schedule = (delayMs: number) => { if (this.closed || state.abort.signal.aborted) return; state.nextRunAt = new Date(Date.now() + delayMs).toISOString(); state.timer = setTimeout(run, delayMs); state.timer.unref?.(); };
    const run = async () => { if (state.running || state.abort.signal.aborted) return; state.running = true; state.nextRunAt = undefined; let delay = intervalMs; try { await job(state.abort.signal); state.consecutiveFailures = 0; state.lastSuccessAt = new Date().toISOString(); } catch (e) { state.consecutiveFailures++; state.lastFailureAt = new Date().toISOString(); delay = schedulerRetryDelay(intervalMs, state.consecutiveFailures, this.options.maxBackoffMs); this.onError(e); } finally { state.running = false; schedule(delay); } };
    this.controllers.set(id, state); schedule(intervalMs);
  }
  health(): { ok: boolean; jobs: Record<string, { running: boolean; consecutiveFailures: number; lastFailureAt?: string; lastSuccessAt?: string; nextRunAt?: string }> } { const jobs = Object.fromEntries([...this.controllers].map(([id, s]) => [id, { running: s.running, consecutiveFailures: s.consecutiveFailures, lastFailureAt: s.lastFailureAt, lastSuccessAt: s.lastSuccessAt, nextRunAt: s.nextRunAt }])); return { ok: Object.values(jobs).every((job) => job.consecutiveFailures === 0), jobs }; }
  stop(): void { this.closed = true; for (const { timer, abort } of this.controllers.values()) { abort.abort(); if (timer) clearTimeout(timer); } this.controllers.clear(); }
}
export function schedulerRetryDelay(intervalMs: number, consecutiveFailures: number, maxBackoffMs = 300_000): number { return Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(10, Math.max(0, consecutiveFailures))); }
export function buildVerticalContext(input: { manifest: VerticalManifest; dataRoot: string; config: Record<string, unknown>; sessionFactory?: (roots: string[]) => ScopedSessions; taskFactory?: (roots: string[], capabilities: readonly string[]) => ScopedTasks; actionFactory?: (verticalId: string) => ScopedActions; llmFactory?: (verticalId: string) => ScopedLlm; sourceFactory?: (verticalId: string) => ScopedSources; logger: (operation: string, message: string) => void; scheduler: SchedulerScope;lifecycle?:LifecycleCapability }): VerticalContext {
  const { manifest } = input, caps = new Set(manifest.capabilities ?? []), roots = Object.freeze([...(manifest.roots ?? [])]);
  const lifecycle=input.lifecycle??new LifecycleCapability("vertical",manifest.id),guard=<T extends(...args:any[])=>any>(fn:T):T=>((...args:any[])=>{lifecycle.assertWrite();return fn(...args)}) as T;
  const ctx: VerticalContext = { id: manifest.id, config: deepFreeze(structuredClone(input.config)), log: input.logger };
  if (caps.has("storage")) (ctx as any).storage = scopedStorage(input.dataRoot, manifest.id,lifecycle);
  if (caps.has("scheduler")) (ctx as any).scheduler = Object.freeze({every:guard(input.scheduler.every.bind(input.scheduler))});
  if (caps.has("sessions")) { if (!input.sessionFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Session Service 不可用");const raw=input.sessionFactory(roots as string[]);(ctx as any).sessions=Object.freeze({create:guard(raw.create.bind(raw)),adopt:guard(raw.adopt.bind(raw)),send:guard(raw.send.bind(raw)),interrupt:guard(raw.interrupt.bind(raw)),state:raw.state.bind(raw)}); }
  if(caps.has("tasks:full-access")&&!caps.has("tasks"))throw new ExtensionPolicyError("VERTICAL_CAPABILITY_NOT_GRANTED","tasks:full-access 依赖 tasks");
  if (caps.has("tasks")) { if (!input.taskFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Task Service 不可用"); if (!roots.length) throw new ExtensionPolicyError("VERTICAL_ROOT_NOT_GRANTED", "Task capability 必须声明 root");const raw=input.taskFactory(roots as string[],[...caps]);(ctx as any).tasks=Object.freeze({startWork:guard(raw.startWork.bind(raw)),list:raw.list.bind(raw)}); }
  if (caps.has("actions")) { if (!input.actionFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Action Service 不可用");const raw=input.actionFactory(manifest.id);(ctx as any).actions=Object.freeze({list:raw.list.bind(raw),open:guard(raw.open.bind(raw)),resolve:guard(raw.resolve.bind(raw)),dismiss:guard(raw.dismiss.bind(raw))}); }
  if (caps.has("llm")) { if (!input.llmFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Decision Model Service 不可用");const raw=input.llmFactory(manifest.id);(ctx as any).llm=Object.freeze({complete:guard(raw.complete.bind(raw)),engines:raw.engines.bind(raw)}); }
  if (caps.has("sources")) { if (!input.sourceFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Source Service 不可用");const raw=input.sourceFactory(manifest.id);(ctx as any).sources=Object.freeze({status:raw.status.bind(raw),inspect:raw.inspect.bind(raw),fetch:raw.fetch.bind(raw)}); }
  for (const cap of ["events", "notify"] as const) if (caps.has(cap)) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", `${cap} Service 尚未开放`);
  if (caps.has("vault")) { if (!manifest.vault) throw new ExtensionPolicyError("VERTICAL_VAULT_UNDECLARED", "Vault capability 未声明 scope"); (ctx as any).vault = Object.freeze({ scopes: Object.freeze([...manifest.vault.scopes]), sensitivity: manifest.vault.sensitivity }); }
  return Object.freeze(ctx);
}
