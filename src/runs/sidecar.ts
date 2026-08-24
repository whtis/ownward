import { createHash, randomUUID } from "crypto";
import { SessionRepository } from "../sessions/repository.ts";
import { DATA, log } from "../util.ts";
import { RunRepository, type RunEvent } from "./repository.ts";

export type RunSidecarOutcome = "completed" | "failed" | "interrupted";
export interface RunSidecarHandle { readonly commandId: string; readonly runId: string; readonly taskId: string; readonly sessionId: string; readonly providerId: string; active: boolean; dispatching: boolean; started: boolean; terminal: boolean; }
export interface RunSidecarDiagnostic { component: "run-sidecar"; operation: "accept" | "dispatch" | "start" | "terminal"; providerId: string; taskFingerprint: string; errorClass: string; }
export interface RunSidecarDeps { dataRoot?: string; repository?: Pick<RunRepository, "append">; now?: () => string; uuid?: () => string; diagnostic?: (entry: RunSidecarDiagnostic) => void; identity?: { cwd: string; control?: "ownward" | "observing" | "external" }; }
export class RunDispatchJournalUnavailableError extends Error {
  readonly code = "RUN_DISPATCH_JOURNAL_UNAVAILABLE";
  constructor() { super("Run dispatch journal unavailable; Provider dispatch was not attempted"); this.name = "RunDispatchJournalUnavailableError"; }
}
const fingerprint = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 12);
const defaultDiagnostic = (entry: RunSidecarDiagnostic) => log(JSON.stringify(entry));
function sessionId(dataRoot: string, taskId: string, providerId: string, identity?: RunSidecarDeps["identity"]): string {
  const repo = new SessionRepository(dataRoot), existing = repo.getByTaskId(taskId);
  if (existing) return existing.id;
  if (identity && (providerId === "claude" || providerId === "codex")) return repo.reserve({ taskId, providerId, cwd: identity.cwd, control: identity.control }).id;
  return taskId; // 仅供纯仓库调用；实际 Provider 接入一律传 identity 并先 reserve。
}
function base(h: RunSidecarHandle, eventId: string, at: string) { return { schemaVersion: 1 as const, eventId, at, commandId: h.commandId, runId: h.runId, taskId: h.taskId, sessionId: h.sessionId, providerId: h.providerId }; }

/** 阶段 2 旁路：旧 Task 状态仍是权威。故障只留无敏感诊断，绝不能阻止 Provider turn。 */
export function acceptRunSidecar(taskId: string, providerId: string, deps: RunSidecarDeps = {}): RunSidecarHandle {
  const dataRoot = deps.dataRoot ?? DATA, uuid = deps.uuid ?? randomUUID, now = deps.now ?? (() => new Date().toISOString());
  let canonical = taskId;
  try { canonical = sessionId(dataRoot, taskId, providerId, deps.identity); }
  catch (error) {
    const h: RunSidecarHandle = { commandId: uuid(), runId: uuid(), taskId, sessionId: taskId, providerId, active: false, dispatching: false, started: false, terminal: false };
    (deps.diagnostic ?? defaultDiagnostic)({ component: "run-sidecar", operation: "accept", providerId, taskFingerprint: fingerprint(taskId), errorClass: error instanceof Error ? error.constructor.name : "UnknownError" });
    return h;
  }
  const h: RunSidecarHandle = { commandId: uuid(), runId: uuid(), taskId, sessionId: canonical, providerId, active: false, dispatching: false, started: false, terminal: false };
  try {
    const repo = deps.repository ?? new RunRepository(dataRoot);
    repo.append({ ...base(h, uuid(), now()), type: "command-accepted" });
    h.active = true;
  } catch (error) {
    (deps.diagnostic ?? defaultDiagnostic)({ component: "run-sidecar", operation: "accept", providerId, taskFingerprint: fingerprint(taskId), errorClass: error instanceof Error ? error.constructor.name : "UnknownError" });
  }
  return h;
}

