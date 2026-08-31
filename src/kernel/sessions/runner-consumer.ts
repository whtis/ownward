import { randomUUID } from "crypto";
import { realpathSync, statSync } from "fs";
import { isAbsolute, relative } from "path";
import { expandCodexHome } from "../../sessions/provider-home.ts";
import { RunnerClient } from "../../runner/client.ts";
import { stageRunnerAttachment } from "../../runner/attachments.ts";
import type { DevMsg } from "./types.ts";
import { RunnerCommandJournal, RunnerEventJournal, type RunnerCommandRecord, type RunnerEventRecord } from "../../runner/journals.ts";
import { RunRepository, type RunEvent } from "../../runs/repository.ts";
import { SessionRepository, type SessionRecord, type SessionProviderId } from "../../sessions/repository.ts";
import type { KernelGrantedAccess, SessionCapability, SessionInput } from "./contracts.ts";
import { SessionRunnerBridgeStore, type BridgeCommand } from "./bridge-store.ts";
import { readInitialHistory } from "./initial-history.ts";

export const PROVIDER_CAPABILITIES: Readonly<Record<SessionProviderId, ReadonlySet<SessionCapability>>> = {
  claude: new Set(["stream", "resume", "interrupt", "approval", "images", "tools", "add-dir", "set-access", "new-session"]),
  codex: new Set(["stream", "resume", "interrupt", "images", "tools", "add-dir", "set-access", "new-session"]),
  // CodeBuddy 走 Claude Code 协议克隆：能力面近 claude，但 CLI 无 --permission-prompt-tool（审批桥）→ 不声明 approval；
  // transcript 是私有格式，无 history 能力（adapter readHistory 会拒）
  codebuddy: new Set(["stream", "resume", "interrupt", "images", "tools", "add-dir", "set-access", "new-session"]),
};

export class KernelSessionPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "KernelSessionPolicyError"; this.code = code; }
}
export class KernelMutationError extends KernelSessionPolicyError {
  readonly commandId: string; readonly runId: string; readonly outcomeUnknown: boolean;
  constructor(code: string, message: string, receipt: RunnerCommandReceipt, outcomeUnknown: boolean) { super(code, message); this.name = "KernelMutationError"; this.commandId = receipt.commandId; this.runId = receipt.runId; this.outcomeUnknown = outcomeUnknown; }
}

function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function validateDirectoryGrant(dir: string, roots: readonly string[]): string {
  if (!isAbsolute(dir)) throw new KernelSessionPolicyError("SESSION_CWD_NOT_GRANTED", "目录必须是绝对路径");
  let actual: string; try { actual = realpathSync(dir); if (!statSync(actual).isDirectory()) throw new Error(); }
  catch { throw new KernelSessionPolicyError("SESSION_CWD_NOT_GRANTED", "目录不存在或不是目录"); }
  const allowed = roots.map((r) => { try { return realpathSync(r); } catch { return ""; } }).filter(Boolean);
  if (!allowed.some((root) => contains(root, actual))) throw new KernelSessionPolicyError("SESSION_CWD_NOT_GRANTED", "目录不在 Kernel 授权 roots 内");
  return actual;
}

