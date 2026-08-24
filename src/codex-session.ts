// Codex 会话：派发首轮 = `codex exec --json`，追问 = `codex exec resume <rolloutId> --json`，
// 事件流回灌消息列表。没有 CC 那种常驻 stdin 多轮，但 resume 让上下文连续——
// 对用户来说体验一致：同一个对话视图、随时追问、可中断。
import type { AgentControl, DevImage, DevMsg, PlanStep, TokenUsage } from "./agent-session.ts";
// 队列语义与 claude 引擎共用一份实现（/btw 识别、合并顺序、id 生成），别再各写各的
import { mergeQueued, parseQueued, QUEUE_VIEW, type QueuedItem, type QueuedView } from "./kernel/sessions/input-queue.ts";
import { DATA, ensureDir, log, run } from "./util.ts";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { reconcileLegacySessions, SessionRepository } from "./sessions/repository.ts";
import { acceptRunSidecar, crossRunDispatchBoundary, diagnoseUnstartedRunSidecar, finishRunSidecar, markRunStartedSidecar, type RunSidecarDeps, type RunSidecarHandle } from "./runs/sidecar.ts";
import { assertLegacyWriteAllowed } from "./kernel/sessions/legacy-ownership.ts";

interface CodexTakeover {
  taskId: string;
  cwd: string;
  home: string;          // codex | codex-alt
  rolloutId: string;
  turn: "running" | "idle";
  messages: DevMsg[];
  proc: ReturnType<typeof Bun.spawn> | null;
  control: AgentControl;   // 输入权归属：ownward 才允许追问
  queued: QueuedItem[];   // 忙时输入队列：本轮结束合并发出（图片随条目暂存，发出时落临时文件）
  plan: PlanStep[];      // update_plan / todo_list 抽出的最新执行计划（覆盖不堆叠）
  tokens: TokenUsage;    // turn.completed 的 usage 累计
  model?: string;        // 若事件能带出模型标识
  cfgModel?: string;     // 派发时用户指定的模型：每轮（首轮 + resume 追问）都要 -m 带上，不然追问轮回落默认模型
  lastActivityAt: number; // 最后一次活动 epoch ms：每个 item 事件/进程状态变化处 touch（供 attention 判卡住）
  turnStartHead?: string; // 本轮开始时的 git HEAD：轮结束出「本轮改动卡片」
  ctxTokens?: number;     // 最近一轮的 input 总量 ≈ 当前上下文占用（客户端换算 ctx%）
  firstTurnDone?: boolean; // 首轮已完成：首轮走 OWNWARD_EXIT+reap（通知/收割一次），追问轮走 updateTask 静默收敛（与 claude 引擎对称）
  watchdog?: ReturnType<typeof setInterval>; // 卡死看门狗：长时间无活动 SIGKILL（codex exec 网络 hang 时兜底）
  logFile?: string;       // 任务日志：追问轮开始时清空，避免旧 OWNWARD_EXIT 被 reap 二次触发
  extraDirs?: string[];   // 会话中途追加的可写目录(下一轮 spawn 注入 writable_roots)
  fullAccess?: boolean;
  activeRun?: RunSidecarHandle;
  killReason?: "watchdog";
  runSidecarDeps?: RunSidecarDeps; // 测试/未来 runner 注入；生产为空时使用 DATA。
}

const MSG_CAP = 600, MSG_KEEP = 400;   // 内存消息裁剪（与 claude 引擎一致，防长跑无界增长）
const CODEX_IDLE_KILL_MS = 15 * 60_000; // 一轮内 15 分钟无任何事件 = 判定卡死，SIGKILL 回收

/** push 消息 + 裁剪：codex 长跑任务几百次工具调用，不裁剪内存无界增长（S1） */
function pushMsg(s: CodexTakeover, m: DevMsg) {
  s.messages.push(m);
  if (s.messages.length > MSG_CAP) s.messages = s.messages.slice(-MSG_KEEP);
}

/** 卡死看门狗：本轮进程启动时装，退出时清。lastActivityAt 靠 touch() 在每个事件处刷新，
 *  持续产出的正常任务不会被误杀；只有真卡住（网络 hang、进程不退）才 SIGKILL。 */
