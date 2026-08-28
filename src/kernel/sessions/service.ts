import { appendFileSync, statSync } from "fs";
import { join } from "path";
import { SessionRepository, type SessionRecord } from "../../sessions/repository.ts";
import { readRunJournalStrict, reduceRuns } from "../../runs/repository.ts";
import { parseSessionMigrationMode, type KernelGrantedAccess, type KernelSessionDto, type KernelSessionGrants, type KernelSessionState, type SessionInput, type SessionMutationResult, type SessionService } from "./contracts.ts";
import { expandCodexHome,inputForRunner, KernelSessionPolicyError, projectRunnerEvent, RunnerAgentStateProjector, RunnerSessionConsumer, validateDirectoryGrant } from "./runner-consumer.ts";
import { RunnerCommandJournal, RunnerEventJournal, type RunnerCommandRecord, type RunnerEventRecord } from "../../runner/journals.ts";
import { SessionRunnerBridgeStore, type BridgeCommand } from "./bridge-store.ts";
import { mergeQueued, parseQueued, SessionInputQueueStore, type QueuedView } from "./input-queue.ts";
import { cfg,log } from "../../util.ts";
import { clearInitialHistory, readInitialHistory, readInitialHistorySnapshot, writeInitialHistory } from "./initial-history.ts";
import { buildCodexResumeCommand } from "../../sessions/provider-home.ts";
import { commandSessionImages } from "./session-images.ts";

export type SessionMigrationMode = "off" | "runner";
export interface SessionServiceOptions { mode?: SessionMigrationMode; roots?: string[]; taskIds?: string[]; }
const ACTIVE_SESSION_CONSUMERS = new Map<string, Promise<void>>();
/** 每会话同一时刻只跑一个 flush：漏掉的触发会被下一次轮询/下一轮收尾再叫起来 */
const ACTIVE_QUEUE_DRAINS = new Map<string, Promise<void>>();
export const SESSION_STATE_CACHE_LIMIT=32;
function runnerJournalSignature(dataRoot:string):string{return["events.jsonl","commands.jsonl"].map(name=>{try{const st=statSync(join(dataRoot,"runner",name));return`${st.size}:${st.mtimeMs}`;}catch{return"0:0";}}).join("|");}
export function readStableRunnerSnapshot(dataRoot:string,afterRead:()=>void=()=>{}):{journal:RunnerEventJournal;events:RunnerEventRecord[];commands:Map<string,RunnerCommandRecord>;signature:string}{let last:any;for(let attempt=0;attempt<3;attempt++){const before=runnerJournalSignature(dataRoot),journal=new RunnerEventJournal(dataRoot),events=journal.readStrict(),commands=new Map(new RunnerCommandJournal(dataRoot).readStrict().map(command=>[command.commandId,command]));afterRead();const after=runnerJournalSignature(dataRoot);last={journal,events,commands,signature:`${after}|seq:${events.at(-1)?.sequence??0}|events:${events.length}|commands:${commands.size}`};if(before===after)return last;}return{...last,signature:`unstable:${crypto.randomUUID()}:${last.signature}`};}
class StateLru<K,V> extends Map<K,V>{override get(key:K){const value=super.get(key);if(value!==undefined){super.delete(key);super.set(key,value);}return value;}override set(key:K,value:V){super.delete(key);super.set(key,value);while(this.size>SESSION_STATE_CACHE_LIMIT)super.delete(this.keys().next().value!);return this;}}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }

