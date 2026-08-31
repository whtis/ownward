import { realpathSync, statSync } from "fs";
import { AGENT_IMAGE_PROVIDER_LINE_MAX_BYTES, contentImageUrls, normalizeClaudeContentImages } from "../../runner/agent-images.ts";
import { readRunnerAttachment } from "../../runner/attachments.ts";
import type { RunnerCommandRecord, RunnerReasonCode } from "../../runner/journals.ts";
import type { ProviderEventInput, RunnerProvider } from "../../runner/server.ts";
import { readClaudeTranscriptAsync } from "../transcript-history-async.ts";
import { emitCoreLog } from "../../kernel/observability/contracts.ts";
import {
  buildClaudeProviderArgs, claudeUserFrame, parseClaudeAccess, parseClaudeAddDir, parseClaudeApprovalInput,
  parseClaudeNewSession, parseClaudeSendInput, parseClaudeStartInput, type ClaudeSessionOptions,
  CLAUDE_PROVIDER_CAPABILITIES, CLAUDE_PROVIDER_ID,
} from "./protocol.ts";

type EventInput = ProviderEventInput;
type ControlWait = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; onAck?: () => void };
type PendingApproval = { requestId: string; runId: string; input: Record<string, unknown>; reserved: boolean };
type Turn = { command: RunnerCommandRecord; queue: AsyncEventQueue; interruptRequested: boolean; terminal: boolean; delta: string; started: boolean; sessionUpdateEmitted: boolean; completion: Promise<void>; complete: () => void; proc?: Bun.Subprocess; generation?: number; initMeta?: { model?: string; commands: string[] }; toolNames?: Map<string, string> };
type ClaudeSession = {
  sessionId: string; cwd: string; options: ClaudeSessionOptions; nativeRef?: string; proc?: Bun.Subprocess; generation: number;
  turn?: Turn; operation?: string; controlOperation?: string; pending: Map<string, PendingApproval>; controls: Map<string, ControlWait>; mutex: AsyncMutex;
  stderrTail: string; invalidLines: number; consecutiveInvalidLines: number; droppedFrames: number;
};
export type ClaudeProviderOptions = { controlAckTimeoutMs?: number; maxInvalidLines?: number; maxStdoutBufferBytes?: number; stderrRingBytes?: number; dataRoot?: string; providerId?: string };

class ProviderError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const providerError = (code: string, message: string) => new ProviderError(code, message);

class AsyncMutex {
  private tail = Promise.resolve();
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const prior = this.tail; this.tail = this.tail.then(() => gate);
    await prior; try { return await fn(); } finally { release(); }
  }
}
class AsyncEventQueue {
  private values: EventInput[] = []; private waiters: Array<(value: IteratorResult<EventInput>) => void> = []; private ended = false;
  push(value: EventInput): void { if (this.ended) return; const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value); }
  end(): void { if (this.ended) return; this.ended = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true }); }
  async *iterate(): AsyncGenerator<EventInput> { while (true) { if (this.values.length) { yield this.values.shift()!; continue; } if (this.ended) return; const next = await new Promise<IteratorResult<EventInput>>((resolve) => this.waiters.push(resolve)); if (next.done) return; yield next.value; } }
}

