// 轻量会话引擎：ownward 自己的 bg 任务从「claude -p 单发」升级为 stream-json 长驻会话。
// 借鉴 clawos/clawd 的 SDK 模式集成（cc-integration.md），只取个人工作台需要的子集：
//   多轮追问（stdin 保持打开连续投 user 帧）、interrupt（control_request 不杀进程）、
//   --resume 断点续聊、权限/提问经 control_request(can_use_tool) 进 Action 收件箱。
// 已知边界：进程是 daemon 直接子进程，daemon 重启（evolve apply）时在跑的 turn 会中断，
// 靠 --resume + reconcileEngine 收敛状态。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import { openAction, resolveAction } from "./actions.ts";
import { addRule, logDecision, matchRule, patternFor, type RuleScope } from "./approval.ts";
import { notify } from "./notify.ts";
import { reconcileLegacySessions, SessionRepository } from "./sessions/repository.ts";
import { acceptRunSidecar, crossRunDispatchBoundary, diagnoseUnstartedRunSidecar, finishRunSidecar, markRunStartedSidecar, type RunSidecarDeps, type RunSidecarHandle } from "./runs/sidecar.ts";
import { DATA, cfg, ensureDir, log, run } from "./util.ts";
import { assertLegacyWriteAllowed } from "./kernel/sessions/legacy-ownership.ts";
import type { AgentControl, DevImage, DevMsg, PlanStep, TokenUsage } from "./kernel/sessions/types.ts";
export type { AgentControl, DevImage, DevMsg, PlanStep, TokenUsage } from "./kernel/sessions/types.ts";

// 忙时输入队列的类型和合并规则搬到了 kernel/sessions/input-queue.ts：
// Runner 会话现在也排队（见那边的 SessionInputQueueStore），两条链路必须用同一套
// /btw 识别、斜杠命令独占一帧、合并顺序——各写一份迟早会漂移成两种行为。
import { mergeQueued, parseQueued, QUEUE_VIEW, sliceQueue, type QueuedItem, type QueuedView } from "./kernel/sessions/input-queue.ts";
export { mergeQueued, newQueuedId, parseQueued, sliceQueue, type QueuedItem, type QueuedView } from "./kernel/sessions/input-queue.ts";

// —— 结构化进度：执行计划 + token 用量（CC/codex 共用，客户端进度视图渲染）——

interface PendingPerm {
  requestId: string;
  toolName: string;
  input: any;
  at: number;
  brief: string;   // 客户端审批卡片展示用
}

export interface EngineOpts {
  model?: string;
  effort?: string;
  bypass?: boolean;   // true = --dangerously-skip-permissions（全放行，不产生审批）
  extraDirs?: string[];  // 附加项目目录：agent 也能读写（Claude Code --add-dir），跨仓库任务用
}

interface EngineSession {
  taskId: string;
  cwd: string;
  logFile: string;
  opts: EngineOpts;
  proc: ReturnType<typeof Bun.spawn> | null;
  toolSessionId?: string;
  turn: "running" | "idle";
  alive: boolean;
  partial: string;          // 流式中的半截 assistant 文本（整段帧到达后清空）
  lastActivityAt: number;   // 最后一次活动 epoch ms：输出 chunk/工具事件/进程状态变化处 touch（供 attention 判卡住）
  messages: DevMsg[];
  pendingPerms: Map<string, PendingPerm>;
  firstTurnMarked: boolean;  // OWNWARD_EXIT 标记只写一次（接旧 reap/收割流程）
  idleTimer?: ReturnType<typeof setTimeout>;
  ctrlSeq: number;
  control: AgentControl;    // 输入权归属：ownward 才允许追问
  queued: QueuedItem[];      // 忙时输入队列：本轮结束合并发出
  plan: PlanStep[];          // 最新一份 TodoWrite 待办（后来的覆盖前面，不堆叠）
  tokens: TokenUsage;        // result 事件累计的 token 用量
  model?: string;            // assistant 帧带出的模型标识（如 claude-opus-4-8）
  commands?: string[];       // init 帧回报的 slash_commands（客户端输入框补全用）
  turnStartHead?: string;    // 本轮开始时的 git HEAD：轮结束出「本轮改动卡片」的 diff 基线
  ctxTokens?: number;        // 最近一轮请求的上下文占用（input+cache 读写）：客户端换算 ctx%
  autoCompacting?: boolean;  // 正在自动压缩：防止压缩期间重复触发
  activeRun?: RunSidecarHandle;
  interruptRequested?: boolean;
  runSidecarDeps?: RunSidecarDeps;
}

// 上下文窗口 & 自动压缩阈值（claude 系当前 200k）：ctx 超过阈值就自动 /compact，避免撞满上限
const CTX_WINDOW = 200_000;

const sessions = new Map<string, EngineSession>();
const IDLE_KILL_MS = 30 * 60_000;

