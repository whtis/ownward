import { chmodSync, existsSync, lstatSync, unlinkSync } from "fs";
import { RunnerCommandJournal, RunnerEventJournal, type RunnerCommandRecord } from "./journals.ts";
import { capabilityMatches, ensureRunnerCapability, runnerPaths } from "./capability.ts";
import { encodeRunnerFrame, parseRunnerRequestBody, RunnerFrameDecoder, RUNNER_API_VERSION, type RunnerEnvelope } from "./protocol.ts";
import { acquireRunnerInstanceLock, type RunnerInstanceLock } from "./instance-lock.ts";
import { reconcileRunnerStartup } from "./startup-reconcile.ts";
import { emitCoreLog } from "../kernel/observability/contracts.ts";

export type ProviderEventInput = Parameters<RunnerEventJournal["append"]>[0] & { durability?: "critical" | "best-effort" };
export interface RunnerProvider {
  readonly id?: string;
  readonly version?: string;
  readonly capabilities?: ReadonlySet<string>;
  execute(command: RunnerCommandRecord, input: string): AsyncIterable<ProviderEventInput>;
  readHistory?(input: { nativeRef: string; providerHome?: string; cwd?: string }): Promise<RunnerHistoryMessage[]> | RunnerHistoryMessage[];
  /** normalized event 无法 durable 时立即收回 Provider 所有权，不能让未观察到的 turn 继续跑。 */
  abort?(command: RunnerCommandRecord, reason: "event-journal-unavailable" | "no-progress" | "provider-error"): Promise<void> | void;
  shutdown?(): Promise<void> | void;
  getMetrics?(): Record<string, number>;
}
export type RunnerHistoryMessage = { role: "user" | "assistant" | "tool" | "system"; text: string; name?: string; ts?: string };
export type RunnerProviderResolver = (providerId: string) => RunnerProvider;
type Connection = { decoder: RunnerFrameDecoder; chain: Promise<void>; socket: Bun.Socket<Connection>; outgoing: Uint8Array[]; offset: number; queuedBytes: number; authed: boolean; watches: Set<string> };
export const RUNNER_MAX_OUTGOING_BYTES = 2 * 1024 * 1024;
export type RunnerMetrics = { eventsAttempted: number; observationalAppended: number; observationalDropped: number; pushDropped: number; criticalAppendFailures: number; providerTimeouts: number; appendLatencyMsTotal: number; appendLatencyMsMax: number };
export type ProviderHealthDTO = { id:string; version:string; state:"ready"|"degraded"; lastSuccessAt:string|null; lastFailureAt:string|null; errorClass:string|null; queueDepth:{value:null;applicable:false;reason:"provider-executes-directly"}; activeDepth:{value:number;applicable:true}; capabilities:string[]; metrics:Record<string,number> };

const runnerEventId = (label: string, commandId: string) => `${label}:${new Bun.CryptoHasher("sha256").update(commandId).digest("hex").slice(0, 32)}`;
const terminal = (type: string) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(type);
const BEST_EFFORT_EVENT_TYPES = new Set(["delta", "usage", "provider-notice"]);
const CRITICAL_EVENT_TYPES = new Set(["started", "message-completed", "session-updated", "approval-requested", "completed", "failed", "interrupted", "unknown-outcome"]);
function eventDurability(type: string): "critical" | "best-effort" {
  if (BEST_EFFORT_EVENT_TYPES.has(type)) return "best-effort";
  if (CRITICAL_EVENT_TYPES.has(type)) return "critical";
  throw Object.assign(new Error(`Provider event type 未分类: ${type}`), { code: "PROVIDER_PROTOCOL_ERROR" });
}
const errorReason = (error: unknown) => {
  const mapping: Record<string, import("./journals.ts").RunnerReasonCode> = {
    PROVIDER_CAPABILITY_UNSUPPORTED: "unsupported_command", PROVIDER_SESSION_NOT_FOUND: "provider_unavailable",
    PROVIDER_SESSION_BUSY: "provider_busy", PROVIDER_APPROVAL_STALE: "approval_stale", PROVIDER_RUN_NOT_ACTIVE: "run_not_active",
    PROVIDER_NO_ACK: "provider_no_ack", PROVIDER_INPUT_INVALID: "provider_input_invalid", PROVIDER_CWD_INVALID: "provider_input_invalid",
    PROVIDER_UNAVAILABLE: "provider_unavailable", PROVIDER_NO_PROGRESS: "provider_no_progress", PROVIDER_PROTOCOL_ERROR: "provider_protocol_error",
  };
  const code = typeof (error as any)?.code === "string" ? (error as any).code : "";
  if (mapping[code]) return mapping[code];
  emitCoreLog({ event: "runner-provider-error-unmapped", moduleType: "provider", moduleId: "unknown", operation: "classify-error", errorClass: code || "NO_CODE", msg: "provider error mapped to protocol error" });
  return "provider_protocol_error" as const;
};

