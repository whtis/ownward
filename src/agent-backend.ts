// 统一 agent 后端契约：把 CC（agent-session，常驻 stream-json 会话）和 codex（codex-session，
// 每轮 `codex exec resume`）抽象成一层薄薄的分发接口。workbench 只认这层，不再散落
// SessionRepository.providerId 分发。**不是**真正的 ACP 协议，只做「消息/turn状态/存活/待审批/resume/接管租约」
// 到两套已有实现的映射。
import type { AgentControl, DevImage, DevMsg } from "./agent-session.ts";
import { SessionRepository } from "./sessions/repository.ts";
import { buildCodexResumeCommand } from "./sessions/provider-home.ts";
import { DATA } from "./util.ts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { cfg, log } from "./util.ts";

export type { AgentControl };

function repositoryIdentity(taskId: string) {
  try { const repo = new SessionRepository(DATA), identity = repo.getByTaskId(taskId), diagnostics = repo.getDiagnostics(); if (diagnostics.some((d) => d.key === taskId)) throw Object.assign(new Error(`Session provider/ref drift: ${taskId}`), { code: "SESSION_IDENTITY_DRIFT" }); if(identity){let taskProvider:"claude"|"codex"|"codebuddy"|null=null;try{const task=(JSON.parse(readFileSync(join(DATA,"tasks.json"),"utf8")) as any[]).find(x=>x?.id===taskId);if(task)taskProvider=task.mode==="codex-bg"?"codex":task.mode==="codebuddy-bg"?"codebuddy":"claude";}catch{}if(taskProvider&&taskProvider!==identity.providerId)throw Object.assign(new Error(`Session provider/ref drift: ${taskId}`),{code:"SESSION_IDENTITY_DRIFT"});} if (diagnostics.some((d) => d.key === "store")) { if (cfg.architecture?.sessionRunnerMode === undefined || cfg.architecture?.sessionRunnerMode === "off") { log(`session repository global diagnostic [${taskId}], isolated by legacy compatibility`); return null; } throw Object.assign(new Error(`Session repository store drift: ${taskId}`), { code: "SESSION_IDENTITY_DRIFT" }); } return identity; }
  catch (error: any) { if (error?.code === "SESSION_IDENTITY_DRIFT") throw error; if (cfg.architecture?.sessionRunnerMode === undefined || cfg.architecture?.sessionRunnerMode === "off") { log(`session repository unavailable [${taskId}], legacy compatibility: ${error instanceof Error ? error.name : "UnknownError"}`); return null; } throw error; }
}
function legacyProvider(taskId: string): "claude" | "codex" | "codebuddy" { try { const { mode } = (JSON.parse(readFileSync(join(DATA, "tasks.json"), "utf8")) as any[]).find((t) => t?.id === taskId) ?? {}; return mode === "codex-bg" ? "codex" : mode === "codebuddy-bg" ? "codebuddy" : "claude"; } catch { return "claude"; } }
function providerIdentity(taskId: string): "claude" | "codex" | "codebuddy" {
  const identity = repositoryIdentity(taskId);
  if (identity) return identity.providerId;
  if (cfg.architecture?.sessionRunnerMode === undefined || cfg.architecture?.sessionRunnerMode === "off") return legacyProvider(taskId);
  throw new Error(`Session 身份不存在: ${taskId}`);
}
function taskMetaControl(taskId: string, provider: "claude" | "codex" | "codebuddy"): AgentControl | null {
  const file = join(DATA, "tasks", `${taskId}.${provider === "codex" ? "codex" : "session"}.json`);
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")).control;
    return c === "observing" || c === "external" || c === "ownward" ? c : "ownward";
  } catch { return null; }
}

export interface AgentState {
  messages: DevMsg[];
  turn: string;           // running | idle
  alive: boolean;
  partial: string;        // 流式半截文本（codex 无，恒空）
  pending: any[];         // 待审批/提问（codex 无，恒空）
  resume: { id: string; tool: string; cmd: string } | null;
  backend: "claude" | "codex" | "codebuddy";
  providerId: "claude" | "codex" | "codebuddy"; // 迁移期与 backend 双写；新调用方只认 providerId
  control: AgentControl;  // 输入权归属：ownward 才能 sendToAgent
  queued?: any[];         // 忙时输入队列（P1-4，两套实现各自带出）
  plan?: any[];           // 执行计划/待办（P1-5）
  tokens?: any;           // token 用量（P1-5）
  model?: string;         // 当前模型（P1-5）
  commands?: string[];    // provider 回报的命令补全
  ctxTokens?: number;     // 当前上下文占用
  lastActivityAt?: number;
  fullAccess?: boolean;   // 仅支持热切换访问级别的 provider 返回
}