// —— 权限规则：确定性判断，不让任务卡在琐碎审批上 ——
// Bash 之外的工具全放行；Bash 只拦高危模式 → Action 收件箱等人批
// git push 允许中间夹 -C/flag（git -C x push 也拦）；rm -rf 各种变体（rm -rf . / rm -fr / rm -rf --）都拦，
// 不再只拦 ~// 开头目标（codex review 查出 rm -rf . / rm -rf -- / / git -C 会绕过）
const RISKY = /\b(git\b[^\n]*\bpush\b|sudo\b|rm\s+-[a-zA-Z]*[rRfF][a-zA-Z]*\b|launchctl|shutdown|reboot|diskutil|mkfs|:\(\)\s*\{)/;

function decidePermission(toolName: string, input: any): "allow" | "ask" {
  if (toolName === "AskUserQuestion") return "ask";
  if (toolName !== "Bash") return "allow";
  return RISKY.test(String(input?.command || "")) ? "ask" : "allow";
}

function sessionFile(taskId: string): string {
  return join(DATA, "tasks", `${taskId}.session.json`);
}

function persist(s: EngineSession) {
  ensureDir(join(DATA, "tasks"));
  writeFileSync(sessionFile(s.taskId), JSON.stringify({
    toolSessionId: s.toolSessionId, turn: s.turn, control: s.control, messages: s.messages.slice(-400),
    plan: s.plan, tokens: s.tokens, model: s.model, commands: s.commands, ctxTokens: s.ctxTokens, lastActivityAt: s.lastActivityAt,
    opts: s.opts,
  }));
  // legacy meta 仍是当前 Provider 真相；写成功后再补 Session Repository。失败可由 daemon reconcile 重试。
  try {
    const registered = (() => { try { return JSON.parse(readFileSync(join(DATA, "tasks.json"), "utf8")).some((t: any) => t.id === s.taskId); } catch { return false; } })();
    if (registered && s.toolSessionId) new SessionRepository(DATA).bind({ taskId: s.taskId, providerId: "claude", nativeRef: s.toolSessionId, cwd: s.cwd, control: s.control });
    else reconcileLegacySessions(DATA);
  }
  catch (e) { log(`session repository reconcile failed [${s.taskId}]: ${e}`); }
}

function push(s: EngineSession, m: DevMsg) {
  s.messages.push(m);
  if (s.messages.length > 600) s.messages = s.messages.slice(-400);
}

/** 触活：记一次「会话仍在动」的时间戳，供 attention 判卡住（不误报持续 partial/长命令/成功工具执行）。 */
function touch(s: EngineSession) {
  s.lastActivityAt = Date.now();
}

const now = () => new Date().toISOString();

/** 启动一个引擎任务：spawn 长驻 claude，投第一条 user 帧（可带图片，与追问同一 userFrame 编码） */
export function startEngineTask(taskId: string, cwd: string, task: string, logFile: string, opts: EngineOpts = {}, images: DevImage[] = []): number {
  assertLegacyWriteAllowed(taskId);
  const s: EngineSession = {
    taskId, cwd, logFile, opts, proc: null, turn: "running", alive: false, partial: "",
    lastActivityAt: Date.now(),
    messages: [], pendingPerms: new Map(), firstTurnMarked: false, ctrlSeq: 0,
    control: "ownward", queued: [], plan: [], tokens: {},
  };
  sessions.set(taskId, s);
  captureTurnHead(s);
  push(s, { role: "user", text: images.length ? `📎×${images.length} ${task}` : task, ts: now() });
  spawn(s);
  try { s.activeRun = beginClaudeProviderRun(s, () => writeStdin(s, userFrame(task, images))); }
  catch (error) { restoreClaudeAfterDispatchGate(s, error, true, () => persist(s)); sessions.delete(taskId); throw error; }
  persist(s);
  return s.proc?.pid ?? 0;
}

/** 接管一个外部 CC 会话（clawd/Terminal）：不 spawn，预置 toolSessionId + 历史，
 *  第一次追问时以 --resume 在原 cwd 重生进程续聊 */
export function adoptEngineSession(taskId: string, cwd: string, logFile: string, toolSessionId: string, seed: DevMsg[], opts: EngineOpts = {}) {
  assertLegacyWriteAllowed(taskId);
  const s: EngineSession = {
    taskId, cwd, logFile, opts, proc: null, turn: "idle", alive: false, partial: "",
    lastActivityAt: Date.now(),
    toolSessionId, messages: seed.slice(-80), pendingPerms: new Map(),
    firstTurnMarked: true, // 接管的会话不走首轮 reap 通知/收割（不是"任务结束"语义）
    ctrlSeq: 0, control: "ownward", queued: [], plan: [], tokens: {}, // 接管即取得输入权
  };
  sessions.set(taskId, s);
  persist(s);
  log(`engine [${taskId}] adopted cc session ${toolSessionId} @ ${cwd}`);
}

function userFrame(text: string, images: DevImage[] = []): string {
  const content: any[] = images.map((im) => ({
    type: "image", source: { type: "base64", media_type: im.media_type, data: im.data },
  }));
  content.push({ type: "text", text });
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/** 构造 Claude CLI 参数。导出供单测锁定 --add-dir / --resume 的真实授权链路。 */
export function buildClaudeArgs(opts: EngineOpts, toolSessionId?: string, resume = false, memoryPack = ""): string[] {
  const args = [
    "claude", "--print", "--output-format", "stream-json", "--input-format", "stream-json",
    "--verbose", "--include-partial-messages",
  ];
  if (opts.bypass) args.push("--dangerously-skip-permissions");
  else args.push("--permission-prompt-tool", "stdio", "--permission-mode", "acceptEdits");
  // 附加项目：授权 agent 读写额外仓库（跨项目任务）
  for (const d of opts.extraDirs ?? []) args.push("--add-dir", d);
  if (memoryPack) args.push("--append-system-prompt", memoryPack);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (resume && toolSessionId) args.push("--resume", toolSessionId);
  return args;
}

function spawn(s: EngineSession, resume = false) {
  let pack = "";
  // 项目记忆注入：agent 不重复踩坑（约束/目录/近期风险）
  try {
    const { memoryPack } = require("./memory.ts");
    pack = memoryPack("agent", s.cwd.split("/").pop());
  } catch { /* memory 层不可用不阻塞任务 */ }
  const args = buildClaudeArgs(s.opts, s.toolSessionId, resume, pack);
  const proc = Bun.spawn(args, {
    cwd: s.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DISABLE_OMC: "1" },
  });
  s.proc = proc;
  s.alive = true;
  touch(s); // 进程启动 = 状态变化，触活
  readLoop(s, proc).catch((e) => log(`engine [${s.taskId}] read loop error: ${e}`));
  drainStderr(s, proc).catch(() => {});
  proc.exited.then((code) => {
    if (s.proc !== proc) return; // 已被新 spawn 替换
    s.alive = false;
    s.proc = null;
    touch(s); // 进程退出 = 状态变化，触活
    // 死进程的审批假成功修复：进程没了，pendingPerms 再点批准也只是往空 proc 写、异常被吞、
    // API 却返回成功。收摊：清 pending + resolve 对应 Action（interrupted）+ 消息暴露，
    // 别让死会话还挂着可点的审批。
    if (s.pendingPerms.size) {
      for (const p of s.pendingPerms.values()) {
        resolveAction(`perm:${s.taskId}:${p.requestId}`, "interrupted");
      }
      s.pendingPerms.clear();
      push(s, { role: "system", text: "⚠️ 进程已退出，挂起的审批随会话中断已失效", ts: now() });
    }
    // 进程退了但 turn 还挂着 = 异常死亡（正常路径是 result 帧先到）
    if (s.turn === "running") {
      push(s, { role: "system", text: `进程退出 (code ${code})`, ts: now() });
      endTurn(s, code || 1, s.interruptRequested ? "interrupted" : "failed", s.interruptRequested ? "user_interrupt" : "provider_exit_without_result",
        undefined, true, code);
    }
    persist(s);
  });
  log(`engine [${s.taskId}] spawned pid=${proc.pid}${resume ? " (resume)" : ""}`);
}

async function drainStderr(s: EngineSession, proc: ReturnType<typeof Bun.spawn>) {
  const text = await new Response(proc.stderr as ReadableStream).text();
  if (text.trim()) appendFileSync(s.logFile, `\n[stderr] ${text.slice(0, 2000)}\n`);
}

async function readLoop(s: EngineSession, proc: ReturnType<typeof Bun.spawn>) {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      // 目录热追加会脱钩并终止旧进程；旧 stdout 缓冲里迟到的 result/init 不能再污染新一代会话。
      if (s.proc !== proc) return;
      appendFileSync(s.logFile, line.slice(0, 8000) + "\n"); // 原始帧留档（tail 调试用）
      try { handleLine(s, JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
    }
  }
}

function handleLine(s: EngineSession, e: any) {
  // 子 agent 流不进主对话（clawd 实测：污染 text 流）
  if (e.isSidechain === true || e.parent_tool_use_id) return;

  if (e.type === "system" && e.subtype === "init") {
    if (e.session_id) s.toolSessionId = e.session_id;
    if (e.model) s.model = String(e.model);
    // 斜杠命令全量透传给 CC 自己解释（实测 stream-json 认识它们：能执行的执行如 /compact，
    // 不能的回 synthetic 说明文本）；这里存 init 回报的可用命令表，供客户端输入框补全
    if (Array.isArray(e.slash_commands)) s.commands = e.slash_commands.map(String).slice(0, 300);
    return;
  }
  if (e.type === "system" && e.subtype === "status") {
    // /compact 的过程帧：不透出用户就只看到长时间死寂
    touch(s);
    if (e.status === "compacting") push(s, { role: "system", text: "⏳ 正在压缩上下文（/compact）…", ts: now() });
    else if (e.compact_result === "failed") { s.autoCompacting = false; push(s, { role: "system", name: "error", text: `⚠️ 压缩失败：${String(e.compact_error || "").slice(0, 200)}`, ts: now() }); }
    else if (e.compact_result) { s.autoCompacting = false; push(s, { role: "system", text: "✅ 上下文已压缩", ts: now() }); }
    persist(s);
    return;
  }
  if (e.type === "control_request") return handleControlRequest(s, e);
  if (e.type === "stream_event") {
    // token 级流式：客户端 2s 轮询 partial 即可获得打字机体验
    const d = e.event?.delta;
    if (d?.type === "text_delta" && d.text) { s.partial += d.text; touch(s); } // 每个输出 chunk 触活
    return;
  }
  if (e.type === "assistant") {
    touch(s); // assistant 帧（含 tool_use 工具事件）触活
    const msg = e.message;
    if (msg?.model === "<synthetic>") {
      // synthetic 帧不全是噪音：限流/登录过期/API 错都以它的形态出现，吞掉用户只会看到死寂
      //（2026-07-28 夜里撞限流，ownward 里连发两条消息毫无反应）。
      // 实测唯一无害占位是拒绝工具后的固定文案 "No response requested."
      const t = extractText(msg?.content).trim();
      if (t && t !== "No response requested.") {
        // 去重：/compact 失败时 CC 会 status 帧 + synthetic 帧各报一次同样的话，只留一条
        const last = s.messages[s.messages.length - 1];
        if (last?.role === "system" && last.text.includes(t.slice(0, 100))) return;
        push(s, { role: "system", name: "error", text: `⚠️ ${t.slice(0, 500)}`, ts: now() });
        persist(s);
      }
      return;
    }
    if (msg?.model) s.model = String(msg.model);
    // 当前上下文占用只能取【单次请求】的 usage：这次请求实际塞进去多少 token。
    // 绝不能用 result.usage——那是整轮累计，每次工具往返的 cache_read 都加了一遍，
    // 拿它当占用会算出 274% 这种数（2026-08-04 实测 msnv：累计 548759 → "ctx≈274%"，
    // 而真实上下文远没满），自动压缩就变成了无差别乱压。计费累计归 s.tokens，两个数别混。
    const u = msg?.usage;
    if (u) {
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) s.ctxTokens = ctx;
    }
    for (const c of Array.isArray(msg?.content) ? msg.content : []) {
      if (c?.type === "thinking" && c.thinking?.trim()) {
        push(s, { role: "thinking", text: String(c.thinking).slice(0, 2000), ts: now() });
      }
    }
    const t = extractText(msg?.content).trim();
    if (t) { push(s, { role: "assistant", text: t.slice(0, 6000), ts: now() }); s.partial = ""; }
    for (const c of Array.isArray(msg?.content) ? msg.content : []) {
      if (c?.type !== "tool_use") continue;
      // TodoWrite：把最新待办抽成结构化 plan（复用同一份、覆盖不堆叠），不进消息流
      if (c.name === "TodoWrite") { capturePlan(s, c.input?.todos); continue; }
      if (c.name !== "AskUserQuestion") {
        push(s, { role: "tool", name: c.name, text: toolBrief(c.input), ts: now() });
      }
    }
    return;
  }
  if (e.type === "user") {
    touch(s); // tool_result（含成功结果）触活——成功工具执行不该被判卡住
    // 工具报错要看得见——成功结果太吵不进流，失败必须暴露
    for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c?.type === "tool_result" && c.is_error) {
        const txt = typeof c.content === "string" ? c.content
          : Array.isArray(c.content) ? c.content.map((x: any) => x?.text || "").join(" ") : "";
        if (txt.trim()) push(s, { role: "tool", name: "⚠️ 出错", text: txt.slice(0, 500), ts: now() });
      }
    }
    return;
  }
  if (e.type === "result") {
    touch(s); // 本轮 result 触活
    s.partial = "";
    accumulateTokens(s, e.usage);
    const outcome = claudeResultOutcome(!!e.is_error, !!s.interruptRequested);
    endTurn(s, e.is_error ? 1 : 0, outcome,
      outcome === "interrupted" ? "user_interrupt" : e.is_error ? "provider_result_error" : undefined, resultUsage(e.usage), false);
    persist(s);
    return;
  }
}

