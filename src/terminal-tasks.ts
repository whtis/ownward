// terminal 任务收尾：terminal 模式任务由 osascript 拉起 Terminal.app 里的交互式 claude，
// Ownward 不持有该进程，reapExited 显式跳过它——过去只能手动 `own done <id>`。
// 这里做两件事：
//   ① sweepTerminalTasks：运行中的 terminal 任务，若对应 CC 会话已沉寂超阈值，自动 done+harvest+flight；
//   ② findTerminalCcSession：给「一键接管」端点用，把 terminal 任务底层 CC 会话定位出来接进引擎。
// 匹配启发式（纯逻辑，见单测）：CC 会话 cwd == 任务 cwd 且会话 mtime >= 任务 startedAt（会话是这任务拉起的），
// 同 cwd 多个候选取 mtime 最新的一个。匹配不到就不动（继续等）。
import type { CcSessionMeta } from "./cc-sessions.ts";
import type { WorkTask } from "./dispatch.ts";
import { DATA, log } from "./util.ts";

/** terminal 任务「沉寂即结束」阈值：CC 会话超过这段时间无写入视为已收工。
 *  对齐 capture.ts 的 15 分钟沉寂判定，避免人只是在 Terminal 里思考就被误判结束。 */
export const TERMINAL_SILENT_MS = 15 * 60_000;

/** 匹配所需的最小会话形状（便于单测构造） */
export interface CcLite {
  id: string;
  cwd: string;
  firstUser: string; // 首条真实 user 文本（terminal 拉起时 = 任务原文）
  mtime: number;     // 毫秒
  active: boolean;   // 2 分钟内有写入
}

/** 归一化：去首尾空白 + 折叠内部空白，用于文本比较 */
function norm(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** 两段文本是否「同一开头」——terminal 拉起 `claude '<task>'`，会话首条 user = 任务原文，
 *  但 firstUser 被截到 120 字、task 可能更长，故按较短一方的前缀（>=12 字）互相判包含。 */
function sameStart(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length, 60);
  if (n < 12) return x === y;             // 太短只认全等，避免误配
  return x.slice(0, n) === y.slice(0, n);
}

/** 纯匹配：在 CC 会话列表里确定性地认领 terminal 任务自己的会话。
 *  terminal 模式拉起的是 `claude '<任务原文>'`，该会话首条 user 消息 == 任务原文——据此认领，
 *  彻底避开「同 cwd 里别的 Claude 会话（daemon 的 claude -p / 你手开的会话）被误配」的老问题。
 *  规则（保守，宁可不配也不错配）：
 *    候选 = cwd 相等 且 mtime >= startedAt（派发之后才有写入的会话）；
 *    · 任务原文已知（常态）：只认 firstUser 与任务原文同开头的会话（多个取 mtime 最新），认不到就返回 null——
 *      **绝不**因为"这个 cwd 里派发后只有这一个会话"就凑合用它（同 cwd 常有无关会话：daemon 的 claude -p、
 *      你手开的会话、甚至另一个 terminal 任务）；
 *    · 任务原文缺失（防御/历史数据，正常任务不会）：无法用文本区分，只有单候选时才回退。 */
export function matchTerminalCcSession<T extends CcLite>(
  task: { cwd: string; startedAt: string; task?: string },
  sessions: T[],
): T | null {
  const startedMs = new Date(task.startedAt).getTime();
  if (!task.cwd || Number.isNaN(startedMs)) return null;
  const candidates = sessions.filter((s) => s.cwd === task.cwd && s.mtime >= startedMs);
  if (!candidates.length) return null;

  const taskText = norm(task.task || "");
  if (taskText) {
    // 任务原文已知：只认首条 user 消息 == 任务原文的会话，认不到就不猜
    let best: T | null = null;
    for (const s of candidates) {
      if (!sameStart(s.firstUser, taskText)) continue;
      if (!best || s.mtime > best.mtime) best = s;
    }
    return best;
  }
  // 任务原文缺失：单候选才回退
  return candidates.length === 1 ? candidates[0] : null;
}

/** 纯判定：会话是否已沉寂（不再活跃且超过阈值无写入）。sweep 用它决定是否自动收尾。 */
export function isCcSilent(session: CcLite, now: number, thresholdMs = TERMINAL_SILENT_MS): boolean {
  return !session.active && now - session.mtime > thresholdMs;
}

/** IO：定位一个 terminal 任务底层的 CC 会话（接管端点 + sweep 共用）。匹配不到返回 null。
 *  已确定性链接（ccSessionId）的直接用它——但要校验链接仍然成立，避免用到失效/误配的旧链接。 */