/** POSIX shell 单参数引用；恢复命令会被用户直接复制执行，路径必须不可注入。 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

/** 把 resume 信息拼成"到原生 CLI 一键续聊"的命令（cwd + resume id）。
 *  claude 用 sessionId，codex 用 rolloutId（codex-alt 要带 CODEX_HOME）。 */
export function buildResume(
  r: { sessionId: string; cwd: string } | { rolloutId: string; home: string; cwd: string } | null,
): { id: string; tool: string; cmd: string } | null {
  if (!r) return null;
  const cd = `cd ${shellQuote(r.cwd)}`;
  if ("sessionId" in r) {
    return { id: r.sessionId, tool: "claude", cmd: `${cd} && claude --resume ${r.sessionId}` };
  }
  return { id: r.rolloutId, tool: "codex", cmd: buildCodexResumeCommand(r.cwd,r.rolloutId,r.home) };
}

/** 是否存在活的 agent 会话（CC 或 codex 任一在内存里） */
export async function hasAgent(taskId: string): Promise<boolean> {
  const provider = providerIdentity(taskId);
  const { hasCodexSession } = await import("./codex-session.ts");
  if (provider === "codex") return hasCodexSession(taskId);
  const { hasEngineSession } = await import("./agent-session.ts");
  return hasEngineSession(taskId);
}

/** 统一读会话态：只据持久化 SessionRepository.providerId 分发；运行态探针不参与身份选择。 */
export async function getAgentState(taskId: string): Promise<AgentState> {
  const { loadTasks } = await import("./dispatch.ts");
  const task = loadTasks().find((t) => t.id === taskId);
  const identity = repositoryIdentity(taskId);
  if (!identity && cfg.architecture?.sessionRunnerMode !== undefined && cfg.architecture?.sessionRunnerMode !== "off") throw new Error(`Session 身份不存在: ${taskId}`);
  const provider = identity?.providerId ?? legacyProvider(taskId);
  const trustedIdentity = identity;

  const { codexMessages, codexResume, codexControl } = await import("./codex-session.ts");
  const cm = provider === "codex" ? codexMessages(taskId) : null;
  if (cm) {
    return { ...cm, resume: buildResume(codexResume(taskId)), backend: "codex", providerId: "codex", control: codexControl(taskId) };
  }
  // 非活的 codex 任务（daemon 重启后）：认出是 codex，从 rollout 读回历史 + plan/tokens + 落盘的 resume
  if (provider === "codex") {
    const cr = codexResume(taskId);
    let messages: DevMsg[] = [];
    let plan: any[] = [];
    let tokens: any = {};
    if (cr) {
      try {
        const { codexSessionPath, readCodexMessages } = await import("./codex-sessions.ts");
        const r = readCodexMessages(codexSessionPath(`cdx:${cr.home}:${cr.rolloutId}`), 0);
        messages = r.messages as any; plan = r.plan || []; tokens = r.tokens || {};
      } catch { /* rollout 找不到就空 */ }
    }
    let fullAccess = false;
    try {
      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      const { DATA } = await import("./util.ts");
      fullAccess = !!JSON.parse(readFileSync(join(DATA, "tasks", `${taskId}.codex.json`), "utf8")).fullAccess;
    } catch { /* 无 meta */ }
    return {
      messages, turn: "idle", alive: false, partial: "", pending: [], queued: [], plan, tokens,
      resume: buildResume(cr ?? (trustedIdentity?.nativeRef ? { rolloutId: trustedIdentity.nativeRef, home: trustedIdentity.providerHome || "codex", cwd: trustedIdentity.cwd } : null)),
      backend: "codex", providerId: "codex", control: taskMetaControl(taskId, "codex") ?? trustedIdentity?.control ?? codexControl(taskId), fullAccess,
    };
  }

  const { getEngineMessages, engineSessionId, engineControl, hasEngineSession } = await import("./agent-session.ts");
  const sid = engineSessionId(taskId);
  const native = sid ?? (trustedIdentity?.providerId === "claude" ? trustedIdentity.nativeRef : null);
  const cwd = task?.cwd ?? trustedIdentity?.cwd;
  const resume = native && cwd ? buildResume({ sessionId: native, cwd }) : null;
  const control = hasEngineSession(taskId)
    ? engineControl(taskId)
    : taskMetaControl(taskId, "claude") ?? trustedIdentity?.control ?? engineControl(taskId);
  return { ...getEngineMessages(taskId), resume, backend: "claude", providerId: "claude", control };
}