/** interrupt 写入只代表请求，不代表 Provider 确认；成功 result 永远胜出。 */
export function claudeResultOutcome(isError: boolean, interruptRequested: boolean): "completed" | "failed" | "interrupted" {
  return isError ? (interruptRequested ? "interrupted" : "failed") : "completed";
}

/** Claude stdin Provider 边界；accepted 在写前，started 仅在 write 成功后。 */
export function beginClaudeProviderRun(s: Pick<EngineSession, "taskId" | "cwd" | "control" | "runSidecarDeps">, send: () => boolean): RunSidecarHandle {
  const deps = s.runSidecarDeps;
  const h = acceptRunSidecar(s.taskId, "claude", { ...(deps ?? {}), identity: { cwd: s.cwd, control: s.control } });
  const sent = crossRunDispatchBoundary(h, send, deps);
  if (sent) markRunStartedSidecar(h, deps);
  else diagnoseUnstartedRunSidecar(h, new Error("provider stdin write failed"), deps);
  return h;
}

/** 回滚 journal gate 失败：只杀本轮新 spawn；复用中的健康 Provider 没收到帧，必须继续存活。 */
export function restoreClaudeAfterDispatchGate(
  s: Pick<EngineSession, "proc" | "alive" | "turn" | "autoCompacting">,
  error: unknown,
  spawnedForTurn: boolean,
  persistState: () => void = () => {},
): boolean {
  if ((error as any)?.code !== "RUN_DISPATCH_JOURNAL_UNAVAILABLE") return false;
  s.turn = "idle";
  s.autoCompacting = false;
  if (spawnedForTurn) {
    const proc = s.proc;
    s.proc = null; // exited handler 看到旧 proc 后直接返回，不把未发送输入伪装成 Provider failure。
    s.alive = false;
    if (proc) { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } }
  }
  persistState();
  return true;
}