export interface RunnerCommandReceipt { commandId: string; runId: string; }
export class RunnerSessionConsumer {
  constructor(readonly dataRoot: string, private readonly clientFactory = () => new RunnerClient(dataRoot), private readonly uuid: () => string = randomUUID) {}
  private openClient(): RunnerClient { try { return this.clientFactory(); } catch (error) { throw new KernelSessionPolicyError("RUNNER_UNAVAILABLE", `Runner 不可用：${error instanceof Error ? error.message : String(error)}`); } }
  require(providerId: SessionProviderId, capability: SessionCapability): void {
    if (!PROVIDER_CAPABILITIES[providerId].has(capability)) throw new KernelSessionPolicyError("PROVIDER_CAPABILITY_UNSUPPORTED", `${providerId} 不支持 ${capability}`);
  }
  async readHistory(input: { providerId: SessionProviderId; nativeRef: string; providerHome?: string; cwd?: string }): Promise<DevMsg[]> { const client = this.openClient(); try { const response = await client.readHistory(input); const messages = response.body.messages; if (!Array.isArray(messages) || messages.some((m: any) => !m || !["user", "assistant", "tool", "system"].includes(m.role) || typeof m.text !== "string")) throw new KernelSessionPolicyError("RUNNER_HISTORY_INVALID", "Runner 历史响应非法"); const stamp = new Date().toISOString(); return messages.filter((m:any)=>!(m.role==="system"&&["history","diagnostic"].includes(String(m.name||"")))).map((m: any) => ({ role: m.role, text: m.text, ...(typeof m.name === "string" ? { name: m.name } : {}), ts: typeof m.ts === "string" && Number.isFinite(Date.parse(m.ts)) ? new Date(m.ts).toISOString() : stamp })); } finally { client.close(); } }
  async submit(taskId: string, session: SessionRecord, kind: "start-run" | "resume-run" | "send-input" | "add-dir" | "set-access" | "new-session", input: unknown, identity?: RunnerCommandReceipt): Promise<RunnerCommandReceipt> {
    const commandId = identity?.commandId ?? this.uuid(), runId = identity?.runId ?? this.uuid(), receipt = { commandId, runId }; let client: RunnerClient;
    try { client = this.openClient(); } catch (error: any) { throw new KernelMutationError(error?.code || "RUNNER_UNAVAILABLE", "Runner 不可用", receipt, false); }
    try {
      // 只有 Agent turn 是 Run；配置控制命令仍由 Runner command journal 审计，不污染 runs.jsonl。
      if (kind === "start-run" || kind === "resume-run" || kind === "send-input") new RunRepository(this.dataRoot).append({ schemaVersion: 1, eventId: `runner:accepted:${commandId}`, type: "command-accepted", at: new Date().toISOString(), commandId, runId, taskId, sessionId: session.id, providerId: session.providerId });
      try { await client.request("submit", { commandId, kind, runId, sessionId: session.id, providerId: session.providerId, input: JSON.stringify(input) }); }
      catch (error: any) { const uncertain = error?.code === "RUNNER_REQUEST_OUTCOME_UNKNOWN"; throw new KernelMutationError(error?.code || "RUNNER_UNAVAILABLE", uncertain ? "Runner 命令结果未知" : "Runner 拒绝命令", receipt, uncertain); }
      return receipt;
    } finally { client.close(); }
  }
  async interrupt(session: SessionRecord, targetRunId: string, identity?: RunnerCommandReceipt): Promise<RunnerCommandReceipt> {
    this.require(session.providerId, "interrupt"); const receipt = identity ?? { commandId: this.uuid(), runId: targetRunId }; let client: RunnerClient; try { client = this.openClient(); } catch (error: any) { throw new KernelMutationError(error?.code || "RUNNER_UNAVAILABLE", "Runner 不可用", receipt, false); }
    try { try { await client.request("interrupt", { commandId: receipt.commandId, runId: targetRunId, sessionId: session.id, providerId: session.providerId }); } catch (error: any) { const uncertain = error?.code === "RUNNER_REQUEST_OUTCOME_UNKNOWN"; throw new KernelMutationError(error?.code || "RUNNER_UNAVAILABLE", uncertain ? "Runner 中断结果未知" : "Runner 拒绝中断", receipt, uncertain); } return receipt; }
    finally { client.close(); }
  }
  async approval(session: SessionRecord, targetRunId: string, requestId: string, response: { allow: boolean; message?: string; remember?: "session" | "global" | null }, identity?: RunnerCommandReceipt): Promise<RunnerCommandReceipt> {
    this.require(session.providerId, "approval"); const receipt = identity ?? { commandId: this.uuid(), runId: targetRunId }; let client: RunnerClient; try { client = this.openClient(); } catch (error: any) { throw new KernelMutationError(error?.code || "RUNNER_UNAVAILABLE", "Runner 不可用", receipt, false); }
    try { try { await client.request("approval-response", { commandId: receipt.commandId, runId: targetRunId, sessionId: session.id, providerId: session.providerId, approvalRequestId: requestId, input: JSON.stringify({ targetRunId, response: response.allow ? "allow" : "deny", ...(response.message ? { message: response.message } : {}), ...(response.remember !== undefined && response.remember !== null ? { remember: response.remember } : {}) }) }); } catch (error: any) { const uncertain = error?.code === "RUNNER_REQUEST_OUTCOME_UNKNOWN"; throw new KernelMutationError(error?.code || "RUNNER_UNAVAILABLE", uncertain ? "Runner 审批结果未知" : "Runner 拒绝审批", receipt, uncertain); } return receipt; }
    finally { client.close(); }
  }
  private async syncWithClient(client: RunnerClient, taskId: string, commandId: string, initialCursor = 0): Promise<RunnerEventRecord[]> {
    const found: RunnerEventRecord[] = []; let afterSequence = initialCursor; const projection = new RunnerEventProjector(this.dataRoot);
    for (;;) {
      const response = await client.queryCommand(commandId, undefined, { afterSequence, limit: 500 });
      const events = Array.isArray(response.body.events) ? response.body.events as unknown as RunnerEventRecord[] : [];
      for (const event of events) { projection.apply(taskId, event); found.push(event); afterSequence = Math.max(afterSequence, event.sequence); }
      if (!response.body.truncated || events.length === 0) break;
    }
    return found;
  }
  async syncCommand(taskId: string, commandId: string, afterSequence = 0): Promise<RunnerEventRecord[]> {
    const client = this.openClient();
    try {
      return await this.syncWithClient(client, taskId, commandId, afterSequence);
    } finally { client.close(); }
  }
  async waitTerminal(taskId: string, commandId: string, timeoutMs = 5_000, initialCursor = 0, receipt: RunnerCommandReceipt = { commandId, runId: commandId }): Promise<RunnerEventRecord[]> {
    const deadline = Date.now() + timeoutMs, client = this.openClient(); let cursor = initialCursor; const all: RunnerEventRecord[] = [];
    try { while (Date.now() < deadline) { const next = await this.syncWithClient(client, taskId, commandId, cursor); all.push(...next); for (const e of next) cursor = Math.max(cursor, e.sequence); const terminal = all.find((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type)); if (terminal) { if (terminal.type !== "completed") throw new KernelSessionPolicyError("RUNNER_CONTROL_FAILED", `Runner control ${terminal.type}:${terminal.reason ?? "unknown"}`); return all; } await Bun.sleep(20); } }
    catch (error: any) { if (error instanceof KernelMutationError) throw error; if (error?.code === "RUNNER_REQUEST_OUTCOME_UNKNOWN" || /ENOENT|connect/i.test(String(error))) throw new KernelMutationError("RUNNER_UNAVAILABLE", "Runner 不可用；请按原 commandId 补查", receipt, true); if (error instanceof KernelSessionPolicyError) throw new KernelMutationError(error.code, error.message, receipt, error.code === "RUNNER_CONTROL_TIMEOUT" || /unknown-outcome/.test(error.message)); throw error; }
    finally { client.close(); }
    throw new KernelMutationError("RUNNER_CONTROL_TIMEOUT", "Runner control 结果未知；请按 commandId 查询", receipt, true);
  }
}