function armWatchdog(s: CodexTakeover, proc: ReturnType<typeof Bun.spawn>) {
  clearInterval(s.watchdog);
  s.watchdog = setInterval(() => {
    if (s.proc !== proc) { clearInterval(s.watchdog); return; }
    if (Date.now() - s.lastActivityAt > CODEX_IDLE_KILL_MS) {
      log(`codex [${s.taskId}] 卡死看门狗触发（${Math.round(CODEX_IDLE_KILL_MS / 60000)}min 无活动），SIGKILL`);
      s.killReason = "watchdog";
      try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
      clearInterval(s.watchdog);
    }
  }, 60_000);
}

/** 本轮开始时冻结 git HEAD（异步；非 git 目录留空即不出卡片） */
function captureTurnHead(s: CodexTakeover) {
  s.turnStartHead = undefined;
  run(["git", "-C", s.cwd, "rev-parse", "HEAD"], { timeoutMs: 10_000 })
    .then((r) => { if (r.code === 0) s.turnStartHead = r.stdout.trim(); })
    .catch(() => {});
}

/** 本轮改动卡片：与 claude 引擎同款（改动摘要直接插进对话流） */
function emitTurnChanges(s: CodexTakeover) {
  const base = s.turnStartHead;
  s.turnStartHead = undefined;
  if (!base) return;
  import("./repo-panel.ts").then(async ({ turnChanges }) => {
    const c = await turnChanges(s.cwd, base);
    if (c) { pushMsg(s, { role: "system", name: "changes", text: c, ts: now() }); touch(s); }
  }).catch(() => {});
}

const sessions = new Map<string, CodexTakeover>();
const now = () => new Date().toISOString();

/** Provider 边界：accept 必须发生在 spawn 前，started 只能发生在 spawn 成功后。 */
export function acceptCodexProviderRun(s: Pick<CodexTakeover, "taskId" | "cwd" | "control" | "runSidecarDeps">): RunSidecarHandle {
  return acceptRunSidecar(s.taskId, "codex", { ...(s.runSidecarDeps ?? {}), identity: { cwd: s.cwd, control: s.control } });
}
export function dispatchCodexProviderProcess<T>(h: RunSidecarHandle, spawn: () => T, deps?: RunSidecarDeps): T {
  return crossRunDispatchBoundary(h, spawn, deps);
}
export function markCodexProviderRunStarted(h: RunSidecarHandle, deps?: RunSidecarDeps): void {
  markRunStartedSidecar(h, deps);
}
export function finishCodexProviderExit(s: Pick<CodexTakeover, "activeRun" | "killReason" | "runSidecarDeps">, code: number): void {
  finishRunSidecar(s.activeRun, "failed", { exitCode: code, reason: s.killReason === "watchdog" ? "watchdog_timeout" : "provider_exit_without_terminal" }, s.runSidecarDeps);
  s.activeRun = undefined;
}
export function interruptCodexProviderRun(s: Pick<CodexTakeover, "activeRun" | "runSidecarDeps">): void {
  finishRunSidecar(s.activeRun, "interrupted", { reason: "user_interrupt" }, s.runSidecarDeps);
  s.activeRun = undefined;
}

/** 触活：记一次「会话仍在动」的时间戳，供 attention 判卡住（不误报长命令/成功工具执行）。 */
function touch(s: CodexTakeover) {
  s.lastActivityAt = Date.now();
}

/** 清理 exec 命令展示：剥 shell 壳 + 环境变量赋值 + heredoc 前缀，只留有用命令。
 *  原始如 `/bin/zsh -lc "cat <<'EOF' | LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 lark-cli docx ..."`
 *  → `lark-cli docx ...`。命令行本就用于人眼扫一眼在干嘛，噪音全砍。 */