export function finishClaudeProviderResult(h: RunSidecarHandle | undefined, isError: boolean, interruptRequested: boolean,
  usage: { inputTokens?: number; outputTokens?: number } | undefined, deps?: RunSidecarDeps): void {
  const outcome = claudeResultOutcome(isError, interruptRequested);
  finishRunSidecar(h, outcome, {
    ...(outcome === "interrupted" ? { reason: "user_interrupt" } : isError ? { reason: "provider_result_error" } : {}),
    ...(usage ? { usage } : {}),
  }, deps);
}

/** TodoWrite → plan：content/status 映射；空或非法则不动（保留上一份） */
function capturePlan(s: EngineSession, todos: any) {
  if (!Array.isArray(todos)) return;
  const steps: PlanStep[] = [];
  for (const t of todos) {
    const text = String(t?.content ?? t?.activeForm ?? "").trim();
    if (!text) continue;
    const st = t?.status;
    steps.push({ text: text.slice(0, 200), status: st === "in_progress" || st === "completed" ? st : "pending" });
  }
  if (steps.length) s.plan = steps;
}

/** result.usage → 累计计费 token（整轮所有请求之和，input 含 cache 读写）。
 *  这里【只】管累计花销，不再顺手当上下文占用用——占用在 assistant 帧按单次请求量取。 */
function accumulateTokens(s: EngineSession, usage: any) {
  if (!usage || typeof usage !== "object") return;
  const inp = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const out = usage.output_tokens || 0;
  if (!inp && !out) return;
  s.tokens.input = (s.tokens.input || 0) + inp;
  s.tokens.output = (s.tokens.output || 0) + out;
  s.tokens.total = (s.tokens.input || 0) + (s.tokens.output || 0);
}

/** Run journal 只接受可信计数；Provider 的 NaN/Infinity/负数/浮点值不能污染协议。 */
function resultUsage(usage: any): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const token = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0;
  const inputTokens = token(usage.input_tokens) + token(usage.cache_read_input_tokens) + token(usage.cache_creation_input_tokens);
  const outputTokens = token(usage.output_tokens);
  return inputTokens + outputTokens > 0 ? { inputTokens, outputTokens } : undefined;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
}

function toolBrief(input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern
    || input.prompt || input.description || input.query || input.url || "";
  return String(v).replace(/\s+/g, " ").slice(0, 160);
}

