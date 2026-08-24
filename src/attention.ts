// 统一注意力收件箱：跨所有 agent 会话（CC 引擎 + codex 接管）聚合「需要你关注」的两类状态，
// 一键跳转处理。是「今日行动队列」（actions.ts，飞书/PR/routine 那类）之外的**新的一层**，
// 专门盯 agent 会话本身：卡住 / 待收尾。
//
// 审批**不再**进这里——审批归 Action 收件箱唯一权威源（agent-session 的 openAction，
// 今日页可直接批），注意力若再显示一张只能跳转的 approve 卡会与之重复且压不住。
//
// 判定逻辑拆成纯函数 classify(SessionSnapshot)，便于单测；collectAttention() 只负责
// 从内存活会话 + 最近任务采样出快照。控制成本：卡住只看内存活会话（读内存，零 IO），
// 待收尾只看任务元数据（不读消息、不跑 git）。

// —— 判定阈值（集中定义，单测与线上同源）——
import { DATA, cfg } from "./util.ts";
import type { KernelSessionService } from "./kernel/sessions/service.ts";
/** 卡住：turn 一直 running，但最后一次活动（输出/工具/进程状态变化）距今超过此值（8 分钟）。 */
export const STUCK_MS = 8 * 60_000;
/** 待收尾：任务结束后此窗口内（12 小时）才提示收尾，避免历史任务永久堆积。 */
export const DONE_RECENT_MS = 12 * 60 * 60_000;
/** 成本上限：除了所有内存活会话，再额外看最近这么多个开发任务（按 startedAt 倒序）。 */
export const MAX_TASKS = 60;
/** 结果条数上限：防列表被 done 刷屏。 */
export const MAX_ITEMS = 40;

export type AttentionKind = "stuck" | "done";

export interface AttentionItem {
  taskId: string;
  project: string;
  backend: "claude" | "codex" | "codebuddy";
  kind: AttentionKind;
  title: string;   // 会话/任务标题（精炼标题优先）
  detail: string;  // 一句话说清为什么需要关注
  age: number;     // 距触发时刻的秒数（客户端格式化）
  since: number;   // 触发时刻 epoch ms（排序 + 客户端兜底）
}

