import { appendFileSync, statSync } from "fs";
import { join } from "path";
import { SessionRepository, SessionRepositoryError, type SessionRecord } from "../../sessions/repository.ts";
import { readRunJournalStrict, reduceRuns } from "../../runs/repository.ts";
import { parseSessionMigrationMode, type KernelGrantedAccess, type KernelSessionDto, type KernelSessionGrants, type KernelSessionState, type SessionInput, type SessionMutationResult, type SessionService } from "./contracts.ts";
import { expandCodexHome,inputForRunner, KernelSessionPolicyError, projectRunnerEvent, RunnerAgentStateProjector, RunnerSessionConsumer, validateDirectoryGrant, type RunnerCommandReceipt } from "./runner-consumer.ts";
import { archivedSessionEventsSignature, readArchivedSessionEvents, RunnerCommandJournal, RunnerEventJournal, type RunnerCommandRecord, type RunnerEventRecord } from "../../runner/journals.ts";
import { SessionRunnerBridgeStore, type BridgeCommand } from "./bridge-store.ts";
import { mergeQueued, parseQueued, SessionInputQueueStore, type QueuedView } from "./input-queue.ts";
import { cfg,log } from "../../util.ts";
import { clearInitialHistory, initialHistorySignature, readInitialHistory, readInitialHistorySnapshot, writeInitialHistory } from "./initial-history.ts";
import { buildCodexResumeCommand } from "../../sessions/provider-home.ts";
import { commandSessionImages } from "./session-images.ts";
import { assertProviderOptions, DEFAULT_CODEX_MODEL } from "../../session-options.ts";
import { addRule, logDecision } from "../../approval.ts";
import { approvalRuleToRemember } from "./approval-sweep.ts";

export type SessionMigrationMode = "off" | "runner";
export interface SessionServiceOptions { mode?: SessionMigrationMode; roots?: string[]; taskIds?: string[]; }
const ACTIVE_SESSION_CONSUMERS = new Map<string, Promise<void>>();
let approvalRequestedListener: ((dataRoot: string) => void) | null = null;
export function onRunnerApprovalRequested(listener: ((dataRoot: string) => void) | null): void { approvalRequestedListener = listener; }
// consume 循环是 daemon 向 Runner 拉事件的**唯一**节奏源：turn 跑着的整段时间它都在转。
// 定死 50ms 时，一轮里真正在流字的只占少数——等 API 首字、跑长 Bash、等用户审批这些空窗期
// 同样按 20 次/秒空拉。改成有事件就贴着 50ms 走、空转则指数退到 500ms：流式手感不变
// （一有事件立刻回到最小间隔），空窗期的空拉降一个数量级。退避只影响空窗之后**第一帧**的
// 可见延迟，上限 500ms。
//
// 别高估这一项的收益（2026-09-09 实测，避免后人重复推错因果）：单次空拉本身很便宜——
// 客户端往返 0.056ms、Runner 侧 query-command 的 readStrict+filter 0.22ms、
// 有事件时 bridge.advance 0.94ms（788 条命令的 400KB 文件全量重写）。60 次/秒满打满算
// 也就 4% 单核。当时观测到的 daemon 40% / runner 12% 三条加起来解释不了，真正的大头没找到，
// 别拿这段注释当「CPU 问题已解决」的凭据。这里省的是空窗期的无谓唤醒，不是那 40%。
const SYNC_POLL_MIN_MS = 50, SYNC_POLL_MAX_MS = 500;
/** 每会话同一时刻只跑一个 flush：漏掉的触发会被下一次轮询/下一轮收尾再叫起来 */
const ACTIVE_QUEUE_DRAINS = new Map<string, Promise<void>>();
/** 会话状态缓存条数。以前 32——生产 100+ 个会话，侧栏一次 states(all) 就把它整个抖掉，"热"调用和冷调用一样慢。 */
export const SESSION_STATE_CACHE_LIMIT=256;
/** 常驻投影器条数（每个持有该会话全部消息，大会话几 MB）；输入 blob 缓存上限（命令文本，很小）。 */
const PROJECTION_CACHE_LIMIT=64,INPUT_CACHE_LIMIT=5000;
function runnerJournalSignature(dataRoot:string):string{return["events.jsonl","commands.jsonl"].map(name=>{try{const st=statSync(join(dataRoot,"runner",name));return`${st.size}:${st.mtimeMs}`;}catch{return"0:0";}}).join("|");}
export type RunnerSnapshot={journal:RunnerEventJournal;events:RunnerEventRecord[];commands:Map<string,RunnerCommandRecord>;signature:string;bySession:Map<string,RunnerEventRecord[]>};
function bucketBySession(events:readonly RunnerEventRecord[]):Map<string,RunnerEventRecord[]>{const map=new Map<string,RunnerEventRecord[]>();for(const event of events){const list=map.get(event.sessionId);if(list)list.push(event);else map.set(event.sessionId,[event]);}return map;}
/** 一次读稳整个 runner journal（读前后指纹一致才算稳），顺手按会话分桶——批量投影/索引扫描每个会话时不必各自重扫全部事件。 */
export function readStableRunnerSnapshot(dataRoot:string,afterRead:()=>void=()=>{}):RunnerSnapshot{let last:RunnerSnapshot|undefined;for(let attempt=0;attempt<3;attempt++){const before=runnerJournalSignature(dataRoot),journal=new RunnerEventJournal(dataRoot),events=journal.readStrict(),commands=new Map(new RunnerCommandJournal(dataRoot).readStrict().map(command=>[command.commandId,command]));afterRead();const after=runnerJournalSignature(dataRoot);last={journal,events,commands,signature:`${after}|seq:${events.at(-1)?.sequence??0}|events:${events.length}|commands:${commands.size}`,bySession:bucketBySession(events)};if(before===after)return last;}return{...last!,signature:`unstable:${crypto.randomUUID()}:${last!.signature}`};}
class StateLru<K,V> extends Map<K,V>{constructor(private readonly limit:number=SESSION_STATE_CACHE_LIMIT){super();}override get(key:K){const value=super.get(key);if(value!==undefined){super.delete(key);super.set(key,value);}return value;}override set(key:K,value:V){super.delete(key);super.set(key,value);while(this.size>this.limit)super.delete(this.keys().next().value!);return this;}}
type LiveProjection={projector:RunnerAgentStateProjector;holder:{commands:ReadonlyMap<string,RunnerCommandRecord>};applied:number;lastEventId:string;historyKey:string;archiveKey:string;resetCommandId?:string};
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }
/** 某个原生会话在终端里接着聊的命令：三家 CLI 各自的 resume 语法，cwd 与 CODEX_HOME 一并带上（唯一拼装处，runnerState 与谱系共用） */
export function resumeFor(s: Pick<SessionRecord, "providerId" | "cwd" | "providerHome">, nativeRef: string): { id: string; tool: string; cmd: string } {
  const cmd = s.providerId === "claude" ? `cd ${shellQuote(s.cwd)} && claude --resume ${shellQuote(nativeRef)}`
    : s.providerId === "codebuddy" ? `cd ${shellQuote(s.cwd)} && codebuddy --resume ${shellQuote(nativeRef)}`
    : buildCodexResumeCommand(s.cwd, nativeRef, s.providerHome || "codex");
  return { id: nativeRef, tool: s.providerId, cmd };
}