/** 幂等刷新飞行记录：每轮收尾调一次，overwrite 捕获到目前完整历史。失败仅 log 不阻塞。 */
function refreshFlightRecord(taskId: string) {
  import("./flight-record.ts").then(async ({ writeFlightRecord }) => {
    const { loadTasks } = await import("./dispatch.ts");
    const task = loadTasks().find((t) => t.id === taskId);
    if (task) await writeFlightRecord(task);
  }).catch((e) => log(`engine [${taskId}] flight record refresh failed: ${e}`));
}

/** turn 结束：首轮写 OWNWARD_EXIT 标记走既有 reap（通知/收割/verify）；
 *  追问轮 reap 不会再管（标记只写一次），直接把任务状态收回 exited。起 30min 闲杀 */
/** 本轮开始时冻结 git HEAD（异步；非 git 目录留空即不出卡片） */
function captureTurnHead(s: EngineSession) {
  s.turnStartHead = undefined;
  run(["git", "-C", s.cwd, "rev-parse", "HEAD"], { timeoutMs: 10_000 })
    .then((r) => { if (r.code === 0) s.turnStartHead = r.stdout.trim(); })
    .catch(() => {});
}

/** 本轮改动卡片：相对轮开始 head 的改动摘要插进消息流——改动出现在注意力所在的对话里，
 *  聊完立刻看见（codex 设计共识）。无改动不发。 */
function emitTurnChanges(s: EngineSession) {
  const base = s.turnStartHead;
  s.turnStartHead = undefined;
  if (!base) return;
  import("./repo-panel.ts").then(async ({ turnChanges }) => {
    const c = await turnChanges(s.cwd, base);
    if (c) { push(s, { role: "system", name: "changes", text: c, ts: now() }); persist(s); }
  }).catch(() => {});
}

/** 自动压缩：一轮结束后若上下文占用超阈值，自动注入 /compact，避免下一轮撞满窗口。
 *  同 VSCode/Claude Code 的 ctx 自动压缩。触发即开一个压缩 turn，返回 true 让 endTurn 让路。
 *  默认开，config.json engine.autoCompact=false 关；阈值 engine.compactThreshold（默认 0.85）。 */
function maybeAutoCompact(s: EngineSession): boolean {
  if (cfg.engine?.autoCompact === false) return false;
  if (s.control !== "ownward" || s.autoCompacting) return false;
  if (!s.alive && !s.toolSessionId) return false;           // 无法 resume 就压不了
  const ratio = (s.ctxTokens || 0) / CTX_WINDOW;
  if (ratio < (cfg.engine?.compactThreshold ?? 0.85)) return false;

  s.autoCompacting = true;
  s.interruptRequested = false;
  s.ctxTokens = undefined;   // 清掉旧测量：压缩后靠下一轮真实 usage 重判，避免压缩帧回来又立即触发成死循环
  push(s, { role: "system", text: `🗜 上下文约 ${Math.round(ratio * 100)}%，自动压缩中…`, ts: now() });
  s.turn = "running";
  clearTimeout(s.idleTimer);
  let spawnedForTurn = false;
  if (!s.alive && s.toolSessionId) { spawn(s, true); spawnedForTurn = true; }
  try { s.activeRun = beginClaudeProviderRun(s, () => writeStdin(s, userFrame("/compact"))); }
  catch (error) {
    if (restoreClaudeAfterDispatchGate(s, error, spawnedForTurn, () => persist(s))) {
      log(`engine [${s.taskId}] auto-compact skipped: RUN_DISPATCH_JOURNAL_UNAVAILABLE`);
      return false;
    }
    throw error;
  }
  persist(s);
  import("./dispatch.ts").then(({ updateTask }) =>
    updateTask(s.taskId, { status: "running", endedAt: undefined, exitCode: undefined }),
  ).catch((e) => log(`engine [${s.taskId}] auto-compact 状态回写失败: ${e}`));
  log(`engine [${s.taskId}] auto-compact @ ctx≈${Math.round(ratio * 100)}%`);
  return true;
}

function endTurn(s: EngineSession, code: number, outcome: "completed" | "failed" | "interrupted" = code === 0 ? "completed" : "failed", reason?: string,
  usage?: { inputTokens?: number; outputTokens?: number }, providerExitKnown = true, providerExitCode = code) {
  if (providerExitKnown) finishRunSidecar(s.activeRun, outcome, { exitCode: providerExitCode, ...(reason ? { reason } : {}), ...(usage ? { usage } : {}) }, s.runSidecarDeps);
  else finishClaudeProviderResult(s.activeRun, outcome !== "completed", outcome === "interrupted", usage, s.runSidecarDeps);
  s.activeRun = undefined;
  s.interruptRequested = false;
  s.turn = "idle";
  emitTurnChanges(s);   // 队列续轮之前也要出卡（本轮确实结束了，改动归本轮）
  // ctx 超阈值先自动压缩（排在队列之前，让压缩后的 turn 有余量跑排队的消息）
  if (maybeAutoCompact(s)) return;
  // 收尾先看忙时队列：非空就自动合并发出，本轮无缝续到下一轮（不落 idle/exited）
  if (s.queued.length && flushQueue(s)) return;
  // 多轮 upsert：每轮收尾都幂等刷新飞行记录（messages 是累计的，overwrite 即可捕获到目前完整历史）。
  // 修的是「飞行记录只在首轮触发、追问的后续轮不 reap」。失败仅 log 不阻塞收尾。
  refreshFlightRecord(s.taskId);
  if (!s.firstTurnMarked) {
    s.firstTurnMarked = true;
    try { appendFileSync(s.logFile, `\nOWNWARD_EXIT:${code}\n`); } catch { /* 日志写不进不阻塞 */ }
  } else {
    import("./dispatch.ts").then(({ updateTask }) =>
      updateTask(s.taskId, { status: "exited", exitCode: code, endedAt: now() }),
    ).catch((e) => log(`engine [${s.taskId}] 退出状态回写失败: ${e}`));
  }
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.turn === "idle" && s.proc) {
      log(`engine [${s.taskId}] idle-kill (30m), resume 凭 toolSessionId`);
      s.proc.kill(9); // CC 卡住时不响应 SIGTERM（clawd 实测），一律 SIGKILL
    }
  }, IDLE_KILL_MS);
}