const at = () => new Date().toISOString();
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const extractText = (content: unknown): string => Array.isArray(content) ? content.filter((item) => plain(item) && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n") : typeof content === "string" ? content : "";
/** tool_result 的 content 拍平：string 直接用，块数组只取 text 块（图片等二进制块丢弃）。 */
const flattenToolResult = (content: unknown): string => typeof content === "string" ? content : extractText(content);
const safeToken = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
// 一次 probe 拿两个能力位：effort（help 文本可见）与 permission-prompt-tool（真 claude 的 help 不列这个隐藏旗标，
// 只能带着旗标跑 --help 看退出码——克隆 CLI（codebuddy）会 unknown option 退非零）。
type CliCapability = { state: "pending" | "ready" | "failed"; effort: boolean; permissionPromptTool: boolean; probe?: Promise<void> };
const cliCapabilities=new Map<string,CliCapability>();

export class ClaudeCodeRunnerProvider implements RunnerProvider {
  // providerId 可参数化：codebuddy（腾讯 CodeBuddy Code）的 CLI 与 stream-json 协议是
  // Claude Code 克隆（-p/--output-format stream-json/--resume/--permission-mode 全同款，
  // 2026-08-20 实测帧同构；差异帧 status:null/file-history-snapshot/双 init 均被既有
  // 幂等与 dropFrame 逻辑兜住），同一 adapter 换命令即成新 Provider
  readonly id: string;
  readonly version = "1.0.0";
  readonly capabilities = CLAUDE_PROVIDER_CAPABILITIES;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly eventSequences = new Map<string, number>();
  readonly metrics = { invalidLines: 0, droppedFrames: 0, notices: 0, aggregatedDeltas: 0, controlTimeouts: 0, effortUnsupported: 0, effortProbePending: 0, effortProbeFailures: 0 };
  private readonly options: Required<Omit<ClaudeProviderOptions, "dataRoot" | "providerId">> & { dataRoot?: string };
  constructor(private readonly claudeCommand: readonly string[] = ["claude"], private readonly env: Record<string, string | undefined> = process.env, options: ClaudeProviderOptions = {}) {
    if (!claudeCommand.length || claudeCommand.some((part) => !part)) throw new Error("Claude command 非法");
    this.id = options.providerId ?? CLAUDE_PROVIDER_ID;
    this.options = { controlAckTimeoutMs: options.controlAckTimeoutMs ?? 5_000, maxInvalidLines: options.maxInvalidLines ?? 3, maxStdoutBufferBytes: options.maxStdoutBufferBytes ?? AGENT_IMAGE_PROVIDER_LINE_MAX_BYTES, stderrRingBytes: options.stderrRingBytes ?? 16 * 1024, dataRoot: options.dataRoot };
  }
  readHistory(input: { nativeRef: string }) {
    // codebuddy 的 transcript 是自有格式（~/.codebuddy/projects/，非 CC 帧结构）——
    // 显式报不支持而不是解析出错误历史；resume 走 --resume 不依赖这里
    if (this.id !== CLAUDE_PROVIDER_ID) return Promise.reject(providerError("PROVIDER_CAPABILITY_UNSUPPORTED", `${this.id} 不支持读取历史`));
    return readClaudeTranscriptAsync(input.nativeRef, this.env.HOME);
  }
  async close(): Promise<void> { await this.shutdown(); }
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.mutex.run(async () => {
        const turn = session.turn; if (turn && !turn.terminal) { turn.terminal = true; turn.queue.end(); }
        this.rejectControls(session, providerError("PROVIDER_UNAVAILABLE", "Claude Provider 正在关闭"));
        await this.stopProcess(session, true);
      });
    }
    this.sessions.clear();
  }
  async abort(command: RunnerCommandRecord): Promise<void> {
    const session = this.sessions.get(command.sessionId); if (!session) return;
    await session.mutex.run(async () => {
      const turn = session.turn; if (!turn || turn.command.commandId !== command.commandId) return;
      turn.terminal = true; turn.queue.end(); this.rejectControls(session, providerError("PROVIDER_UNAVAILABLE", "Provider 所有权已收回")); await this.stopProcess(session, true);
    });
  }

  async *execute(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> {
    try {
      switch (command.kind) {
        case "start-run": yield* this.start(command, input); return;
        case "resume-run": yield* this.resume(command, input); return;
        case "send-input": yield* this.send(command, input); return;
        case "interrupt": yield* this.interrupt(command); return;
        case "approval-response": yield* this.approval(command, input); return;
        case "add-dir": yield* this.addDir(command, input); return;
        case "set-access": yield* this.setAccess(command, input); return;
        case "new-session": yield* this.newSession(command, input); return;
        default: throw providerError("PROVIDER_CAPABILITY_UNSUPPORTED", `Claude Provider 不支持 ${(command as RunnerCommandRecord).kind}`);
      }
    } catch (error) {
      if (error instanceof ProviderError || typeof (error as any)?.code === "string") throw error;
      throw providerError("PROVIDER_INPUT_INVALID", error instanceof Error ? error.message : "Claude command 非法");
    }
  }

  private event(command: RunnerCommandRecord, type: EventInput["type"], extra: Partial<EventInput> = {}, durability?: EventInput["durability"]): EventInput {
    const sequence = (this.eventSequences.get(command.commandId) ?? 0) + 1; this.eventSequences.set(command.commandId, sequence);
    const hash = new Bun.CryptoHasher("sha256").update(command.commandId).digest("hex").slice(0, 24), eventId = `claude:${hash}:${sequence}`;
    if (eventId.length > 128) throw providerError("PROVIDER_PROTOCOL_ERROR", "eventId 超出协议边界");
    return { eventId, type, at: at(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, ...extra, ...(durability ? { durability } : {}) } as EventInput;
  }
  private makeSession(sessionId: string, cwd: string, options: ClaudeSessionOptions, nativeRef?: string): ClaudeSession {
    return { sessionId, cwd: this.validateCwd(cwd), options, nativeRef, generation: 0, pending: new Map(), controls: new Map(), mutex: new AsyncMutex(), stderrTail: "", invalidLines: 0, consecutiveInvalidLines: 0, droppedFrames: 0 };
  }
  private validateCwd(cwd: string): string {
    try { const canonical = realpathSync(cwd); if (!statSync(canonical).isDirectory()) throw new Error("not directory"); return canonical; }
    catch { throw providerError("PROVIDER_CWD_INVALID", "Claude cwd 不存在或不是目录"); }
  }
  private materializeImages(images: import("./protocol.ts").ClaudeImage[]): import("./protocol.ts").ClaudeMaterializedImage[] {
    if (!images.length) return [];
    if (!this.options.dataRoot) throw providerError("PROVIDER_INPUT_INVALID", "Claude 图片需要 Runner dataRoot 读取授权 blob");
    return images.map((image) => ({ mediaType: image.mediaType, data: readRunnerAttachment(this.options.dataRoot!, image.blob) }));
  }
  private async *start(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> {
    const parsed = parseClaudeStartInput(input), existing = this.sessions.get(command.sessionId);
    if (existing) { await this.awaitTerminalCleanup(existing); await existing.mutex.run(async () => { if (existing.turn || existing.operation) throw providerError("PROVIDER_SESSION_BUSY", "Claude session 正在执行"); await this.stopProcess(existing, false); }); }
    const session = this.makeSession(command.sessionId, parsed.cwd, parsed.options); this.sessions.set(command.sessionId, session);
    yield* this.runTurn(session, command, claudeUserFrame(parsed.text, this.materializeImages(parsed.images)));
  }
  private async *send(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> {
    const parsed = parseClaudeSendInput(input); let session = this.sessions.get(command.sessionId);
    if (!session) {
      if (!parsed.cwd || !parsed.options || !parsed.nativeRef) throw providerError("PROVIDER_SESSION_NOT_FOUND", "Runner 重启后 resume 必须显式携带 nativeRef/cwd/options");
      session = this.makeSession(command.sessionId, parsed.cwd, parsed.options, parsed.nativeRef); this.sessions.set(command.sessionId, session);
    } else if (parsed.nativeRef) {
      if (!session.nativeRef || parsed.nativeRef !== session.nativeRef || this.validateCwd(parsed.cwd!) !== session.cwd || JSON.stringify(parsed.options) !== JSON.stringify(session.options)) throw providerError("PROVIDER_INPUT_INVALID", "send-input recovery snapshot 与当前 Session 冲突");
    }
    yield* this.runTurn(session, command, claudeUserFrame(parsed.text, this.materializeImages(parsed.images)));
  }
  private async *resume(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> {
    const parsed = parseClaudeSendInput(input); if (!parsed.cwd || !parsed.options || !parsed.nativeRef) throw providerError("PROVIDER_INPUT_INVALID", "resume-run 必须显式携带 nativeRef/cwd/options");
    let session = this.sessions.get(command.sessionId); const cwd = this.validateCwd(parsed.cwd);
    if (session) { await this.awaitTerminalCleanup(session); session = this.sessions.get(command.sessionId); }
    if (session) {
      await session.mutex.run(() => {
        if (session!.turn || session!.operation) throw providerError("PROVIDER_SESSION_BUSY", "Claude session 正在执行或变更配置");
        if (session!.nativeRef !== parsed.nativeRef || session!.cwd !== cwd || JSON.stringify(session!.options) !== JSON.stringify(parsed.options)) throw providerError("PROVIDER_INPUT_INVALID", "resume-run recovery snapshot 与当前 Session 冲突");
      });
    } else { session = this.makeSession(command.sessionId, cwd, parsed.options, parsed.nativeRef); this.sessions.set(command.sessionId, session); }
    yield* this.runTurn(session, command, claudeUserFrame(parsed.text, this.materializeImages(parsed.images)));
  }
  private async *runTurn(session: ClaudeSession, command: RunnerCommandRecord, frame: string): AsyncIterable<EventInput> {
    await this.awaitTerminalCleanup(session);
    let complete!: () => void; const completion = new Promise<void>((resolve) => { complete = resolve; });
    const queue = new AsyncEventQueue(), turn: Turn = { command, queue, interruptRequested: false, terminal: false, delta: "", started: false, sessionUpdateEmitted: false, completion, complete };
    await session.mutex.run(() => { if (session.turn || session.operation) throw providerError("PROVIDER_SESSION_BUSY", "Claude session 正在执行或变更配置"); session.turn = turn; session.operation = "turn"; });
    try {
      if (!session.proc) await this.spawn(session);
      turn.proc = session.proc; turn.generation = session.generation;
      if (!this.write(session, frame)) throw providerError("PROVIDER_UNAVAILABLE", "Claude stdin 写入失败");
      queue.push(this.event(command, "started", session.nativeRef ? { nativeRef: session.nativeRef } : {})); turn.started = true; this.emitSessionUpdate(session, turn);
      yield* queue.iterate();
    } finally {
      try {
        if (turn.terminal) await this.stopTurnProcess(session, turn);
        await session.mutex.run(() => { if (session.turn === turn) { session.turn = undefined; session.operation = undefined; } for (const [id, pending] of session.pending) if (pending.runId === command.runId) session.pending.delete(id); });
      } finally { turn.complete(); }
    }
  }
  private async *interrupt(command: RunnerCommandRecord): AsyncIterable<EventInput> {
    const session = this.requireSession(command); let turn!: Turn, requestId!: string, ack!: Promise<void>;
    await session.mutex.run(() => {
      turn = session.turn!; if (!turn || turn.terminal || turn.command.runId !== command.runId) throw providerError("PROVIDER_RUN_NOT_ACTIVE", "目标 run 不在执行");
      if (session.controlOperation) throw providerError("PROVIDER_SESSION_BUSY", "Claude control command 正在处理"); session.controlOperation = command.commandId;
      requestId = `ownward-${crypto.randomUUID()}`; ack = this.controlWait(session, requestId, () => { turn.interruptRequested = true; });
    });
    try { yield this.event(command, "started", session.nativeRef ? { nativeRef: session.nativeRef } : {}); if (!this.write(session, JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n")) { this.rejectControl(session, requestId, providerError("PROVIDER_UNAVAILABLE", "Claude interrupt 写入失败")); throw providerError("PROVIDER_UNAVAILABLE", "Claude interrupt 写入失败"); } await ack; yield this.event(command, "completed"); }
    finally { await session.mutex.run(() => { if (session.controlOperation === command.commandId) session.controlOperation = undefined; }); }
  }
  private async *approval(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> {
    const session = this.requireSession(command), parsed = parseClaudeApprovalInput(input), requestId = command.approvalRequestId!; let pending!: PendingApproval, ack!: Promise<void>;
    await session.mutex.run(() => {
      pending = session.pending.get(requestId)!;
      if (!pending || pending.reserved || pending.runId !== parsed.targetRunId || session.turn?.command.runId !== parsed.targetRunId) throw providerError("PROVIDER_APPROVAL_STALE", "审批请求已处理、过期或绑定不匹配");
      if (session.controlOperation) throw providerError("PROVIDER_SESSION_BUSY", "Claude control command 正在处理"); session.controlOperation = command.commandId;
      pending.reserved = true; ack = this.controlWait(session, requestId);
    });
    try {
      yield this.event(command, "started", session.nativeRef ? { nativeRef: session.nativeRef } : {});
      const response = parsed.response === "allow" ? { behavior: "allow", updatedInput: parsed.updatedInput ?? pending.input } : { behavior: "deny", message: parsed.message || "用户拒绝" };
      if (!this.write(session, JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n")) { this.rejectControl(session, requestId, providerError("PROVIDER_UNAVAILABLE", "Claude approval 写入失败")); throw providerError("PROVIDER_UNAVAILABLE", "Claude approval 写入失败"); }
      await ack; await session.mutex.run(() => session.pending.delete(requestId)); yield this.event(command, "completed");
    } catch (error) { await session.mutex.run(() => { pending.reserved = false; }); throw error; }
    finally { await session.mutex.run(() => { if (session.controlOperation === command.commandId) session.controlOperation = undefined; }); }
  }
  private async *addDir(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> { const dir = parseClaudeAddDir(input); yield* this.reconfigure(command, "add-dir", async (session) => { session.options.extraDirs = [...new Set([...session.options.extraDirs, dir])]; }); }
  private async *setAccess(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> { const access = parseClaudeAccess(input); yield* this.reconfigure(command, "set-access", async (session) => { session.options = { ...session.options, access }; }); }
  private async *newSession(command: RunnerCommandRecord, input: string): AsyncIterable<EventInput> {
    parseClaudeNewSession(input); const session = this.requireSession(command);
    await this.reserveIdle(session, "new-session"); try { yield this.event(command, "started"); await this.stopProcess(session, false); session.nativeRef = undefined; session.pending.clear(); yield this.event(command, "session-updated", { payload: JSON.stringify({ nativeRef: null }) }); yield this.event(command, "completed"); } finally { await session.mutex.run(() => { if (session.operation === "new-session") session.operation = undefined; }); }
  }
  private async *reconfigure(command: RunnerCommandRecord, operation: string, mutate: (session: ClaudeSession) => Promise<void>): AsyncIterable<EventInput> {
    const session = this.requireSession(command); await this.reserveIdle(session, operation);
    try { yield this.event(command, "started"); await this.stopProcess(session, false); await mutate(session); yield this.event(command, "completed"); }
    finally { await session.mutex.run(() => { if (session.operation === operation) session.operation = undefined; }); }
  }
  private async reserveIdle(session: ClaudeSession, operation: string): Promise<void> { await this.awaitTerminalCleanup(session); await session.mutex.run(() => { if (session.turn || session.operation) throw providerError("PROVIDER_SESSION_BUSY", "Claude session 正在执行或变更配置"); session.operation = operation; }); }
  private async awaitTerminalCleanup(session: ClaudeSession): Promise<void> {
    const finishing = session.turn?.terminal ? session.turn.completion : undefined; if (!finishing) return;
    const settled = await Promise.race([finishing.then(() => true), Bun.sleep(this.options.controlAckTimeoutMs).then(() => false)]);
    if (!settled) throw providerError("PROVIDER_SESSION_BUSY", "Claude terminal turn 清理超时");
  }
  private requireSession(command: RunnerCommandRecord): ClaudeSession { const session = this.sessions.get(command.sessionId); if (!session) throw providerError("PROVIDER_SESSION_NOT_FOUND", "Claude session 不存在"); return session; }

  private async cliCapability(cleanEnv: Record<string,string|undefined>,waitForProbe:boolean):Promise<CliCapability> {
    const key=`${this.claudeCommand.join("\0")}\0${this.env.FAKE_CLAUDE_EFFORT??""}\0${this.env.FAKE_CLAUDE_HELP_DELAY_MS??""}\0${this.env.FAKE_CLAUDE_HELP_FAIL??""}\0${this.env.FAKE_CLAUDE_PERMISSION_PROMPT_TOOL??""}`;
    let capability=cliCapabilities.get(key);
    if(!capability){capability={state:"pending",effort:false,permissionPromptTool:true};cliCapabilities.set(key,capability);capability.probe=(async()=>{
      const probeRun=async(extra:string[])=>{let proc:Bun.Subprocess|undefined,timer:ReturnType<typeof setTimeout>|undefined;try{proc=Bun.spawn([...this.claudeCommand,...extra],{env:cleanEnv,stdout:"pipe",stderr:"pipe",stdin:"ignore"});timer=setTimeout(()=>{try{proc?.kill("SIGKILL");}catch{}},2_000);const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(),new Response(proc.stderr as ReadableStream<Uint8Array>).text(),proc.exited]);return{code,text:`${stdout}\n${stderr}`};}finally{if(timer)clearTimeout(timer);}};
      try{
        // 只给旗标不给值：已知旗标报 argument missing、未知旗标报 unknown option，都即刻退出不开会话。
        // 不能用「旗标+--help 看退出码」——commander 的 --help 短路在未知旗标校验之前，恒退 0（线上实测）
        const parse=await probeRun(["--permission-prompt-tool"]);
        capability!.permissionPromptTool=!parse.text.includes("unknown option '--permission-prompt-tool'");
        const bare=await probeRun(["--help"]);
        if(bare.code!==0)throw new Error("Claude CLI capability probe failed");
        capability!.effort=bare.text.includes("--effort");
        capability!.state="ready";
      }catch{capability!.state="failed";this.metrics.effortProbeFailures++;}
    })();}
    if(capability.state==="pending"){this.metrics.effortProbePending++;if(waitForProbe)await capability.probe;}
    return capability;
  }

  private async spawn(session: ClaudeSession): Promise<void> {
    const generation = ++session.generation, cleanEnv = { ...this.env, DISABLE_OMC: "1" }; for (const key of Object.keys(cleanEnv)) if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CODEBUDDY_")) delete cleanEnv[key];  // 两家 CLI 的嵌套会话变量都剥，防被当成父会话的子会话
    // 非 bypass 必须等 probe：错发 --permission-prompt-tool 给不认识它的克隆 CLI（codebuddy）会直接 unknown option 崩
    const capability=await this.cliCapability(cleanEnv,!!session.options.effort||session.options.access!=="bypass"),supportsEffort=capability.state==="ready"&&capability.effort;
    if(session.options.effort&&!supportsEffort){this.metrics.effortUnsupported++;throw providerError("PROVIDER_CAPABILITY_UNSUPPORTED",capability.state==="failed"?`${this.id} CLI 无法确认 --effort 支持，已拒绝启动`:`${this.id} CLI 不支持 --effort，已拒绝启动`);}
    const supportsPermissionPromptTool=capability.state!=="ready"||capability.permissionPromptTool;
    let proc: Bun.Subprocess; try { proc = Bun.spawn(buildClaudeProviderArgs(this.claudeCommand, session.options, session.nativeRef,supportsEffort,supportsPermissionPromptTool), { cwd: session.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: cleanEnv }); } catch { throw providerError("PROVIDER_UNAVAILABLE", "无法启动 Claude CLI"); }
    session.proc = proc; void this.readStdout(session, proc, generation); void this.readStderr(session, proc, generation); void proc.exited.then((code) => this.onExit(session, proc, generation, code));
  }
  private async readStdout(session: ClaudeSession, proc: Bun.Subprocess, generation: number): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer) > this.options.maxStdoutBufferBytes) throw providerError("PROVIDER_PROTOCOL_ERROR", "Claude stdout 半行超过上限");
        let newline; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line.trim() && session.proc === proc && session.generation === generation) this.parseLine(session, line); }
      }
      buffer += decoder.decode(); if (buffer.trim() && session.proc === proc && session.generation === generation) this.parseLine(session, buffer);
    } catch (error) { this.failTurn(session, "provider_protocol_error", error instanceof Error ? error.message : "Claude stream parse error"); try { proc.kill("SIGKILL"); } catch {} }
  }
  private parseLine(session: ClaudeSession, line: string): void {
    let raw: unknown; try { raw = JSON.parse(line); }
    catch {
      session.invalidLines++; session.consecutiveInvalidLines++; this.metrics.invalidLines++;
      emitCoreLog({ event: "claude-invalid-json-line", moduleType: "provider", moduleId: this.id, operation: "decode-frame", runId: session.turn?.command.runId, sessionId: session.sessionId, eventId: session.turn?.command.commandId, errorClass: "PROVIDER_FRAME_INVALID", msg: `consecutive=${session.consecutiveInvalidLines} bytes=${Buffer.byteLength(line)}` });
      if (session.consecutiveInvalidLines >= this.options.maxInvalidLines) this.failTurn(session, "provider_protocol_error", "Claude 连续输出非法 JSON"); return;
    }
    session.consecutiveInvalidLines = 0; this.handleFrame(session, raw);
  }
  private async readStderr(session: ClaudeSession, proc: Bun.Subprocess, generation: number): Promise<void> {
    try { const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader(), decoder = new TextDecoder(); while (true) { const { done, value } = await reader.read(); if (done) break; if (session.proc !== proc || session.generation !== generation) return; session.stderrTail = (session.stderrTail + decoder.decode(value, { stream: true })).slice(-this.options.stderrRingBytes); } }
    catch { /* stderr 只是有界诊断，不影响协议状态 */ }
  }
  private handleFrame(session: ClaudeSession, raw: unknown): void {
    if (!plain(raw)) return this.dropFrame(session, "not-object");
    if (raw.isSidechain === true || raw.parent_tool_use_id) return this.dropFrame(session, "sidechain");
    if (raw.type === "control_response") { const id = this.controlResponseId(raw); if (id && session.controls.has(id)) { const wait = session.controls.get(id)!; clearTimeout(wait.timer); session.controls.delete(id); wait.onAck?.(); wait.resolve(); return; } return this.dropFrame(session, "unmatched-control-response"); }
    const turn = session.turn; if (!turn) return this.dropFrame(session, "no-active-turn"); const command = turn.command;
    if (raw.type === "system" && raw.subtype === "init") { if (typeof raw.session_id !== "string" || !raw.session_id) return this.failTurn(session, "provider_protocol_error", "Claude init 缺 session_id"); session.nativeRef = raw.session_id; turn.initMeta = { ...(typeof raw.model === "string" ? { model: raw.model } : {}), commands: Array.isArray(raw.slash_commands) ? raw.slash_commands.filter((v): v is string => typeof v === "string").slice(0, 300) : [] }; this.emitSessionUpdate(session, turn); return; }
    // status 帧只认压缩语义（legacy 同款：其余 status 一律忽略）。以前把未知 status 误标成
    // api_error（空详情）——每个任务开头蹦一条「⚠️ API 错误」，用户以为坏了，实际什么都没坏
    if (raw.type === "system" && raw.subtype === "status") {
      if (raw.status === "compacting") return this.notice(turn, "compacting", {});
      if (raw.compact_result === "failed") return this.notice(turn, "compact_failed", { error: typeof raw.compact_error === "string" ? raw.compact_error : undefined });
      if (raw.compact_result) return this.notice(turn, "compact_ok", {});
      return this.dropFrame(session, `status:${typeof raw.status === "string" ? raw.status.slice(0, 40) : "unknown"}`);  // 可观测地忽略，不装成错误
    }
    // resume 时 CLI 会补发上一轮遗留的后台任务通知（background shell 没有完成记录）。必须透出：
    // agent 上一轮往往承诺了「后台跑完自动怎样」，而那个进程早随上一轮的 CLI 一起没了
    if (raw.type === "system" && raw.subtype === "task_notification") {
      const taskId = typeof raw.task_id === "string" ? raw.task_id : "?", status = typeof raw.status === "string" ? raw.status : "unknown";
      const summary = typeof raw.summary === "string" ? raw.summary.replace(/\s+/g, " ").slice(0, 200) : "";
      return this.notice(turn, "background_task", { message: `上一轮的后台任务 ${taskId} → ${status}${summary ? `：${summary}` : ""}` });
    }
    if (raw.type === "control_request" && plain(raw.request) && raw.request.subtype === "can_use_tool") {
      const requestId = typeof raw.request_id === "string" ? raw.request_id : ""; if (!requestId) return this.failTurn(session, "provider_protocol_error", "Claude approval request 缺 request_id");
      const toolName = typeof raw.request.tool_name === "string" ? raw.request.tool_name : typeof raw.request.toolName === "string" ? raw.request.toolName : "", toolInput = plain(raw.request.input) ? structuredClone(raw.request.input) : {};
      session.pending.set(requestId, { requestId, runId: command.runId, input: toolInput, reserved: false });
      const question = toolName === "AskUserQuestion", first = question && Array.isArray((toolInput as any).questions) ? (toolInput as any).questions[0] : undefined;
      const normalized = question ? { kind: "question", question: typeof first?.question === "string" ? first.question : "Agent 请求用户输入", options: Array.isArray(first?.options) ? first.options.map((option: any) => typeof option?.label === "string" ? option.label : "").filter(Boolean).slice(0, 20) : [] } : { kind: "tool", toolName, input: toolInput };
      turn.queue.push(this.event(command, "approval-requested", { approvalRequestId: requestId, payload: JSON.stringify(normalized) })); return;
    }
    if (raw.type === "stream_event" && plain(raw.event) && plain(raw.event.delta) && raw.event.delta.type === "text_delta" && typeof raw.event.delta.text === "string") { turn.delta += raw.event.delta.text; return; }
    if (raw.type === "assistant" && plain(raw.message)) {
      if (raw.message.model === "<synthetic>") { const text = extractText(raw.message.content).trim(); if (text === "No response requested.") return; const category = /rate|limit|429/i.test(text) ? "rate_limited" : /auth|login|token|credential/i.test(text) ? "auth_expired" : "api_error"; return this.notice(turn, category, { message: text.slice(0, 2_000) }); }
      this.flushDelta(turn);
      const content = raw.message.content, message = { role: "assistant", text: extractText(content), thinking: Array.isArray(content) ? content.filter((item) => plain(item) && item.type === "thinking" && typeof item.thinking === "string").map((item) => item.thinking) : [], tools: Array.isArray(content) ? content.filter((item) => plain(item) && item.type === "tool_use").map((item) => ({ id: item.id, name: item.name, input: item.input })) : [], model: typeof raw.message.model === "string" ? raw.message.model : undefined };
      for (const tool of message.tools) if (typeof tool.id === "string" && typeof tool.name === "string") (turn.toolNames ??= new Map()).set(tool.id, tool.name);  // 给后续 tool_result 配名
      turn.queue.push(this.event(command, "message-completed", { payload: JSON.stringify(message) })); turn.queue.push(this.event(command, "usage", { payload: JSON.stringify({ scope: "request", ...normalizeUsage(raw.message.usage) }) }, "best-effort")); return;
    }
    if (raw.type === "user" && plain(raw.message)) {
      const content = normalizeClaudeContentImages(this.options.dataRoot, session.sessionId, raw.message.content), items = Array.isArray(content) ? content.filter((item) => plain(item) && item.type === "tool_result") : [];
      const errors = items.filter((item) => item.is_error).map((item) => item.content);
      if (errors.length) turn.queue.push(this.event(command, "message-completed", { payload: JSON.stringify({ role: "tool", error: true, content: errors }) }));
      // 成功的工具结果也入 journal（终端能看到，控制台不该缺）：每条截 2000、每帧合计 8000 有界；
      // 图片块（截图/Read 图片）落 agent-images 仓（内容寻址、有界、观测数据），payload 只带 URL
      let budget = 8_000; const results: { name: string; content: string; images?: string[] }[] = [];
      for (const item of items) {
        if (item.is_error) continue;
        const images = contentImageUrls(item.content);
        const text = budget > 0 ? flattenToolResult(item.content).trim().slice(0, Math.min(2_000, budget)) : "";
        if (!text && !images.length) continue;
        budget -= text.length;
        results.push({ name: turn.toolNames?.get(typeof item.tool_use_id === "string" ? item.tool_use_id : "") ?? "", content: text, ...(images.length ? { images } : {}) });
      }
      if (results.length) turn.queue.push(this.event(command, "message-completed", { payload: JSON.stringify({ role: "tool-result", results }) }));
      return;
    }
    if (raw.type === "result") {
      // 上面那条后台任务通知在 CLI 里是一个独立的伪 turn（init + result(origin.kind="task-notification")），
      // 跟用户这条消息无关。认它作 turn 终结 → runTurn 立刻 SIGKILL CLI，而用户的消息还没被 CLI 从
      // stdin 读走，随进程一起蒸发；run 却记成 completed，前端连个提示都没有
      // （2026-08-31 实撞：会话上一轮留了个活着的后台任务，此后每条消息都被静默吞掉，且永久复发）
      if (plain(raw.origin) && raw.origin.kind === "task-notification") return this.dropFrame(session, "task-notification-result");
      this.flushDelta(turn); turn.queue.push(this.event(command, "usage", { payload: JSON.stringify({ scope: "turn", ...normalizeUsage(raw.usage) }) }, "best-effort"));
      const type = raw.is_error ? (turn.interruptRequested ? "interrupted" : "failed") : "completed"; if (raw.is_error) this.notice(turn, "api_error", { subtype: raw.subtype ?? null, result: typeof raw.result === "string" ? raw.result.slice(0, 2_000) : undefined });
      turn.terminal = true; turn.queue.push(this.event(command, type, type === "interrupted" ? { reason: "user_interrupt" } : type === "failed" ? { reason: "provider_result_error" } : {})); turn.queue.end(); return;
    }
    this.dropFrame(session, "unsupported-frame");
  }
  private flushDelta(turn: Turn): void { if (!turn.delta) return; const text = turn.delta; turn.delta = ""; this.metrics.aggregatedDeltas++; turn.queue.push(this.event(turn.command, "delta", { payload: JSON.stringify({ role: "assistant", text }) }, "best-effort")); }
  private emitSessionUpdate(session: ClaudeSession, turn: Turn): void { if (!turn.started || turn.sessionUpdateEmitted || !session.nativeRef || !turn.initMeta) return; turn.sessionUpdateEmitted = true; turn.queue.push(this.event(turn.command, "session-updated", { nativeRef: session.nativeRef, payload: JSON.stringify({ nativeRef: session.nativeRef, ...turn.initMeta }) })); }
  private notice(turn: Turn, category: "rate_limited" | "auth_expired" | "api_error" | "compacting" | "compact_failed" | "compact_ok" | "stderr" | "background_task", detail: Record<string, unknown>): void { this.metrics.notices++; turn.queue.push(this.event(turn.command, "provider-notice", { payload: JSON.stringify({ category, ...detail }) }, "best-effort")); }
  private dropFrame(session: ClaudeSession, reason: string): void { session.droppedFrames++; this.metrics.droppedFrames++; emitCoreLog({ event: "claude-frame-dropped", moduleType: "provider", moduleId: this.id, operation: "decode-frame", runId: session.turn?.command.runId, sessionId: session.sessionId, eventId: session.turn?.command.commandId, errorClass: "PROVIDER_FRAME_DROPPED", msg: `reason=${reason} total=${session.droppedFrames}` }); }
  private onExit(session: ClaudeSession, proc: Bun.Subprocess, generation: number, code: number): void {
    if (session.proc !== proc || session.generation !== generation) return; session.proc = undefined; const turn = session.turn; if (!turn || turn.terminal) return;
    if (session.stderrTail) this.notice(turn, "stderr", { tail: session.stderrTail }); turn.terminal = true; turn.queue.push(this.event(turn.command, turn.interruptRequested ? "interrupted" : "failed", turn.interruptRequested ? { reason: "user_interrupt", exitCode: code } : { reason: "provider_exit", exitCode: code })); turn.queue.end();
  }
  private failTurn(session: ClaudeSession, reason: RunnerReasonCode, detail: string): void { const turn = session.turn; if (!turn || turn.terminal) return; this.notice(turn, "api_error", { message: detail.slice(0, 2_000) }); turn.terminal = true; turn.queue.push(this.event(turn.command, "failed", { reason })); turn.queue.end(); }
  private controlWait(session: ClaudeSession, requestId: string, onAck?: () => void): Promise<void> {
    if (session.controls.has(requestId)) throw providerError("PROVIDER_APPROVAL_STALE", "control request 已在等待 ack");
    return new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { session.controls.delete(requestId); this.metrics.controlTimeouts++; reject(providerError("PROVIDER_NO_ACK", "Claude control request 未确认")); }, this.options.controlAckTimeoutMs); session.controls.set(requestId, { resolve, reject, timer, ...(onAck ? { onAck } : {}) }); });
  }
  private controlResponseId(raw: Record<string, unknown>): string | undefined { const response = plain(raw.response) ? raw.response : undefined; return typeof raw.request_id === "string" ? raw.request_id : typeof response?.request_id === "string" ? response.request_id : undefined; }
  private rejectControl(session: ClaudeSession, requestId: string, error: Error): void { const wait = session.controls.get(requestId); if (!wait) return; clearTimeout(wait.timer); session.controls.delete(requestId); wait.reject(error); }
  private rejectControls(session: ClaudeSession, error: Error): void { for (const id of [...session.controls.keys()]) this.rejectControl(session, id, error); }
  private write(session: ClaudeSession, value: string): boolean { try { const stdin = session.proc?.stdin as any; if (!stdin) return false; const result = stdin.write(value); stdin.flush?.(); return result !== false && result !== 0; } catch { return false; } }
  private async stopProcess(session: ClaudeSession, settleActive: boolean): Promise<void> { if (session.turn && !settleActive) throw providerError("PROVIDER_SESSION_BUSY", "不能停止 active Claude turn"); const proc = session.proc; if (!proc) return; session.proc = undefined; session.generation++; try { proc.kill("SIGKILL"); } catch {} await proc.exited.catch(() => -1); }
  private async stopTurnProcess(session: ClaudeSession, turn: Turn): Promise<void> {
    const proc = turn.proc; if (!proc || session.turn !== turn || session.proc !== proc || session.generation !== turn.generation) return;
    session.proc = undefined; session.generation++; try { proc.kill("SIGKILL"); } catch {} await proc.exited.catch(() => -1);
  }
  private sessionHash(sessionId: string): string { return new Bun.CryptoHasher("sha256").update(sessionId).digest("hex").slice(0, 12); }
}

function normalizeUsage(raw: unknown): { inputTokens: number; outputTokens: number; contextTokens: number } {
  const value = plain(raw) ? raw : {}, direct = safeToken(value.input_tokens), cacheRead = safeToken(value.cache_read_input_tokens), cacheCreate = safeToken(value.cache_creation_input_tokens), output = safeToken(value.output_tokens);
  return { inputTokens: direct + cacheRead + cacheCreate, outputTokens: output, contextTokens: direct + cacheRead + cacheCreate };
}
