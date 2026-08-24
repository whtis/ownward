// Runner 模式审批的可见性投影与兜底收敛。
// legacy 引擎里这条链在 agent-session（openAction + 横幅 + 飞书互动卡 + sweepPendingPerms 的
// 6 小时兜底拒绝）；切 Runner 后审批只活在 journal 与会话视图里——人不在屏幕前就永远不知道
// 任务卡在审批上，且没有任何超时收敛。本模块把这三样接回来：
//   1) 新出现的 pending 审批 → openAction(perm:taskId:requestId) + 横幅 + 飞书互动卡（一次）
//   2) 审批被答复 / turn 已终结 → resolveAction 对应资格
//   3) 超过 6 小时无人审批 → respondApproval(deny) 兜底 + resolveAction(timeout) + 审计留痕
// 审批策略属于 Kernel（Provider 不得反向依赖 notify/actions），所以投影住在 kernel/sessions。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, log } from "../../util.ts";
import { toolBrief } from "./runner-consumer.ts";

/** 与 legacy PERM_TIMEOUT_MS 同值：挂起等人，6 小时才兜底拒绝（防会话永久泄漏）。 */
export const RUNNER_PERM_TIMEOUT_MS = 6 * 60 * 60_000;

const TERMINAL = new Set(["completed", "failed", "interrupted", "unknown-outcome"]);

export interface ApprovalEventLike { type: string; commandId: string; sessionId: string; runId: string; approvalRequestId?: string; at: string; }
export interface ApprovalCommandLike { commandId: string; kind: string; sessionId: string; approvalRequestId?: string; }
export interface PendingApproval { sessionId: string; runId: string; requestId: string; at: string; event: ApprovalEventLike; stale: boolean; }
export interface ResolvedApproval { sessionId: string; requestId: string; resolution: "answered" | "turn-ended"; answeredBy?: string; }

/** 纯判定：journal 记录 → pending（含 stale 标记）与 resolved 两组。无 IO，便于单测。 */
export function classifyApprovals(
  events: readonly ApprovalEventLike[],
  commands: readonly ApprovalCommandLike[],
  now: number,
  timeoutMs = RUNNER_PERM_TIMEOUT_MS,
): { pending: PendingApproval[]; resolved: ResolvedApproval[] } {
  const terminalCommands = new Set(events.filter((e) => TERMINAL.has(e.type)).map((e) => e.commandId));
  const answered = new Map<string, string>(); // `${sessionId}:${requestId}` → 答复 commandId
  for (const c of commands) {
    if (c.kind !== "approval-response" || !c.approvalRequestId) continue;
    // 答复只有落到 completed/failed 终态才算数——in-flight 的答复下一轮再看，避免误 resolve
    if (events.some((e) => e.commandId === c.commandId && ["completed", "failed"].includes(e.type)))
      answered.set(`${c.sessionId}:${c.approvalRequestId}`, c.commandId);
  }
  const pending: PendingApproval[] = [], resolved: ResolvedApproval[] = [];
  for (const e of events) {
    if (e.type !== "approval-requested" || !e.approvalRequestId) continue;
    const key = `${e.sessionId}:${e.approvalRequestId}`;
    const by = answered.get(key);
    if (by) { resolved.push({ sessionId: e.sessionId, requestId: e.approvalRequestId, resolution: "answered", answeredBy: by }); continue; }
    if (terminalCommands.has(e.commandId)) { resolved.push({ sessionId: e.sessionId, requestId: e.approvalRequestId, resolution: "turn-ended" }); continue; }
    const at = Date.parse(e.at) || 0;
    pending.push({ sessionId: e.sessionId, runId: e.runId, requestId: e.approvalRequestId, at: e.at, event: e, stale: now - at > timeoutMs });
  }
  return { pending, resolved };
}