const terminalMap: Partial<Record<RunnerEventRecord["type"], RunEvent["type"]>> = {
  completed: "run-completed", failed: "run-failed", interrupted: "run-interrupted", "unknown-outcome": "run-unknown-outcome",
};
/** Runner journal -> Kernel repositories. Push 只是提示；调用方必须分页 query 后传入这里。 */
export function projectRunnerEvent(dataRoot: string, taskId: string, event: RunnerEventRecord): void {
  new RunnerEventProjector(dataRoot).apply(taskId, event);
}

class RunnerEventProjector {
  private readonly runRepo: RunRepository; private readonly accepted: Set<string>; private readonly commands: Map<string, RunnerCommandRecord>; private readonly commandJournal: RunnerCommandJournal;
  constructor(readonly dataRoot: string) { this.runRepo = new RunRepository(dataRoot); this.accepted = new Set(this.runRepo.readStrict().map((e) => e.commandId)); this.commandJournal = new RunnerCommandJournal(dataRoot); this.commands = new Map(this.commandJournal.readStrict().map((c) => [c.commandId, c])); }
  apply(taskId: string, event: RunnerEventRecord): void {
  const sessionRepo = new SessionRepository(this.dataRoot), session = sessionRepo.getById(event.sessionId);
  if (!session || session.providerId !== event.providerId || !session.taskIds.includes(taskId)) throw new KernelSessionPolicyError("SESSION_PROVIDER_DRIFT", "Runner event 与持久化 Session 身份不一致");
  const command = this.commands.get(event.commandId), kind = command?.kind; if (!this.accepted.has(event.commandId) && (kind === "start-run" || kind === "resume-run" || kind === "send-input")) throw new KernelSessionPolicyError("RUN_BRIDGE_ACCEPTED_MISSING", "Runner turn event 缺少 Kernel accepted hard gate");
  if (event.type === "session-updated") {
    const raw = new RunnerEventJournal(this.dataRoot).readPayload(event), body = raw ? JSON.parse(raw) : null;
    const bridge = new SessionRunnerBridgeStore(this.dataRoot); if (!bridge.isNewSessionEvent(session.id, event.at, event.eventId)) return;
    if (body?.nativeRef === null) { sessionRepo.clearNativeRef(session.id); bridge.markSessionEvent(session.id, event.at, event.eventId); return; }
    const nativeRef = typeof body?.nativeRef === "string" ? body.nativeRef : event.nativeRef;
    if (!nativeRef) throw new KernelSessionPolicyError("SESSION_NATIVE_REF_INVALID", "session-updated 缺少 nativeRef");
    sessionRepo.bind({ taskId, providerId: session.providerId, nativeRef, ...(session.providerHome ? { providerHome: session.providerHome } : {}), cwd: session.cwd, control: session.control }); bridge.markSessionEvent(session.id, event.at, event.eventId);
    return;
  }
  if (event.type === "completed" && command && (kind === "add-dir" || kind === "set-access")) { const acceptance = new SessionRunnerBridgeStore(this.dataRoot).list(session.id).find((c) => c.commandId === command.commandId && c.runId === command.runId && c.kind === kind && c.providerId === session.providerId); if (!acceptance) throw new KernelSessionPolicyError("CONTROL_ACCEPTED_MISSING", "Control grant 缺少 Kernel acceptance"); const raw = this.commandJournal.readInput(command), body = raw ? JSON.parse(raw) : {}; if (kind === "add-dir") { if (typeof body.dir !== "string" || !acceptance.authorizedRoots) throw new KernelSessionPolicyError("CONTROL_GRANT_INVALID", "add-dir acceptance 非法"); const actual = validateDirectoryGrant(body.dir, acceptance.authorizedRoots); sessionRepo.updateGrants(session.id, { addDirectory: actual }); } if (kind === "set-access") { const granted = acceptance.authorizedAccess, expected = granted === "workspace" ? (session.providerId !== "codex" ? "standard" : "workspace-write") : session.providerId !== "codex" ? "bypass" : "full-access"; if (!granted || body.access !== expected) throw new KernelSessionPolicyError("CONTROL_GRANT_INVALID", "set-access acceptance 漂移"); sessionRepo.updateGrants(session.id, { access: granted }); } }
  if (!this.accepted.has(event.commandId)) return;
  const common = { schemaVersion: 1 as const, eventId: `runner:${event.eventId}`, at: event.at, commandId: event.commandId, runId: event.runId, taskId, sessionId: event.sessionId, providerId: event.providerId };
  let projected: RunEvent | null = event.type === "dispatching" ? { ...common, type: "run-dispatching" }
    : event.type === "started" ? { ...common, type: "run-started" }
    : terminalMap[event.type] ? { ...common, type: terminalMap[event.type]!, ...(event.reason ? { reason: event.reason } : {}) } as RunEvent : null;
  if (projected) this.runRepo.append(projected);
  }
}

