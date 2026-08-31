// 编码调度台：派任务给 claude/codex，terminal 可见模式或 bg 后台模式。
// 任务注册表 data/tasks.json；bg 任务默认 worktree 隔离，由 daemon 看护退出。
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { fsyncSync } from "./fs-durable.ts";
import { basename, join } from "path";
import { DATA, ROOT, SOURCE_ROOT, cfg, ensureDir, expandHome, fmt, log, run } from "./util.ts";
import { readRunJournalStrictIndexed, reduceRuns } from "./runs/repository.ts";
import { openAction } from "./actions.ts";
import { DEFAULT_CODEX_MODEL } from "./session-options.ts";

export interface WorkTask {
  id: string;
  project: string;        // 项目名（repo 目录名）
  projectDir: string;     // 原始项目目录
  cwd: string;            // 实际执行目录（worktree 或原目录）
  branch?: string;
  task: string;           // 任务描述（原文）
  title?: string;         // 轻量模型生成的精炼标题（列表展示用，异步补齐）
  extraDirs?: string[];   // 附加项目：agent 也能读写（跨仓库任务）
  mode: "terminal" | "claude-bg" | "codex-bg" | "codebuddy-bg";
  engine?: boolean;       // claude-bg 走会话引擎（可追问/审批/中断），false 为旧式单发
  model?: string;
  effort?: string;
  kind?: "evolve" | "routine" | "adopted";  // evolve=自演进（verify+审批上线）；routine=文档写入任务；adopted=接管外部会话（非运行，无退出码）
  verify?: "running" | "pass" | "fail";
  applied?: boolean;      // 演进任务已合并上线
  deployState?: "pending" | "applied" | "failed";
  deployTransactionId?: string;
  deployAttemptId?: string;
  deployExpectedBuild?: string;
  deployExpectedHead?: string;
  deployDiagnostic?: string;
  ccSessionId?: string;   // terminal 任务确定性链接到的底层 CC 会话 id（据首条 user 消息认领，冻结后不变）
  ccLinkedBy?: "hook" | "match";  // 链接来源：hook=claude 自己报的事实（不再由启发式推翻）；match=文本匹配推断
  ccEndedBy?: string;     // SessionEnd 钩子报告的退出原因（terminal 任务据此立刻收尾，不等 15min 沉寂）
  terminalLaunchId?: string; // launch→adopt 一次性握手 id（非凭证；凭证只存在 0600 文件）
  pid?: number;
  logFile?: string;
  startHead?: string;     // 派发时冻结的不可变 git 基线（rev-parse HEAD），飞行记录据此出 diff
  gitIdentity?: { name: string; email: string }; // 派发时冻结的 commit author 身份，收割只归属精确匹配的提交
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  status: "running" | "exited" | "done";
  harvested?: boolean;
  harvestedAt?: string;   // 上次收割时刻：日志比它新就说明追问轮又干了活，sweepHarvest 据此重收
  flightState?: "pending" | "written" | "failed";  // 飞行记录状态（客户端只在 written 时给按钮）
  flightPath?: string;    // 已写飞行记录的绝对路径
  flightAttempts?: number; // 写失败重试计数（durable 重试上限用）
  commandId?: string;      // Runner 接受边界生成的稳定命令身份
  runId?: string;
  uncertain?: boolean;     // submit 响应丢失：保持 running，由 durable journal/recovery 收敛
  launchState?: "pending" | "accepted";
  launchAcceptedAt?: string;
}

const TASKS_FILE = join(DATA, "tasks.json");
const TASKS_LOCK_STALE_MS=30_000;

// 上次成功读到的任务表：读到截断/坏 JSON 时不返回空数组（否则后续 saveTasks 会把整表覆盖丢光），
// 而是回退到内存里最后一份好的。多轮飞行记录刷新放大了并发读写，这道防线很关键（codex review）。
let lastGoodTasks: WorkTask[] = [];