export async function findTerminalCcSession(task: WorkTask): Promise<CcSessionMeta | null> {
  const { listCcSessions } = await import("./cc-sessions.ts");
  const sessions = listCcSessions(80);
  if (task.ccSessionId) {
    const linked = sessions.find((s) => s.id === task.ccSessionId);
    if (linked && linkValid(task, linked)) return linked;  // 存量链接有效才用
  }
  return matchTerminalCcSession(task, sessions);            // 无链接/链接失效 → 重认（认不到返回 null）
}

/** 存量链接是否仍成立：会话首条 user 要与任务原文对得上（任务原文缺失则无从校验，信任）。
 *  防的是「链接冻结后指向了错的会话」——比如同 cwd 后来跑了别的任务、或早先误配的历史脏数据。
 *  例外：hook 链接是 claude 自己在 SessionStart 报的 session_id——那是事实，文本启发式无权推翻。 */
function linkValid(task: { task?: string; ccLinkedBy?: string }, s: CcLite): boolean {
  if (task.ccLinkedBy === "hook") return true;
  const taskText = norm(task.task || "");
  return !taskText || sameStart(s.firstUser, taskText);
}

/** SessionStart / SessionEnd 钩子上报：claude 自报 session_id 与退出，取代事后猜。
 *  链接立刻落盘（同步），收尾走后台（harvest 要调模型，绝不能卡住钩子的 3s 窗口）。
 *  返回给端点的 ok 只代表「已记录 / 已排队」——不做的事就明说，别回了 ok 又静默丢掉。 */
export async function applyCcHook(taskId: string, hook: any): Promise<{ ok: boolean; msg: string }> {
  const { loadTasks, updateTask } = await import("./dispatch.ts");
  const t = loadTasks().find((x) => x.id === taskId);
  if (!t) return { ok: false, msg: "任务不存在" };
  if (t.mode !== "terminal") return { ok: false, msg: "非 terminal 任务，不接受会话上报" };

  const event = String(hook?.hook_event_name || "");
  const { ccIdFromTranscript } = await import("./cc-sessions.ts");
  const rawPath = String(hook?.transcript_path || "");
  const ccId = ccIdFromTranscript(rawPath);
  if (ccId) {
    if (t.terminalLaunchId && t.ccLinkedBy === "hook" && t.ccSessionId && t.ccSessionId !== ccId && hook?.__ownwardAdopted!==true) return { ok: false, msg: "会话与已接管 Session 不一致" };
    if (t.ccSessionId !== ccId) log(`terminal link(hook): [${taskId}] ${t.project} → ${ccId.split("/").pop()}`);
    updateTask(taskId, { ccSessionId: ccId, ccLinkedBy: "hook" });
    // 新 launcher 已在认证握手中通过 SessionService.adopt 写入 canonical native ref；
    // legacy copy-forward 会把 transcript 复合 id 当 native ref 覆盖它，只供无握手旧任务使用。
    if (!t.terminalLaunchId) {
      try { (await import("./sessions/repository.ts")).reconcileLegacySessions(DATA); }
      catch (e) { log(`session repository reconcile failed [${taskId}]: ${e}`); }
    }
  } else if (rawPath) {
    // 给了路径却解不出会话 id = 越界或格式不对：这是异常，必须留痕，不能和「没给路径」混成一句话
    log(`cc-hook [${taskId}] transcript_path 非法，未链接: ${rawPath.slice(0, 200)}`);
    if (event !== "SessionEnd") return { ok: false, msg: "transcript_path 非法，未链接" };
  }

  if (event !== "SessionEnd") return { ok: true, msg: ccId ? "已链接" : "无 transcript_path，未链接" };

  // /clear 也发 SessionEnd，但人还在同一个窗口继续干活——不是收工
  const reason = String(hook?.reason || "other");
  if (reason === "clear") return { ok: true, msg: "clear 不收尾" };
  if (t.status !== "running") return { ok: true, msg: `任务已是 ${t.status}，不重复收尾` };

  updateTask(taskId, { ccEndedBy: reason, endedAt: new Date().toISOString() });
  const fresh = loadTasks().find((x) => x.id === taskId)!;
  log(`terminal end(hook): [${taskId}] ${t.project} 会话退出（${reason}），立即收尾`);
  finalizeTerminalTask(fresh)
    .then(async () => {
      const { notify } = await import("./notify.ts");
      await notify(`✅ terminal 任务结束 [${t.project}] ${t.task.slice(0, 40)}\n（Claude 会话已退出，已 done+收割）`, { source: "dispatch" });
    })
    .catch((e) => log(`terminal end(hook) finalize [${taskId}] failed: ${e}`));
  return { ok: true, msg: "已排队收尾" };
}

/** 认领/校正一个 terminal 任务的 CC 会话链接：
 *  既有链接有效则不动；失效（会话没了 / firstUser 与任务原文对不上）就清掉重认；认到就冻结 id。
 *  拉起 claude 后会话要几秒才落盘，故派发时异步重试几轮；daemon 也周期性维护。 */