// —— control_request：权限 + AskUserQuestion ——

function handleControlRequest(s: EngineSession, e: any) {
  const sub = e.request?.subtype;
  if (sub !== "can_use_tool") return; // 其它 subtype 不消费
  touch(s); // 权限/提问请求 = 工具事件，触活
  const requestId = e.request_id;
  const toolName = e.request.tool_name || e.request.toolName || "";
  const input = e.request.input ?? {};

  if (decidePermission(toolName, input) === "allow") {
    return respondPermission(s, requestId, true, input);
  }

  // 命中「总是批准」规则（会话级/全局）→ 直接放行，不打断长任务，只记审计
  const hit = matchRule(s.taskId, toolName, input);
  if (hit) {
    const { kind, pattern } = patternFor(toolName, input);
    logDecision({ taskId: s.taskId, requestId, toolName, kind, pattern,
      decision: "auto-allow", by: "rule", ruleScope: hit.scope, detail: toolBrief(input) });
    push(s, { role: "system", name: "decision", text: `🔓 命中自动批准规则（${pattern}）`, ts: now() });
    return respondPermission(s, requestId, true, input);
  }

  // 需要人批：挂 pending + Action 收件箱 + 飞书通知
  const isQuestion = toolName === "AskUserQuestion";
  const opts = isQuestion
    ? (input.questions?.[0]?.options || []).map((o: any) => o.label).filter(Boolean).slice(0, 4)
    : [];
  const brief = isQuestion
    ? `${(input.questions?.[0]?.question || "agent 有问题要问").slice(0, 140)}${opts.length ? `（选项: ${opts.join(" / ")}）` : ""}`
    : `${toolName}: ${toolBrief(input)}`;
  s.pendingPerms.set(requestId, { requestId, toolName, input, at: Date.now(), brief });
  push(s, { role: "system", name: isQuestion ? "question" : "permission", text: brief, ts: now() });
  openAction({
    id: `perm:${s.taskId}:${requestId}`,
    kind: isQuestion ? "decide" : "approve",
    source: "dispatch",
    title: isQuestion ? `任务提问：${brief.slice(0, 60)}` : `任务想执行高危操作`,
    reason: brief,
    ref: { task_id: s.taskId },
  });
  // 横幅+feed 留着（noLark），飞书改发可直接点的互动卡片（离开电脑也能批）
  notify(`🔐 任务 [${s.taskId}] ${isQuestion ? "提问" : "等待审批"}\n${brief}`, { source: "dispatch", noLark: true }).catch(() => {});
  import("./lark-cards.ts").then((m) =>
    isQuestion
      ? m.sendQuestionCard(s.taskId, requestId, input.questions?.[0]?.question || brief, opts)
      : m.sendPermCard(s.taskId, requestId, brief),
  ).catch(() => {});
  persist(s);
}

function respondPermission(s: EngineSession, requestId: string, allow: boolean, input?: any, message?: string) {
  // updatedInput 必须 camelCase——CC zod strict，snake_case 静默丢弃（clawd 实测）
  const inner = allow
    ? { behavior: "allow", updatedInput: input ?? {} }
    : { behavior: "deny", message: message || "用户拒绝" };
  writeStdin(s, JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: inner },
  }) + "\n");
}

/** 收件箱审批入口。AskUserQuestion 的回答走 deny message 通道回传（模型会读到 message 继续干活）。
 *  remember: 仅对 allow 有效——"session"=本会话记忆 / "global"=全局记忆 / null=只批本次 */
export function decidePerm(taskId: string, requestId: string, allow: boolean, message?: string, remember?: RuleScope | null): string {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("会话不存在或已随 daemon 重启失效");
  const p = s.pendingPerms.get(requestId);
  if (!p) throw new Error("该请求已处理或已过期");
  s.pendingPerms.delete(requestId);
  if (p.toolName === "AskUserQuestion") {
    respondPermission(s, requestId, false, undefined, message ? `用户的回答：${message}` : "用户跳过了这个问题，按你的判断继续");
  } else {
    respondPermission(s, requestId, allow, p.input, message);
  }
  // 「总是批准」→ 按操作类型+对象记忆成规则（问题类不记忆）
  let ruleScope: RuleScope | undefined;
  const { kind, pattern } = patternFor(p.toolName, p.input);
  if (allow && remember && p.toolName !== "AskUserQuestion") {
    const rule = addRule({ scope: remember, sessionId: taskId, kind, pattern });
    ruleScope = rule.scope;
  }
  logDecision({ taskId, requestId, toolName: p.toolName, kind, pattern,
    decision: allow ? "allow" : "deny", by: "user", ruleScope, detail: p.brief });
  resolveAction(`perm:${taskId}:${requestId}`, allow ? "approved" : "denied");
  const tail = ruleScope ? `（已记忆：${ruleScope === "global" ? "全局" : "本会话"}）` : "";
  push(s, { role: "system", name: "decision", text: allow ? `✅ 已批准${tail}` : `⛔ ${message || "已拒绝"}`, ts: now() });
  persist(s);
  return "已提交";
}

/** 追问：进程活着直接投帧；死了带 --resume 重生。
 *  忙时（本轮还在跑）不再报错——入队列，本轮结束在 endTurn 处自动合并发出。 */