/** 工具入参一行摘要（legacy toolBrief 语义）：给会话视图和审批投影共用。 */
export function toolBrief(input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.prompt || input.description || input.query || input.url || "";
  return String(v).replace(/\s+/g, " ").slice(0, 160);
}
/** tool_result 的 content 拍平成纯文本（string 或 [{type:"text",text}]，其余丢弃）。 */
function flatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((i: any) => i && typeof i === "object" && i.type === "text" && typeof i.text === "string").map((i: any) => i.text).join("\n");
}

/** 审批卡投影：runner payload 是归一化的 {kind:"question"|"tool",...}，但 web/安卓的
 *  渲染都长在 legacy 形状上（toolName/brief/input.questions[0].options[].label）——
 *  两种形状都给，客户端零改动可用，新字段（kind/question/options）留给未来 UI。 */
function pendingView(requestId: string | undefined, body: any, at: string): Record<string, unknown> {
  const base = { requestId, at, ...(body && typeof body === "object" ? body : {}) };
  if (body?.kind === "question") {
    const question = typeof body.question === "string" ? body.question : "agent 有问题要问";
    const options = Array.isArray(body.options) ? body.options.filter((o: unknown): o is string => typeof o === "string") : [];
    return { ...base, toolName: "AskUserQuestion", brief: `${question.slice(0, 140)}${options.length ? `（选项: ${options.slice(0, 4).join(" / ")}）` : ""}`, input: { questions: [{ question, options: options.map((label) => ({ label })) }] } };
  }
  if (body?.kind === "tool") {
    const toolName = typeof body.toolName === "string" ? body.toolName : "unknown-tool";
    return { ...base, toolName, brief: `${toolName}: ${toolBrief(body.input)}` };
  }
  return base;  // legacy/未知形状原样透传
}