export function loadTasks(): WorkTask[] {
  try {
    const t = JSON.parse(readFileSync(TASKS_FILE, "utf8")) as WorkTask[];
    if (Array.isArray(t)) { lastGoodTasks = t; return t; }
  } catch { /* 文件不存在/半截写入：回退最后一份好的，绝不返回空表覆盖 */ }
  return lastGoodTasks;
}

function pidAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch{return false;}}
function acquireTasksLock(dataRoot=DATA):()=>void{ensureDir(dataRoot);const lock=join(dataRoot,".tasks.write.lock"),recovery=`${lock}.recovery`,token=crypto.randomUUID(),owner=join(lock,"owner.json");for(let i=0;i<250;i++){if(existsSync(recovery)){if(!existsSync(lock))try{unlinkSync(recovery);}catch{}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);continue;}try{mkdirSync(lock);writeFileSync(owner,JSON.stringify({pid:process.pid,createdAt:Date.now(),token}),{flag:"wx",mode:0o600});return()=>{try{const current=JSON.parse(readFileSync(owner,"utf8"));if(current.pid!==process.pid||current.token!==token)return;rmSync(lock,{recursive:true,force:true});}catch{}};}catch{let stale=false;try{const current=JSON.parse(readFileSync(owner,"utf8"));stale=Number.isInteger(current.pid)&&!pidAlive(current.pid);}catch{try{stale=Date.now()-statSync(lock).mtimeMs>TASKS_LOCK_STALE_MS;}catch{}}if(stale){const abandoned=`${lock}.stale.${process.pid}.${crypto.randomUUID()}`;try{linkSync(owner,recovery);const expected=statSync(recovery),current=statSync(owner);if(expected.dev!==current.dev||expected.ino!==current.ino){unlinkSync(recovery);continue;}renameSync(lock,abandoned);const claimed=statSync(join(abandoned,"owner.json"));if(claimed.dev!==expected.dev||claimed.ino!==expected.ino)throw new Error("TASKS_LOCK_IDENTITY_CHANGED");rmSync(abandoned,{recursive:true,force:true});unlinkSync(recovery);continue;}catch(error:any){if(existsSync(abandoned))try{if(!existsSync(lock))renameSync(abandoned,lock);}catch{}try{unlinkSync(recovery);}catch{}if(error?.message==="TASKS_LOCK_IDENTITY_CHANGED")continue;}}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}}throw new Error("TASKS_WRITE_BUSY");}
export function mutateTasksAt(dataRoot:string,mutator:(tasks:WorkTask[])=>WorkTask[]):WorkTask[]{const file=join(dataRoot,"tasks.json"),release=acquireTasksLock(dataRoot);try{let current:WorkTask[]=[];if(existsSync(file)){try{const parsed=JSON.parse(readFileSync(file,"utf8"));if(!Array.isArray(parsed))throw new Error("not array");current=parsed;}catch(error){throw Object.assign(new Error(`tasks registry corrupt: ${error instanceof Error?error.message:String(error)}`),{code:"TASKS_REGISTRY_CORRUPT"});}}const tasks=mutator(structuredClone(current));if(dataRoot===DATA)lastGoodTasks=tasks;
  // 原子 + durable 写：tmp+rename 防半截 JSON；fsync 内容与目录防崩溃后整表回退——
  // tasks.json 是任务注册表唯一真相，回退会引起重复派发/状态倒退（同仓 durable-write.ts 的标准姿势）
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dfd = openSync(dataRoot, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
  return tasks;}finally{release();}}
export function mutateTasks(mutator:(tasks:WorkTask[])=>WorkTask[]):WorkTask[]{return mutateTasksAt(DATA,mutator);}
/** Exact replacement for bootstrap/tests only. Product code should use add/update/remove/mutate. */
export function saveTasks(tasks: WorkTask[]) {mutateTasks(()=>tasks);}
export function addTask(task:WorkTask):void{mutateTasks(tasks=>{if(tasks.some(item=>item.id===task.id))throw new Error(`任务已存在: ${task.id}`);tasks.push(task);return tasks;});}
export function removeTask(id:string):void{mutateTasks(tasks=>tasks.filter(task=>task.id!==id));}

export function updateTask(id: string, patch: Partial<WorkTask>): WorkTask | null {
  // read-modify-write 尽量收窄窗口：每次都重读最新，只改目标任务再整表落盘
  let result:WorkTask|null=null;mutateTasks(tasks=>{const t=tasks.find(x=>x.id===id);if(t){Object.assign(t,patch);result=t;}return tasks;});return result;
}

export async function durableLaunchReceipt(dataRoot:string,taskId:string):Promise<{commandId:string;runId:string}|null>{const {SessionRepository}=await import("./sessions/repository.ts"),{RunnerCommandJournal}=await import("./runner/journals.ts"),{readRunJournalStrict}=await import("./runs/repository.ts"),session=new SessionRepository(dataRoot).getByTaskId(taskId),run=reduceRuns(readRunJournalStrict(dataRoot)).filter(item=>item.taskId===taskId&&(!session||item.sessionId===session.id)).at(-1),command=session?new RunnerCommandJournal(dataRoot).readStrict().filter(item=>item.sessionId===session.id).at(-1):undefined;return run?{commandId:run.commandId,runId:run.runId}:command?{commandId:command.commandId,runId:command.runId}:null;}
export function runnerTaskPatch(run:ReturnType<typeof reduceRuns>[number]):Partial<WorkTask>|null{if(run.status==="unknown_outcome")return{status:"exited",endedAt:run.endedAt??new Date().toISOString(),uncertain:true,commandId:run.commandId,runId:run.runId};if(["completed","failed","interrupted"].includes(run.status))return{status:"exited",exitCode:run.status==="completed"?0:run.status==="interrupted"?130:(run.terminal?.providerExitCode??1),uncertain:false,endedAt:run.endedAt??new Date().toISOString(),commandId:run.commandId,runId:run.runId};return null;}
export function commitTaskPatchesAt(dataRoot:string,patches:Map<string,Partial<WorkTask>>,guards:Map<string,{commandId:string;runId:string}>=new Map()):Set<string>{const applied=new Set<string>();if(!patches.size)return applied;mutateTasksAt(dataRoot,latest=>{for(const task of latest){const patch=patches.get(task.id);if(!patch)continue;const guard=guards.get(task.id);if(guard&&(task.commandId||task.runId)&&(task.commandId!==guard.commandId||task.runId!==guard.runId))continue;Object.assign(task,patch);applied.add(task.id);}return latest;});return applied;}

export interface WorkOptions {
  bg?: boolean;
  codex?: boolean;   // 旧调用方布尔开关；新调用方用 provider 字段，provider 优先
  provider?: "claude" | "codex" | "codebuddy";
  worktree?: boolean;   // 显式覆盖默认（terminal 默认原地，bg 默认 worktree）
  branch?: string;
  kind?: "evolve";
  model?: string;       // Provider 模型名；Codex 支持的模型与默认值见 session-options.ts
  effort?: string;      // Claude/CodeBuddy 五档；Codex 按所选模型校验（见 session-options.ts）
  permission?: "safe" | "bypass";  // safe=高危 Bash 走审批（默认），bypass=全放行
  extraDirs?: string[];  // 附加项目目录（跨仓库任务，引擎任务生效）
  images?: { media_type: string; data: string }[];  // 首轮附图（base64）；仅 bg 引擎任务支持
}

export async function startWork(projectDir: string, task: string, opts: WorkOptions): Promise<WorkTask> {
  if(opts.permission==="bypass"&&cfg.architecture?.allowFullAccess!==true)throw Object.assign(new Error("未启用全权限任务；请在 config.json 设置 architecture.allowFullAccess=true 后重启 Ownward"),{code:"SESSION_ACCESS_NOT_GRANTED"});
  const dir = expandHome(projectDir);
  if (!existsSync(dir)) throw new Error(`项目目录不存在: ${dir}`);
  const project = basename(dir);
  const id = `${fmt(new Date(), "date").replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
  const provider = opts.provider ?? (opts.codex ? "codex" : "claude");
  const model = opts.model ?? (provider === "codex" ? (cfg.llm?.codexModel || DEFAULT_CODEX_MODEL) : undefined);
  const mode: WorkTask["mode"] = opts.bg ? (`${provider}-bg` as WorkTask["mode"]) : "terminal";
  // terminal 模式给不了图（交互式 claude 只吃 argv 文本）——显式报错，不许静默丢（守则 9）
  if (opts.images?.length && mode === "terminal") throw new Error("terminal 模式不支持图片，请勾选「后台运行」");
  if (opts.extraDirs?.length && mode === "terminal") throw new Error("terminal 模式不支持附加目录，请勾选「后台运行」");

  // worktree：bg 默认开（保护主 checkout），terminal 默认原地
  const useWorktree = opts.worktree ?? !!opts.bg;
  let cwd = dir;
  let branch: string | undefined;
  if (useWorktree) {
    branch = opts.branch || `ownward/${id}`;
    const wtRoot = expandHome(cfg.dispatch.worktreeRoot);
    ensureDir(wtRoot);
    cwd = join(wtRoot, `${project}-${id}`);
    const r = await run(["git", "-C", dir, "worktree", "add", cwd, "-b", branch], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`worktree 创建失败: ${r.stderr.slice(0, 300)}`);
  }

  // 附加项目：展开 ~ 并去掉不存在的/与主项目重复的
  const extraDirs = (opts.extraDirs ?? [])
    .map((d) => expandHome(d))
    .filter((d) => d !== dir && existsSync(d));

  // 冻结不可变 git 基线：派发时的 HEAD。worktree 刚从主 checkout 拉出，HEAD 即分叉点；
  // 原地任务则是当前 HEAD——在 master 上原地干活也能靠它出 diff（不再退化成 merge-base=HEAD 丢提交）。
  let startHead: string | undefined;
  let gitIdentity: WorkTask["gitIdentity"];
  try {
    const [rp, name, email] = await Promise.all([
      run(["git", "-C", cwd, "rev-parse", "HEAD"], { timeoutMs: 15_000 }),
      run(["git", "-C", cwd, "config", "--get", "user.name"], { timeoutMs: 10_000 }),
      run(["git", "-C", cwd, "config", "--get", "user.email"], { timeoutMs: 10_000 }),
    ]);
    if (rp.code === 0 && rp.stdout.trim()) startHead = rp.stdout.trim();
    if (name.code === 0 && email.code === 0 && name.stdout.trim() && email.stdout.trim()) {
      gitIdentity = { name: name.stdout.trim(), email: email.stdout.trim() };
    }
  } catch { /* 非 git 仓库/空仓库：无基线，飞行记录按 git 状态标注 */ }

  const t: WorkTask = {
    id, project, projectDir: dir, cwd, branch, task, mode, kind: opts.kind,
    model, effort: opts.effort, startHead, gitIdentity,
    extraDirs: extraDirs.length ? extraDirs : undefined,
    startedAt: new Date().toISOString(), status: "running",
  };

  let terminalLaunch: { launchId: string; tokenFile: string; expiresAt: string } | undefined;
  if (mode === "terminal") {
    const { createTerminalAdoptLaunch, revokeTerminalAdoptLaunch } = await import("./kernel/sessions/terminal-adopt.ts");
    terminalLaunch = createTerminalAdoptLaunch(DATA, { taskId: id, providerId: "claude", cwd });
    t.terminalLaunchId = terminalLaunch.launchId;
    // SessionStart 可能在 osascript 返回前到达；先 durable 登记任务，避免合法 hook 看到“不存在”。
    addTask(t);
    try { await launchTerminal(cwd, task, id, terminalLaunch); }
    catch (error) { revokeTerminalAdoptLaunch(DATA, terminalLaunch.launchId); removeTask(id); throw error; }
  } else {
    // 后台 Agent 的唯一写路径：Kernel SessionService → 独立 Runner → Provider Registry。
    // 先 durable 登记任务再提交命令；Runner 不可用时保留明确失败态，绝不回退 legacy 引擎。
    t.engine = true;
    t.launchState = "pending";
    addTask(t);
    const { createNewSessionService } = await import("./session-service.ts");
    const providerId = provider;
    const roots = [cwd, ...extraDirs];
    const access = opts.permission === "bypass" ? "full-access" : "workspace";
    const sessions = createNewSessionService(roots);
    try {
      const session = await sessions.create({ taskId: id, providerId, cwd, control: "ownward", extraDirs, model, effort: opts.effort }, { roots, access });
      const accepted=await sessions.send(session.id, { text: task, images: opts.images ?? [], clientMutationId: `dispatch:${id}` });
      updateTask(id,{launchState:"accepted",launchAcceptedAt:new Date().toISOString(),commandId:accepted.commandId,runId:accepted.runId});
    } catch (error: any) {
      let durable:{commandId:string;runId:string}|null=null;try{durable=await durableLaunchReceipt(DATA,id);}catch{/* 原错误仍决定结果 */}
      if(durable||error?.outcomeUnknown===true){const commandId=durable?.commandId??error.commandId,runId=durable?.runId??error.runId;updateTask(id,{status:"running",launchState:"accepted",launchAcceptedAt:new Date().toISOString(),...(commandId?{commandId}:{}),...(runId?{runId}:{}),uncertain:true});}
      else updateTask(id, { status: "exited", endedAt: new Date().toISOString(), exitCode: 1, uncertain: false });
      throw error;
    }
  }

  // 任务在 Runner submit 前已 durable 登记；这里不能再用旧快照整对象回写，
  // 否则极快的 terminal event 可能刚投影出的 endedAt/exitCode 会被覆盖。
  // Provider 首次 persist 可能早于 tasks.json 登记；任务表落稳后再补一次统一身份，失败留给 daemon 重试。
  try { (await import("./sessions/repository.ts")).reconcileLegacySessions(DATA); }
  catch (e) { log(`session repository reconcile failed [${t.id}]: ${e}`); }
  log(`work dispatched: [${t.id}] ${project} (${mode}${branch ? ", " + branch : ""})`);
  titleFor(id, task).catch(() => {});   // 异步补精炼标题，不阻塞派发
  if (mode === "terminal") {
    // 认领这个任务自己拉起的 CC 会话（据首条 user 消息），冻结 id 供旁观/接管/沉寂收尾用
    import("./terminal-tasks.ts").then((m) => m.linkTerminalSessionSoon(id).catch(() => {}));
  }
  return t;
}

/** 给最近还没有标题的任务补生成（现有任务/生成失败的重试）；每轮限量控成本 */
export async function sweepTaskTitles(): Promise<void> {
  const pending = loadTasks()
    .filter((t) => !t.title)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 3);
  for (const t of pending) {
    try { await titleFor(t.id, t.task); } catch { /* 下轮再试 */ }
  }
}

/** 用轻量模型把任务原文压成一句短标题（<=16字，动词开头）。失败就不设，客户端回退原文 */
export async function titleFor(id: string, task: string): Promise<void> {
  const raw = task.trim();
  if (raw.length < 18) { updateTask(id, { title: raw }); return; }  // 本来就短，不劳模型
  const { llmJson } = await import("./llm.ts");
  const res = await llmJson([
    "把下面的开发任务压成一句中文短标题，要求：",
    "- 12 字以内，动词开头，说清做什么（如「优化飞书文档排版」「修复登录闪退」）",
    "- 去掉 URL、路径、编号等噪音，只保留意图",
    "- 输出严格 JSON：{\"title\": \"...\"}",
    "",
    raw.slice(0, 800),
  ].join("\n"));
  const title = res?.title ? String(res.title).slice(0, 24).trim() : "";
  if (title) updateTask(id, { title });
}

// 从 claude 会话里开出来的 Terminal.app 会带上这些 CLAUDE_CODE_* 环境变量，`do script` 的新窗口全部继承。
// 不清掉的话，terminal 任务的 `claude` 会把自己当成那个父会话的【子会话】，transcript 写进父会话的项目目录
// （不是本任务 cwd 对应的目录）——于是 ownward 按 cwd 永远找不到它，任务"在 Terminal 正常跑，但工作台看不到"。
// （实撞过：一个 terminal 任务就这样被父会话收编，工作台里始终显示没启动）
const CLAUDE_CHILD_ENVS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH"];

/** 会话上报钩子的局部 settings：只随 ownward 派发的 terminal 任务生效（`claude --settings <file>`），
 *  绝不写用户全局 ~/.claude/settings.json。幂等重写，改脚本路径后自动跟上。 */
function ccHookSettingsFile(): string {
  const f = join(DATA, "cc-hook-settings.json");
  const entry = [{ hooks: [{ type: "command", command: join(ROOT, "scripts", "cc-session-hook.sh"), timeout: 5 }] }];
  writeFileSync(f, JSON.stringify({ hooks: { SessionStart: entry, SessionEnd: entry } }, null, 2));
  return f;
}

/** 拉起可见 Terminal.app 窗口跑交互式 claude；过程数据由 Claude Code transcript 记录，事后 harvest。
 *  注入 OWNWARD_TASK_ID + 会话钩子：claude 一启动就把自己的 session_id 报回来，
 *  任务↔会话的链接不再依赖「同 cwd + 首条消息文本匹配」这类事后推断。 */
export function buildTerminalShellCommand(cwd: string, task: string, taskId: string, launch: { launchId: string; tokenFile: string }, port: number): string {
  // env -u 剥掉 CLAUDE_CODE_*，保证这是个干净的顶层会话（自己的 transcript 落在自己 cwd 的项目目录）
  const clean = CLAUDE_CHILD_ENVS.map((v) => `-u ${v}`).join(" ");
  const envAssign = `OWNWARD_TASK_ID=${shq(taskId)} OWNWARD_PORT=${shq(String(port))} OWNWARD_ADOPT_LAUNCH_ID=${shq(launch.launchId)} OWNWARD_ADOPT_TOKEN_FILE=${shq(launch.tokenFile)}`;
  let hookArgs = "";
  try { hookArgs = `--settings ${shq(ccHookSettingsFile())} `; } catch { /* 写不了就退回纯文本匹配认领 */ }
  return `cd ${shq(cwd)} && env ${clean} ${envAssign} claude ${hookArgs}${shq(task)}`;
}

async function launchTerminal(cwd: string, task: string, taskId: string, launch: { launchId: string; tokenFile: string }) {
  const shellCmd = buildTerminalShellCommand(cwd, task, taskId, launch, cfg.dashboard?.port || 4517);
  const r = await run([
    "osascript",
    "-e", `tell application "Terminal" to activate`,
    "-e", `tell application "Terminal" to do script ${JSON.stringify(shellCmd)}`,
  ], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`Terminal 拉起失败: ${r.stderr.slice(0, 300)}`);
}

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 接管外部 CC 会话：clawd / Terminal 跑过的会话变成 ownward 引擎任务，可续聊/审批。
 *  正在被别的端驱动（active）的会话拒绝接管——双端同时喂同一个 session 会精神分裂。 */
export async function adoptCcSession(ccId: string): Promise<WorkTask> {
  const { listCcSessions } = await import("./cc-sessions.ts");
  const meta = listCcSessions().find((x) => x.id === ccId);
  if (!meta) throw new Error("会话不在列表中（刷新后再试）");
  if (meta.active) throw new Error("会话正在被其他端驱动，等它空闲（2 分钟无写入）再接管");
  if (!meta.cwd || !existsSync(meta.cwd)) throw new Error(`原工作目录不存在: ${meta.cwd || "(未知)"}`);
  const toolSessionId = ccId.split("/").pop()!;

  const id = `${fmt(new Date(), "date").replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
  const t: WorkTask = {
    id, project: meta.project, projectDir: meta.cwd, cwd: meta.cwd,
    task: `接管会话：${meta.title.slice(0, 80)}`, mode: "claude-bg", engine: true,
    startedAt: new Date().toISOString(), status: "exited", exitCode: 0, harvested: true,
  };
  addTask(t);
  try { await (await import("./session-service.ts")).createNewSessionService([meta.cwd]).adopt({ taskId: id, providerId: "claude", nativeRef: toolSessionId, cwd: meta.cwd, control: "ownward" }, { roots: [meta.cwd], access: "workspace" }); }
  catch (error) { removeTask(id); throw error; }
  log(`cc session adopted: [${id}] ${meta.project} (${toolSessionId})`);
  return t;
}

/** 自演进任务：agent 在 worktree 里改 ownward 自己 */
export async function startEvolve(requirement: string): Promise<WorkTask> {
  const dirty = await run(["git", "-C", ROOT, "status", "--porcelain"], { timeoutMs: 15_000 });
  if (dirty.stdout.trim()) throw new Error("主仓库有未提交改动，先提交再演进（保证可回滚基线）");
  const task = [
    "你在 ownward 自己的仓库的隔离 worktree 中执行【自演进任务】。",
    "第一步：完整阅读 docs/development.md（架构边界、开发约束与验证要求）。",
    "",
    `需求：${requirement}`,
    "",
    "完成标准：",
    "1. 实现需求，遵守 docs/development.md 的约束",
    "2. 在 worktree 根目录跑 ./verify.sh，必须输出 VERIFY: PASS",
    "3. git add -A && git commit（中文 conventional commit）",
    "禁止：merge / push / 修改 data/ / 修改 launchd Label 或端口。",
  ].join("\n");
  return startWork(ROOT, task, { bg: true, worktree: true, kind: "evolve" });
}

/** 上线演进产物：tag last-good → merge → 独立 launchd one-shot helper 重启 */
export async function applyEvolve(id: string): Promise<string> {
  const t = loadTasks().find((x) => x.id === id);
  if (!t || t.kind !== "evolve") throw new Error("不是演进任务");
  if (t.verify !== "pass") throw new Error(`verify 状态为 ${t.verify || "未验证"}，不能上线`);
  if (t.applied) throw new Error("已上线过");
  if (!t.branch) throw new Error("无分支信息");

  let r = await run(["git", "-C", SOURCE_ROOT, "tag", "-f", "last-good"], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`打 last-good tag 失败: ${r.stderr.slice(0, 200)}`);

  r = await run(["git", "-C", SOURCE_ROOT, "merge", "--no-ff", t.branch, "-m", `evolve: ${t.task.split("\n").find((l) => l.startsWith("需求："))?.slice(3) || t.id}`], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    await run(["git", "-C", SOURCE_ROOT, "merge", "--abort"], { timeoutMs: 15_000 });
    throw new Error(`合并冲突，已中止: ${r.stderr.slice(0, 200)}`);
  }

  const head=(await run(["git","-C",SOURCE_ROOT,"rev-parse","HEAD"],{timeoutMs:15_000})).stdout.trim();
  if(!/^[a-f0-9]{40,64}$/.test(head))throw new Error("合并后 HEAD 无法冻结");
  const {prepareRelease}=await import("./release/build.ts");
  ensureDir(join(DATA,"releases"));
  const expectedBuild=prepareRelease(SOURCE_ROOT,join(DATA,"releases")).buildIdentity;
  const attemptId=`apply-${id}-${crypto.randomUUID()}`;
  const {reserveEvolveAttempt,writeEvolveDeployReceipt,reconcileEvolveReceipts}=await import("./evolve-release.ts");
  reserveEvolveAttempt(DATA,id,attemptId,expectedBuild,head);
  const { dispatchDeployHelper } = await import("./deploy-helper.ts");
  let helper:string;try{helper=await dispatchDeployHelper("apply",[t.cwd,t.branch,id,attemptId,expectedBuild],attemptId);}catch(error){writeEvolveDeployReceipt(DATA,id,attemptId,expectedBuild,"failed",`helper dispatch failed: ${error}`);reconcileEvolveReceipts(DATA);throw error;}
  log(`evolve [${id}] merged, independent helper dispatched: ${helper}`);
  return "已合并并进入发布事务；观察窗和 canary 通过后才会标记上线";
}

/** 检查 bg 任务日志里的退出标记，返回状态刚变化的任务 */
export function reapExited(): WorkTask[] {
  const tasks = loadTasks();
  const changed: WorkTask[] = [];
  const patches=new Map<string,Partial<WorkTask>>();
  const patchGuards=new Map<string,{commandId:string;runId:string}>();
  const runnerRuns = new Map<string, ReturnType<typeof reduceRuns>[number]>();
  try {
    for (const run of reduceRuns(readRunJournalStrictIndexed(DATA))) {
      const old = runnerRuns.get(run.taskId);
      if (!old || run.firstSequence > old.firstSequence) runnerRuns.set(run.taskId, run);
    }
  } catch (error) {
    // 损坏 journal 必须 fail closed：不猜退出码、不把任务误报完成。
    log(`reap: Runner run journal unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const t of tasks) {
    const runner = runnerRuns.get(t.id);
    if(t.mode==="terminal")continue;const newerRunner=!!(t.engine&&runner&&(t.commandId!==runner.commandId||t.runId!==runner.runId));if(t.status!=="running"&&!newerRunner)continue;
    if (t.engine && runner?.status === "unknown_outcome") {
      // Unknown is evidence of uncertainty, never evidence that the business task ended.
      // Keep it out of daemon's terminal/flight/harvest pipeline until a later query
      // proves a real terminal or the owner explicitly settles it.
      if (!t.uncertain || t.commandId !== runner.commandId || t.runId !== runner.runId) { const patch=runnerTaskPatch(runner)!;Object.assign(t,patch);patches.set(t.id,patch);patchGuards.set(t.id,{commandId:runner.commandId,runId:runner.runId}); }
      openAction({ id: `runner-uncertain:${t.id}`, kind: "decide", source: "runner", title: `任务结果待确认：${t.title || t.task.slice(0, 50)}`, reason: `Runner 无法证明 command ${runner.commandId} 的最终结果；请查询命令或人工收敛。`, ref: { task_id: t.id, note: `command:${runner.commandId}` } });
      continue;
    }
    if (t.engine && runner && ["completed", "failed", "interrupted"].includes(runner.status)) {
      const patch=runnerTaskPatch(runner)!;Object.assign(t,patch);
      patches.set(t.id,patch);
      patchGuards.set(t.id,{commandId:runner.commandId,runId:runner.runId});
      changed.push(t);
      continue;
    }
    if (!t.logFile) continue;
    if (!existsSync(t.logFile)) continue;
    const tail = readFileSync(t.logFile, "utf8").slice(-2000);
    const m = tail.match(/OWNWARD_EXIT:(\d+)/);
    if (m) {
      t.status = "exited";
      t.exitCode = parseInt(m[1], 10);
      t.endedAt = new Date().toISOString();
      patches.set(t.id,{status:t.status,exitCode:t.exitCode,endedAt:t.endedAt});
      changed.push(t);
    } else if (!t.engine && t.pid && !processAlive(t.pid)) {
      // 仅旧式 nohup 任务：进程死了却没留退出标记（nohup 组被 daemon 重启连坐杀掉、或异常死亡）→
      // 别让任务永远挂 running（血泪：codex-bg 任务挂了 17 小时「运行中」）。
      // Runner 引擎任务不走 pid 推断；它们只由上面的 durable Run terminal 收敛。
      t.status = "exited";
      t.exitCode = 1;
      t.endedAt = new Date().toISOString();
      patches.set(t.id,{status:t.status,exitCode:t.exitCode,endedAt:t.endedAt});
      changed.push(t);
      log(`reap: [${t.id}] 进程 ${t.pid} 已消失且无退出标记，按异常退出收敛`);
    }
  }
  const applied=commitTaskPatchesAt(DATA,patches,patchGuards);
  return changed.filter(task=>applied.has(task.id));
}

/** pid 存活探测（signal 0 不发信号只查权限/存在） */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