/** 判定输入快照：从会话/任务采样出的最小事实集合，纯数据、可注入（便于测试）。 */
export interface SessionSnapshot {
  taskId: string;
  project: string;
  backend: "claude" | "codex" | "codebuddy";
  live: boolean;            // 是否内存活会话（非活的只可能进 done）
  turn: string;             // running | idle
  alive: boolean;           // 底层进程是否存活
  lastActivityAt: number;   // 最后一次活动 epoch ms：输出 chunk/工具事件/进程状态变化处 touch（无活动 = 0）
  status: string;           // 任务 status：running | exited | done
  endedAt?: number;         // 任务结束时刻 epoch ms
  harvested: boolean;       // 产出是否已收割
  kind?: string;            // 任务 kind：evolve | routine
  verify?: string;          // 演进任务验证态：running | pass | fail
  applied?: boolean;        // 演进任务是否已上线
  titleText: string;        // 展示标题（精炼标题优先，回退原文）
  now: number;              // 当前时刻 epoch ms（注入便于测试）
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 纯判定：一个会话/任务快照 → 至多一条 AttentionItem（不需关注则返回 null）。
 *  优先级 stuck > done：卡住更紧急，一条会话只产一项。审批不在此列（归 Action 收件箱）。 */
export function classify(s: SessionSnapshot): AttentionItem | null {
  const title = clip(s.titleText || s.project, 60);
  const base = { taskId: s.taskId, project: s.project, backend: s.backend, title };
  const mk = (kind: AttentionKind, detail: string, since: number): AttentionItem => ({
    ...base, kind, detail,
    since,
    age: Math.max(0, Math.floor((s.now - since) / 1000)),
  });

  // 1) 卡住：活会话 turn 仍 running，但要么进程已死（异常），要么很久没活动。
  //    卡住判定用 lastActivityAt（每个输出 chunk/工具事件/进程状态变化都 touch），
  //    不再用「最后一条展示消息时间」——持续 partial 流、长命令、成功工具执行都可能
  //    很久没新消息但其实在干活，用消息时间会误报。
  if (s.live && s.turn === "running") {
    if (!s.alive) {
      return mk("stuck", "进程已退出，但仍显示运行中（异常，需要你介入）", s.lastActivityAt || s.now);
    }
    if (s.lastActivityAt > 0 && s.now - s.lastActivityAt > STUCK_MS) {
      const mins = Math.floor((s.now - s.lastActivityAt) / 60_000);
      return mk("stuck", `已 ${mins} 分钟没有新动静，可能卡住了`, s.lastActivityAt);
    }
    return null; // 正常运行中
  }

  // 2) 待收尾：任务已结束、还没收割产出（routine 自完成，不提示收尾）
  if (s.kind !== "routine" && (s.status === "exited" || s.status === "done") && !s.harvested) {
    if (s.endedAt && s.now - s.endedAt < DONE_RECENT_MS) {
      const detail = s.kind === "evolve" && s.verify === "pass" && !s.applied
        ? "自演进已验证通过，待上线（apply）"
        : "已结束，待收尾（未收割产出）";
      return mk("done", detail, s.endedAt);
    }
  }

  return null;
}

const KIND_ORDER: Record<AttentionKind, number> = { stuck: 0, done: 1 };

/** 取样口径（纯逻辑，可单测）：先无上限纳入所有内存活会话，再 union 最近 MAX_TASKS 个任务（去重、保序）。
 *  dev 需按 startedAt 倒序传入。修的是「活会话被 60 上限裁掉」——老的长活任务不该因排在窗口外而消失。 */
export function pickTasks<T extends { id: string }>(dev: T[], isLive: (id: string) => boolean): T[] {
  const picked = new Map<string, T>();
  for (const t of dev) if (isLive(t.id)) picked.set(t.id, t);          // 所有活会话（无上限）
  for (const t of dev.slice(0, MAX_TASKS)) if (!picked.has(t.id)) picked.set(t.id, t); // 再补最近 MAX_TASKS
  return [...picked.values()];
}

/** 聚合所有需要关注的 agent 会话。
 *  取样口径：**先无上限纳入所有内存活会话**（老的长任务即便排在 MAX_TASKS 之外，只要会话还活着
 *  就不能被裁掉，否则它的 stuck/待收尾会连人一起消失），**再 union 最近结束的 MAX_TASKS 个任务**。 */
export async function collectAttention(): Promise<AttentionItem[]> {
  const { loadTasks } = await import("./dispatch.ts");
  const { createSessionService } = await import("./session-service.ts");
  const { KernelSessionService } = await import("./kernel/sessions/service.ts");
  const { SessionRepository } = await import("./sessions/repository.ts");
  const { readRunJournalStrictIndexed, reduceRuns } = await import("./runs/repository.ts");
  const repo = new SessionRepository(DATA);
  const serviceFor = (taskId: string) => createSessionService(taskId, cfg.architecture?.allowedRoots ?? [], DATA);
  const now = Date.now();

  const dev = loadTasks()
    .filter((t) => t.mode === "claude-bg" || t.mode === "codex-bg")
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));

  // Attention 不能把事实层损坏伪装成“没有待关注项”；由 API 边界显式返回失败。
  const runnerLive = new Set(reduceRuns(readRunJournalStrictIndexed(DATA)).filter((run) => run.status === "running").map((run) => run.taskId));
  const picked = pickTasks(dev, (id) => runnerLive.has(id));
  const live = new Map<string, Awaited<ReturnType<KernelSessionService["state"]>>>();
  const groups=new Map<KernelSessionService,string[]>();for(const task of picked)if(runnerLive.has(task.id)){const service=serviceFor(task.id),ids=groups.get(service)??[];ids.push(task.id);groups.set(service,ids);}for(const [service,ids] of groups)for(const [id,state] of await service.states(ids))if(state.alive||state.turn==="running")live.set(id,state);

  const items: AttentionItem[] = [];
  for (const t of picked) {
    const state = live.get(t.id);
    let session:any=null;try{session=repo.getByTaskId(t.id);}catch{/* repository damage degrades to task mode */}
    const backend: "claude" | "codex" | "codebuddy" = session?.providerId ?? (t.mode === "codex-bg" ? "codex" : t.mode === "codebuddy-bg" ? "codebuddy" : "claude");

    let turn = "idle", alive = false, lastActivityAt = 0;

    // 只读内存活会话，不触碰落盘文件（成本可控）
    if (state) { turn = state.turn; alive = state.alive; lastActivityAt = state.lastActivityAt ?? 0; }

    const item = classify({
      taskId: t.id, project: t.project, backend,
      live: !!state, turn, alive, lastActivityAt,
      status: t.status, endedAt: t.endedAt ? Date.parse(t.endedAt) : undefined,
      harvested: !!t.harvested, kind: t.kind, verify: t.verify, applied: !!t.applied,
      titleText: t.title || t.task, now,
    });
    if (item) items.push(item);
  }

  // stuck > done；同类越久越靠前（since 早的先处理）
  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since - b.since);
  return items.slice(0, MAX_ITEMS);
}