/** 兼容 Web AgentState 的纯投影；正文只能由 journal payload loader 显式提供。 */
export class RunnerAgentStateProjector {
  private readonly messages: DevMsg[] = []; private partial = ""; private turn = "idle"; private pending: unknown[] = []; private tokens: Record<string, unknown> = {}; private lastActivityAt = 0;
  private plan: unknown[] = []; private commands: string[] | undefined; private model: string | undefined; private ctxTokens = 0; private cumInput = 0; private cumOutput = 0;
  constructor(private readonly session: SessionRecord, private readonly payload: (event: RunnerEventRecord) => unknown, private readonly command: (commandId: string) => Pick<RunnerCommandRecord, "kind" | "approvalRequestId"> | undefined = () => ({ kind: "start-run" }), initial: DevMsg[] = []) { this.messages.push(...structuredClone(initial)); }
  apply(event: RunnerEventRecord): void {
    if (event.sessionId !== this.session.id || event.providerId !== this.session.providerId) throw new KernelSessionPolicyError("SESSION_PROVIDER_DRIFT", "事件身份漂移");
    this.lastActivityAt = Math.max(this.lastActivityAt, Date.parse(event.at) || 0);
    const body: any = event.payloadRef ? this.payload(event) : null;
    const command = this.command(event.commandId), isTurn = command?.kind === "start-run" || command?.kind === "resume-run" || command?.kind === "send-input";
    if (event.type === "started" && isTurn) this.turn = "running";
    else if (event.type === "delta") this.partial += typeof body === "string" ? body : String(body?.text ?? "");
    else if (event.type === "message-completed") this.applyMessage(body, event.at);
    else if (event.type === "provider-notice") this.applyNotice(body, event.at);
    else if (event.type === "session-updated" && body && typeof body === "object") {
      if (Array.isArray(body.commands)) this.commands = body.commands.filter((c: unknown): c is string => typeof c === "string").slice(0, 300);
      if (typeof body.model === "string" && body.model) this.model = body.model;
    }
    else if (event.type === "approval-requested") this.pending.push(pendingView(event.approvalRequestId, body, event.at));
    else if (event.type === "usage" && body && typeof body === "object") {
      // ctx 占用只认 request 级 usage（assistant 帧单次；turn 级是整轮聚合）。
      if (body.scope === "request" && Number.isFinite(body.contextTokens)) this.ctxTokens = body.contextTokens;
      // turn 级累计出 legacy 别名（input/output/total）：web 的 token pill 和安卓的信息面板
      // 都读旧键——runner 只给 inputTokens/outputTokens 时它们恒显 0
      if (body.scope === "turn") { this.cumInput += Number(body.inputTokens) || 0; this.cumOutput += Number(body.outputTokens) || 0; }
      this.tokens = { ...this.tokens, ...body, input: this.cumInput, output: this.cumOutput, total: this.cumInput + this.cumOutput };
    }
    else if (["completed", "failed", "interrupted", "unknown-outcome"].includes(event.type) && isTurn) { this.turn = "idle"; this.pending = []; this.partial = ""; }
    else if (["completed", "failed"].includes(event.type) && command?.kind === "approval-response") this.pending = this.pending.filter((p: any) => p.requestId !== command.approvalRequestId);
  }
  /** message-completed 完整展开成 legacy 形状的多条消息。原实现只取 body.text，
   *  thinking/工具行/工具报错/codex 的命令执行全被丢——「控制台比终端少内容」的根源。 */
  private applyMessage(body: any, at: string): void {
    if (!body || typeof body !== "object") { const text = typeof body === "string" ? body : ""; if (text) this.messages.push({ role: "assistant", text, ts: at }); this.partial = ""; return; }
    // claude 工具报错（adapter 既有 payload：{role:"tool",error:true,content[]}）
    if (body.role === "tool" && body.error) { const txt = (Array.isArray(body.content) ? body.content.map(flatContent).join("\n") : flatContent(body.content)).trim(); if (txt) this.messages.push({ role: "tool", name: "⚠️ 出错", text: txt.slice(0, 500), ts: at }); return; }
    // claude 成功工具结果（payload：{role:"tool-result",results:[{name,content,images?}]}）
    if (body.role === "tool-result" && Array.isArray(body.results)) {
      for (const r of body.results.slice(0, 20)) {
        const txt = String(r?.content ?? "").trim();
        // 图片 URL 只放行我们自己的仓路径——payload 虽来自可信 adapter，磁盘一律当外部输入
        const images = Array.isArray(r?.images) ? r.images.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("/api/agent-image/")).slice(0, 8) : [];
        if (!txt && !images.length) continue;
        this.messages.push({
          role: "tool",
          name: txt ? `↳ ${String(r?.name || "结果").slice(0, 40)}` : "image",
          text: txt ? txt.slice(0, 2000) : `🖼 图片 ×${images.length}`,
          ts: at,
          ...(images.length ? { images } : {}),
        });
      }
      return;
    }
    // codex 泛型 item（{role,type,item}）：命令执行/文件改动/搜索/思考/计划
    if (typeof body.type === "string" && body.item && typeof body.item === "object") { this.applyCodexItem(body.role, body.type, body.item, at); return; }
    // claude assistant 帧：thinking[] + text + tools[]（截断与 legacy push 一致）
    for (const think of Array.isArray(body.thinking) ? body.thinking : []) if (typeof think === "string" && think.trim()) this.messages.push({ role: "thinking", text: think.slice(0, 2000), ts: at });
    const text = typeof body.text === "string" ? body.text : String(body.text ?? this.partial);
    if (text.trim()) this.messages.push({ role: "assistant", text: text.slice(0, 6000), ts: at });
    for (const tool of Array.isArray(body.tools) ? body.tools : []) if (tool && typeof tool.name === "string") this.messages.push({ role: "tool", name: tool.name, text: toolBrief(tool.input), ts: at });
    this.partial = "";
  }
  private applyCodexItem(role: unknown, kind: string, item: any, at: string): void {
    if (role === "plan") {
      const raw = item.items ?? item.plan ?? item.todos;
      // 归一化成 legacy {text,status}：todo_list 给 {text,completed}、plan_update 给 {step,status}，
      // web 的 plan-box 和安卓的 PlanStrip 都只认 text/status（原样透传会进度恒 0、文本全空）
      if (Array.isArray(raw)) this.plan = raw.filter((p: any) => p && typeof p === "object").map((p: any) => ({
        text: String(p.text ?? p.step ?? "").slice(0, 200),
        status: typeof p.status === "string" ? p.status : p.completed === true ? "completed" : "pending",
      }));
      return;
    }
    if (role === "thinking") { const t = String(item.text ?? "").trim(); if (t) this.messages.push({ role: "thinking", text: t.slice(0, 2000), ts: at }); return; }
    if (role !== "tool") return;
    if (kind === "command_execution") {
      const cmd = String(item.command ?? "").replace(/\s+/g, " ").slice(0, 200), out = String(item.aggregated_output ?? "").trim().slice(0, 1600);
      const exit = Number.isFinite(item.exit_code) && item.exit_code !== 0 ? `\n(exit ${item.exit_code})` : "";
      if (cmd || out) this.messages.push({ role: "tool", name: "$", text: `${cmd}${out ? `\n${out}` : ""}${exit}`, ts: at });
      return;
    }
    if (kind === "file_change") { const changes = Array.isArray(item.changes) ? item.changes.map((c: any) => `${c?.kind ?? ""} ${c?.path ?? ""}`.trim()).filter(Boolean).join("\n") : ""; this.messages.push({ role: "tool", name: "✎ 文件", text: (changes || JSON.stringify(item).slice(0, 500)), ts: at }); return; }
    if (kind === "web_search") { this.messages.push({ role: "tool", name: "🔎 搜索", text: String(item.query ?? "").slice(0, 200), ts: at }); return; }
    this.messages.push({ role: "tool", name: kind, text: JSON.stringify(item).slice(0, 500), ts: at });  // mcp_tool_call 等：有界兜底展示
  }
  /** provider-notice 透出为 system 消息——限流/登录过期/压缩中/压缩失败/stderr。
   *  用户必须看见 Provider 限流等实际失败，投影层不许吞掉。 */
  private applyNotice(body: any, at: string): void {
    if (!body || typeof body !== "object" || typeof body.category !== "string") return;
    const detail = String(body.message ?? body.error ?? body.result ?? body.tail ?? "").replace(/\s+/g, " ").slice(0, 500);
    // 空详情的 api_error 是旧 adapter 把未知 status 帧误标出来的（历史 journal 里还躺着一批）——
    // 没有任何可给用户看的内容，渲染出来只会让人以为坏了。真错误（限流/掉登录/带信息的
    // api_error）都有 detail，照常透出
    if (body.category === "api_error" && !detail) return;
    const map: Record<string, string> = {
      compacting: "⏳ 正在压缩上下文（/compact）…",
      compact_ok: "✅ 上下文已压缩",
      compact_failed: `⚠️ 压缩失败${detail ? `：${detail}` : ""}`,
      rate_limited: `⚠️ 撞到限流${detail ? `：${detail}` : ""}`,
      auth_expired: `⚠️ 登录过期${detail ? `：${detail}` : ""}`,
      api_error: `⚠️ ${detail}`,
      stderr: `⚠️ stderr: ${detail}`,
      provider_warning: `⚠️ ${detail || "provider 警告"}`,
      lock_conflict: `⚠️ 会话被另一个进程占用，本轮没跑起来${detail ? `：${detail}` : ""}\n多半是终端里还开着同一个会话（codex resume / claude --resume），先退出它再续聊`,
      resume_not_found: `⚠️ 找不到可恢复的会话${detail ? `：${detail}` : ""}`,
      background_task: `⚠️ ${detail || "后台任务状态变更"}`,
    };
    // 查不到就兜底原样透出：分类表永远追不上 provider 新增的错误，而「有错误却什么都不显示」
    // 正是这个函数存在的理由。2026-08-24 实撞：lock_conflict 不在表里，用户只看到「失败 1」。
    const text = map[body.category] ?? (detail ? `⚠️ ${body.category}：${detail}` : "");
    if (text) this.messages.push({ role: "system", ...(["compacting", "compact_ok"].includes(body.category) ? {} : { name: "error" }), text, ts: at });
  }
  state() { return { messages: structuredClone(this.messages), turn: this.turn, alive: this.turn === "running", partial: this.partial, pending: structuredClone(this.pending), resume: null, backend: this.session.providerId, providerId: this.session.providerId, control: this.session.control, queued: [], plan: structuredClone(this.plan), tokens: structuredClone(this.tokens), lastActivityAt: this.lastActivityAt, ...(this.commands ? { commands: [...this.commands] } : {}), ...(this.model ? { model: this.model } : {}), ...(this.ctxTokens ? { ctxTokens: this.ctxTokens } : {}) }; }
}

export { expandCodexHome } from "../../sessions/provider-home.ts";
export function inputForRunner(dataRoot: string, session: SessionRecord, input: SessionInput, access: KernelGrantedAccess = session.access ?? "workspace", extraDirs: string[] = session.extraDirs ?? []) {
  const options = session.providerId !== "codex" ? { access: access === "bypass" || access === "full-access" ? "bypass" : "standard", extraDirs, ...(session.model ? { model: session.model } : {}), ...(session.effort ? { effort: session.effort } : {}) }
    : { access: access === "full-access" || access === "bypass" ? "full-access" : "workspace-write", extraDirs, home: session.providerHome ? { kind: "path", path: expandCodexHome(session.providerHome) } : { kind: "default" }, ...(session.model ? { model: session.model } : {}), ...(session.effort ? { effort: session.effort } : {}) };
  const images = (input.images ?? []).map((image) => ({ mediaType: image.media_type, blob: stageRunnerAttachment(dataRoot, image.data) }));
  return { text: input.text, images, cwd: session.cwd, options, ...(session.nativeRef ? { nativeRef: session.nativeRef } : {}) };
}