export class KernelSessionService implements SessionService {
  private readonly repo: SessionRepository; private readonly runner: RunnerSessionConsumer; private readonly bridge: SessionRunnerBridgeStore; private readonly queue: SessionInputQueueStore;
  private readonly stateCache = new StateLru<string, { signature: string; state: KernelSessionState }>();
  private readonly projections = new StateLru<string, LiveProjection>(PROJECTION_CACHE_LIMIT);
  private readonly archiveMemo = new StateLru<string, { archiveKey: string; events: RunnerEventRecord[] }>(PROJECTION_CACHE_LIMIT);
  private readonly inputCache = new Map<string, string | undefined>();
  private rebuilds = 0;
  private readonly historyMarkers = new Map<string, import("./types.ts").DevMsg>();
  readonly mode: SessionMigrationMode; readonly roots: string[]; readonly taskIds: string[];
  constructor(readonly dataRoot: string, options: SessionServiceOptions = {}, runner?: RunnerSessionConsumer) {
    this.repo = new SessionRepository(dataRoot); this.runner = runner ?? new RunnerSessionConsumer(dataRoot); this.bridge = new SessionRunnerBridgeStore(dataRoot); this.queue = new SessionInputQueueStore(dataRoot);
    this.mode = parseSessionMigrationMode(options.mode); this.roots = options.roots ?? []; this.taskIds = options.taskIds ?? [];
  }
  dispose():void { this.stateCache.clear(); this.projections.clear(); this.archiveMemo.clear(); this.inputCache.clear(); this.historyMarkers.clear(); }
  cacheSizeForTest():number{return this.stateCache.size;}
  projectionStatsForTest():{rebuilds:number;live:number}{return{rebuilds:this.rebuilds,live:this.projections.size};}
  private session(id: string): SessionRecord {
    const s = this.repo.getByTaskId(id) ?? this.repo.getById(id); if (!s) throw new KernelSessionPolicyError("SESSION_NOT_FOUND", `Session 不存在: ${id}`);
    if (this.mode === "runner" && this.taskIds.length && ![s.id, ...s.taskIds].some((taskId) => this.taskIds.includes(taskId))) throw new KernelSessionPolicyError("SESSION_CANARY_NOT_GRANTED", "Session 未进入 Runner 灰度范围");
    return s;
  }
  private assertOperable(s: SessionRecord): void {if(s.isolated)throw new KernelSessionPolicyError("SESSION_RECORD_UNOPERABLE","历史 Codex Session 身份非法，仅供读取本地历史"); if (s.archive) throw new KernelSessionPolicyError("SESSION_ARCHIVED_READ_ONLY", "归档 Session 仅供审计和读取历史，禁止运行态操作"); }
  private pendingLegacyRunner(sessionId?: string, taskId?: string): boolean { const terminalEvents = new RunnerEventJournal(this.dataRoot).readStrict().filter((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type)), terminals = new Map(terminalEvents.map((e) => [e.commandId, e])); for (const command of this.bridge.list(sessionId)) { const terminal = terminals.get(command.commandId); if (!command.terminal && terminal) this.bridge.advance(command.commandId, terminal.sequence, true); } const pendingBridge = this.bridge.list(sessionId).some((c) => !c.terminal && (!taskId || c.taskId === taskId)), pendingRunner = new RunnerCommandJournal(this.dataRoot).readStrict().some((c) => (!sessionId || c.sessionId === sessionId) && !terminals.has(c.commandId)); return pendingBridge || pendingRunner; }
  private legacyGuard(id: string): void { let s: SessionRecord | null = null; try { s = this.repo.getById(id) ?? this.repo.getByTaskId(id); } catch { try { if (this.pendingLegacyRunner(undefined, id)) throw new KernelSessionPolicyError("SESSION_RUNNER_DRAIN_REQUIRED", "Session 身份损坏且仍有未收敛的 Runner 命令，拒绝 legacy 写入"); } catch (error) { if (error instanceof KernelSessionPolicyError) throw error; throw new KernelSessionPolicyError("SESSION_RUNNER_JOURNAL_INVALID", "Runner journal 无法验证，拒绝 legacy 写入"); } return; } if (!s) return; this.assertOperable(s); try { if (this.pendingLegacyRunner(s.id)) throw new KernelSessionPolicyError("SESSION_RUNNER_DRAIN_REQUIRED", "Session 仍有未收敛的 Runner 命令，拒绝切回旧链写入"); } catch (error) { if (error instanceof KernelSessionPolicyError) throw error; throw new KernelSessionPolicyError("SESSION_RUNNER_JOURNAL_INVALID", "Runner journal 无法验证，拒绝 legacy 写入"); } }
  private taskId(session: SessionRecord, requestedId: string): string { return session.taskIds.includes(requestedId) ? requestedId : (session.taskIds[0] ?? session.id); }
  private dto(s: SessionRecord): KernelSessionDto { return { id: s.id, providerId: s.providerId, nativeRef: s.nativeRef, cwd: s.cwd, control: s.control, recoverable: s.recoverable, taskIds: [...s.taskIds], ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}), operability: s.archive||s.isolated ? "read-only" : "active", ...(s.archive ? { archiveState: s.archive.state } : {}) }; }
  private async legacy() { return import("../../agent-backend.ts"); }
  private async rejectLiveLegacyOwner(taskId: string): Promise<void> { try { const legacy = await (await this.legacy()).getAgentState(taskId); if (legacy.alive || legacy.turn === "running") throw new KernelSessionPolicyError("SESSION_LEGACY_OWNED", "legacy Provider 仍持有会话；请先安全 handoff 或新建 Runner 会话"); } catch (error) { if (error instanceof KernelSessionPolicyError) throw error; } }
  private validateAccessGrant(access: KernelGrantedAccess): void { if ((access === "full-access" || access === "bypass") && cfg.architecture?.allowFullAccess !== true) throw new KernelSessionPolicyError("SESSION_ACCESS_NOT_GRANTED", "Kernel 配置未授予 full access"); }
  private providerHome(providerId:"claude"|"codex"|"codebuddy",value:string|undefined,roots:string[]):string|undefined { if(value===undefined)return undefined;if(providerId!=="codex")throw new KernelSessionPolicyError("SESSION_PROVIDER_HOME_INVALID","仅 Codex 支持 providerHome");return validateDirectoryGrant(expandCodexHome(value),roots); }
  private providerOptions(providerId:"claude"|"codex"|"codebuddy",model?:string,effort?:string):void{try{assertProviderOptions(providerId,model,effort);}catch(error){throw new KernelSessionPolicyError("PROVIDER_INPUT_INVALID",error instanceof Error?error.message:"options 非法");}}
  private effectiveOptions(providerId:"claude"|"codex"|"codebuddy",model?:string,effort?:string,previous?:SessionRecord):{model?:string;effort?:string}{const same=previous?.providerId===providerId,effectiveModel=model??(same?previous.model:undefined)??(providerId==="codex"?(cfg.llm?.codexModel||DEFAULT_CODEX_MODEL):undefined),effectiveEffort=effort??(same?previous.effort:undefined);this.providerOptions(providerId,effectiveModel,effectiveEffort);return{...(effectiveModel?{model:effectiveModel}:{}),...(effectiveEffort?{effort:effectiveEffort}:{})};}
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
      ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}),
      fullAccess: s.access === "full-access" || s.access === "bypass", stale: snapshot?.status !== "ok",
      ...(snapshot?.status === "ok" ? {} : { errorCode: "SESSION_ARCHIVED_HISTORY_UNAVAILABLE" }),
      operability: "read-only", archiveState: s.archive!.state };
  }
  private isolatedState(s:SessionRecord):KernelSessionState{const snapshot=readInitialHistorySnapshot(this.dataRoot,s.id);return{messages:snapshot?.messages??[],turn:"idle",alive:false,partial:"",pending:[],backend:s.providerId,providerId:s.providerId,control:s.control,resume:null,...(s.model?{model:s.model}:{}),...(s.effort?{effort:s.effort}:{}),stale:true,errorCode:"SESSION_RECORD_UNOPERABLE",operability:"read-only"};}
  async create(input: { taskId: string; providerId: "claude" | "codex" | "codebuddy"; cwd: string; control?: "ownward" | "observing" | "external"; providerHome?: string; extraDirs?: string[]; model?: string; effort?: string }, grants: KernelSessionGrants): Promise<KernelSessionDto> {
    if (this.mode !== "runner") throw new KernelSessionPolicyError("SESSION_RUNNER_DISABLED", "新会话必须由 Runner 创建；当前 effective mode 已关闭");
    this.validateAccessGrant(grants.access);const options=this.effectiveOptions(input.providerId,input.model,input.effort),cwd = validateDirectoryGrant(input.cwd, grants.roots), extraDirs = (input.extraDirs ?? []).map((dir) => validateDirectoryGrant(dir, grants.roots)),providerHome=this.providerHome(input.providerId,input.providerHome,grants.roots);
    const created = this.repo.reserve({ ...input, ...options, ...(providerHome?{providerHome}:{}), cwd, extraDirs, access: grants.access }); return this.dto(this.session(created.id));
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
  /** 「总是批准」→ 记成自动批准规则。Runner 模式以前只把 remember 透传给 Provider，规则从没落盘：
   *  点「总是（全局）」等于只批本次，同类命令下一条照弹（2026-09-14 28 号机实测）。尽力而为——记不下来不影响本次已批准。 */
  private rememberApproval(taskId: string, requested: RunnerEventRecord, scope: "session" | "global"): void { try { const raw = new RunnerEventJournal(this.dataRoot).readPayload(requested), remembered = approvalRuleToRemember(raw ? JSON.parse(raw) : null); if (!remembered) return; const rule = addRule({ scope, sessionId: taskId, kind: remembered.kind, pattern: remembered.pattern }); logDecision({ taskId, requestId: requested.approvalRequestId, toolName: remembered.toolName, kind: remembered.kind, pattern: remembered.pattern, decision: "allow", by: "user", ruleScope: rule.scope, detail: remembered.brief }); } catch (error) { log(`approval remember failed [${taskId}]: ${error instanceof Error ? error.name : "unknown"}`); } }
  private pendingApproval(session: SessionRecord, requestId: string, runId: string): RunnerEventRecord { const commands = new RunnerCommandJournal(this.dataRoot).readStrict(), events = new RunnerEventJournal(this.dataRoot).readStrict(), requested = events.find((e) => e.type === "approval-requested" && e.sessionId === session.id && e.runId === runId && e.approvalRequestId === requestId); if (!requested) throw new KernelSessionPolicyError("SESSION_APPROVAL_NOT_PENDING", "审批请求不存在或不属于当前 Run"); const answered = commands.filter((c) => c.kind === "approval-response" && c.sessionId === session.id && c.runId === runId && c.approvalRequestId === requestId).some((c) => events.some((e) => e.commandId === c.commandId && ["completed", "failed"].includes(e.type))); if (answered) throw new KernelSessionPolicyError("SESSION_APPROVAL_NOT_PENDING", "审批请求已经处理"); return requested; }
  private async sync(command: BridgeCommand): Promise<boolean> { const events = await this.runner.syncCommand(command.taskId, command.commandId, command.cursor); let cursor = command.cursor, terminal = command.terminal, asked = false; for (const event of events) { cursor = Math.max(cursor, event.sequence); terminal ||= ["completed", "failed", "interrupted", "unknown-outcome"].includes(event.type); asked ||= event.type === "approval-requested"; } if (events.length) this.bridge.advance(command.commandId, cursor, terminal); command.cursor = cursor; command.terminal = terminal; if (asked) try { approvalRequestedListener?.(this.dataRoot); } catch { /* 通知失败退回 60s 定时 sweep */ } return terminal; }
  private reserveControl(s: SessionRecord, taskId: string, kind: BridgeCommand["kind"], input: unknown, options: { targetRunId?: string; authorizedRoots?: string[]; authorizedAccess?: KernelGrantedAccess } = {}): BridgeCommand { return this.bridge.reserve({ taskId, sessionId: s.id, providerId: s.providerId, kind, serializedInput: JSON.stringify(input), ...options }).command; }
  private async finishControl(taskId: string, command: BridgeCommand): Promise<void> { try { await this.runner.waitTerminal(taskId, command.commandId, 5_000, command.cursor, command); } finally { const events = new RunnerEventJournal(this.dataRoot).readStrict().filter((e) => e.commandId === command.commandId), cursor = events.reduce((n, e) => Math.max(n, e.sequence), command.cursor), terminal = events.some((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type)); if (events.length) this.bridge.advance(command.commandId, cursor, terminal); } }
  private async markTaskAccepted(taskId:string,command:BridgeCommand):Promise<void>{const {markTaskRunAccepted}=await import("../task-status.ts");markTaskRunAccepted(this.dataRoot,taskId,command);}
  private recoverHistoryReset(s:SessionRecord):SessionRecord{const pending=s.pendingHistoryReset;if(!pending)return s;const terminal=new RunnerEventJournal(this.dataRoot).readStrict().filter(event=>event.commandId===pending.commandId&&["completed","failed","interrupted","unknown-outcome"].includes(event.type)).at(-1);if(!terminal)return s;const completed=terminal.type==="completed",settled=this.repo.finishHistoryReset(s.id,pending.commandId,completed);if(completed){clearInitialHistory(this.dataRoot,s.id);this.historyMarkers.delete(s.id);this.stateCache.delete(s.id);}return settled;}
  private writableSession(id:string):SessionRecord{const s=this.recoverHistoryReset(this.session(id));if(s.pendingHistoryReset)throw new KernelSessionPolicyError("SESSION_HISTORY_RESET_PENDING","新会话切换尚未收敛，拒绝恢复旧 Provider ref");return s;}
  private consume(command: BridgeCommand): Promise<void> {
    const key = `${this.dataRoot}\0${command.commandId}`, existing = ACTIVE_SESSION_CONSUMERS.get(key); if (existing) return existing;
    // 命令收敛（本轮跑完/失败/被中断）就是队列该发下一段的时刻——flush 挂在这儿，不另起定时器
    const work = (async () => { this.bridge.markError(command.commandId); try { let idle = SYNC_POLL_MIN_MS; while (!command.terminal) { const cursor = command.cursor; if (await this.sync(command)) break; idle = command.cursor > cursor ? SYNC_POLL_MIN_MS : Math.min(idle * 2, SYNC_POLL_MAX_MS); await Bun.sleep(idle); } } catch (error: any) { this.bridge.markError(command.commandId, String(error?.code || error?.name || "RUNNER_BRIDGE_ERROR")); throw error; } })().finally(() => { ACTIVE_SESSION_CONSUMERS.delete(key); if (!this.queue.empty()) void this.drainQueue(command.sessionId); });
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
  /** 某会话在热 journal 里的事件（按 historyReset 截到重置之后）。snapshot 已按会话分桶时直接取桶，不再每次重扫全部事件。 */
  private sessionEvents(s: SessionRecord, allEvents: readonly RunnerEventRecord[], snapshot?: RunnerSnapshot): RunnerEventRecord[] {
    const mine = snapshot?.bySession?.get(s.id) ?? allEvents.filter((event) => event.sessionId === s.id);
    if (!s.historyResetCommandId) return mine;
    const resetIndex = mine.findIndex((event) => event.commandId === s.historyResetCommandId && event.type === "completed");
    if (resetIndex >= 0) return mine.slice(resetIndex + 1);
    // 重置点不在热 journal：多半已被每日归档挪走——那热 journal 里剩下的全是重置之后的；两边都没有才是"什么都不可见"
    return this.archivedEvents(s).some((event) => event.commandId === s.historyResetCommandId && event.type === "completed") ? mine : [];
  }
  /** 会话的归档事件（按归档文件指纹记忆；一天最多变一次）。 */
  private archivedEvents(s: SessionRecord): RunnerEventRecord[] {
    const archiveKey = archivedSessionEventsSignature(this.dataRoot, s.id), memo = this.archiveMemo.get(s.id);
    if (memo?.archiveKey === archiveKey) return memo.events;
    const events = archiveKey === "none" ? [] : readArchivedSessionEvents(this.dataRoot, s.id);
    this.archiveMemo.set(s.id, { archiveKey, events });
    return events;
  }
  /** 重建投影时要回放的归档事件：/new 之后的历史重置同样截断归档——以前归档部分不截，重置前的旧对话会从归档里"复活"。 */
  private archivedForRebuild(s: SessionRecord): RunnerEventRecord[] {
    const all = this.archivedEvents(s);
    if (!s.historyResetCommandId) return all;
    const resetIndex = all.findIndex((event) => event.commandId === s.historyResetCommandId && event.type === "completed");
    return resetIndex >= 0 ? all.slice(resetIndex + 1) : [];
  }
  /** 会话状态指纹：只含**这个会话**的事件/命令尾巴 + 记录 updatedAt + 初始历史/归档文件指纹。
   *  以前用 events.jsonl 的 size:mtime——任何会话追加一条事件，全部会话的缓存一起作废，网页 2.5s 轮询
   *  和侧栏 60s 刷新就变成对整个 journal 的反复重放（2026-09-13 实测 31k blob 逐个读+校验 3.8s，
   *  daemon 每两分钟整段卡死 4-6s）。 */
  private sessionSignature(s: SessionRecord, events: readonly RunnerEventRecord[], commands: ReadonlyMap<string, RunnerCommandRecord>): string {
    let count = 0, last = "";
    for (const command of commands.values()) if (command.sessionId === s.id) { count++; last = command.commandId; }
    return `${events.length}:${events.at(-1)?.eventId ?? ""}|${count}:${last}|${s.updatedAt}|${s.historyResetCommandId ?? ""}|${this.historyKey(s)}|${archivedSessionEventsSignature(this.dataRoot, s.id)}`;
  }
  private historyKey(s: SessionRecord): string { return `${initialHistorySignature(this.dataRoot, s.id)}|${this.historyMarkers.get(s.id)?.text ?? ""}`; }
  private readInputCached(journal: RunnerCommandJournal, command: RunnerCommandRecord): string | undefined {
    if (this.inputCache.has(command.commandId)) return this.inputCache.get(command.commandId);
    const raw = journal.readInput(command);
    if (this.inputCache.size >= INPUT_CACHE_LIMIT) this.inputCache.clear();
    this.inputCache.set(command.commandId, raw);
    return raw;
  }
  /** 只算指纹不投影：索引扫描先拿它和上次入库的比，没变就连投影都省了。 */
  indexSignature(id: string, snapshot?: RunnerSnapshot): string | null {
    const s = this.repo.getById(id) ?? this.repo.getByTaskId(id); if (!s) return null;
    if (s.archive) return `archive|${this.historyKey(s)}|${s.updatedAt}`;
    if (s.isolated) return `isolated|${this.historyKey(s)}|${s.updatedAt}`;
    const journal = snapshot?.journal ?? new RunnerEventJournal(this.dataRoot);
    const commands = snapshot?.commands ?? new Map(new RunnerCommandJournal(this.dataRoot).readStrict().map((c) => [c.commandId, c]));
    return this.sessionSignature(s, this.sessionEvents(s, snapshot?.events ?? journal.readStrict(), snapshot), commands);
  }
  /** 索引/侧栏用：不过 canary 门、不问 runner、不截断消息——纯本地投影。签名没变就不必重写索引。 */
  projectForIndex(id: string, snapshot?: RunnerSnapshot): { signature: string; state: KernelSessionState } | null {
    const s = this.repo.getById(id) ?? this.repo.getByTaskId(id); if (!s) return null;
    if (s.archive) return { signature: `archive|${this.historyKey(s)}|${s.updatedAt}`, state: this.archivedState(s) };
    if (s.isolated) return { signature: `isolated|${this.historyKey(s)}|${s.updatedAt}`, state: this.isolatedState(s) };
    return this.projectSession(s, snapshot);
  }
  private runnerState(s: SessionRecord, snapshot?: RunnerSnapshot): KernelSessionState { return this.withQueue(s, this.projectSession(s, snapshot).state); }
  private projectSession(s: SessionRecord, snapshot?: RunnerSnapshot): { signature: string; state: KernelSessionState } {
    const journal = snapshot?.journal ?? new RunnerEventJournal(this.dataRoot);
    const commands = snapshot?.commands ?? new Map(new RunnerCommandJournal(this.dataRoot).readStrict().map((c) => [c.commandId, c]));
    const events = this.sessionEvents(s, snapshot?.events ?? journal.readStrict(), snapshot);
    const signature = this.sessionSignature(s, events, commands);
    const cached = this.stateCache.get(s.id);
    if (cached?.signature === signature) return { signature, state: structuredClone(cached.state) };
    // 增量投影：同一会话的投影器常驻，只 apply 新到的事件；初始历史 / 归档文件 / 重置点变了才整个重建。
    // 以前每次缓存失效都新建投影器从头重放全部事件（每条 payload blob 读盘 + sha256），活跃会话被网页
    // 2.5s 轮询一次就重放一次。
    const historyKey = this.historyKey(s), archiveKey = archivedSessionEventsSignature(this.dataRoot, s.id);
    let live = this.projections.get(s.id);
    const reusable = !!live && live.historyKey === historyKey && live.archiveKey === archiveKey && live.resetCommandId === s.historyResetCommandId && live.applied <= events.length && (live.applied === 0 || events[live.applied - 1].eventId === live.lastEventId);
    if (!reusable) {
      const holder = { commands }, history = readInitialHistory(this.dataRoot, s.id);
      const projector = new RunnerAgentStateProjector(s, (event) => { const raw = journal.readPayload(event); return raw ? JSON.parse(raw) : null; }, (id) => holder.commands.get(id), history.length ? history : (this.historyMarkers.has(s.id) ? [this.historyMarkers.get(s.id)!] : []));
      live = { projector, holder, applied: 0, lastEventId: "", historyKey, archiveKey, resetCommandId: s.historyResetCommandId };
      this.rebuilds++;
      try { for (const event of this.archivedForRebuild(s)) projector.apply(event); } catch (error) { this.projections.delete(s.id); throw error; }
    }
    live!.holder.commands = commands;
    try { for (let i = live!.applied; i < events.length; i++) live!.projector.apply(events[i]); }
    catch (error) { this.projections.delete(s.id); throw error; }   // 半截 apply 的投影器不能留：下次从头重建
    live!.applied = events.length; live!.lastEventId = events.at(-1)?.eventId ?? "";
    this.projections.set(s.id, live!);
    const state = { ...live!.projector.state(), ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}), ...(s.archive ? { alive: false, turn: "idle", partial: "", pending: [], operability: "read-only" as const, archiveState: s.archive.state } : { operability: "active" as const }) } as KernelSessionState;
    const commandJournal=new RunnerCommandJournal(this.dataRoot),orderedCommands=[...commands.values()],resetCommandIndex=s.historyResetCommandId?orderedCommands.findIndex((command)=>command.commandId===s.historyResetCommandId):-1,snapshotHistory=readInitialHistorySnapshot(this.dataRoot,s.id),copiedAt=Date.parse(snapshotHistory?.copiedAt||"")||0,createdAt=Date.parse(s.createdAt)||0,overlap=new Map<string,number>(); if(s.source==="adopted")for(const message of snapshotHistory?.messages??[])if(message.role==="user"&&(Date.parse(message.ts||"")||0)>=createdAt)overlap.set(message.text,(overlap.get(message.text)??0)+1);const inputs: import("./types.ts").DevMsg[]=[];for(const [index,command] of orderedCommands.entries()){if(index<=resetCommandIndex||command.sessionId!==s.id||!["start-run","resume-run","send-input"].includes(command.kind))continue;const raw=this.readInputCached(commandJournal,command);if(raw===undefined)continue;let text="";try{text=JSON.parse(raw)?.text;}catch{}const images=commandSessionImages(command.sessionId,raw);if((typeof text!=="string"||!text.trim())&&!images.length)continue;const normalized=typeof text==="string"?text:"",count=overlap.get(normalized)??0;if(s.source==="adopted"&&Date.parse(command.acceptedAt)<=copiedAt&&count>0){overlap.set(normalized,count-1);continue;}
inputs.push({role:"user",name:`command:${command.commandId}`,text:images.length?`📎×${images.length}${normalized?` ${normalized}`:""}`:normalized,ts:command.acceptedAt,...(images.length?{images}:{})});}state.messages=[...state.messages,...inputs].sort((a,b)=>(Date.parse(a.ts||"")||0)-(Date.parse(b.ts||"")||0));const resume=!s.archive&&s.nativeRef?resumeFor(s,s.nativeRef):null;Object.assign(state,{resume,fullAccess:s.access==="full-access"||s.access==="bypass"});
    this.stateCache.set(s.id, { signature, state: structuredClone(state) });
    return { signature, state };
  }
  /** 排队消息挂在 state 上返回。必须在 stateCache 之外贴：队列变化不进 signature，
   *  写进缓存的话撤回一条要等下一次 runner journal 变动才看得见。 */
  private withQueue(s:SessionRecord,state:KernelSessionState):KernelSessionState{const queued=this.queue.view(s.id);return queued.length?{...state,queued}:state;}
  private projectHandoffChain(s:SessionRecord,current:KernelSessionState,snapshot?:RunnerSnapshot):KernelSessionState{
    const chain:{session:SessionRecord;state:KernelSessionState}[]=[{session:s,state:current}],seen=new Set([s.id]);let cursor=s,predecessorOmitted=false;
    for(;;){const id=cursor.handoff?.predecessorId;if(!id)break;if(seen.has(id)||chain.length>=1_000){predecessorOmitted=true;break;}const predecessor=this.repo.getById(id);if(!predecessor){predecessorOmitted=true;break;}seen.add(id);chain.unshift({session:predecessor,state:this.runnerState(predecessor,snapshot)});cursor=predecessor;}
    const messages:import("./types.ts").DevMsg[]=[];for(let index=0;index<chain.length;index++){const item=chain[index],internalIds=new Set(this.bridge.list(item.session.id).filter(c=>c.clientMutationId?.startsWith("handoff:")).map(c=>c.commandId));if(index){const previous=chain[index-1].session;messages.push({role:"system",name:"handoff",text:`已从 ${previous.providerId} 接力到 ${item.session.providerId}${previous.handoff?.reason?`：${previous.handoff.reason}`:""}`,ts:item.session.handoff?.at??item.session.createdAt});}for(const message of item.state.messages){const commandId=message.name?.startsWith("command:")?message.name.slice(8):undefined;if(commandId&&internalIds.has(commandId))continue;messages.push(commandId?(({name:_name,...visible})=>visible)(message):message);}}
    let chars=0,messageOmitted=false;const bounded:import("./types.ts").DevMsg[]=[];for(const message of messages.reverse()){if(bounded.length>=200||chars+message.text.length>128_000){messageOmitted=true;break;}chars+=message.text.length;bounded.push(message);}bounded.reverse();
    if(predecessorOmitted||messageOmitted)bounded.unshift({role:"system",name:"history",text:`⚠️ 历史已按显示预算截断${predecessorOmitted?"，部分接力前序不可用":""}${messageOmitted?"，较早消息已省略":""}`,ts:s.updatedAt});
    // 会话谱系：链上每个 Session 一条（含当前），带原生 ID 与恢复命令；被 /new 换掉的旧 ref 也列出——历史"保留"了却查不到入口等于没保留
    const lineage:import("./contracts.ts").SessionLineageEntry[]=chain.map((item,index)=>{const record=item.session,successor=chain[index+1]?.session;return{sessionId:record.id,providerId:record.providerId,...(record.model?{model:record.model}:{}),...(record.effort?{effort:record.effort}:{}),cwd:record.cwd,nativeRef:record.nativeRef,resume:record.nativeRef?resumeFor(record,record.nativeRef):null,createdAt:record.createdAt,...(successor?{handedOffAt:record.handoff?.successorId?record.handoff.at:successor.createdAt,...(record.handoff?.reason?{reason:record.handoff.reason}:{})}:{}),current:index===chain.length-1,...(record.previousRefs?.length?{previousRefs:record.previousRefs.map((ref)=>({nativeRef:ref,resume:resumeFor(record,ref)}))}:{})};});
    return{...current,messages:bounded,lineage,...(s.handoff?.predecessorId?{handoff:{predecessorId:s.handoff.predecessorId,at:s.handoff.at,...(s.handoff.reason?{reason:s.handoff.reason}:{}),currentProviderId:s.providerId}}:{})};
  }
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
  async handoff(id:string,input:{providerId:"claude"|"codex"|"codebuddy";model?:string;effort?:string;reason?:string;confirmUnknownOutcome?:boolean}):Promise<SessionMutationResult & {sessionId:string;providerId:"claude"|"codex"|"codebuddy";inPlace?:true}>{
    if(this.mode!=="runner")throw new KernelSessionPolicyError("SESSION_RUNNER_DISABLED","会话配置接力只支持 Runner Session");
    const old=this.writableSession(id);this.assertOperable(old);const taskId=this.taskId(old,id),options=this.effectiveOptions(input.providerId,input.model,input.effort,old);
    if(old.control!=="ownward")throw new KernelSessionPolicyError("SESSION_CONTROL_REQUIRED","未持有输入权，不能接力");
    if(old.providerId===input.providerId&&(input.model===undefined||old.model===input.model)&&(input.effort===undefined||old.effort===input.effort))throw new KernelSessionPolicyError("SESSION_HANDOFF_SAME_PROVIDER","Provider、模型和思考深度均未变化");
    // 同 Provider 只是换模型/深度：就地改，不接力。接力会新建 Session 并只带 40 条截断快照——原生上下文全丢，
    // 而两家 CLI 本来就支持带新参数续聊。老客户端（安卓/iOS）仍打 handoff 接口，在这里统一改道。
    if(old.providerId===input.providerId){const r=await this.reconfigure(id,{...(input.model!==undefined?{model:input.model}:{}),...(input.effort!==undefined?{effort:input.effort}:{})});return{queued:r.queued,...(r.commandId?{commandId:r.commandId}:{}),...(r.runId?{runId:r.runId}:{}),...(r.outcomeUnknown!==undefined?{outcomeUnknown:r.outcomeUnknown}:{}),sessionId:r.sessionId,providerId:r.providerId,inPlace:true as const};}
    this.runner.require(input.providerId,"stream");await this.reconcile(old);
    if(await this.busy(old))throw new KernelSessionPolicyError("SESSION_HANDOFF_RUNNING","当前轮仍在运行，不能接力");
    if(this.queue.list(old.id).length)throw new KernelSessionPolicyError("SESSION_HANDOFF_QUEUED","存在待发送消息，不能接力");
    const oldState=this.projectHandoffChain(old,this.runnerState(old));if(oldState.pending.length)throw new KernelSessionPolicyError("SESSION_HANDOFF_PENDING","存在待处理审批，不能接力");
    const latestRun=reduceRuns(readRunJournalStrict(this.dataRoot)).filter(run=>run.sessionId===old.id).sort((a,b)=>b.firstSequence-a.firstSequence)[0],unknown=latestRun?.status==="unknown_outcome"&&old.confirmedUnknownRunId!==latestRun.runId;
    if(unknown&&!input.confirmUnknownOutcome)throw new KernelSessionPolicyError("SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED","最新 Run 结果未知，需明确确认后接力；不会重放旧命令");
    if(unknown&&input.confirmUnknownOutcome)this.repo.confirmHandoffUnknown(old.id,latestRun!.runId);
    const reason=(input.reason||(old.providerId===input.providerId?"用户调整模型配置":"用户主动切换引擎")).slice(0,512),transcript=oldState.messages.slice(-40).map(m=>`${m.role}: ${m.text.slice(0,2000)}`).join("\n").slice(-32_000);
    const prompt=["你正在接手另一个 Provider 未完成的任务。请先检查工作区实际状态，再继续执行；不要重放任何旧工具调用或命令。",`接力原因：${reason}`,"以下是有界历史快照：",transcript||"（无可用历史）"].join("\n\n");
    let moved:ReturnType<SessionRepository["handoff"]>;try{moved=this.repo.handoff({taskId,expectedSessionId:old.id,providerId:input.providerId,...options,reason});}catch(error){if(error instanceof SessionRepositoryError&&error.message==="SESSION_HANDOFF_STALE")throw new KernelSessionPolicyError("SESSION_HANDOFF_STALE","会话已被另一个接力请求更新，请刷新后重试");throw error;}
    try{const receipt=await this.submitTurn(moved.current,taskId,{text:prompt,clientMutationId:`handoff:${moved.previous.id}:${input.providerId}`});this.stateCache.delete(moved.previous.id);this.stateCache.delete(moved.current.id);return{...receipt,sessionId:moved.current.id,providerId:input.providerId};}
    catch(error:any){if(error?.outcomeUnknown!==true){if(typeof error?.commandId==="string")this.bridge.abandon(error.commandId,String(error?.code||"RUNNER_SUBMIT_REJECTED"));this.repo.rollbackHandoff(moved.current.id);}throw error;}
  }
  /** 同 Provider 就地改模型/思考深度。两家 CLI 原生都支持带着新参数续聊（claude --resume 加 --model/--effort；
   *  codex exec -m … resume <thread>，2026-09-05 实测 rollout 里逐轮记录的 model 随之切换），所以不走跨 Provider 的
   *  「新建 Session + 重放有界历史」——那条路会丢掉原生上下文（只剩 40 条截断快照）还多花一轮 token。
   *  排队消息不挡：它们是对同一个会话说的，换个模型照样该发；待处理审批要挡：claude 侧要重启 CLI，审批会随进程一起没。 */
  async reconfigure(id:string,input:{model?:string;effort?:string}):Promise<SessionMutationResult & {sessionId:string;providerId:"claude"|"codex"|"codebuddy";model?:string;effort?:string}>{
    if(this.mode!=="runner")throw new KernelSessionPolicyError("SESSION_RUNNER_DISABLED","会话就地改配置只支持 Runner Session");
    const s=this.writableSession(id);this.assertOperable(s);const taskId=this.taskId(s,id),options=this.effectiveOptions(s.providerId,input.model,input.effort,s);
    if(s.control!=="ownward")throw new KernelSessionPolicyError("SESSION_CONTROL_REQUIRED","未持有输入权，不能改配置");
    const patch={...(options.model!==undefined&&options.model!==s.model?{model:options.model}:{}),...(options.effort!==undefined&&options.effort!==s.effort?{effort:options.effort}:{})};
    if(!Object.keys(patch).length)throw new KernelSessionPolicyError("SESSION_RECONFIGURE_NOOP","模型和思考深度均未变化");
    this.runner.require(s.providerId,"set-options");await this.reconcile(s);
    if(await this.busy(s))throw new KernelSessionPolicyError("SESSION_RECONFIGURE_RUNNING","当前轮仍在运行，等结束或中断后再改");
    if(this.projectHandoffChain(s,this.runnerState(s)).pending.length)throw new KernelSessionPolicyError("SESSION_RECONFIGURE_PENDING","存在待处理审批，先处理完再改");
    const command=this.reserveControl(s,taskId,"set-options",patch);let receipt:RunnerCommandReceipt;
    // 确定性失败（Runner 明确拒绝/失败）要把 bridge 上这条控制命令作废，否则它会一直算「进行中」把会话卡成 busy；
    // 结果未知（超时/断线）则留着，按 commandId 补查——与 handoff 同一套处置
    try{receipt=await this.runner.submit(taskId,s,"set-options",patch,command);await this.finishControl(taskId,command);}
    catch(error:any){if(error?.outcomeUnknown!==true)this.bridge.abandon(command.commandId,String(error?.code||"RUNNER_CONTROL_FAILED"));throw error;}
    this.repo.updateOptions(s.id,patch);this.stateCache.delete(s.id);
    return{queued:false,...receipt,sessionId:s.id,providerId:s.providerId,...(options.model?{model:options.model}:{}),...(options.effort?{effort:options.effort}:{})};
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
  async respondApproval(id:string,requestId:string,response:{allow:boolean;message?:string;remember?:"session"|"global"|null}):Promise<SessionMutationResult|void>{if(this.mode!=="runner"){this.legacyGuard(id);const{decidePerm}=await import("../../agent-session.ts");decidePerm(id,requestId,response.allow,response.message,response.remember);return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"approval");await this.reconcile(s);const runId=this.activeRun(s);const requested=this.pendingApproval(s,requestId,runId);const command=this.reserveControl(s,taskId,"approval-response",{requestId,response},{targetRunId:runId}),receipt=await this.runner.approval(s,runId,requestId,response,command);await this.finishControl(taskId,command);if(response.allow&&response.remember)this.rememberApproval(response.remember === "session" ? (s.taskIds[0] ?? s.id) : taskId,requested,response.remember);return{queued:false,...receipt};}
  async addDirectory(id:string,dir:string):Promise<SessionMutationResult|void>{if(this.mode==="off"){this.legacyGuard(id);await(await this.legacy()).addAgentDir(id,dir);return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"add-dir");const actual=validateDirectoryGrant(dir,this.roots),command=this.reserveControl(s,taskId,"add-dir",{dir:actual},{authorizedRoots:this.roots}),receipt=await this.runner.submit(taskId,s,"add-dir",{dir:actual},command);await this.finishControl(taskId,command);this.repo.updateGrants(s.id,{addDirectory:actual});this.stateCache.delete(s.id);return{queued:false,...receipt};}
  async acquireControl(id:string,owner:"ownward"|"observing"):Promise<{sessionId:string;control:"ownward"|"observing"|"external"}>{if(this.mode==="off"){this.legacyGuard(id);const control=await(await this.legacy()).setAgentControl(id,owner==="ownward"?"take":"release");let sessionId=id;try{sessionId=(this.repo.getById(id)??this.repo.getByTaskId(id))?.id??id;}catch{}return{sessionId,control};}const s=this.session(id);this.assertOperable(s);if(owner==="ownward"&&reduceRuns(readRunJournalStrict(this.dataRoot)).some(run=>run.sessionId===s.id&&run.status==="running"))throw new KernelSessionPolicyError("SESSION_CONTROL_BUSY","Run 执行中不能接管输入权");const saved=this.repo.setControl(s.id,owner);
    // 接管回来 = 队列重新有资格发（释放输入权期间 flush 会一直拒绝，见 flushQueue 的租约校验）
    if(owner==="ownward"&&!this.queue.empty())void this.drainQueue(saved.id);
    return{sessionId:saved.id,control:saved.control};}
  async setAccess(id:string,access:KernelGrantedAccess):Promise<SessionMutationResult|void>{if(this.mode==="off"){this.legacyGuard(id);await(await this.legacy()).setAgentAccess(id,access!=="workspace");return;}const s=this.session(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"set-access");if(s.access!=="full-access"&&s.access!=="bypass")this.validateAccessGrant(access);const providerAccess=s.providerId!=="codex"?(access==="workspace"?"standard":"bypass"):(access==="workspace"?"workspace-write":"full-access")/* codebuddy 与 claude 同 access 语义(见 runner-consumer 投影与 inputForRunner)，不能归到 codex 侧，否则 set-access acceptance 校验必抛 CONTROL_GRANT_INVALID */,command=this.reserveControl(s,taskId,"set-access",{access:providerAccess},{authorizedAccess:access}),receipt=await this.runner.submit(taskId,s,"set-access",{access:providerAccess},command);await this.finishControl(taskId,command);this.repo.updateGrants(s.id,{access});this.stateCache.delete(s.id);return{queued:false,...receipt};}
  async newSession(id:string):Promise<string>{if(this.mode==="off"){this.legacyGuard(id);return(await this.legacy()).newAgentSession(id);}const s=this.writableSession(id);this.assertOperable(s);const taskId=this.taskId(s,id);this.runner.require(s.providerId,"new-session");const command=this.reserveControl(s,taskId,"new-session",{});this.repo.beginHistoryReset(s.id,command.commandId);try{await this.runner.submit(taskId,s,"new-session",{},command);await this.finishControl(taskId,command);}catch(error:any){if(error?.outcomeUnknown!==true)this.repo.finishHistoryReset(s.id,command.commandId,false);throw error;}this.repo.finishHistoryReset(s.id,command.commandId,true);this.queue.clear(s.id);/* /new 是丢上下文重开：还排着的话是对旧上下文说的，跟着一起清（legacy 同）*/clearInitialHistory(this.dataRoot,s.id);this.historyMarkers.delete(s.id);this.stateCache.delete(s.id);return"已开启新会话";}
}