// —— 通知去重状态（观测数据：丢了只是重发一次横幅，原子写即可不必 fsync）——
interface SweepState { notified: Record<string, { at: string; taskId: string }>; }
const statePath = (dataRoot: string) => join(dataRoot, "kernel", "approval-sweep.json");
function loadState(dataRoot: string): SweepState {
  try { const raw = JSON.parse(readFileSync(statePath(dataRoot), "utf8")); if (raw && typeof raw.notified === "object") return raw; } catch { /* 首次/损坏都从空开始 */ }
  return { notified: {} };
}
function saveState(dataRoot: string, state: SweepState): void {
  const file = statePath(dataRoot); mkdirSync(join(dataRoot, "kernel"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(tmp, file);
}

function briefFromPayload(payload: unknown): { question: boolean; brief: string; questionText?: string; options: string[]; toolName: string; input: any } {
  const p = payload as any;
  if (p?.kind === "question") {
    const q = typeof p.question === "string" ? p.question : "agent 有问题要问";
    const options = Array.isArray(p.options) ? p.options.filter((o: unknown) => typeof o === "string").slice(0, 4) : [];
    return { question: true, brief: `${q.slice(0, 140)}${options.length ? `（选项: ${options.join(" / ")}）` : ""}`, questionText: q, options, toolName: "AskUserQuestion", input: {} };
  }
  const toolName = typeof p?.toolName === "string" ? p.toolName : "unknown-tool", input = p?.input && typeof p.input === "object" ? p.input : {};
  return { question: false, brief: `${toolName}: ${toolBrief(input)}`, options: [], toolName, input };
}

let sweeping = false;

/** daemon 每 60s 调一次。所有副作用逐项 try/catch：单个会话出错不拖垮整轮。 */
export async function sweepRunnerApprovals(dataRoot = DATA): Promise<void> {
  if (sweeping) return; sweeping = true;
  try {
    const { RunnerCommandJournal, RunnerEventJournal } = await import("../../runner/journals.ts");
    const eventJournal = new RunnerEventJournal(dataRoot);
    let events, commands;
    try { events = eventJournal.readStrict(); commands = new RunnerCommandJournal(dataRoot).readStrict(); }
    catch { return; /* journal 尚不存在/暂不可读：下一轮再看 */ }
    const { pending, resolved } = classifyApprovals(events, commands, Date.now());
    const state = loadState(dataRoot);
    if (!pending.length && !Object.keys(state.notified).length) return;
    const { SessionRepository } = await import("../../sessions/repository.ts");
    const repo = new SessionRepository(dataRoot);
    const taskIdOf = (sessionId: string): string | null => {
      try { const s = repo.getById(sessionId); return s ? (s.taskIds[0] ?? s.id) : null; } catch { return null; }
    };
    let dirty = false;

    // 已答复 / turn 终结：收敛我们建过的 Action，并清通知状态
    for (const r of resolved) {
      const key = `${r.sessionId}:${r.requestId}`;
      const entry = state.notified[key];
      if (!entry) continue;
      try {
        const { resolveAction } = await import("../../actions.ts");
        let resolution = r.resolution === "turn-ended" ? "interrupted" : "answered";
        if (r.answeredBy) {
          try {
            const raw = new RunnerCommandJournal(dataRoot).readStrict().find((c) => c.commandId === r.answeredBy);
            const input = raw ? new RunnerCommandJournal(dataRoot).readInput(raw) : undefined;
            const parsed = input ? JSON.parse(input) : null;
            if (parsed?.response === "allow") resolution = "approved"; else if (parsed?.response === "deny") resolution = "denied";
          } catch { /* 读不到答复内容就用泛化 resolution */ }
        }
        resolveAction(`perm:${entry.taskId}:${r.requestId}`, resolution);
      } catch (e) { log(`approval sweep resolve [${key}]: ${e instanceof Error ? e.name : "unknown"}`); }
      delete state.notified[key]; dirty = true;
    }

    for (const p of pending) {
      const key = `${p.sessionId}:${p.requestId}`;
      const taskId = state.notified[key]?.taskId ?? taskIdOf(p.sessionId);
      if (!taskId) continue;
      // 首见：投影 Action + 横幅 + 飞书互动卡（openAction 本身按 id 幂等；横幅/卡片靠状态文件防重发）
      if (!state.notified[key]) {
        try {
          const raw = eventJournal.readPayload(p.event as any);
          const meta = briefFromPayload(raw ? JSON.parse(raw) : null);
          const { openAction } = await import("../../actions.ts");
          openAction({
            id: `perm:${taskId}:${p.requestId}`,
            kind: meta.question ? "decide" : "approve",
            source: "dispatch",
            title: meta.question ? `任务提问：${meta.brief.slice(0, 60)}` : "任务想执行高危操作",
            reason: meta.brief,
            ref: { task_id: taskId },
          } as any);
          const { notify } = await import("../../notify.ts");
          void notify(`🔐 任务 [${taskId}] ${meta.question ? "提问" : "等待审批"}\n${meta.brief}`, { source: "dispatch", noLark: true }).catch(() => {});
          void import("../../lark-cards.ts").then((m) =>
            meta.question ? m.sendQuestionCard(taskId, p.requestId, meta.questionText || meta.brief, meta.options) : m.sendPermCard(taskId, p.requestId, meta.brief),
          ).catch(() => {});
          state.notified[key] = { at: new Date().toISOString(), taskId }; dirty = true;
        } catch (e) { log(`approval sweep notify [${key}]: ${e instanceof Error ? e.name : "unknown"}`); }
        continue; // 首见轮不判超时（at 刚过去不到 6h，continue 只是省一次判断）
      }
      // 兜底超时：与 legacy 相同语义——deny + 审计 + Action 收敛。失败留状态下一轮重试。
      if (p.stale) {
        try {
          const { createSessionService } = await import("../../session-service.ts");
          await createSessionService(taskId, [], dataRoot).respondApproval(p.sessionId, p.requestId, { allow: false, message: "6 小时无人审批，兜底拒绝；请换安全方式继续" });
          const { resolveAction } = await import("../../actions.ts");
          resolveAction(`perm:${taskId}:${p.requestId}`, "timeout");
          try {
            const raw = eventJournal.readPayload(p.event as any);
            const meta = briefFromPayload(raw ? JSON.parse(raw) : null);
            const { logDecision, patternFor } = await import("../../approval.ts");
            const { kind, pattern } = patternFor(meta.toolName, meta.input);
            logDecision({ taskId, requestId: p.requestId, toolName: meta.toolName, kind, pattern, decision: "timeout", by: "system", detail: meta.brief });
          } catch { /* 审计尽力而为，不阻塞收敛 */ }
          delete state.notified[key]; dirty = true;
          log(`approval sweep: [${taskId}] ${p.requestId} 超 6 小时无人审批，兜底拒绝`);
        } catch (e) { log(`approval sweep timeout-deny [${key}]: ${e instanceof Error ? e.name : "unknown"}`); }
      }
    }

    // 清理孤儿状态：journal 里已经找不到对应审批（例如 journal 轮替）时别让状态无限膨胀
    const known = new Set([...pending.map((p) => `${p.sessionId}:${p.requestId}`), ...resolved.map((r) => `${r.sessionId}:${r.requestId}`)]);
    for (const key of Object.keys(state.notified)) if (!known.has(key)) { delete state.notified[key]; dirty = true; }
    if (dirty) saveState(dataRoot, state);
  } finally { sweeping = false; }
}