/** 必须紧贴 Provider send/spawn 前调用：从此刻起，重启后不能证明命令有没有越过投递边界。 */
export function markRunDispatchingSidecar(h: RunSidecarHandle, deps: RunSidecarDeps = {}): RunSidecarHandle {
  if (!h.active || h.dispatching || h.started || h.terminal) return h;
  const uuid = deps.uuid ?? randomUUID, now = deps.now ?? (() => new Date().toISOString());
  try {
    (deps.repository ?? new RunRepository(deps.dataRoot ?? DATA)).append({ ...base(h, uuid(), now()), type: "run-dispatching" });
    h.dispatching = true;
  } catch (error) {
    h.active = false;
    (deps.diagnostic ?? defaultDiagnostic)({ component: "run-sidecar", operation: "dispatch", providerId: h.providerId, taskFingerprint: fingerprint(h.taskId), errorClass: error instanceof Error ? error.constructor.name : "UnknownError" });
  }
  return h;
}

/** dispatching durable append 是 Provider send/spawn 的硬闸；回调绝不能在 accepted/dispatching 失败时执行。 */
export function crossRunDispatchBoundary<T>(h: RunSidecarHandle, dispatch: () => T, deps: RunSidecarDeps = {}): T {
  markRunDispatchingSidecar(h, deps);
  if (!h.active || !h.dispatching || h.started || h.terminal) throw new RunDispatchJournalUnavailableError();
  return dispatch();
}

export function markRunStartedSidecar(h: RunSidecarHandle, deps: RunSidecarDeps = {}): RunSidecarHandle {
  if (!h.active || h.started || h.terminal) return h;
  const uuid = deps.uuid ?? randomUUID, now = deps.now ?? (() => new Date().toISOString());
  try {
    (deps.repository ?? new RunRepository(deps.dataRoot ?? DATA)).append({ ...base(h, uuid(), now()), type: "run-started" });
    h.started = true;
  } catch (error) {
    h.active = false;
    (deps.diagnostic ?? defaultDiagnostic)({ component: "run-sidecar", operation: "start", providerId: h.providerId, taskFingerprint: fingerprint(h.taskId), errorClass: error instanceof Error ? error.constructor.name : "UnknownError" });
  }
  return h;
}

/** 已知同步投递失败写 failed；若进程在结果写入前消失，启动恢复会写 unknown_outcome。 */
export function diagnoseUnstartedRunSidecar(h: RunSidecarHandle, error: unknown, deps: RunSidecarDeps = {}): void {
  (deps.diagnostic ?? defaultDiagnostic)({ component: "run-sidecar", operation: "start", providerId: h.providerId, taskFingerprint: fingerprint(h.taskId), errorClass: error instanceof Error ? error.constructor.name : "UnknownError" });
  if (!h.active || !h.dispatching || h.started || h.terminal) return;
  finishRunSidecar(h, "failed", { reason: "provider_dispatch_failed" }, deps);
}

/** Provider 已经成功接收输入的调用点可用这个合并入口。 */
export function beginRunSidecar(taskId: string, providerId: string, deps: RunSidecarDeps = {}): RunSidecarHandle {
  return markRunStartedSidecar(markRunDispatchingSidecar(acceptRunSidecar(taskId, providerId, deps), deps), deps);
}

export function finishRunSidecar(h: RunSidecarHandle | undefined, outcome: RunSidecarOutcome, options: { exitCode?: number; reason?: string; usage?: { inputTokens?: number; outputTokens?: number } } = {}, deps: RunSidecarDeps = {}): void {
  if (!h?.active || (!h.started && !(h.dispatching && outcome !== "completed")) || h.terminal) return;
  const uuid = deps.uuid ?? randomUUID, now = deps.now ?? (() => new Date().toISOString());
  const type: RunEvent["type"] = outcome === "completed" ? "run-completed" : outcome === "failed" ? "run-failed" : "run-interrupted";
  try {
    const valid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
    const usage = options.usage ? { ...(valid(options.usage.inputTokens) ? { inputTokens: options.usage.inputTokens } : {}), ...(valid(options.usage.outputTokens) ? { outputTokens: options.usage.outputTokens } : {}) } : undefined;
    const hasUsage = usage && Object.keys(usage).length > 0;
    (deps.repository ?? new RunRepository(deps.dataRoot ?? DATA)).append({ ...base(h, uuid(), now()), type, ...(options.exitCode !== undefined ? { providerExitCode: options.exitCode } : {}), ...(options.reason ? { reason: options.reason } : {}), ...(hasUsage ? { usage } : {}) } as RunEvent);
    h.terminal = true;
  } catch (error) {
    (deps.diagnostic ?? defaultDiagnostic)({ component: "run-sidecar", operation: "terminal", providerId: h.providerId, taskFingerprint: fingerprint(h.taskId), errorClass: error instanceof Error ? error.constructor.name : "UnknownError" });
  }
}