function cleanExec(raw: any): string {
  let c = (Array.isArray(raw) ? raw.join(" ") : String(raw || "")).trim();
  const wrap = c.match(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/); // /bin/zsh -lc "..."
  if (wrap) c = wrap[2].trim();
  c = c.replace(/\b[A-Z][A-Z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/g, "");  // 大写环境变量赋值噪音
  c = c.replace(/^cat\s+<<-?\s*['"]?[A-Za-z0-9_]+['"]?\s*\|\s*/, "");  // cat <<'EOF' | 前缀
  c = c.replace(/\s+/g, " ").trim();
  return c.slice(0, 200);
}

/** base64 图片落临时文件（codex exec 只吃 --image=<路径>，没有 stdin 内联通道）。
 *  轮结束（proc.exited）由调用方清理；清不掉只 log 不阻塞 */
function writeImageFiles(taskId: string, images: DevImage[]): string[] {
  if (!images.length) return [];
  const dir = join(DATA, "tasks", "img");
  ensureDir(dir);
  return images.map((im, i) => {
    const ext = (im.media_type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
    const f = join(dir, `${taskId}-${Date.now()}-${i}.${ext}`);
    writeFileSync(f, Buffer.from(im.data, "base64"));
    return f;
  });
}

function cleanupImageFiles(files: string[]) {
  for (const f of files) { try { unlinkSync(f); } catch { /* 已删/不存在 */ } }
}

export function hasCodexSession(taskId: string): boolean {
  return sessions.has(taskId);
}

/** 沙箱开关：解除后以 danger-full-access 覆写（exec 模式本就无审批，即完全放开；
 *  与 claude 引擎的 bypass 对齐，默认仍是 workspace-write 沙箱） */
function sandboxArgs(s: CodexTakeover): string[] {
  return s.fullAccess ? ["-c", `sandbox_mode="danger-full-access"`] : [];
}

/** 追加可写目录 → codex -c 覆写(workspace-write 沙箱在 cwd 之外的白名单) */
function writableRootArgs(s: CodexTakeover): string[] {
  return s.extraDirs?.length ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(s.extraDirs)}`] : [];
}

function codexMetaFile(taskId: string): string {
  return join(DATA, "tasks", `${taskId}.codex.json`);
}

/** 会话元数据落盘：resume 三要素 + 接管租约 + 会话中途开关（可写目录/沙箱） */
function persistMeta(s: CodexTakeover): void {
  writeFileSync(codexMetaFile(s.taskId), JSON.stringify({
    rolloutId: s.rolloutId, home: s.home, cwd: s.cwd, control: s.control,
    extraDirs: s.extraDirs || [], fullAccess: !!s.fullAccess,
  }));
  try {
    const registered = (() => { try { return JSON.parse(readFileSync(join(DATA, "tasks.json"), "utf8")).some((t: any) => t.id === s.taskId); } catch { return false; } })();
    if (registered && s.rolloutId) new SessionRepository(DATA).bind({ taskId: s.taskId, providerId: "codex", nativeRef: s.rolloutId, providerHome: s.home, cwd: s.cwd, control: s.control });
    else reconcileLegacySessions(DATA);
  }
  catch (e) { log(`session repository reconcile failed [${s.taskId}]: ${e}`); }
}

export function adoptCodexSession(taskId: string, cwd: string, home: string, rolloutId: string, seed: DevMsg[]) {
  assertLegacyWriteAllowed(taskId);
  let extraDirs: string[] = [];
  let fullAccess = false;
  try {
    const m = JSON.parse(readFileSync(codexMetaFile(taskId), "utf8"));
    extraDirs = m.extraDirs || []; fullAccess = !!m.fullAccess;
  } catch { /* 首次接管无 meta */ }
  const s: CodexTakeover = {
    taskId, cwd, home, rolloutId, turn: "idle", proc: null,
    messages: seed.slice(-80), control: "ownward", queued: [], plan: [], tokens: {}, // 接管即取得输入权
    lastActivityAt: Date.now(), extraDirs, fullAccess,
  };
  sessions.set(taskId, s);
  // 落盘 resume 三要素 + 接管租约：daemon 重启后仍能拼续聊命令、认出这是 codex 任务
  ensureDir(join(DATA, "tasks"));
  persistMeta(s);
  log(`codex takeover [${taskId}] rollout=${rolloutId} home=${home}`);
}

/** 会话中途加可写目录:立即落 meta,下一轮 spawn 生效 */
export function codexAddDir(taskId: string, dir: string): void {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("codex 会话不存在");
  s.extraDirs = [...new Set([...(s.extraDirs || []), dir])];
  persistMeta(s);
  pushMsg(s, { role: "system", text: `📁 已加入可写目录:${dir}(下一轮生效)`, ts: now() });
  touch(s);
}

/** 会话中途切换沙箱:下一轮生效,落 meta,会话流留审计消息 */
export function codexSetAccess(taskId: string, full: boolean): void {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("codex 会话不存在");
  s.fullAccess = full;
  persistMeta(s);
  pushMsg(s, { role: "system", text: full ? "🔓 已解除沙箱(下一轮生效,可写全盘)" : "🔒 已恢复沙箱(下一轮生效,workspace-write)", ts: now() });
  touch(s);
}

export function codexMessages(taskId: string) {
  const s = sessions.get(taskId);
  if (!s) return null;
  return { messages: s.messages, turn: s.turn, alive: s.proc !== null, partial: "", pending: [], queued: codexQueue(taskId), plan: s.plan, tokens: s.tokens, backend: "codex", model: s.model, ctxTokens: s.ctxTokens, lastActivityAt: s.lastActivityAt, fullAccess: !!s.fullAccess };
}

/** 忙时队列视图（客户端轮询展示） */
export function codexQueue(taskId: string): QueuedView[] {
  const s = sessions.get(taskId);
  if (!s) return [];
  return QUEUE_VIEW(s.queued);
}

/** 撤回一条还没发出的排队消息（按稳定 id）。找不到如实回 removed:false，不静默当成撤成功 */
export function removeCodexQueued(taskId: string, queueId: string): { removed: boolean; queued: QueuedView[] } {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("codex 会话不存在");
  const at = s.queued.findIndex((i) => i.id === queueId);
  if (at >= 0) s.queued.splice(at, 1);
  return { removed: at >= 0, queued: codexQueue(taskId) };
}

/** 原生 CLI 续聊信息：rollout id + home（codex-alt 要带 CODEX_HOME）+ 工作目录。
 *  先活会话，再落盘文件——daemon 重启/历史任务也能取到 */
export function codexResume(taskId: string): { rolloutId: string; home: string; cwd: string } | null {
  const s = sessions.get(taskId);
  if (s) return { rolloutId: s.rolloutId, home: s.home, cwd: s.cwd };
  try {
    const m = JSON.parse(readFileSync(codexMetaFile(taskId), "utf8"));
    return m.rolloutId ? { rolloutId: m.rolloutId, home: m.home || "codex", cwd: m.cwd || homedir() } : null;
  } catch { return null; }
}

/** 接管租约状态：先活会话，再落盘文件兜底；都没有默认 ownward */
export function codexControl(taskId: string): AgentControl {
  const s = sessions.get(taskId);
  if (s) return s.control;
  try {
    const m = JSON.parse(readFileSync(codexMetaFile(taskId), "utf8"));
    return (m.control as AgentControl) || "ownward";
  } catch { return "ownward"; }
}

/** 切换接管租约（take=ownward / release=observing）。只对活会话有效，切完落盘 */
export function setCodexControl(taskId: string, control: AgentControl) {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("codex 会话不存在或已随 daemon 重启失效");
  s.control = control;
  persistMeta(s);
}

/** codex-bg 派发首轮：managed 子进程（非 nohup——nohup 组会被 daemon 重启连坐杀掉且不留退出标记，
 *  任务永远挂 running）。事件流与追问同一套解析；thread.started 捕获 rolloutId 落盘供续聊；
 *  退出时写 OWNWARD_EXIT 标记接既有 reap（状态翻转/通知/收割/飞行记录）。 */
export function startCodexTask(taskId: string, cwd: string, task: string, logFile: string, images: DevImage[] = [], model?: string, fullAccess = false): number {
  assertLegacyWriteAllowed(taskId);
  const s: CodexTakeover = {
    taskId, cwd, home: "codex", rolloutId: "", turn: "running", proc: null, logFile,
    messages: [{ role: "user", text: images.length ? `📎×${images.length} ${task}` : task, ts: now() }], control: "ownward",
    queued: [], plan: [], tokens: {}, lastActivityAt: Date.now(), cfgModel: model, model, fullAccess,
  };
  sessions.set(taskId, s);
  captureTurnHead(s);
  // 图片经临时文件 + --image=（用 = 连写：-i 是贪婪多值参数，空格分隔会把后面的 prompt 吞成图片路径）
  const imgFiles = writeImageFiles(taskId, images);
  s.activeRun = acceptCodexProviderRun(s);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = dispatchCodexProviderProcess(s.activeRun, () => Bun.spawn(
      ["codex", "exec", "--full-auto", "--json", "--skip-git-repo-check",
        ...(model ? ["-m", model] : []), ...sandboxArgs(s), ...writableRootArgs(s), ...imgFiles.map((f) => `--image=${f}`), task],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ), s.runSidecarDeps);
  } catch (error) { diagnoseUnstartedRunSidecar(s.activeRun, error, s.runSidecarDeps); cleanupImageFiles(imgFiles); throw error; }
  s.proc = proc;
  s.killReason = undefined;
  touch(s);
  armWatchdog(s, proc);
  readLoop(s, proc).catch((e) => log(`codex task [${taskId}] read error: ${e}`));
  drainStderr(proc, logFile);   // codex 的 ERROR/警告走 stderr：留档 + 防管道缓冲区塞死
  proc.exited.then((code) => {
    cleanupImageFiles(imgFiles);
    if (s.proc !== proc) return;
    s.proc = null;
    clearInterval(s.watchdog);
    touch(s);
    finishCodexProviderExit(s, code);
    if (s.turn === "running") {
      s.turn = "idle";
      if (code !== 0) pushMsg(s, { role: "system", text: `codex 进程退出 (code ${code})`, ts: now() });
    }
    emitTurnChanges(s);
    // 首轮完成走 OWNWARD_EXIT + reap（通知/收割一次，与 claude 引擎首轮对称）
    try { appendFileSync(logFile, `\nOWNWARD_EXIT:${code}\n`); } catch { /* 日志写不进不阻塞 */ }
    s.firstTurnDone = true;
    refreshFlightRecord(taskId);
    if (s.queued.length && s.control === "ownward") {
      const merged = mergeQueued(s.queued);
      s.queued = [];
      if (merged.text.trim() || merged.images.length) {
        try { codexFollowUp(taskId, merged.text, merged.images); } catch (e) { log(`codex task [${taskId}] flush queue failed: ${e}`); }
      }
    }
  });
  return proc.pid;
}

/** 排空 stderr：codex 往 stderr 写日志，不读会塞满管道缓冲区把进程卡死；顺手留档 */
function drainStderr(proc: ReturnType<typeof Bun.spawn>, logFile?: string) {
  new Response(proc.stderr as ReadableStream).text().then((text) => {
    if (text.trim() && logFile) appendFileSync(logFile, `[stderr] ${text.slice(0, 4000)}\n`);
  }).catch(() => {});
}

export function codexFollowUp(taskId: string, text: string, images: DevImage[] = []): { queued: boolean } {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s) throw new Error("codex 会话不存在");
  // 忙时不再报错——入队列，本轮结束（proc.exited）自动合并发出
  if (s.turn === "running") {
    s.queued.push(parseQueued(text, images));
    return { queued: true };
  }
  // worktree 被清理后不能静默退化到 homedir 跑（工具全失败、用户困惑）——直接报错回对话（M5）
  if (!existsSync(s.cwd)) {
    pushMsg(s, { role: "system", name: "error", text: `⚠️ 工作目录已不存在（worktree 可能已清理）：${s.cwd}`, ts: now() });
    return { queued: false };
  }
  pushMsg(s, { role: "user", text: images.length ? `📎×${images.length} ${text}` : text, ts: now() });
  s.turn = "running";
  captureTurnHead(s);
  // 追问轮起始：清空 logFile（清掉首轮的 OWNWARD_EXIT，否则 reap 会在本轮把它当二次退出重复通知/收割），
  // 并把 dispatch 任务状态拉回 running（与 claude 引擎 sendFollowUp 对称，任务卡才会显示运行中）
  if (s.logFile) { try { writeFileSync(s.logFile, ""); } catch { /* 清不掉不阻塞 */ } }
  import("./dispatch.ts").then(({ updateTask }) =>
    updateTask(taskId, { status: "running", endedAt: undefined, exitCode: undefined }),
  ).catch((e) => log(`codex [${taskId}] 续聊状态回写失败: ${e}`));

  const env = { ...process.env } as Record<string, string>;
  if (s.home === "codex-alt") env.CODEX_HOME = join(homedir(), ".codex-alt");
  // 图片经临时文件 + --image=（用 = 连写：-i 是贪婪多值参数，空格分隔会把后面的 prompt 吞成图片路径）
  const imgFiles = writeImageFiles(taskId, images);
  s.activeRun = acceptCodexProviderRun(s);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = dispatchCodexProviderProcess(s.activeRun, () => Bun.spawn(
      // exec resume 不支持 -C，工作目录用 spawn cwd 给
      ["codex", "exec", "resume", s.rolloutId, "--json", "--skip-git-repo-check",
        ...(s.cfgModel ? ["-m", s.cfgModel] : []), ...sandboxArgs(s), ...writableRootArgs(s), ...imgFiles.map((f) => `--image=${f}`), text],
      { cwd: s.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env },
    ), s.runSidecarDeps);
  } catch (error) { diagnoseUnstartedRunSidecar(s.activeRun, error, s.runSidecarDeps); cleanupImageFiles(imgFiles); throw error; }
  s.proc = proc;
  s.killReason = undefined;
  touch(s); // 本轮进程启动 = 状态变化，触活
  armWatchdog(s, proc);
  readLoop(s, proc).catch((e) => log(`codex takeover [${taskId}] read error: ${e}`));
  drainStderr(proc, s.logFile);   // 不读 stderr 会塞满管道缓冲区把 codex 卡死
  proc.exited.then((code) => {
    cleanupImageFiles(imgFiles);
    if (s.proc !== proc) return;
    s.proc = null;
    clearInterval(s.watchdog);
    touch(s); // 进程退出 = 状态变化，触活
    finishCodexProviderExit(s, code);
    if (s.turn === "running") {
      s.turn = "idle";
      if (code !== 0) pushMsg(s, { role: "system", text: `codex 进程退出 (code ${code})`, ts: now() });
    }
    emitTurnChanges(s);
    // 追问轮静默收敛 dispatch 状态（不写 OWNWARD_EXIT/不再通知——与 claude 引擎追问轮对称）
    import("./dispatch.ts").then(({ updateTask }) =>
      updateTask(taskId, { status: "exited", exitCode: code, endedAt: now() }),
    ).catch((e) => log(`codex [${taskId}] 退出状态回写失败: ${e}`));
    // 多轮 upsert：每轮（proc.exited）都幂等刷新飞行记录，overwrite 捕获到目前完整历史。失败仅 log。
    refreshFlightRecord(taskId);
    // 本轮收尾：忙时队列非空且仍持有输入权就合并续发（observing 时不自动发，留着等重新接管）
    if (s.turn === "idle" && s.queued.length && s.control === "ownward") {
      const merged = mergeQueued(s.queued);
      s.queued = [];
      if (merged.text.trim() || merged.images.length) {
        try { codexFollowUp(taskId, merged.text, merged.images); } catch (e) { log(`codex takeover [${taskId}] flush queue failed: ${e}`); }
      }
    }
  });

  return { queued: false };
}

/** 幂等刷新飞行记录：每轮（proc.exited）调一次，overwrite 捕获到目前完整历史。失败仅 log 不阻塞。 */
function refreshFlightRecord(taskId: string) {
  import("./flight-record.ts").then(async ({ writeFlightRecord }) => {
    const { loadTasks } = await import("./dispatch.ts");
    const task = loadTasks().find((t) => t.id === taskId);
    if (task) await writeFlightRecord(task);
  }).catch((e) => log(`codex takeover [${taskId}] flight record refresh failed: ${e}`));
}

async function readLoop(s: CodexTakeover, proc: ReturnType<typeof Bun.spawn>) {
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
      handleCodexProviderLine(s, proc, line);
    }
  }
}

/** 唯一 JSONL 入站边界：进程身份校验和解析必须与生产 readLoop 走同一条路径。 */
export function handleCodexProviderLine(s: CodexTakeover, proc: ReturnType<typeof Bun.spawn>, line: string): void {
  if (s.proc !== proc) return; // 旧进程迟到的终帧绝不能结束新一轮 Run。
  try {
    const event = JSON.parse(line);
    // spawn 成功只证明进程存在；首个合法 Provider 帧才证明本轮命令已被接收。
    if (s.activeRun) markCodexProviderRunStarted(s.activeRun, s.runSidecarDeps);
    handleEvent(s, event);
  } catch { /* 非 JSON 行忽略 */ }
}

function handleEvent(s: CodexTakeover, e: any) {
  touch(s); // 每个事件（item / turn / reasoning / 计划更新）都是活动，触活
  // codex 0.144 exec --json schema（实测）：thread.started / turn.started /
  // item.completed{item:{type,...}} / turn.completed / turn.failed
  // 派发首轮还没有 rolloutId：thread.started 一到就捕获并落盘（resume 三要素齐了才能追问）
  if (e.type === "thread.started" && (e.thread_id || e.thread?.id)) {
    if (!s.rolloutId) {
      s.rolloutId = String(e.thread_id || e.thread.id);
      ensureDir(join(DATA, "tasks"));
      persistMeta(s);
      log(`codex task [${s.taskId}] thread=${s.rolloutId}`);
    }
    return;
  }
  if (e.type === "item.completed" && e.item) {
    const it = e.item;
    switch (it.type) {
      case "agent_message":
        if (it.text) pushMsg(s, { role: "assistant", text: String(it.text).slice(0, 6000), ts: now() });
        break;
      case "reasoning":
        if (it.text) pushMsg(s, { role: "thinking", text: String(it.text).slice(0, 1500), ts: now() });
        break;
      case "command_execution":
        pushMsg(s, { role: "tool", name: "exec", text: cleanExec(it.command), ts: now() });
        break;
      case "mcp_tool_call":
        pushMsg(s, { role: "tool", name: `${it.server || "mcp"}.${it.tool || ""}`, text: "", ts: now() });
        break;
      case "error":
        pushMsg(s, { role: "tool", name: "⚠️ 出错", text: String(it.message || "").slice(0, 300), ts: now() });
        break;
      // codex 执行计划：update_plan 的 todo_list 项。旧/新字段名都兜一遍
      case "todo_list":
      case "plan":
      case "plan_update":
        capturePlan(s, it.items || it.plan || it.todos);
        break;
    }
    return;
  }
  // 计划项也可能在 item.started/updated 阶段先出现（进行中态实时刷新）
  if ((e.type === "item.started" || e.type === "item.updated") && e.item?.type === "todo_list") {
    capturePlan(s, e.item.items || e.item.plan);
    return;
  }
  if (e.type === "turn.completed" || e.type === "turn.failed") {
    // usage：turn.completed 常带 { input_tokens, cached_input_tokens, output_tokens }
    const usage = e.usage || e.turn?.usage;
    accumulateTokens(s, usage);
    if (e.type === "turn.failed") {
      pushMsg(s, { role: "system", text: `本轮失败: ${JSON.stringify(e.error || {}).slice(0, 200)}`, ts: now() });
    }
    finishRunSidecar(s.activeRun, e.type === "turn.completed" ? "completed" : "failed", {
      ...(e.type === "turn.failed" ? { reason: "provider_turn_failed" } : {}), ...(runUsage(usage) ? { usage: runUsage(usage) } : {}),
    }, s.runSidecarDeps);
    s.activeRun = undefined;
    s.turn = "idle";
  }
}

/** codex 计划项 → PlanStep：兼容 {step,status}（update_plan）与 {text,completed}（todo_list） */
function capturePlan(s: CodexTakeover, items: any) {
  if (!Array.isArray(items)) return;
  const steps: PlanStep[] = [];
  for (const it of items) {
    const text = String(it?.step ?? it?.text ?? it?.content ?? "").trim();
    if (!text) continue;
    let status: PlanStep["status"] = "pending";
    if (it?.status === "in_progress" || it?.status === "completed") status = it.status;
    else if (it?.completed === true) status = "completed";
    steps.push({ text: text.slice(0, 200), status });
  }
  if (steps.length) s.plan = steps;
}

/** codex usage → 累计 token（字段名尽量兼容） */
function accumulateTokens(s: CodexTakeover, usage: any) {
  if (!usage || typeof usage !== "object") return;
  const inp = (usage.input_tokens || 0) + (usage.cached_input_tokens || usage.cache_read_input_tokens || 0);
  const out = usage.output_tokens || 0;
  if (inp > 0) s.ctxTokens = inp;   // 最近一轮 input 总量 ≈ 当前上下文占用
  const tot = usage.total_tokens || (inp + out);
  if (!inp && !out && !tot) return;
  s.tokens.input = (s.tokens.input || 0) + inp;
  s.tokens.output = (s.tokens.output || 0) + out;
  s.tokens.total = (s.tokens.input || 0) + (s.tokens.output || 0) || tot;
}

function runUsage(usage: any): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const token = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0;
  const inputTokens = token(usage.input_tokens) + token(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const outputTokens = token(usage.output_tokens);
  return inputTokens + outputTokens > 0 ? { inputTokens, outputTokens } : undefined;
}

export function codexInterrupt(taskId: string) {
  assertLegacyWriteAllowed(taskId);
  const s = sessions.get(taskId);
  if (!s?.proc) throw new Error("没有在跑的轮次");
  interruptCodexProviderRun(s);
  s.proc.kill(9);
  s.proc = null;
  s.turn = "idle";
  pushMsg(s, { role: "system", text: "⏹ 已中断本轮", ts: now() });
}