export function sendFollowUp(taskId: string, text: string, images: DevImage[] = []): { queued: boolean } {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("会话不存在（daemon 重启后旧任务只能看不能续聊）");
  if (s.turn === "running") {
    s.queued.push(parseQueued(text, images));
    return { queued: true };
  }
  push(s, { role: "user", text: images.length ? `📎×${images.length} ${text}` : text, ts: now() });
  s.turn = "running";
  s.autoCompacting = false;   // 用户发新消息：清自动压缩态（防标记卡住）
  s.interruptRequested = false;
  captureTurnHead(s);
  clearTimeout(s.idleTimer);
  // 有 session_id 带 --resume 续聊；没有（/new 清掉之后）就全新开局，init 帧会回报新 id
  let spawnedForTurn = false;
  if (!s.alive) { spawn(s, !!s.toolSessionId); spawnedForTurn = true; }
  try { s.activeRun = beginClaudeProviderRun(s, () => writeStdin(s, userFrame(text, images))); }
  catch (error) { restoreClaudeAfterDispatchGate(s, error, spawnedForTurn, () => persist(s)); throw error; }
  persist(s);
  // 追问的新 turn 让任务回到运行态（客户端角标 + reap 不重复触发：标记已写过）
  import("./dispatch.ts").then(({ updateTask }) =>
    updateTask(taskId, { status: "running", endedAt: undefined, exitCode: undefined }),
  ).catch((e) => log(`engine [${taskId}] 续聊状态回写失败: ${e}`));
  return { queued: false };
}

/** 空闲 Claude 会话追加授权目录。Claude Code 不支持给已启动的 stream-json 进程热加
 * --add-dir，因此持久化配置并收掉空闲进程；下一轮以同一 session_id --resume 重启。 */
export function addEngineDir(taskId: string, dir: string): void {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("会话不存在（请先恢复会话后再添加目录）");
  if (s.control !== "ownward") throw new Error("未持有输入权，请先接管");
  if (s.turn === "running") throw new Error("Claude 正在执行本轮任务，请等本轮结束后再添加目录");
  s.opts.extraDirs = [...new Set([...(s.opts.extraDirs ?? []), dir])];
  clearTimeout(s.idleTimer);
  const proc = s.proc;
  s.proc = null; // 先脱钩，避免 exited 回调把空闲会话误判成异常退出
  s.alive = false;
  if (proc) { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } }
  touch(s);
  persist(s);
}

/** /new：同任务丢弃全部上下文重开。杀进程、清 resume id / plan / 队列 / 挂起审批，
 *  下一条消息在同目录 spawn 全新 claude（不带 --resume）。卡死/撞限流时的逃生门。 */
export function newEngineSession(taskId: string): string {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("会话不存在（daemon 重启后旧任务只能看不能续聊）");
  if (s.control !== "ownward") throw new Error("未持有输入权，请先接管");
  if (s.turn === "running") finishRunSidecar(s.activeRun, "interrupted", { reason: "user_new_session" }, s.runSidecarDeps);
  s.activeRun = undefined;
  s.interruptRequested = false;
  if (s.proc) { try { s.proc.kill("SIGKILL"); } catch { /* 已退出 */ } s.proc = null; } // CC 不理 SIGTERM
  s.alive = false;
  s.turn = "idle";
  s.partial = "";
  s.queued = [];
  clearTimeout(s.idleTimer);
  if (s.pendingPerms.size) {
    for (const p of s.pendingPerms.values()) resolveAction(`perm:${taskId}:${p.requestId}`, "interrupted");
    s.pendingPerms.clear();
  }
  s.toolSessionId = undefined;   // 关键：下次 sendFollowUp 不带 --resume，全新会话
  s.plan = [];
  s.tokens = {};
  push(s, { role: "system", text: "🆕 已开新会话：上下文已清空，下一条消息在同目录从零开始", ts: now() });
  persist(s);
  return "已开新会话，上下文已清空";
}

/** 本轮收尾：把忙时队列合并成一条 user 帧发出。返回是否真的发了 */
function flushQueue(s: EngineSession): boolean {
  // 租约校验：本轮跑着时用户释放了输入权（observing），队列不自动续发——留着等重新接管，
  // 否则会绕过「非 ownward 不许发」的租约（codex review 查出的漏洞）
  if (s.control !== "ownward") return false;
  // 一次只发一段（斜杠命令独占一帧，见 sliceQueue），剩下的下一轮 endTurn 接着发
  while (s.queued.length) {
    const { batch, rest } = sliceQueue(s.queued);
    s.queued = rest;
    const { text, images } = mergeQueued(batch);
    if (!text.trim() && !images.length) continue;   // 整段空白：跳过，接着看下一段
    // 此时 turn 已置 idle，sendFollowUp 会把它拉回 running 并投帧（进程还活着直接写）
    try { sendFollowUp(s.taskId, text, images); return true; }
    catch (e) { log(`engine [${s.taskId}] flush queue failed: ${e}`); return false; }
  }
  return false;
}

/** 忙时队列的当前视图（客户端轮询展示，不含图片体） */
export function engineQueue(taskId: string): QueuedView[] {
  const s = sessions.get(taskId);
  if (!s) return [];
  return QUEUE_VIEW(s.queued);
}

/** 撤回一条还没发出的排队消息（按稳定 id）。
 *  找不到就如实回 removed:false——多半是本轮刚结束、这条已经发出去了，
 *  这种情况必须让调用方看见，绝不静默当成撤成功（规则 9：不许静默 no-op）。 */
export function removeEngineQueued(taskId: string, queueId: string): { removed: boolean; queued: QueuedView[] } {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("会话不存在");
  const at = s.queued.findIndex((i) => i.id === queueId);
  if (at >= 0) s.queued.splice(at, 1);
  return { removed: at >= 0, queued: engineQueue(taskId) };
}