/** 非活会话「一发即自动接管」：daemon 重启后会话不在内存，但落盘 meta/session_id + rollout/transcript
 *  历史还在。发消息前先据此 re-adopt（取得输入权 + 预置历史），消除「能读却发不出」的读写路径分叉。 */
async function ensureLiveSession(taskId: string): Promise<void> {
  const { hasCodexSession, adoptCodexSession, codexResume } = await import("./codex-session.ts");
  const { hasEngineSession, adoptEngineSession, engineSessionId, engineOpts, getEngineMessages } = await import("./agent-session.ts");
  const provider = providerIdentity(taskId);
  if (provider === "codex" ? hasCodexSession(taskId) : hasEngineSession(taskId)) return;

  const { loadTasks } = await import("./dispatch.ts");
  const task = loadTasks().find((t) => t.id === taskId);
  if (!task) return; // 不认识的 id 交给下游报明确错误

  // codex 任务：落盘 meta（rollout/home/cwd）+ rollout 历史 → re-adopt
  const identity = repositoryIdentity(taskId);
  if (!identity && cfg.architecture?.sessionRunnerMode !== undefined && cfg.architecture?.sessionRunnerMode !== "off") throw new Error(`Session 身份不存在: ${taskId}`);
  const taskProvider = identity?.providerId ?? legacyProvider(taskId);
  const trustedIdentity = identity;
  const cr = codexResume(taskId) ?? (trustedIdentity?.providerId === "codex" && trustedIdentity.nativeRef
    ? { rolloutId: trustedIdentity.nativeRef, home: trustedIdentity.providerHome || "codex", cwd: trustedIdentity.cwd } : null);
  if (taskProvider === "codex" && cr) {
    let seed: DevMsg[] = [];
    try {
      const { codexSessionPath, readCodexMessages } = await import("./codex-sessions.ts");
      seed = readCodexMessages(codexSessionPath(`cdx:${cr.home}:${cr.rolloutId}`), 0).messages as any;
    } catch { /* 找不到 rollout 就空历史，仍可续 */ }
    adoptCodexSession(taskId, cr.cwd, cr.home, cr.rolloutId, seed);
    return;
  }
  // CC 引擎任务：落盘 session_id + 历史 → re-adopt（首次追问时 --resume 重生进程续聊）
  const sid = engineSessionId(taskId) ?? (trustedIdentity?.providerId === "claude" ? trustedIdentity.nativeRef : null);
  if (sid) adoptEngineSession(taskId, task.cwd, task.logFile || "", sid, getEngineMessages(taskId).messages, engineOpts(taskId));
}

/** 统一追问：先确保会话在内存（非活则自动 re-adopt），再校验接管租约，分发到 codexFollowUp / sendFollowUp。
 *  返回 {queued}：忙时进了输入队列（P1-4），本轮结束自动合并发出。 */
export async function sendToAgent(taskId: string, text: string, images: DevImage[] = []): Promise<{ queued: boolean }> {
  await ensureLiveSession(taskId); // 非活会话一发即自动接管，消除读写路径分叉
  const provider = providerIdentity(taskId);
  const { hasCodexSession, codexControl, codexFollowUp } = await import("./codex-session.ts");
  if (provider === "codex") {
    if (!hasCodexSession(taskId)) throw new Error("Codex Session 未恢复");
    if (codexControl(taskId) !== "ownward") throw new Error("未持有输入权，请先接管");
    return codexFollowUp(taskId, text?.trim() || (images.length ? "看一下这张图" : "继续"), images);
  }
  const { engineControl, sendFollowUp } = await import("./agent-session.ts");
  if (engineControl(taskId) !== "ownward") throw new Error("未持有输入权，请先接管");
  return sendFollowUp(taskId, text?.trim() || "看一下这张图", images);
}