export class KernelSessionService implements SessionService {
  private readonly repo: SessionRepository; private readonly runner: RunnerSessionConsumer; private readonly bridge: SessionRunnerBridgeStore; private readonly queue: SessionInputQueueStore;
  private readonly stateCache = new StateLru<string, { signature: string; state: KernelSessionState }>();
  private readonly historyMarkers = new Map<string, import("./types.ts").DevMsg>();
  readonly mode: SessionMigrationMode; readonly roots: string[]; readonly taskIds: string[];
  constructor(readonly dataRoot: string, options: SessionServiceOptions = {}, runner?: RunnerSessionConsumer) {
    this.repo = new SessionRepository(dataRoot); this.runner = runner ?? new RunnerSessionConsumer(dataRoot); this.bridge = new SessionRunnerBridgeStore(dataRoot); this.queue = new SessionInputQueueStore(dataRoot);
    this.mode = parseSessionMigrationMode(options.mode); this.roots = options.roots ?? []; this.taskIds = options.taskIds ?? [];
  }
  dispose():void { this.stateCache.clear(); this.historyMarkers.clear(); }
  cacheSizeForTest():number{return this.stateCache.size;}
  private session(id: string): SessionRecord {
    const s = this.repo.getByTaskId(id) ?? this.repo.getById(id); if (!s) throw new KernelSessionPolicyError("SESSION_NOT_FOUND", `Session 不存在: ${id}`);
    if (this.mode === "runner" && this.taskIds.length && ![s.id, ...s.taskIds].some((taskId) => this.taskIds.includes(taskId))) throw new KernelSessionPolicyError("SESSION_CANARY_NOT_GRANTED", "Session 未进入 Runner 灰度范围");
    return s;
  }
  private assertOperable(s: SessionRecord): void {if(s.isolated)throw new KernelSessionPolicyError("SESSION_RECORD_UNOPERABLE","历史 Codex Session 身份非法，仅供读取本地历史"); if (s.archive) throw new KernelSessionPolicyError("SESSION_ARCHIVED_READ_ONLY", "归档 Session 仅供审计和读取历史，禁止运行态操作"); }
  private pendingLegacyRunner(sessionId?: string, taskId?: string): boolean { const terminalEvents = new RunnerEventJournal(this.dataRoot).readStrict().filter((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type)), terminals = new Map(terminalEvents.map((e) => [e.commandId, e])); for (const command of this.bridge.list(sessionId)) { const terminal = terminals.get(command.commandId); if (!command.terminal && terminal) this.bridge.advance(command.commandId, terminal.sequence, true); } const pendingBridge = this.bridge.list(sessionId).some((c) => !c.terminal && (!taskId || c.taskId === taskId)), pendingRunner = new RunnerCommandJournal(this.dataRoot).readStrict().some((c) => (!sessionId || c.sessionId === sessionId) && !terminals.has(c.commandId)); return pendingBridge || pendingRunner; }
  private legacyGuard(id: string): void { let s: SessionRecord | null = null; try { s = this.repo.getById(id) ?? this.repo.getByTaskId(id); } catch { try { if (this.pendingLegacyRunner(undefined, id)) throw new KernelSessionPolicyError("SESSION_RUNNER_DRAIN_REQUIRED", "Session 身份损坏且仍有未收敛的 Runner 命令，拒绝 legacy 写入"); } catch (error) { if (error instanceof KernelSessionPolicyError) throw error; throw new KernelSessionPolicyError("SESSION_RUNNER_JOURNAL_INVALID", "Runner journal 无法验证，拒绝 legacy 写入"); } return; } if (!s) return; this.assertOperable(s); try { if (this.pendingLegacyRunner(s.id)) throw new KernelSessionPolicyError("SESSION_RUNNER_DRAIN_REQUIRED", "Session 仍有未收敛的 Runner 命令，拒绝切回旧链写入"); } catch (error) { if (error instanceof KernelSessionPolicyError) throw error; throw new KernelSessionPolicyError("SESSION_RUNNER_JOURNAL_INVALID", "Runner journal 无法验证，拒绝 legacy 写入"); } }
  private taskId(session: SessionRecord, requestedId: string): string { return session.taskIds.includes(requestedId) ? requestedId : session.id; }
  private dto(s: SessionRecord): KernelSessionDto { return { id: s.id, providerId: s.providerId, nativeRef: s.nativeRef, cwd: s.cwd, control: s.control, recoverable: s.recoverable, taskIds: [...s.taskIds], operability: s.archive||s.isolated ? "read-only" : "active", ...(s.archive ? { archiveState: s.archive.state } : {}) }; }
  private async legacy() { return import("../../agent-backend.ts"); }
  private async rejectLiveLegacyOwner(taskId: string): Promise<void> { try { const legacy = await (await this.legacy()).getAgentState(taskId); if (legacy.alive || legacy.turn === "running") throw new KernelSessionPolicyError("SESSION_LEGACY_OWNED", "legacy Provider 仍持有会话；请先安全 handoff 或新建 Runner 会话"); } catch (error) { if (error instanceof KernelSessionPolicyError) throw error; } }
  private validateAccessGrant(access: KernelGrantedAccess): void { if ((access === "full-access" || access === "bypass") && cfg.architecture?.allowFullAccess !== true) throw new KernelSessionPolicyError("SESSION_ACCESS_NOT_GRANTED", "Kernel 配置未授予 full access"); }
  private providerHome(providerId:"claude"|"codex"|"codebuddy",value:string|undefined,roots:string[]):string|undefined { if(value===undefined)return undefined;if(providerId!=="codex")throw new KernelSessionPolicyError("SESSION_PROVIDER_HOME_INVALID","仅 Codex 支持 providerHome");return validateDirectoryGrant(expandCodexHome(value),roots); }
  private providerOptions(model?:string,effort?:string):void{if(model!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))throw new KernelSessionPolicyError("PROVIDER_INPUT_INVALID","model 非法");if(effort!==undefined&&!['low','medium','high'].includes(effort))throw new KernelSessionPolicyError("PROVIDER_INPUT_INVALID","effort 非法");}
  private async ensureInitialHistory(s: SessionRecord,force=false): Promise<void> {
    const prior=readInitialHistorySnapshot(this.dataRoot,s.id);if(!s.nativeRef||(prior?.status==="ok"&&prior.nativeRef===s.nativeRef)||s.source==="native")return;if(!force&&prior?.nextRetryAt&&prior.nativeRef===s.nativeRef&&Date.now()<Date.parse(prior.nextRetryAt)){this.historyMarkers.set(s.id,{role:"system",text:"历史会话暂时无法读取；稍后自动重试。",ts:new Date().toISOString()});return;}
    let messages: import("./types.ts").DevMsg[] = [];
    try { messages = await this.runner.readHistory({ providerId: s.providerId, nativeRef: s.nativeRef, ...(s.providerHome ? { providerHome: s.providerHome } : {}), cwd: s.cwd }); }
    catch {
      try { messages = structuredClone((await (await this.legacy()).getAgentState(s.taskIds[0] ?? s.id)).messages ?? []); } catch { /* explicit marker below */ }
      if (!messages.length) this.historyMarkers.set(s.id, { role: "system", text: "历史会话暂时无法读取；原始 Provider transcript 已保留。", ts: new Date().toISOString() });
    }
    if (!messages.length) { this.historyMarkers.set(s.id, this.historyMarkers.get(s.id) ?? { role: "system", text: "Provider 历史暂时为空；后续读取会继续刷新。", ts: new Date().toISOString() });const attempts=(prior?.attempts??0)+1,delay=Math.min(300_000,1_000*2**Math.min(attempts-1,8)); writeInitialHistory(this.dataRoot, { status: "unavailable", sessionId: s.id, providerId: s.providerId, nativeRef: s.nativeRef, messages: [],attempts,nextRetryAt:new Date(Date.now()+delay).toISOString() }); return; }
    writeInitialHistory(this.dataRoot, { status: "ok", sessionId: s.id, providerId: s.providerId, nativeRef: s.nativeRef, messages }); this.historyMarkers.delete(s.id);
  }
  private archivedState(s: SessionRecord): KernelSessionState {
    const snapshot = readInitialHistorySnapshot(this.dataRoot, s.id);
    const messages = snapshot?.status === "ok" ? snapshot.messages : [{
      role: "system" as const, name: "history", text: "归档会话的本地初始历史不可用。", ts: snapshot?.copiedAt ?? s.updatedAt,
    }];
    return { messages: structuredClone(messages), turn: "idle", alive: false, partial: "", pending: [],
      backend: s.providerId, providerId: s.providerId, control: s.control, resume: null,
      fullAccess: s.access === "full-access" || s.access === "bypass", stale: snapshot?.status !== "ok",
      ...(snapshot?.status === "ok" ? {} : { errorCode: "SESSION_ARCHIVED_HISTORY_UNAVAILABLE" }),
      operability: "read-only", archiveState: s.archive!.state };
  }
  private isolatedState(s:SessionRecord):KernelSessionState{const snapshot=readInitialHistorySnapshot(this.dataRoot,s.id);return{messages:snapshot?.messages??[],turn:"idle",alive:false,partial:"",pending:[],backend:s.providerId,providerId:s.providerId,control:s.control,resume:null,stale:true,errorCode:"SESSION_RECORD_UNOPERABLE",operability:"read-only"};}
  async create(input: { taskId: string; providerId: "claude" | "codex" | "codebuddy"; cwd: string; control?: "ownward" | "observing" | "external"; providerHome?: string; extraDirs?: string[]; model?: string; effort?: string }, grants: KernelSessionGrants): Promise<KernelSessionDto> {
    if (this.mode !== "runner") throw new KernelSessionPolicyError("SESSION_RUNNER_DISABLED", "新会话必须由 Runner 创建；当前 effective mode 已关闭");
    this.validateAccessGrant(grants.access);this.providerOptions(input.model,input.effort); const cwd = validateDirectoryGrant(input.cwd, grants.roots), extraDirs = (input.extraDirs ?? []).map((dir) => validateDirectoryGrant(dir, grants.roots)),providerHome=this.providerHome(input.providerId,input.providerHome,grants.roots);
    const created = this.repo.reserve({ ...input, ...(providerHome?{providerHome}:{}), cwd, extraDirs, access: grants.access }); return this.dto(this.session(created.id));
  }
  async adopt(input: { taskId: string; providerId: "claude" | "codex" | "codebuddy"; nativeRef: string; providerHome?: string; cwd: string; control?: "ownward" | "observing" | "external" }, grants: KernelSessionGrants): Promise<KernelSessionDto> {
    if (this.mode !== "runner") throw new KernelSessionPolicyError("SESSION_RUNNER_DISABLED", "会话接管必须由 Runner 完成；当前 effective mode 已关闭"); this.validateAccessGrant(grants.access); await this.rejectLiveLegacyOwner(input.taskId); const cwd = validateDirectoryGrant(input.cwd, grants.roots),providerHome=this.providerHome(input.providerId,input.providerHome,grants.roots);input={...input,...(providerHome?{providerHome}:{})};
    // SessionStart 的确定性身份是主链；Provider history 只是可重试的 copy-forward。
    const adopted = this.repo.bind({ ...input, cwd, source: "adopted" }); this.repo.updateGrants(adopted.id, { access: grants.access });
    try { await this.ensureInitialHistory(adopted, true); } catch { /* identity is durable; later state/refresh retries history */ }
    return this.dto(this.session(adopted.id));
  }
  private activeRun(session: SessionRecord): string {
    const active = reduceRuns(readRunJournalStrict(this.dataRoot)).filter((r) => r.sessionId === session.id && r.providerId === session.providerId && r.status === "running").at(-1);
    if (!active) throw new KernelSessionPolicyError("SESSION_ACTIVE_RUN_REQUIRED", "Session 没有可验证的 active Run");
    return active.runId;
  }
  private pendingApproval(session: SessionRecord, requestId: string, runId: string): void { const commands = new RunnerCommandJournal(this.dataRoot).readStrict(), events = new RunnerEventJournal(this.dataRoot).readStrict(), requested = events.find((e) => e.type === "approval-requested" && e.sessionId === session.id && e.runId === runId && e.approvalRequestId === requestId); if (!requested) throw new KernelSessionPolicyError("SESSION_APPROVAL_NOT_PENDING", "审批请求不存在或不属于当前 Run"); const answered = commands.filter((c) => c.kind === "approval-response" && c.sessionId === session.id && c.runId === runId && c.approvalRequestId === requestId).some((c) => events.some((e) => e.commandId === c.commandId && ["completed", "failed"].includes(e.type))); if (answered) throw new KernelSessionPolicyError("SESSION_APPROVAL_NOT_PENDING", "审批请求已经处理"); }
  private async sync(command: BridgeCommand): Promise<boolean> { const events = await this.runner.syncCommand(command.taskId, command.commandId, command.cursor); let cursor = command.cursor, terminal = command.terminal; for (const event of events) { cursor = Math.max(cursor, event.sequence); terminal ||= ["completed", "failed", "interrupted", "unknown-outcome"].includes(event.type); } if (events.length) this.bridge.advance(command.commandId, cursor, terminal); command.cursor = cursor; command.terminal = terminal; return terminal; }
  private reserveControl(s: SessionRecord, taskId: string, kind: BridgeCommand["kind"], input: unknown, options: { targetRunId?: string; authorizedRoots?: string[]; authorizedAccess?: KernelGrantedAccess } = {}): BridgeCommand { return this.bridge.reserve({ taskId, sessionId: s.id, providerId: s.providerId, kind, serializedInput: JSON.stringify(input), ...options }).command; }
  private async finishControl(taskId: string, command: BridgeCommand): Promise<void> { try { await this.runner.waitTerminal(taskId, command.commandId, 5_000, command.cursor, command); } finally { const events = new RunnerEventJournal(this.dataRoot).readStrict().filter((e) => e.commandId === command.commandId), cursor = events.reduce((n, e) => Math.max(n, e.sequence), command.cursor), terminal = events.some((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type)); if (events.length) this.bridge.advance(command.commandId, cursor, terminal); } }
  private async markTaskAccepted(taskId:string,command:BridgeCommand):Promise<void>{const {markTaskRunAccepted}=await import("../task-status.ts");markTaskRunAccepted(this.dataRoot,taskId,command);}
  private recoverHistoryReset(s:SessionRecord):SessionRecord{const pending=s.pendingHistoryReset;if(!pending)return s;const terminal=new RunnerEventJournal(this.dataRoot).readStrict().filter(event=>event.commandId===pending.commandId&&["completed","failed","interrupted","unknown-outcome"].includes(event.type)).at(-1);if(!terminal)return s;const completed=terminal.type==="completed",settled=this.repo.finishHistoryReset(s.id,pending.commandId,completed);if(completed){clearInitialHistory(this.dataRoot,s.id);this.historyMarkers.delete(s.id);this.stateCache.delete(s.id);}return settled;}
  private writableSession(id:string):SessionRecord{const s=this.recoverHistoryReset(this.session(id));if(s.pendingHistoryReset)throw new KernelSessionPolicyError("SESSION_HISTORY_RESET_PENDING","新会话切换尚未收敛，拒绝恢复旧 Provider ref");return s;}
  private consume(command: BridgeCommand): Promise<void> {
    const key = `${this.dataRoot}\0${command.commandId}`, existing = ACTIVE_SESSION_CONSUMERS.get(key); if (existing) return existing;
    // 命令收敛（本轮跑完/失败/被中断）就是队列该发下一段的时刻——flush 挂在这儿，不另起定时器
    const work = (async () => { this.bridge.markError(command.commandId); try { while (!command.terminal) { if (await this.sync(command)) break; await Bun.sleep(50); } } catch (error: any) { this.bridge.markError(command.commandId, String(error?.code || error?.name || "RUNNER_BRIDGE_ERROR")); throw error; } })().finally(() => { ACTIVE_SESSION_CONSUMERS.delete(key); if (!this.queue.empty()) void this.drainQueue(command.sessionId); });
    ACTIVE_SESSION_CONSUMERS.set(key, work); return work;
  }
  // 兜底 flush：命令早就终态、consume 那一发已经错过时（daemon 重启、轮询先到），
  // 靠这里把还排着的消息叫出去——队列空时只是一次 existsSync，不进热路径
  private async reconcile(session: SessionRecord): Promise<void> { if (session.archive) return; for (const command of this.bridge.list(session.id).filter((c) => !c.terminal)) { await this.sync(command); if (!command.terminal) void this.consume(command).catch(() => {}); } if (!this.queue.empty() && this.queue.list(session.id).length) void this.drainQueue(session.id); }
  async resumePending(): Promise<void> { for (const command of this.bridge.list().filter((c) => { if (c.terminal || !this.taskIds.length) return !c.terminal; try { const s = this.repo.getById(c.sessionId) ?? this.repo.getByTaskId(c.taskId); return !!s && [s.id, ...s.taskIds].some((id) => this.taskIds.includes(id)); } catch { return false; } })) { await this.sync(command); if (!command.terminal) void this.consume(command).catch(() => {}); } for (const sessionId of this.queue.sessions()) void this.drainQueue(sessionId); }
  async drainUnknown(input: { sessionId: string; commandId: string; confirm: string }): Promise<{ commandId: string; runId: string; outcome: string }> {
    if (input.confirm !== "MARK_UNKNOWN_OUTCOME") throw new KernelSessionPolicyError("SESSION_DRAIN_CONFIRM_REQUIRED", "必须明确确认 unknown-outcome");
    const command = this.bridge.list(input.sessionId).find((c) => c.commandId === input.commandId); if (!command || command.terminal) throw new KernelSessionPolicyError("SESSION_DRAIN_NOT_PENDING", "指定 command 不是 pending");
    const eventJournal = new RunnerEventJournal(this.dataRoot), existing = eventJournal.readStrict().filter((e) => e.commandId === command.commandId), actualTerminal = existing.find((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type));
    let cursor = actualTerminal?.sequence ?? command.cursor, outcome = actualTerminal?.type ?? "unknown-outcome";
    if (!actualTerminal) {
      if (Date.now() - Date.parse(command.createdAt) < 300_000) throw new KernelSessionPolicyError("SESSION_DRAIN_TOO_RECENT", "command 尚未达到安全 drain 等待时间");
      try { const { RunnerClient } = await import("../../runner/client.ts"); const client = new RunnerClient(this.dataRoot, 1_000); try { const reply = await client.request("ping", {}); if (!Array.isArray(reply.body.activeRuns)) throw new KernelSessionPolicyError("SESSION_DRAIN_RUNNER_UNVERIFIED", "Runner 未返回可验证的 activeRuns"); if (reply.body.activeRuns.includes(command.commandId)) throw new KernelSessionPolicyError("SESSION_DRAIN_ACTIVE", "Runner 仍在执行该 Run，拒绝 drain"); } finally { client.close(); } }
      catch (error: any) { if (error instanceof KernelSessionPolicyError) throw error; if (!/ENOENT|ECONNREFUSED/.test(String(error?.code || error?.message || error))) throw new KernelSessionPolicyError("SESSION_DRAIN_RUNNER_UNVERIFIED", "无法验证 Runner 是否仍持有该命令"); }
      const runnerCommand = new RunnerCommandJournal(this.dataRoot).readStrict().find((c) => c.commandId === command.commandId);
      if (runnerCommand) { const appended = eventJournal.append({ eventId: `drain:${command.commandId}`.slice(0, 128), type: "unknown-outcome", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, reason: "runner_lost_ownership" }).record; projectRunnerEvent(this.dataRoot, command.taskId, appended); cursor = appended.sequence; }
    }
    this.bridge.advance(command.commandId, cursor, true); const audit = join(this.dataRoot, "session-drain-audit.jsonl"); appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), sessionId: command.sessionId, commandId: command.commandId, runId: command.runId, confirmation: input.confirm, outcome }) + "\n", { mode: 0o600 }); return { commandId: command.commandId, runId: command.runId, outcome };
  }
  private runnerState(s: SessionRecord, snapshot?: { journal: RunnerEventJournal; commands: Map<string, RunnerCommandRecord>; events: RunnerEventRecord[]; signature: string }): KernelSessionState { const signature=(snapshot?.signature??["events.jsonl","commands.jsonl"].map((name)=>{try{const st=statSync(join(this.dataRoot,"runner",name));return`${st.size}:${st.mtimeMs}`;}catch{return"0:0";}}).join("|"))+`|${s.updatedAt}|${(()=>{const h=readInitialHistorySnapshot(this.dataRoot,s.id);return h?h.status+":"+h.copiedAt:"missing";})()}`,cached=this.stateCache.get(s.id);if(cached?.signature===signature)return this.withQueue(s,structuredClone(cached.state));const journal=snapshot?.journal??new RunnerEventJournal(this.dataRoot),commands=snapshot?.commands??new Map(new RunnerCommandJournal(this.dataRoot).readStrict().map(c=>[c.commandId,c])),allEvents=snapshot?.events??journal.readStrict(),resetIndex=s.historyResetCommandId?allEvents.findIndex((event)=>event.commandId===s.historyResetCommandId&&event.type==="completed"):-1,events=s.historyResetCommandId?(resetIndex>=0?allEvents.slice(resetIndex+1):[]):allEvents,projector=new RunnerAgentStateProjector(s,(event)=>{const raw=journal.readPayload(event);return raw?JSON.parse(raw):null;},(id)=>commands.get(id),(()=>{const history=readInitialHistory(this.dataRoot,s.id);return history.length?history:(this.historyMarkers.has(s.id)?[this.historyMarkers.get(s.id)!]:[]);})());for(const event of events)if(event.sessionId===s.id)projector.apply(event);const state={...projector.state(),...(s.archive?{alive:false,turn:"idle",partial:"",pending:[],operability:"read-only" as const,archiveState:s.archive.state}:{operability:"active" as const})} as KernelSessionState;
    const commandJournal=new RunnerCommandJournal(this.dataRoot),orderedCommands=[...commands.values()],resetCommandIndex=s.historyResetCommandId?orderedCommands.findIndex((command)=>command.commandId===s.historyResetCommandId):-1,snapshotHistory=readInitialHistorySnapshot(this.dataRoot,s.id),copiedAt=Date.parse(snapshotHistory?.copiedAt||"")||0,createdAt=Date.parse(s.createdAt)||0,overlap=new Map<string,number>(); if(s.source==="adopted")for(const message of snapshotHistory?.messages??[])if(message.role==="user"&&(Date.parse(message.ts||"")||0)>=createdAt)overlap.set(message.text,(overlap.get(message.text)??0)+1);const inputs: import("./types.ts").DevMsg[]=[];for(const [index,command] of orderedCommands.entries()){if(index<=resetCommandIndex||command.sessionId!==s.id||!["start-run","resume-run","send-input"].includes(command.kind))continue;const raw=commandJournal.readInput(command);if(raw===undefined)continue;let text="";try{text=JSON.parse(raw)?.text;}catch{}const images=commandSessionImages(command.sessionId,raw);if((typeof text!=="string"||!text.trim())&&!images.length)continue;const normalized=typeof text==="string"?text:"",count=overlap.get(normalized)??0;if(s.source==="adopted"&&Date.parse(command.acceptedAt)<=copiedAt&&count>0){overlap.set(normalized,count-1);continue;}
inputs.push({role:"user",name:`command:${command.commandId}`,text:images.length?`📎×${images.length}${normalized?` ${normalized}`:""}`:normalized,ts:command.acceptedAt,...(images.length?{images}:{})});}state.messages=[...state.messages,...inputs].sort((a,b)=>(Date.parse(a.ts||"")||0)-(Date.parse(b.ts||"")||0));const resume=!s.archive&&s.nativeRef?{id:s.nativeRef,tool:s.providerId,cmd:s.providerId==="claude"?`cd ${shellQuote(s.cwd)} && claude --resume ${shellQuote(s.nativeRef)}`:s.providerId==="codebuddy"?`cd ${shellQuote(s.cwd)} && codebuddy --resume ${shellQuote(s.nativeRef)}`:buildCodexResumeCommand(s.cwd,s.nativeRef,s.providerHome||"codex")}:null;Object.assign(state,{resume,fullAccess:s.access==="full-access"||s.access==="bypass"});this.stateCache.set(s.id,{signature,state:structuredClone(state)});return this.withQueue(s,state);}
  /** 排队消息挂在 state 上返回。必须在 stateCache 之外贴：队列变化不进 signature，
   *  写进缓存的话撤回一条要等下一次 runner journal 变动才看得见。 */
  private withQueue(s:SessionRecord,state:KernelSessionState):KernelSessionState{const queued=this.queue.view(s.id);return queued.length?{...state,queued}:state;}
  private projectHandoffChain(s:SessionRecord,current:KernelSessionState,snapshot?:{journal:RunnerEventJournal;commands:Map<string,RunnerCommandRecord>;events:RunnerEventRecord[];signature:string}):KernelSessionState{const chain:{session:SessionRecord;state:KernelSessionState}[]=[{session:s,state:current}],seen=new Set([s.id]);let cursor=s;for(let depth=0;depth<15;depth++){const id=cursor.handoff?.predecessorId;if(!id||seen.has(id))break;const predecessor=this.repo.getById(id);if(!predecessor)break;seen.add(id);chain.unshift({session:predecessor,state:this.runnerState(predecessor,snapshot)});cursor=predecessor;}const messages:import("./types.ts").DevMsg[]=[];for(let index=0;index<chain.length;index++){const item=chain[index],internalIds=new Set(this.bridge.list(item.session.id).filter(c=>c.clientMutationId?.startsWith("handoff:")).map(c=>c.commandId));if(index){const previous=chain[index-1].session;messages.push({role:"system",name:"handoff",text:`已从 ${previous.providerId} 接力到 ${item.session.providerId}${previous.handoff?.reason?`：${previous.handoff.reason}`:""}`,ts:item.session.handoff?.at??item.session.createdAt});}for(const message of item.state.messages){const commandId=message.name?.startsWith("command:")?message.name.slice(8):undefined;if(commandId&&internalIds.has(commandId))continue;messages.push(commandId?(({name:_name,...visible})=>visible)(message):message);}}let chars=0;const bounded:import("./types.ts").DevMsg[]=[];for(const message of messages.slice(-200).reverse()){chars+=message.text.length;if(chars>128_000)break;bounded.push(message);}return{...current,messages:bounded.reverse(),...(s.handoff?.predecessorId?{handoff:{predecessorId:s.handoff.predecessorId,at:s.handoff.at,...(s.handoff.reason?{reason:s.handoff.reason}:{}),currentProviderId:s.providerId}}:{})};}
  async states(ids: readonly string[]): Promise<Map<string,KernelSessionState>>{const out=new Map<string,KernelSessionState>();if(this.mode!=="runner"){for(const id of ids)try{out.set(id,await this.state(id));}catch{}return out;}const sessions=[] as SessionRecord[];for(const id of ids)try{const s=this.session(id);if(s.archive){out.set(id,this.archivedState(s));continue;}if(s.isolated){out.set(id,this.isolatedState(s));continue;}await this.ensureInitialHistory(s);await this.reconcile(s);sessions.push(s);}catch{}const snapshot=readStableRunnerSnapshot(this.dataRoot);for(const s of sessions)out.set(this.taskId(s,s.taskIds.find(id=>ids.includes(id))??s.id),this.projectHandoffChain(s,this.runnerState(s,snapshot),snapshot));return out;}
  async state(id:string):Promise<KernelSessionState>{const persisted=this.repo.getById(id)??this.repo.getByTaskId(id);if(persisted?.archive)return this.archivedState(persisted);if(persisted?.isolated)return this.isolatedState(persisted);if(this.mode!=="runner")return structuredClone(await(await this.legacy()).getAgentState(id));let s=this.recoverHistoryReset(this.session(id));try{await this.ensureInitialHistory(s);await this.reconcile(s);s=this.recoverHistoryReset(this.session(id));return this.projectHandoffChain(s,this.runnerState(s));}catch(error:any){const code=String(error?.code||"");if(!code.startsWith("RUNNER_")&&!/ENOENT|ECONNREFUSED|connect/i.test(String(error)))throw error;s=this.session(id);return{...this.projectHandoffChain(s,this.runnerState(s)),stale:true,errorCode:code||"RUNNER_UNAVAILABLE"};}}
  async refreshHistory(id:string):Promise<KernelSessionState>{let s=this.session(id);if(s.archive)throw new KernelSessionPolicyError("SESSION_ARCHIVED_READ_ONLY","归档 Session 不得调用 Provider 刷新历史");await this.ensureInitialHistory(s,true);this.stateCache.delete(s.id);s=this.session(id);return this.projectHandoffChain(s,this.runnerState(s));}
  async send(id: string, input: SessionInput): Promise<SessionMutationResult> {
    if (this.mode !== "runner") { this.legacyGuard(id); return (await this.legacy()).sendToAgent(id, input.text, input.images ?? []); }
    const s = this.writableSession(id); this.assertOperable(s); const taskId = this.taskId(s, id);
    if (!this.bridge.list(s.id).length) await this.rejectLiveLegacyOwner(taskId);
    if (s.control !== "ownward") throw new KernelSessionPolicyError("SESSION_CONTROL_REQUIRED", "未持有输入权，请先接管");
    if (input.clientMutationId !== undefined && (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientMutationId))) throw new KernelSessionPolicyError("SESSION_MUTATION_ID_INVALID", "clientMutationId 非法");
    // 客户端重试（同 clientMutationId + 同内容、原命令还没收敛）走原路复用 identity，不能当新消息排队——
    // 排了就等于把同一句话说两遍。判断口径与 bridge.reserve 的复用条件逐字一致。
    const retry = input.clientMutationId ? this.bridge.find({ taskId, sessionId: s.id, providerId: s.providerId, kind: s.nativeRef ? "resume-run" : "start-run", serializedInput: JSON.stringify({ text: input.text, images: input.images ?? [] }), clientMutationId: input.clientMutationId }) : undefined;
    // 本轮还在跑就排队，不硬发。硬发的下场是：Runner 照收，adapter 回 PROVIDER_SESSION_BUSY，
    // 这条 run 直接 failed；而消息因为已经进了 command journal 照样显示在会话里——
    // 用户看着自己发出去了，agent 从没收到，全程没有一句话提示。宁可排队也不能这么丢。
    // 已经有队列时新消息一律排到队尾：哪怕这会儿刚好空闲，插队也会把用户说话的顺序打乱。
    if (!retry && (this.queue.list(s.id).length || await this.busy(s))) { this.queue.push(s.id, parseQueued(input.text, input.images ?? [], input.clientMutationId)); return { queued: true }; }
    return this.submitTurn(s, taskId, input);
  }
  async handoff(id:string,input:{providerId:"claude"|"codex"|"codebuddy";model?:string;effort?:string;reason?:string;confirmUnknownOutcome?:boolean}):Promise<SessionMutationResult & {sessionId:string;providerId:"claude"|"codex"|"codebuddy"}>{
    if(this.mode!=="runner")throw new KernelSessionPolicyError("SESSION_RUNNER_DISABLED","跨 Provider 接力只支持 Runner Session");
    const old=this.writableSession(id);this.assertOperable(old);const taskId=this.taskId(old,id);this.providerOptions(input.model,input.effort);
    if(old.control!=="ownward")throw new KernelSessionPolicyError("SESSION_CONTROL_REQUIRED","未持有输入权，不能接力");
    if(old.providerId===input.providerId)throw new KernelSessionPolicyError("SESSION_HANDOFF_SAME_PROVIDER","目标 Provider 与当前相同");
    this.runner.require(input.providerId,"stream");await this.reconcile(old);
    if(await this.busy(old))throw new KernelSessionPolicyError("SESSION_HANDOFF_RUNNING","当前轮仍在运行，不能接力");
    if(this.queue.list(old.id).length)throw new KernelSessionPolicyError("SESSION_HANDOFF_QUEUED","存在待发送消息，不能接力");
    const oldState=this.projectHandoffChain(old,this.runnerState(old));if(oldState.pending.length)throw new KernelSessionPolicyError("SESSION_HANDOFF_PENDING","存在待处理审批，不能接力");
    const latestRun=reduceRuns(readRunJournalStrict(this.dataRoot)).filter(run=>run.sessionId===old.id).sort((a,b)=>b.firstSequence-a.firstSequence)[0],unknown=latestRun?.status==="unknown_outcome"&&old.confirmedUnknownRunId!==latestRun.runId;
    if(unknown&&!input.confirmUnknownOutcome)throw new KernelSessionPolicyError("SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED","最新 Run 结果未知，需明确确认后接力；不会重放旧命令");
    if(unknown&&input.confirmUnknownOutcome)this.repo.confirmHandoffUnknown(old.id,latestRun!.runId);
    const reason=(input.reason||"用户主动切换引擎").slice(0,512),transcript=oldState.messages.slice(-40).map(m=>`${m.role}: ${m.text.slice(0,2000)}`).join("\n").slice(-32_000);
    const prompt=["你正在接手另一个 Provider 未完成的任务。请先检查工作区实际状态，再继续执行；不要重放任何旧工具调用或命令。",`接力原因：${reason}`,"以下是有界历史快照：",transcript||"（无可用历史）"].join("\n\n");
    const moved=this.repo.handoff({taskId,providerId:input.providerId,...(input.model?{model:input.model}:{}),...(input.effort?{effort:input.effort}:{}),reason});
    try{const receipt=await this.submitTurn(moved.current,taskId,{text:prompt,clientMutationId:`handoff:${moved.previous.id}:${input.providerId}`});this.stateCache.delete(moved.previous.id);this.stateCache.delete(moved.current.id);return{...receipt,sessionId:moved.current.id,providerId:input.providerId};}
    catch(error:any){if(error?.outcomeUnknown!==true)this.repo.rollbackHandoff(moved.current.id);throw error;}
  }
  /** 真正下发一轮（不再判忙）：send 的直发路径和队列 flush 共用，两边的 identity/幂等语义必须一致。 */
  private async submitTurn(s: SessionRecord, taskId: string, input: SessionInput): Promise<SessionMutationResult> {
    this.runner.require(s.providerId, input.images?.length ? "images" : "stream"); const kind = s.nativeRef ? "resume-run" : "start-run", normalized = inputForRunner(this.dataRoot, s, input), serialized = JSON.stringify({ text: input.text, images: input.images ?? [] }), reserved = this.bridge.reserve({ taskId, sessionId: s.id, providerId: s.providerId, kind, serializedInput: serialized, ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}) }); let providerInput: unknown = normalized;
    if (reserved.reused) { const journal = new RunnerCommandJournal(this.dataRoot), record = journal.readStrict().find((c) => c.commandId === reserved.command.commandId); if (record) { const original = journal.readInput(record); if (original !== null) providerInput = JSON.parse(original); } }
    // 重试始终复用同一 identity；Runner journal 负责幂等判定，绝不生成第二个 command/run。
    await this.runner.submit(taskId, s, reserved.command.kind as "start-run" | "resume-run" | "send-input", providerInput, reserved.command);try{await this.markTaskAccepted(taskId,reserved.command);}catch(error:any){log(`task accepted projection deferred [${taskId}] code=${String(error?.code||error?.name||"TASK_PROJECTION_FAILED")}`);} if (reserved.reused) await this.runner.syncCommand(taskId, reserved.command.commandId, reserved.command.cursor);
    void this.consume(reserved.command).catch(() => {}); return { queued: false, commandId: reserved.command.commandId, runId: reserved.command.runId };
  }
  /** 会话是不是还在跑：以 bridge 里未终态的命令为准，并当场向 Runner 同步一次。
   *  不能只看本地快照——快照过期会把「已经空闲」判成忙（消息白排队）或反过来（撞 provider_busy）。 */
  private async busy(s: SessionRecord): Promise<boolean> {
    for (const command of this.bridge.list(s.id).filter((c) => !c.terminal)) if (!(await this.sync(command))) return true;
    return false;
  }
  /** 撤回一条还没发出的排队消息（按稳定 id）。
   *  撤不到如实回 removed:false——多半是本轮刚结束、这条已经合并发出了，必须让调用方看见（规则 9）。 */
  async removeQueued(id: string, queueId: string): Promise<{ removed: boolean; queued: QueuedView[] }> {
    if (this.mode !== "runner") { this.legacyGuard(id); return (await this.legacy()).removeFromAgentQueue(id, queueId); }
    const s = this.session(id); this.assertOperable(s);
    return { removed: this.queue.remove(s.id, queueId), queued: this.queue.view(s.id) };
  }
  /** 本轮收尾：把忙时队列合并成一条发出。一次只发一段（斜杠命令独占一帧），剩下的下一轮接着发。 */
  private drainQueue(sessionId: string): Promise<void> {
    const key = `${this.dataRoot}\0${sessionId}`, existing = ACTIVE_QUEUE_DRAINS.get(key); if (existing) return existing;
    const work = this.flushQueue(sessionId).catch((error: any) => log(`session queue [${sessionId}] flush 异常: ${String(error?.code || error?.message || error)}`)).finally(() => ACTIVE_QUEUE_DRAINS.delete(key));
    ACTIVE_QUEUE_DRAINS.set(key, work); return work;
  }
  private async flushQueue(sessionId: string): Promise<void> {
    if (this.mode !== "runner") return;
    let s: SessionRecord | null = null; try { s = this.repo.getById(sessionId); } catch { return; }
    if (!s || s.archive || s.isolated || !this.queue.list(s.id).length) return;
    // 租约校验：本轮跑着的时候用户把输入权释放了，队列不自动续发——留着等重新接管，
    // 否则绕过「非 ownward 不许发」的租约（legacy 那边同样的判断，同样的理由）
    if (s.control !== "ownward") return;
    // Runner 问不到就当还在忙：消息留在队列里等下次，绝不在不确定的时候硬发
    try { if (await this.busy(s)) return; } catch { return; }
    const taskId = this.taskId(s, s.taskIds[0] ?? s.id);
    for (;;) {
      const batch = this.queue.take(s.id); if (!batch.length) return;
      const { text, images } = mergeQueued(batch);
      if (!text.trim() && !images.length) continue;   // 整段空白：跳过，接着看下一段
      try { await this.submitTurn(s, taskId, { text, images }); }
      catch (error: any) {
        // 发失败原样放回队首：用户还能在队列里看见它、还能撤——比悄悄丢了强
        this.queue.unshift(s.id, batch);
        log(`session queue [${taskId}] flush failed: ${String(error?.code || error?.message || error)}`);
      }
      return;
    }
  }
  async resume(id: string, input: SessionInput) { if (this.mode !== "runner") return this.send(id, input); const s = this.session(id);this.assertOperable(s);this.runner.require(s.providerId,"resume");if(!s.nativeRef)throw new KernelSessionPolicyError("SESSION_NATIVE_REF_REQUIRED","Session 缺少 Provider ref");return this.send(id,input); }
  async interrupt(id: string): Promise<SessionMutationResult | void> { if(this.mode==="off"){this.legacyGuard(id);await(await this.legacy()).interruptAgent(id);return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);await this.reconcile(s);const runId=this.activeRun(s),command=this.reserveControl(s,taskId,"interrupt",{runId},{targetRunId:runId}),receipt=await this.runner.interrupt(s,runId,command);await this.finishControl(taskId,command);return{queued:false,...receipt}; }
  async respondApproval(id:string,requestId:string,response:{allow:boolean;message?:string;remember?:"session"|"global"|null}):Promise<SessionMutationResult|void>{if(this.mode!=="runner"){this.legacyGuard(id);const{decidePerm}=await import("../../agent-session.ts");decidePerm(id,requestId,response.allow,response.message,response.remember);return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"approval");await this.reconcile(s);const runId=this.activeRun(s);this.pendingApproval(s,requestId,runId);const command=this.reserveControl(s,taskId,"approval-response",{requestId,response},{targetRunId:runId}),receipt=await this.runner.approval(s,runId,requestId,response,command);await this.finishControl(taskId,command);return{queued:false,...receipt};}
  async addDirectory(id:string,dir:string):Promise<SessionMutationResult|void>{if(this.mode==="off"){this.legacyGuard(id);await(await this.legacy()).addAgentDir(id,dir);return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"add-dir");const actual=validateDirectoryGrant(dir,this.roots),command=this.reserveControl(s,taskId,"add-dir",{dir:actual},{authorizedRoots:this.roots}),receipt=await this.runner.submit(taskId,s,"add-dir",{dir:actual},command);await this.finishControl(taskId,command);this.repo.updateGrants(s.id,{addDirectory:actual});this.stateCache.delete(s.id);return{queued:false,...receipt};}
  async acquireControl(id:string,owner:"ownward"|"observing"):Promise<{sessionId:string;control:"ownward"|"observing"|"external"}>{if(this.mode==="off"){this.legacyGuard(id);const control=await(await this.legacy()).setAgentControl(id,owner==="ownward"?"take":"release");let sessionId=id;try{sessionId=(this.repo.getById(id)??this.repo.getByTaskId(id))?.id??id;}catch{}return{sessionId,control};}const s=this.session(id);this.assertOperable(s);if(owner==="ownward"&&reduceRuns(readRunJournalStrict(this.dataRoot)).some(run=>run.sessionId===s.id&&run.status==="running"))throw new KernelSessionPolicyError("SESSION_CONTROL_BUSY","Run 执行中不能接管输入权");const saved=this.repo.setControl(s.id,owner);
    // 接管回来 = 队列重新有资格发（释放输入权期间 flush 会一直拒绝，见 flushQueue 的租约校验）
    if(owner==="ownward"&&!this.queue.empty())void this.drainQueue(saved.id);
    return{sessionId:saved.id,control:saved.control};}
  async setAccess(id:string,access:KernelGrantedAccess):Promise<SessionMutationResult|void>{if(this.mode==="off"){this.legacyGuard(id);await(await this.legacy()).setAgentAccess(id,access!=="workspace");return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"set-access");if(s.access!=="full-access"&&s.access!=="bypass")this.validateAccessGrant(access);const providerAccess=s.providerId!=="codex"?(access==="workspace"?"standard":"bypass"):(access==="workspace"?"workspace-write":"full-access")/* codebuddy 与 claude 同 access 语义(见 runner-consumer 投影与 inputForRunner)，不能归到 codex 侧，否则 set-access acceptance 校验必抛 CONTROL_GRANT_INVALID */,command=this.reserveControl(s,taskId,"set-access",{access:providerAccess},{authorizedAccess:access}),receipt=await this.runner.submit(taskId,s,"set-access",{access:providerAccess},command);await this.finishControl(taskId,command);this.repo.updateGrants(s.id,{access});this.stateCache.delete(s.id);return{queued:false,...receipt};}
  async newSession(id:string):Promise<string>{if(this.mode==="off"){this.legacyGuard(id);return(await this.legacy()).newAgentSession(id);}const s=this.writableSession(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"new-session");const command=this.reserveControl(s,taskId,"new-session",{});this.repo.beginHistoryReset(s.id,command.commandId);try{await this.runner.submit(taskId,s,"new-session",{},command);await this.finishControl(taskId,command);}catch(error:any){if(error?.outcomeUnknown!==true)this.repo.finishHistoryReset(s.id,command.commandId,false);throw error;}this.repo.finishHistoryReset(s.id,command.commandId,true);this.queue.clear(s.id);/* /new 是丢上下文重开：还排着的话是对旧上下文说的，跟着一起清（legacy 同）*/clearInitialHistory(this.dataRoot,s.id);this.historyMarkers.delete(s.id);this.stateCache.delete(s.id);return"已开启新会话";}
}