const response = (request: RunnerEnvelope, kind: "accepted" | "command-status" | "ok" | "error" | "pong", body: Record<string, unknown>): RunnerEnvelope => ({
  runnerApiVersion: RUNNER_API_VERSION, envelope: "response", requestId: request.requestId, capability: request.capability, kind, body,
});

export class RunnerServer {
  private listener?: Bun.UnixSocketListener<Connection>;
  private capability = "";
  private instanceLock?: RunnerInstanceLock;
  private readonly commands: RunnerCommandJournal;
  private readonly events: RunnerEventJournal;
  private readonly connections = new Set<Connection>();
  private readonly active = new Map<string, { command: RunnerCommandRecord; promise: Promise<void> }>();
  private readonly providers = new Set<RunnerProvider>();
  private readonly providerObservations = new Map<string,{lastSuccessAt:string|null;lastFailureAt:string|null;errorClass:string|null}>();
  readonly metrics: RunnerMetrics = { eventsAttempted: 0, observationalAppended: 0, observationalDropped: 0, pushDropped: 0, criticalAppendFailures: 0, providerTimeouts: 0, appendLatencyMsTotal: 0, appendLatencyMsMax: 0 };
  private draining = false;
  constructor(readonly dataRoot: string, private readonly resolveProvider: RunnerProviderResolver, private readonly hooks: { beforeDispatchAppend?: () => void; beforeShutdownUnknownAppend?: () => void; providerNoProgressMs?: number } = {}) {
    this.commands = new RunnerCommandJournal(dataRoot); this.events = new RunnerEventJournal(dataRoot);
  }
  registerProvider(provider:RunnerProvider):void{this.providers.add(provider);const id=provider.id??"unknown";if(!this.providerObservations.has(id))this.providerObservations.set(id,{lastSuccessAt:null,lastFailureAt:null,errorClass:null});}
  providerHealth():ProviderHealthDTO[]{return[...this.providers].map(provider=>{const id=provider.id??"unknown",observation=this.providerObservations.get(id)??{lastSuccessAt:null,lastFailureAt:null,errorClass:null},active=[...this.active.values()].filter(entry=>entry.command.providerId===id).length;return{id,version:provider.version??"1.0.0",state:observation.errorClass?"degraded":"ready",...observation,queueDepth:{value:null,applicable:false,reason:"provider-executes-directly"},activeDepth:{value:active,applicable:true},capabilities:[...(provider.capabilities??[])].sort(),metrics:provider.getMetrics?.()??{}};});}
  start(): void {
    const paths = runnerPaths(this.dataRoot);
    this.instanceLock = acquireRunnerInstanceLock(this.dataRoot);
    try { this.capability = ensureRunnerCapability(this.dataRoot); const recovery = reconcileRunnerStartup(this.dataRoot); if (recovery.diagnostics.acceptedWithoutDispatch || recovery.diagnostics.recoveredUnknownOutcome) emitCoreLog({event:"runner-startup-reconcile",moduleType:"runner",moduleId:"session-runner",operation:"recovery",msg:`acceptedWithoutDispatch=${recovery.diagnostics.acceptedWithoutDispatch} recoveredUnknownOutcome=${recovery.diagnostics.recoveredUnknownOutcome}`}); if (existsSync(paths.socket)) { const stat = lstatSync(paths.socket); if (!stat.isSocket()) throw new Error("拒绝清理非 socket 的 runner.sock"); unlinkSync(paths.socket); } }
    catch (error) {
      this.listener?.stop(true); this.listener = undefined;
      if (existsSync(paths.socket) && lstatSync(paths.socket).isSocket()) unlinkSync(paths.socket);
      this.instanceLock.release(); this.instanceLock = undefined; throw error;
    }
    const owner = this;
    try { this.listener = Bun.listen<Connection>({ unix: paths.socket, socket: {
      binaryType: "buffer",
      open(socket) { const connection: Connection = { decoder: new RunnerFrameDecoder(), chain: Promise.resolve(), socket, outgoing: [], offset: 0, queuedBytes: 0, authed: false, watches: new Set() }; socket.data = connection; owner.connections.add(connection); },
      data(socket, bytes) {
        let frames: RunnerEnvelope[];
        try { frames = socket.data.decoder.push(bytes); } catch (error: any) { emitCoreLog({event:"runner-frame-rejected",moduleType:"runner",moduleId:"session-runner",operation:"ipc-decode",errorClass:error?.code||"RUNNER_FRAME_INVALID",msg:"invalid IPC frame rejected"}); socket.close(); return; }
        for (const frame of frames) socket.data.chain = socket.data.chain.then(() => owner.handle(socket.data, frame)).catch(() => socket.close());
      },
      drain(socket) { owner.flush(socket.data); }, close(socket) { owner.connections.delete(socket.data); }, error(socket) { owner.connections.delete(socket.data); socket.close(); },
    }}); chmodSync(paths.socket, 0o600); }
    catch (error) { this.listener?.stop(true); this.listener = undefined; if (existsSync(paths.socket) && lstatSync(paths.socket).isSocket()) unlinkSync(paths.socket); this.instanceLock.release(); this.instanceLock = undefined; throw error; }
  }
  stop(): void { this.listener?.stop(true); this.listener = undefined; this.cleanupSocketAndLock(); }
  async shutdown(timeoutMs = 5_000): Promise<void> {
    emitCoreLog({ event: "runner-shutdown-started", moduleType: "runner", moduleId: "session-runner", operation: "shutdown", msg: `active=${this.active.size}` });
    this.draining = true;
    this.listener?.stop(false); this.listener = undefined;
    const pending = [...this.active.values()].map((entry) => entry.promise).concat([...this.connections].map((connection) => connection.chain));
    await Promise.race([Promise.allSettled(pending), Bun.sleep(timeoutMs)]);
    const failures: string[] = [];
    if (this.active.size) for (const { command } of this.active.values()) {
      let appended = false;
      for (let attempt = 0; attempt < 3 && !appended; attempt++) try { this.hooks.beforeShutdownUnknownAppend?.(); this.events.append({ eventId: runnerEventId("shutdown-unknown", command.commandId), type: "unknown-outcome", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, reason: "runner_lost_ownership" }); appended = true; } catch {
        try { const history = this.events.readStrict().filter((event) => event.commandId === command.commandId); if (history.some((event) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(event.type))) { appended = true; break; } } catch {}
        if (attempt < 2) await Bun.sleep(10);
      }
      if (!appended) { failures.push(command.commandId); emitCoreLog({ event: "runner-shutdown-terminal-failed", moduleType: "runner", moduleId: "session-runner", operation: "journal-append", runId: command.runId, sessionId: command.sessionId, eventId: command.commandId, errorClass: "RUNNER_SHUTDOWN_JOURNAL_FAILED", msg: "unknown outcome could not be persisted" }); }
    }
    const providerShutdowns = [...this.providers].map(async (provider) => { try { await provider.shutdown?.(); } catch (error) { emitCoreLog({ event: "runner-provider-shutdown-failed", moduleType: "provider", moduleId: provider.id ?? "unknown", operation: "shutdown", errorClass: (error as any)?.code || "UNKNOWN", msg: "provider shutdown failed" }); } });
    await Promise.allSettled(providerShutdowns);
    for (const connection of this.connections) connection.socket.close(); this.cleanupSocketAndLock();
    if (failures.length) throw Object.assign(new Error(`shutdown unknown-outcome 持久化失败: ${failures.join(",")}`), { code: "RUNNER_SHUTDOWN_JOURNAL_FAILED", commandIds: failures });
    emitCoreLog({ event: "runner-shutdown-completed", moduleType: "runner", moduleId: "session-runner", operation: "shutdown", msg: "runner shutdown completed" });
  }
  private cleanupSocketAndLock(): void { const socket = runnerPaths(this.dataRoot).socket; if (existsSync(socket) && lstatSync(socket).isSocket()) unlinkSync(socket); this.instanceLock?.release(); this.instanceLock = undefined; }
  private write(connection: Connection, envelope: RunnerEnvelope, bestEffort = false): boolean {
    try {
      const frame = encodeRunnerFrame(envelope); if (connection.queuedBytes + frame.byteLength > RUNNER_MAX_OUTGOING_BYTES) { if (bestEffort) return false; connection.socket.close(); return false; }
      connection.outgoing.push(frame); connection.queuedBytes += frame.byteLength; this.flush(connection); return true;
    } catch { if (!bestEffort) connection.socket.close(); return false; }
  }
  private flush(connection: Connection): void {
    while (connection.outgoing.length) {
      const frame = connection.outgoing[0]!, written = connection.socket.write(frame, connection.offset, frame.byteLength - connection.offset);
      if (written < 0) { connection.socket.close(); return; } if (written === 0) return;
      connection.offset += written; connection.queuedBytes -= written; if (connection.offset < frame.byteLength) return; connection.outgoing.shift(); connection.offset = 0;
    }
  }
  private async handle(connection: Connection, request: RunnerEnvelope): Promise<void> {
    if (request.envelope !== "request") throw new Error("Runner server 只接受 request");
    if (!capabilityMatches(this.capability, request.capability)) { this.write(connection, response(request, "error", { code: "RUNNER_UNAUTHORIZED", message: "capability 无效" })); connection.socket.close(); return; }
    connection.authed = true;
    let body;
    try { body = parseRunnerRequestBody(request); } catch (error) { const code = (error as any)?.code === "RUNNER_INPUT_TOO_LARGE" ? "RUNNER_INPUT_TOO_LARGE" : "RUNNER_REQUEST_INVALID"; this.write(connection, response(request, "error", { code, message: error instanceof Error ? error.message : "request 非法" })); return; }
    if (request.kind === "ping") { this.write(connection, response(request, "pong", { pid: process.pid, runnerApiVersion: RUNNER_API_VERSION, capabilities: ["quiesce", "resume"], buildIdentity: process.env.OWNWARD_RUNNER_BUILD_IDENTITY || "0".repeat(64), draining: this.draining, activeRuns: [...this.active.keys()], metrics: { ...this.metrics }, providers:this.providerHealth(), providerMetrics: Object.fromEntries([...this.providers].map((provider) => [provider.id ?? "unknown", provider.getMetrics?.() ?? {}])) })); return; }
    if (request.kind === "quiesce") { this.draining = true; this.write(connection, response(request, "accepted", { draining: true, activeRuns: [...this.active.keys()] })); return; }
    if (request.kind === "resume") { this.draining = false; this.write(connection, response(request, "accepted", { draining: false, activeRuns: [...this.active.keys()] })); return; }
    if (request.kind === "query-command") {
      const query = body as { commandId: string; afterSequence?: number; limit?: number }, command = this.commands.find(query.commandId), after = query.afterSequence ?? 0, limit = query.limit ?? 100;
      const all = command ? this.events.readStrict().filter((event) => event.commandId === command.commandId && event.sequence > after) : [], events = all.slice(0, limit), truncated = all.length > events.length;
      connection.watches.add(query.commandId); this.write(connection, response(request, "command-status", { found: !!command, command: command ?? null, events, truncated, nextSequence: events.at(-1)?.sequence ?? after })); return;
    }
    if (request.kind === "read-history") {
      const query = body as { providerId: string; nativeRef: string; providerHome?: string; cwd?: string };
      try {
        const provider = this.resolveProvider(query.providerId); this.registerProvider(provider);
        if (!provider.readHistory) throw Object.assign(new Error("Provider 不支持读取历史"), { code: "PROVIDER_CAPABILITY_UNSUPPORTED" });
        const messages = await provider.readHistory(query);
        this.write(connection, response(request, "ok", { messages }));
      } catch (error: any) { this.write(connection, response(request, "error", { code: error?.code || "RUNNER_HISTORY_UNAVAILABLE", message: error instanceof Error ? error.message : "历史读取失败" })); }
      return;
    }
    const b = body as any;
    if (this.draining) { this.write(connection, response(request, "error", { code: "RUNNER_DRAINING", message: "Runner 正在 drain，拒绝新命令" })); return; }
    const kind = request.kind === "interrupt" ? "interrupt" : request.kind === "approval-response" ? "approval-response" : b.kind;
    if (!["start-run", "resume-run", "send-input", "interrupt", "approval-response", "add-dir", "set-access", "new-session"].includes(kind)) { this.write(connection, response(request, "error", { code: "RUNNER_COMMAND_UNSUPPORTED", message: `不支持 ${kind}` })); return; }
    let provider: RunnerProvider;
    try { provider = this.resolveProvider(b.providerId); this.registerProvider(provider); }
    catch (error) { this.write(connection, response(request, "error", { code: "RUNNER_PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : "Provider 未注册" })); return; }
    let accepted;
    try { accepted = this.commands.accept({ commandId: b.commandId, kind, runId: b.runId, sessionId: b.sessionId, providerId: b.providerId, ...(b.approvalRequestId ? { approvalRequestId: b.approvalRequestId } : {}), ...(b.input !== undefined ? { input: b.input } : {}) }); }
    catch (error: any) { const code = error?.code === "RUNNER_JOURNAL_BUSY" ? "RUNNER_COMMAND_JOURNAL_BUSY" : /冲突/.test(String(error?.message)) ? "RUNNER_COMMAND_CONFLICT" : "RUNNER_COMMAND_JOURNAL_UNAVAILABLE"; this.write(connection, response(request, "error", { code, message: error instanceof Error ? error.message : "command 拒绝" })); return; }
    let dispatching;
    try { this.hooks.beforeDispatchAppend?.(); dispatching = this.events.append({ eventId: `dispatching:${new Bun.CryptoHasher("sha256").update(accepted.record.commandId).digest("hex")}`, type: "dispatching", at: new Date().toISOString(), commandId: accepted.record.commandId, runId: accepted.record.runId, sessionId: accepted.record.sessionId, providerId: accepted.record.providerId }); }
    catch (error: any) { const code = error?.code === "RUNNER_JOURNAL_BUSY" ? "RUNNER_DISPATCH_JOURNAL_BUSY" : "RUNNER_DISPATCH_JOURNAL_UNAVAILABLE"; this.write(connection, response(request, "error", { code, message: "dispatching journal 硬闸失败" })); return; }
    // 这里只确认 command + dispatching 已 durable；Provider 是否真正处理必须查询 terminal event。
    // interrupt/approval 也不能用 `ok` 伪装 Provider 已接受或审批仍有效。
    connection.watches.add(accepted.record.commandId); this.write(connection, response(request, "accepted", { commandId: accepted.record.commandId, appended: accepted.appended }));
    if (dispatching.appended) queueMicrotask(() => { const promise = this.execute(provider, accepted.record, b.input); this.active.set(accepted.record.commandId, { command: accepted.record, promise }); void promise.then(() => this.active.delete(accepted.record.commandId), (error) => { try { if (this.events.readStrict().some((e) => e.commandId === accepted.record.commandId && ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type))) this.active.delete(accepted.record.commandId); } catch { /* 读不到 journal 就留在 active，shutdown 兜底收敛 */ } /* 已写终态的 reject 必须出 active：留着会经 ping.activeRuns 挡住该命令的显式 drain；未写终态的必须留下等 shutdown 收敛 unknown-outcome */ emitCoreLog({ event: "runner-command-execution-unrecoverable", moduleType: "runner", moduleId: "session-runner", operation: "execute", runId: accepted.record.runId, sessionId: accepted.record.sessionId, eventId: accepted.record.commandId, errorClass: (error as any)?.code || "UNKNOWN", msg: "command execution rejected outside recovery boundary" }); }); });
  }
  private async execute(provider: RunnerProvider, command: RunnerCommandRecord, input: string): Promise<void> {
    const iterator = provider.execute(command, input)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await this.nextProviderEvent(iterator, provider, command); if (next.done) break;
        const { durability: declaredDurability, ...event } = next.value, durability = eventDurability(event.type);
        if (declaredDurability && declaredDurability !== durability) throw Object.assign(new Error(`Provider event durability 与 type 冲突: ${event.type}`), { code: "PROVIDER_PROTOCOL_ERROR" });
        this.metrics.eventsAttempted++; const startedAt = performance.now();
        try {
          const saved = this.events.append(event).record, latency = performance.now() - startedAt;
          this.metrics.appendLatencyMsTotal += latency; this.metrics.appendLatencyMsMax = Math.max(this.metrics.appendLatencyMsMax, latency);
          if (durability === "best-effort") this.metrics.observationalAppended++;
          const observed=this.providerObservations.get(provider.id??command.providerId);if(observed&&event.type==="completed"){observed.lastSuccessAt=new Date().toISOString();observed.errorClass=null;}else if(observed&&["failed","unknown-outcome"].includes(event.type)){observed.lastFailureAt=new Date().toISOString();observed.errorClass=typeof(event as any).reason==="string"?(event as any).reason:"PROVIDER_RUNTIME_ERROR";}
          this.push(saved);
        }
        catch (journalError) {
          if (durability === "best-effort") {
            this.metrics.observationalDropped++;
            emitCoreLog({event:"runner-observational-event-dropped",moduleType:"runner",moduleId:"session-runner",operation:"journal-append",runId:command.runId,sessionId:command.sessionId,eventId:event.eventId,errorClass:(journalError as any)?.code||"JOURNAL_UNAVAILABLE",msg:`best-effort ${event.type} dropped`});
            continue;
          }
          this.metrics.criticalAppendFailures++;
          // Provider 已越过副作用边界后，事件落盘失败不能伪装成普通 provider failure。
          // 先终止/脱钩 Provider，再尽力收敛 unknown-outcome；两者都不触发 replay。
          await this.safeAbort(provider, command, "event-journal-unavailable");
          try { await iterator.return?.(); } catch (error) { emitCoreLog({ event: "runner-provider-iterator-return-failed", moduleType: "provider", moduleId: provider.id ?? command.providerId, operation: "abort", runId: command.runId, sessionId: command.sessionId, eventId: command.commandId, errorClass: (error as any)?.code || "UNKNOWN", msg: "provider iterator did not close" }); }
          await this.appendTerminalWithRetry(command, "unknown-outcome", "runner_lost_ownership", "critical-event-journal-failed");
          return;
        }
      }
      const prior = this.events.readStrict().filter((event) => event.commandId === command.commandId);
      if (!prior.some((event) => terminal(event.type))) await this.appendTerminalWithRetry(command, "failed", "provider_exit", "provider-eof");
    } catch (error) {
      const observed=this.providerObservations.get(provider.id??command.providerId);if(observed){observed.lastFailureAt=new Date().toISOString();observed.errorClass=typeof(error as any)?.code==="string"?(error as any).code:"PROVIDER_RUNTIME_ERROR";}emitCoreLog({event:"provider-command-failed",moduleType:"provider",moduleId:provider.id??command.providerId,operation:"execute",runId:command.runId,sessionId:command.sessionId,eventId:command.commandId,errorClass:observed?.errorClass,msg:"provider command failed"});
      await this.safeAbort(provider, command, (error as any)?.code === "PROVIDER_NO_PROGRESS" ? "no-progress" : "provider-error");
      let prior; try { prior = this.events.readStrict().filter((event) => event.commandId === command.commandId); } catch (journalError) { emitCoreLog({ event: "runner-event-journal-read-failed", moduleType: "runner", moduleId: "session-runner", operation: "journal-read", runId: command.runId, sessionId: command.sessionId, eventId: command.commandId, errorClass: (journalError as any)?.code || "UNKNOWN", msg: "terminal reconciliation journal read failed" }); throw journalError; }
      if (!prior.some((event) => terminal(event.type))) {
        const reason = errorReason(error); await this.appendTerminalWithRetry(command, reason === "provider_no_progress" ? "unknown-outcome" : "failed", reason, "provider-error");
      }
    } finally { try { await iterator.return?.(); } catch {} }
  }
  private async nextProviderEvent(iterator: AsyncIterator<ProviderEventInput>, provider: RunnerProvider, command: RunnerCommandRecord): Promise<IteratorResult<ProviderEventInput>> {
    const timeoutMs = this.hooks.providerNoProgressMs;
    // 普通 Claude 工具调用可以长时间没有 normalized event。没有可靠 Provider heartbeat 时，默认无限等待。
    if (!timeoutMs || timeoutMs <= 0) return iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<ProviderEventInput>>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Provider 长时间无 normalized event"), { code: "PROVIDER_NO_PROGRESS" })), timeoutMs); }),
      ]);
    } catch (error) {
      if ((error as any)?.code === "PROVIDER_NO_PROGRESS") this.metrics.providerTimeouts++;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  private async safeAbort(provider: RunnerProvider, command: RunnerCommandRecord, reason: "event-journal-unavailable" | "no-progress" | "provider-error"): Promise<void> {
    try { await provider.abort?.(command, reason); }
    catch (error) { emitCoreLog({ event: "runner-provider-abort-failed", moduleType: "provider", moduleId: provider.id ?? command.providerId, operation: "abort", runId: command.runId, sessionId: command.sessionId, eventId: command.commandId, errorClass: (error as any)?.code || "UNKNOWN", msg: `provider abort failed reason=${reason}` }); }
  }
  private async appendTerminalWithRetry(command: RunnerCommandRecord, type: "failed" | "unknown-outcome", reason: import("./journals.ts").RunnerReasonCode, label: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = this.events.append({ eventId: runnerEventId(label, command.commandId), type, at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, reason }).record; this.push(saved); return;
      } catch (error) {
        if (attempt < 2) { await Bun.sleep(10); continue; }
        emitCoreLog({ event: "runner-terminal-append-failed", moduleType: "runner", moduleId: "session-runner", operation: "journal-append", runId: command.runId, sessionId: command.sessionId, eventId: command.commandId, errorClass: (error as any)?.code || "JOURNAL_UNAVAILABLE", msg: `terminal=${type} reason=${reason} attempts=3` });
        throw error;
      }
    }
  }
  private push(event: unknown): void {
    const commandId = (event as { commandId?: unknown }).commandId;
    for (const connection of this.connections) if (connection.authed && typeof commandId === "string" && connection.watches.has(commandId)) if (!this.write(connection, { runnerApiVersion: RUNNER_API_VERSION, envelope: "push", requestId: `push-${crypto.randomUUID()}`, capability: this.capability, kind: "run-event", body: { event } }, true)) this.metrics.pushDropped++;
  }
}