/** 撤回一条还没发出的排队消息（按稳定 id）。
 *  撤不到不是错误——本轮刚结束、这条已经合并发出去了就是这个结果，交给调用方如实告诉用户。 */
export async function removeFromAgentQueue(taskId: string, queueId: string): Promise<{ removed: boolean; queued: any[] }> {
  const provider = providerIdentity(taskId);
  if (provider === "codex") {
    const { hasCodexSession, removeCodexQueued } = await import("./codex-session.ts");
    if (!hasCodexSession(taskId)) throw new Error("Codex Session 未恢复");
    return removeCodexQueued(taskId, queueId);
  }
  const { removeEngineQueued } = await import("./agent-session.ts");
  return removeEngineQueued(taskId, queueId);
}

/** 会话中途加可写目录：两种后端都在下一轮 spawn 时注入真实 CLI 权限参数。 */
export async function addAgentDir(taskId: string, dir: string): Promise<string> {
  await ensureLiveSession(taskId);
  const provider = providerIdentity(taskId);
  const { hasCodexSession, codexAddDir } = await import("./codex-session.ts");
  if (provider === "codex") {
    if (!hasCodexSession(taskId)) throw new Error("Codex Session 未恢复");
    codexAddDir(taskId, dir);
    return "已加入可写目录，下一轮对话生效";
  }
  const { addEngineDir } = await import("./agent-session.ts");
  addEngineDir(taskId, dir);
  return "已加入可写目录，下一轮对话生效";
}

/** 会话中途切沙箱：codex 走 danger-full-access 覆写（下一轮生效）。claude 引擎 bypass 只能派发时定，
 *  运行中不支持热切（stream-json 进程已带定权限），返回明确说明。 */
export async function setAgentAccess(taskId: string, full: boolean): Promise<string> {
  await ensureLiveSession(taskId);
  const provider = providerIdentity(taskId);
  const { hasCodexSession, codexSetAccess } = await import("./codex-session.ts");
  if (provider === "codex") {
    if (!hasCodexSession(taskId)) throw new Error("Codex Session 未恢复");
    codexSetAccess(taskId, full);
    return full ? "已解除沙箱，下一轮对话生效" : "已恢复沙箱，下一轮对话生效";
  }
  throw new Error("claude 引擎的权限在派发时固定，运行中不支持热切换沙箱");
}

/** /new（/clear 同义）：同任务丢上下文重开。codex 的追问机制绑定 rollout resume，暂不支持。 */
export async function newAgentSession(taskId: string): Promise<string> {
  await ensureLiveSession(taskId);
  if (providerIdentity(taskId) === "codex") throw new Error("codex 会话暂不支持 /new（追问机制绑定 rollout resume）");
  const { newEngineSession } = await import("./agent-session.ts");
  return newEngineSession(taskId);
}

/** 统一中断当前 turn（进程保留，可继续追问） */
export async function interruptAgent(taskId: string) {
  const provider = providerIdentity(taskId);
  const { hasCodexSession, codexInterrupt } = await import("./codex-session.ts");
  if (provider === "codex") { if (!hasCodexSession(taskId)) throw new Error("Codex Session 未恢复"); codexInterrupt(taskId); return; }
  const { interruptTask } = await import("./agent-session.ts");
  interruptTask(taskId);
}

/** 接管租约切换：take = 取得输入权（ownward），release = 交还只旁观（observing）。
 *  外部只旁观、还没有 dev 会话的 CC/codex 会话，先走 /api/cc/adopt 变成 ownward 任务（默认即 ownward）。 */
export async function setAgentControl(taskId: string, action: "take" | "release"): Promise<AgentControl> {
  const control: AgentControl = action === "take" ? "ownward" : "observing";
  const provider = providerIdentity(taskId);
  const { hasCodexSession, setCodexControl } = await import("./codex-session.ts");
  if (provider === "codex") { if (!hasCodexSession(taskId)) throw new Error("Codex Session 未恢复"); setCodexControl(taskId, control); return control; }
  const { setEngineControl } = await import("./agent-session.ts");
  setEngineControl(taskId, control); // 无活会话时抛「会话不存在」
  return control;
}