/** 中断当前 turn（进程不死，可继续追问） */
export function interruptTask(taskId: string) {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s?.alive) throw new Error("进程不在运行");
  const sent = writeStdin(s, JSON.stringify({
    type: "control_request",
    request_id: `ownward-${++s.ctrlSeq}`,
    request: { subtype: "interrupt" },
  }) + "\n");
  if (!sent) throw new Error("中断请求未能发送");
  s.interruptRequested = true;
  push(s, { role: "system", text: "⏹ 已请求中断", ts: now() });
}

function writeStdin(s: EngineSession, data: string): boolean {
  try {
    (s.proc!.stdin as any).write(data);
    (s.proc!.stdin as any).flush?.();
    return true;
  } catch (e) {
    log(`engine [${s.taskId}] stdin write failed: ${e}`);
    return false;
  }
}

/** 客户端轮询：会话消息 + 状态。daemon 重启后从落盘文件兜底（只读） */
export function getEngineMessages(taskId: string): { messages: DevMsg[]; turn: string; alive: boolean; partial: string; pending: PendingPerm[]; queued: QueuedView[]; plan: PlanStep[]; tokens: TokenUsage; backend: string; model?: string; commands?: string[]; ctxTokens?: number; lastActivityAt: number } {
  const s = sessions.get(taskId);
  if (s) return { messages: s.messages, turn: s.turn, alive: s.alive, partial: s.partial, pending: [...s.pendingPerms.values()], queued: engineQueue(taskId), plan: s.plan, tokens: s.tokens, backend: "claude", model: s.model, commands: s.commands, ctxTokens: s.ctxTokens, lastActivityAt: s.lastActivityAt };
  try {
    const saved = JSON.parse(readFileSync(sessionFile(taskId), "utf8"));
    return { messages: saved.messages || [], turn: "idle", alive: false, partial: "", pending: [], queued: [], plan: saved.plan || [], tokens: saved.tokens || {}, backend: "claude", model: saved.model, commands: saved.commands, ctxTokens: saved.ctxTokens, lastActivityAt: saved.lastActivityAt || 0 };
  } catch {
    return { messages: [], turn: "idle", alive: false, partial: "", pending: [], queued: [], plan: [], tokens: {}, backend: "claude", lastActivityAt: 0 };
  }
}

/** 是否有活的引擎会话（在内存 sessions 里） */
export function hasEngineSession(taskId: string): boolean {
  return sessions.has(taskId);
}

/** 接管租约状态：先活会话，再落盘文件兜底；都没有默认 ownward（ownward 自己派的任务） */
export function engineControl(taskId: string): AgentControl {
  const s = sessions.get(taskId);
  if (s) return s.control;
  try {
    const saved = JSON.parse(readFileSync(sessionFile(taskId), "utf8"));
    return (saved.control as AgentControl) || "ownward";
  } catch { return "ownward"; }
}

/** 切换接管租约（take=ownward / release=observing）。只对活会话有效，切完落盘 */
export function setEngineControl(taskId: string, control: AgentControl) {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("会话不存在或已随 daemon 重启失效");
  s.control = control;
  persist(s);
}

/** CC 会话的 session_id（拿去 claude --resume）：先活会话，再落盘文件——重启/历史任务也能取到 */
export function engineSessionId(taskId: string): string | null {
  const s = sessions.get(taskId);
  if (s?.toolSessionId) return s.toolSessionId;
  try {
    const saved = JSON.parse(readFileSync(sessionFile(taskId), "utf8"));
    return saved.toolSessionId || null;
  } catch { return null; }
}

/** 会话启动参数：活会话优先，daemon 重启后从 session json 恢复。 */
export function engineOpts(taskId: string): EngineOpts {
  const s = sessions.get(taskId);
  if (s) return cleanEngineOpts(s.opts);
  try {
    const saved = JSON.parse(readFileSync(sessionFile(taskId), "utf8"));
    return cleanEngineOpts(saved.opts);
  } catch { return {}; }
}

function cleanEngineOpts(raw: unknown): EngineOpts {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const extraDirs = Array.isArray(r.extraDirs)
    ? [...new Set(r.extraDirs.filter((d): d is string => typeof d === "string" && isAbsolute(d)))]
    : undefined;
  return {
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(typeof r.effort === "string" ? { effort: r.effort } : {}),
    ...(typeof r.bypass === "boolean" ? { bypass: r.bypass } : {}),
    ...(extraDirs?.length ? { extraDirs } : {}),
  };
}

// 开发任务的审批不再 15 分钟自动拒绝——长任务可能整晚跑，中途拒绝会白白打断。
// 改为一直挂起等人，只保留 6 小时的兜底超时（防止会话永远泄漏），超时也记审计。
const PERM_TIMEOUT_MS = 6 * 60 * 60_000;

/** 权限请求挂起等人；超过 6 小时兜底才拒绝，避免会话永久泄漏 */
export function sweepPendingPerms() {
  for (const s of sessions.values()) {
    for (const p of [...s.pendingPerms.values()]) {
      if (Date.now() - p.at > PERM_TIMEOUT_MS) {
        s.pendingPerms.delete(p.requestId);
        respondPermission(s, p.requestId, false, undefined, "6 小时无人审批，兜底拒绝；请换安全方式继续");
        resolveAction(`perm:${s.taskId}:${p.requestId}`, "timeout");
        const { kind, pattern } = patternFor(p.toolName, p.input);
        logDecision({ taskId: s.taskId, requestId: p.requestId, toolName: p.toolName, kind, pattern,
          decision: "timeout", by: "system", detail: p.brief });
        push(s, { role: "system", text: "⌛ 审批挂起超 6 小时，兜底拒绝", ts: now() });
      }
    }
  }
}