export async function linkTerminalSession(id: string): Promise<void> {
  const { loadTasks, updateTask } = await import("./dispatch.ts");
  const { listCcSessions } = await import("./cc-sessions.ts");
  const t = loadTasks().find((x) => x.id === id);
  if (!t || t.mode !== "terminal") return;
  if (t.ccLinkedBy === "hook") return;                     // claude 自报的链接：不重认、不清理
  const sessions = listCcSessions(80);
  if (t.ccSessionId) {
    const linked = sessions.find((s) => s.id === t.ccSessionId);
    if (linked && linkValid(t, linked)) return;            // 链接仍有效
    if (!linked) return;                                   // 只是掉出了列表窗口（列表只取最近 80 个）——别把好链接清掉
    updateTask(id, { ccSessionId: undefined });            // 确实失效（会话首条 user 对不上）：清掉重认
  }
  const cc = matchTerminalCcSession(t, sessions);
  if (!cc) return;
  updateTask(id, { ccSessionId: cc.id });
  log(`terminal link: [${id}] ${t.project} → ${cc.id.split("/").pop()}`);
}

/** 派发后异步认领：会话落盘有延迟，短间隔重试几轮，拿到链接就放手（沉寂 sweep 会再兜底维护） */
export async function linkTerminalSessionSoon(id: string): Promise<void> {
  const { loadTasks } = await import("./dispatch.ts");
  for (const wait of [2_000, 3_000, 5_000, 8_000, 15_000]) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      await linkTerminalSession(id);
      if (loadTasks().find((x) => x.id === id)?.ccSessionId) return;
    } catch { /* 下轮再试 */ }
  }
}

/** daemon 周期调：维护所有运行中 terminal 任务的会话链接（补链 + 清理失效/误配的旧链接） */
export async function sweepTerminalLinks(): Promise<void> {
  const { loadTasks } = await import("./dispatch.ts");
  const running = loadTasks().filter((t) => t.mode === "terminal" && t.status === "running");
  for (const t of running) {
    try { await linkTerminalSession(t.id); } catch { /* 下轮再试 */ }
  }
}

/** 收尾一个任务：done + harvest（已收割则跳过）+ 结构化飞行记录。与 `own done` 逻辑一致。
 *  也供「手动结束」端点复用——孤儿/沉寂的运行中 terminal 任务在 app 里一键收尾。 */
export async function finalizeTerminalTask(t: WorkTask): Promise<void> {
  const { updateTask } = await import("./dispatch.ts");
  const endedAt = t.endedAt || new Date().toISOString();
  const done: WorkTask = { ...t, status: "done", endedAt };
  updateTask(t.id, { status: "done", endedAt });

  if (!t.harvested) {
    try {
      const { harvestTask } = await import("./harvest.ts");
      const note = await harvestTask(done);
      if (note) updateTask(t.id, { harvested: true, harvestedAt: new Date().toISOString() });
    } catch (e) {
      log(`terminal sweep harvest [${t.id}] failed: ${e}`);
    }
  }
  try {
    const { writeFlightRecord } = await import("./flight-record.ts");
    await writeFlightRecord(done);
  } catch (e) {
    log(`terminal sweep flight [${t.id}] failed: ${e}`);
  }
}

/** daemon 定时调：把 CC 会话已沉寂的运行中 terminal 任务自动收尾。
 *  只碰 mode==="terminal" && status==="running" 且能匹配到沉寂 CC 会话的任务，其余不动。 */
export async function sweepTerminalTasks(): Promise<void> {
  const { loadTasks } = await import("./dispatch.ts");
  const { listCcSessions } = await import("./cc-sessions.ts");
  const running = loadTasks().filter((t) => t.mode === "terminal" && t.status === "running");
  if (!running.length) return;

  const sessions = listCcSessions(80);
  const now = Date.now();
  for (const t of running) {
    // 优先用已冻结的确定性链接（但要校验仍成立）；没有效链接才退回启发式（保守——认不到不猜）
    const linked = t.ccSessionId ? sessions.find((s) => s.id === t.ccSessionId) : null;
    const cc = (linked && linkValid(t, linked) ? linked : null) || matchTerminalCcSession(t, sessions);
    if (!cc) continue;                       // 匹配不到：继续等（可能会话还没落盘/无法确定性认领）
    if (!isCcSilent(cc, now)) continue;      // 还活跃或刚停：不误伤
    log(`terminal sweep: [${t.id}] ${t.project} CC 会话沉寂 ${Math.round((now - cc.mtime) / 60000)}m，自动收尾`);
    await finalizeTerminalTask(t);
    try {
      const { notify } = await import("./notify.ts");
      await notify(`✅ terminal 任务自动结束 [${t.project}] ${t.task.slice(0, 40)}\n（Claude 会话沉寂 >${TERMINAL_SILENT_MS / 60000}min，已 done+收割）`, { source: "dispatch" });
    } catch { /* 通知失败不影响收尾 */ }
  }
}
