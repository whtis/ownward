// ownward daemon 入口：启动事件源 + triage/heartbeat 定时器。
// launchd 负责常驻与崩溃拉起（KeepAlive）。
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { openAction, sweepActions } from "./actions.ts";
import { reapExited, updateTask } from "./dispatch.ts";
import { harvestTask } from "./harvest.ts";
import { runHeartbeat } from "./heartbeat.ts";
import { notify } from "./notify.ts";
import { takeRestartIntent } from "./restart.ts";
import { CrashGuard } from "./crash-guard.ts";
import { dispatchDeployHelper } from "./deploy-helper.ts";
import { startServer } from "./server.ts";
import { runTriage } from "./triage.ts";
import { DATA, ROOT, cfg, ensureDir, log, run, tailRead, updateState } from "./util.ts";
import { ensureCompatibleSchema } from "./storage/schema.ts";
import { recoverClaims } from "./spool.ts";
import { reconcileLegacySessions } from "./sessions/repository.ts";
import { recoverDispatchingRuns } from "./runs/repository.ts";
import { effectiveSessionMigrationMode, parseSessionMigrationMode } from "./kernel/sessions/contracts.ts";
import { closeLegacyRunningAtStartup } from "./kernel/sessions/legacy-startup-close.ts";

const PID_FILE = join(DATA, "daemon.pid");

function acquireLock() {
  ensureDir(DATA);
  if (existsSync(PID_FILE)) {
    const old = parseInt(readFileSync(PID_FILE, "utf8"), 10);
    try {
      process.kill(old, 0); // 存活探测
      console.error(`Ownward daemon already running (pid ${old})`);
      process.exit(1);
    } catch { /* stale pid */ }
  }
  writeFileSync(PID_FILE, String(process.pid));
  let cleaning=false; const cleanup = async () => { if(cleaning)return;cleaning=true;markLife("signal(SIGTERM/SIGINT)"); try { unlinkSync(PID_FILE); } catch {} try{const {stopVerticals}=await import("./verticals.ts");await Promise.race([stopVerticals(),Bun.sleep(2_000)]);}catch{} try{const {stopConnectors}=await import("./connectors.ts");await Promise.race([stopConnectors(),Bun.sleep(2_000)]);}catch{} process.exit(0); };
  process.on("SIGINT",()=>{void cleanup();});
  process.on("SIGTERM",()=>{void cleanup();});
}

// ---- 死因留痕 ----
// 2026-08-04 10:45:18 daemon 无声死掉，日志一个字都没留，KeepAlive 立刻拉起——
// 崩溃和主动重启在日志里长得一模一样，两个跑了一夜的 engine 任务被 reconcile 标死，查不出因。
// 上一代退出时写下死因，这一代启动读出来打进日志。三种结局能分清：
//   signal(...)          = 有人 bootout/kickstart，正常重启
//   uncaughtException    = 自己崩的，带首行栈
//   （文件不存在/无 how） = 被 SIGKILL 或 OOM 直接干掉，处理器都没跑到
const LIFE_FILE = join(DATA, "logs", "daemon-life.json");
let lifeStartedAt = "";
let lifeMarked = false;

function markLife(how: string, detail = "") {
  if (lifeMarked) return;   // 只记第一因：之后的 exit 事件是它的后果，不是新死因
  lifeMarked = true;
  try {
    writeFileSync(LIFE_FILE, JSON.stringify({
      pid: process.pid, startedAt: lifeStartedAt, exitedAt: new Date().toISOString(),
      how, detail: detail.slice(0, 400),
    }));
  } catch { /* 留痕失败不能反过来搞死 daemon */ }
}

function traceLife() {
  let prev: any = null;
  try { prev = JSON.parse(readFileSync(LIFE_FILE, "utf8")); } catch { /* 首次启动 */ }
  if (prev) {
    const secs = prev.startedAt
      ? Math.round((Date.parse(prev.exitedAt || new Date().toISOString()) - Date.parse(prev.startedAt)) / 1000) : 0;
    const up = secs >= 3600 ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 60)}m`;
    const how = prev.how || "未留痕（SIGKILL / OOM / 断电——退出处理器都没跑到）";
    log(`上一代 daemon pid=${prev.pid} 存活 ${up}，死因=${how}${prev.detail ? " · " + prev.detail : ""}`);
  }
  lifeStartedAt = new Date().toISOString();
  lifeMarked = false;
  try { writeFileSync(LIFE_FILE, JSON.stringify({ pid: process.pid, startedAt: lifeStartedAt })); } catch {}

  process.on("uncaughtException", (e: any) => {
    const stack = String(e?.stack || e);
    log(`❌ uncaughtException: ${stack.slice(0, 1500)}`);
    markLife("uncaughtException", stack.split("\n").slice(0, 2).join(" | "));
    process.exit(1);
  });
  // 野 promise 不让整个 daemon 陪葬：Bun/Node 默认对 unhandledRejection 直接终止进程，
  // 而 daemon 挂掉的代价是所有在跑的 engine 任务一起没（今早就是这么丢的）。
  // 但绝不静默吞——吞掉就是守则 9 的假成功。吵到日志里 + 留痕，进程继续活。
  process.on("unhandledRejection", (r: any) => {
    const stack = String(r?.stack || r);
    log(`❌ unhandledRejection（已捕获，daemon 继续运行）: ${stack.slice(0, 1500)}`);
    if (lifeMarked) return;   // 已经在收尾了，别把死因覆盖成一条野 promise
    try {
      writeFileSync(LIFE_FILE, JSON.stringify({
        pid: process.pid, startedAt: lifeStartedAt,
        lastRejection: { at: new Date().toISOString(), detail: stack.split("\n").slice(0, 2).join(" | ") },
      }));
    } catch { /* 同上 */ }
  });
  process.on("exit", (code) => markLife(`exit(${code})`));
}

/** daemon.log 无轮转会无限增长（launchd 一直追加），启动时超 5MB 截到尾部 512KB */
function rotateLog() {
  const f = join(DATA, "logs", "daemon.log");
  try {
    if (existsSync(f) && statSync(f).size > 5 * 1024 * 1024) {
      const tail = tailRead(f, 512 * 1024);
      writeFileSync(f, `(rotated ${new Date().toISOString()})\n` + tail);
    }
  } catch { /* 轮转失败不阻塞启动 */ }
}

/** 演进任务完成后：在 worktree 里跑验证门，出 diff 摘要，等人工审批 */
async function verifyEvolve(t: { id: string; cwd: string }) {
  updateTask(t.id, { verify: "running" });
  const r = await run(["bash", "./verify.sh"], { cwd: t.cwd, timeoutMs: 600_000 });
  const pass = r.stdout.includes("VERIFY: PASS");
  updateTask(t.id, { verify: pass ? "pass" : "fail" });
  const diff = await run(["git", "-C", t.cwd, "diff", "main", "--stat"], { timeoutMs: 15_000 });
  const stat = diff.stdout.trim().split("\n").slice(-4).join("\n");
  openAction({
    id: `evolve:${t.id}`,
    kind: pass ? "approve" : "decide",
    source: "evolve",
    title: pass ? "演进任务等待上线批准" : "演进任务验证失败",
    reason: pass ? `verify PASS · ${stat.split("\n").pop()?.trim() || ""}` : "verify FAIL，需要决定重试还是放弃",
    ref: { task_id: t.id },
  });
  await notify(
    pass
      ? `🧬 Ownward 演进就绪 [${t.id}]\n${stat}\nverify PASS → 上线: own apply ${t.id}（或使用任务卡按钮）`
      : `🧬❌ 演进验证失败 [${t.id}]\n${(r.stdout.match(/❌.*/g) || []).slice(0, 3).join("\n")}`,
    { source: "dispatch" },
  );
}

export interface RunnerStartupGate { ok:boolean; required:boolean; errorCode?:"RUNNER_UNAVAILABLE"; detail?:string }
export async function requireRunnerStartupGate(sessionMode:"off"|"runner",dataRoot=DATA,options:{attempts?:number;delayMs?:number;expectedBuild?:string;requiredProviders?:readonly string[]}={}):Promise<RunnerStartupGate>{if(sessionMode!=="runner"||process.env.OWNWARD_TEST)return{ok:true,required:false};const[{RunnerClient},{parseRunnerHealth}]=await Promise.all([import("./runner/client.ts"),import("./runner/health-contract.ts")]);const attempts=options.attempts??4,delayMs=options.delayMs??250;let detail="Runner unavailable";for(let attempt=0;attempt<attempts;attempt++){let client:InstanceType<typeof RunnerClient>|undefined;try{client=new RunnerClient(dataRoot,1_000);const reply=await client.request("ping",{}),health=parseRunnerHealth({ok:true,...reply.body},{expectedBuild:options.expectedBuild??process.env.OWNWARD_BUILD_IDENTITY,requiredProviders:options.requiredProviders??["claude","codex"]});if(health.draining)throw new Error("Runner draining");return{ok:true,required:true};}catch(error){detail=error instanceof Error?error.message:String(error);}finally{client?.close();}if(attempt+1<attempts)await Bun.sleep(delayMs);}return{ok:false,required:true,errorCode:"RUNNER_UNAVAILABLE",detail};}
async function main() {
  let sessionMode: "off" | "runner";
  try { sessionMode = parseSessionMigrationMode(cfg.architecture?.sessionRunnerMode); effectiveSessionMigrationMode(sessionMode, "__startup_validation__", cfg.architecture?.sessionRunnerTaskIds); }
  catch (e) { console.error(`Ownward config gate: ${e instanceof Error ? e.message : String(e)}`); process.exit(78); }
  // 必须早于 acquireLock/boots/life/log/server：未来或损坏 schema 下旧程序一字节也不能写。
  try {
    ensureCompatibleSchema(DATA);
  } catch (e) {
    console.error(`Ownward schema gate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(78); // EX_CONFIG：配置/数据版本不兼容，不让 launchd 误以为正常退出
  }
  const requiredProviders=Object.entries(cfg.providers??{}).filter(([,value]:any)=>value?.enabled!==false).map(([id])=>id==="claude-code"?"claude":id).filter(id=>id==="claude"||id==="codex");
  const runnerGate=await requireRunnerStartupGate(sessionMode,DATA,{requiredProviders});
  if (sessionMode === "runner") void import("./kernel/sessions/service.ts").then(({ KernelSessionService }) => new KernelSessionService(DATA, { mode: "runner", roots: cfg.architecture?.allowedRoots ?? [], taskIds: cfg.architecture?.sessionRunnerTaskIds ?? [] }).resumePending()).catch((error) => log(`session runner bridge recovery unavailable (fail-closed): ${error instanceof Error ? error.message : error}`));
  // 测试模式（verify.sh）：备用端口 + 不启动事件源和定时器，纯验证 server/API 可用。
  // 端口由 OWNWARD_TEST_PORT 指定，避免与本地开发 daemon 撞端口：
  // 冒烟实例 EADDRINUSE 死掉，紧接着的探活打到 dev daemon 身上，整步变成假绿。
  if (process.env.OWNWARD_TEST) {
    try { reconcileLegacySessions(DATA); }
    catch (e) { log(`session repository startup reconcile failed: ${e}`); }
    // 测试数据根已由 OWNWARD_DATA_ROOT 隔离；同样覆盖真实启动的恢复顺序。
    try { recoverClaims(DATA); } catch (e) { log(`spool recovery failed: ${e}`); }
    const port = parseInt(process.env.OWNWARD_TEST_PORT || "", 10) || 4519;
    cfg.dashboard = { ...cfg.dashboard, port };
    log(`Ownward daemon starting in TEST mode (port ${port}, sources disabled)`);
    startServer();
    return;
  }

  acquireLock();
  updateState(state=>{state.health={...(state.health||{}),runner:runnerGate.ok?{ok:true,at:new Date().toISOString()}:{ok:false,degraded:true,errorCode:"RUNNER_UNAVAILABLE",at:new Date().toISOString(),detail:runnerGate.detail}};});
  if(!runnerGate.ok){log(`Runner unavailable; daemon degraded startup: ${runnerGate.detail}`);openAction({id:"system:runner-unavailable",kind:"decide",source:"system",title:"Runner 不可用，Session 写操作已暂停",reason:"核心工作台和事件源继续运行；修复 ai.ownward.runner 后重试 Session 操作。",ref:{}});}
  // 单实例锁后才做 read-modify-write；冲突只留痕，不覆盖 legacy 主路径。
  try { reconcileLegacySessions(DATA); }
  catch (e) { log(`session repository startup reconcile failed: ${e}`); }
  try {
    const result = closeLegacyRunningAtStartup(DATA, new Date().toISOString(), (entry) => log(`legacy startup close audit: ${JSON.stringify(entry)}`));
    if (result.closed) log(`legacy startup close: ${result.closed} running task(s) → exited(130)`);
  } catch (e) {
    log(`legacy startup close unavailable (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const recovered = recoverDispatchingRuns(DATA, "daemon_restarted_during_dispatch");
    if (recovered) log(`run recovery: ${recovered} dispatching run(s) → unknown_outcome（未自动重放）`);
  } catch (e) { log(`run dispatch recovery failed: ${e}`); }
  const intent = takeRestartIntent();
  if (intent) log(`上一代是主动重启（${intent.by}，generation=${intent.expectedGeneration}）→ 崩溃计数清零`);
  const crashGuard = new CrashGuard(DATA);
  const boot = crashGuard.begin(!!intent);
  if (boot.shouldRollback) {
    console.error("crash loop detected → dispatch independent rollback helper");
    dispatchDeployHelper("rollback", [], `rollback-${boot.state.generation}`)
      .then(() => {
        // bootstrap 成功才建立抑制重复派发的短租约；失败时下一代必须能重试。
        if (!crashGuard.markRollbackRequested(boot.state.generation)) {
          throw new Error("crash guard refused rollback lease for current generation");
        }
        process.exit(1);
      })
      .catch((e) => { console.error(`rollback helper dispatch failed: ${e}`); process.exit(1); });
    return;
  }
  rotateLog();
  log(`Ownward daemon starting (pid ${process.pid})`);
  traceLife(); // 报出上一代的死因 + 装本代的退出留痕
  // 取得单实例锁并完成 crash-loop/life 留痕后恢复；单文件失败会保留 processing，不阻断启动。
  recoverClaims(DATA);
  try { const result=(await import("./evolve-release.ts")).reconcileEvolveReceipts(DATA);if(result.applied.length||result.failed.length||result.diagnostics.length)log(`evolve release reconcile: applied=${result.applied.length} failed=${result.failed.length} diagnostic=${result.diagnostics.length}`); }
  catch(e){log(`evolve release reconcile failed: ${e}`);}

  // vault 目录骨架先建好：新装用户第一次跑，收割/日报/memory 不会因目录缺失静默写失败
  import("./paths.ts").then((m) => m.ensureVault()).catch((e) => log(`ensureVault: ${e}`));

  // HTTP ready 只在 durable Connector recovery 已安装、所有 Connector 生命周期已隔离收敛、
  // Vertical activate 与 scheduler 注册完成之后开放。单个扩展失败由各 runtime 记入状态，
  // start() 本身仍会 resolve，使诊断面可以启动。
  await import("./connectors.ts").then((m) => m.startConnectors()).catch((e) => log(`connectors runtime start: ${e instanceof Error ? e.name : "unknown"}`));
  await import("./verticals.ts").then((m) => m.startVerticals()).catch((e) => log(`verticals start: ${e instanceof Error ? e.name : "unknown"}`));

  const triageMs = (cfg.triage.intervalMin || 20) * 60_000;
  setInterval(() => runTriage(), triageMs);
  // off 只服务确实存在的 legacy Session；没有 legacy 身份时不加载旧审批状态机。
  if (sessionMode === "off") void import("./session-service.ts").then(async m=>{if(await m.sweepLegacyApprovalsIfPresent())setInterval(()=>m.sweepLegacyApprovalsIfPresent(),60_000);}).catch(e=>log(`legacy approval sweep disabled: ${e instanceof Error?e.name:"unknown"}`));
  // Runner 默认写链的审批投影 + 6h 兜底超时（与上面的 legacy sweep 对称：那条只覆盖 mode=off 的存量会话）。
  // 没有它，Runner 审批只活在会话视图里：人不在屏幕前不知道任务卡住，且永不超时收敛。
  if (sessionMode !== "off") void import("./kernel/sessions/approval-sweep.ts").then(m=>{setInterval(()=>void m.sweepRunnerApprovals().catch(e=>log(`approval sweep: ${e instanceof Error?e.name:"unknown"}`)),60_000);}).catch(e=>log(`approval sweep disabled: ${e instanceof Error?e.name:"unknown"}`));

  // 编码任务看护：bg 任务退出 → 通知 + 自动收割；演进任务额外跑验证门；routine 任务回写状态
  setInterval(async () => {
    for (const t of reapExited()) {
      // 结构化飞行记录：任务退出后第一步先冻结 git 快照（晚了 worktree 可能被用户清理→误报无 git），
      // 再走通知/harvest。与 harvest 互补，失败不阻塞（flightState 记 failed，后续 sweep 重试）。
      try {
        const { writeFlightRecord } = await import("./flight-record.ts");
        await writeFlightRecord(t);
      } catch (e) {
        log(`flight-record [${t.id}] failed: ${e}`);
      }
      const icon = t.exitCode === 0 ? "✅" : "❌";
      if (t.kind === "routine") {
        // 文档写入任务：更新 routine 状态，失败回草稿态等重试
        const { onRoutineTaskDone } = await import("./routines.ts");
        onRoutineTaskDone(t.id, t.exitCode === 0);
        await notify(
          t.exitCode === 0 ? `✅ 文档写入完成 [${t.task.split("\n")[0].slice(0, 40)}]`
            : `❌ 文档写入失败（可能是冲突/定位失败），任务页看详情后重试`,
          { source: "dispatch" });
        continue; // routine 任务不收割、不开失败 Action（状态机自己管）
      }
      await notify(`${icon} ${t.kind === "evolve" ? "演进" : "编码"}任务结束 [${t.project}] ${t.task.slice(0, 50)}\n退出码 ${t.exitCode}${t.branch ? `，分支 ${t.branch}` : ""}`, { source: "dispatch" });
      if (t.kind === "evolve" && t.exitCode === 0) {
        verifyEvolve(t).catch((e) => log(`verify evolve [${t.id}] failed: ${e}`));
      }
      if (t.exitCode !== 0) {
        openAction({
          id: `task-fail:${t.id}`, kind: "decide", source: "dispatch",
          title: `任务失败 [${t.project}]`,
          reason: `退出码 ${t.exitCode}，需要决定重派还是排查`,
          ref: { task_id: t.id },
        });
      }
      try {
        const note = await harvestTask(t);
        // harvestedAt 是重收的判据：只有首轮走到这里，后面的追问轮靠 sweepHarvest 按日志 mtime 补
        if (note) updateTask(t.id, { harvested: true, harvestedAt: new Date().toISOString() });
      } catch (e) {
        log(`auto-harvest [${t.id}] failed: ${e}`);
      }
    }
  }, (cfg.dispatch?.watchSec || 60) * 1000);
  setInterval(() => { import("./flight-record.ts").then((m) => m.sweepFlights().catch((e) => log(`flight sweep: ${e}`))); }, 300_000); // 飞行记录写失败的 durable 重试
  setInterval(() => { import("./routines.ts").then((m) => m.sweepRoutines()).catch((e) => log(`routines sweep: ${e}`)); }, 60_000); // 职责草稿自动生成
  setInterval(() => { import("./memory.ts").then((m) => m.sweepMemoryChores().catch((e) => log(`memory chores: ${e}`))); }, 600_000); // 记忆杂务浮到首页
  setInterval(() => { import("./capture.ts").then((m) => m.sweepCapture().catch((e) => log(`capture: ${e}`))); }, 1200_000); // 会话自动收割（替代 session wrap）
  setInterval(() => { import("./harvest.ts").then((m) => m.sweepHarvest().catch((e) => log(`harvest sweep: ${e}`))); }, 600_000); // 多轮任务收割补收（追问轮不走 reap，见 sweepHarvest 注释）
  setInterval(() => { import("./vault-sync.ts").then((m) => m.syncVault()).catch((e) => log(`vault sync: ${e}`)); }, 1800_000); // vault git 同步（接管 wrap 时代的 commit+push）
  setInterval(() => { import("./dispatch.ts").then((m) => m.sweepTaskTitles().catch(() => {})); }, 300_000); // 任务精炼标题补齐
  setInterval(() => { import("./terminal-tasks.ts").then((m) => m.sweepTerminalTasks().catch((e) => log(`terminal sweep: ${e}`))); }, 300_000); // terminal 任务沉寂自动收尾（CC 会话 >15min 无写入）
  setInterval(() => { import("./terminal-tasks.ts").then((m) => m.sweepTerminalLinks().catch(() => {})); }, 60_000); // 给运行中 terminal 任务补链底层 CC 会话（确定性认领）
  setTimeout(() => { import("./terminal-tasks.ts").then((m) => m.sweepTerminalLinks().catch(() => {})); }, 20_000); // 启动即给现有 terminal 任务补链
  setTimeout(() => { import("./memory.ts").then((m) => m.sweepMemoryChores().catch(() => {})); }, 30_000);
  setTimeout(() => { import("./dispatch.ts").then((m) => m.sweepTaskTitles().catch(() => {})); }, 15_000); // 启动即补现有任务标题
  setInterval(() => { import("./session-cleanup.ts").then((m) => { try { m.sweepDaemonTranscripts(); } catch (e) { log(`session cleanup: ${e}`); } }); }, 6 * 3600_000); // 每 6h 清 daemon 决策 transcript（>3天）
  setTimeout(() => { import("./session-cleanup.ts").then((m) => { try { m.sweepDaemonTranscripts(); } catch (e) { log(`session cleanup: ${e}`); } }); }, 60_000); // 启动 1min 后清一次（首次会清掉历史积压的几千个）

  setInterval(sweepActions, 60_000); // snooze 到期回 open
  setInterval(() => { import("./calendar.ts").then((m) => m.sweepMeetingReminders()).catch((e) => log(`meeting reminders: ${e}`)); }, 60_000); // 会前 10min 提醒
  setInterval(() => { import("./daily-digest.ts").then((m) => m.sweepDigest()).catch((e) => log(`daily digest: ${e}`)); }, 60_000); // 本地 24:00 自动日报

  const hbMs = (cfg.heartbeat.intervalMin || 45) * 60_000;
  setTimeout(() => {
    runHeartbeat();
    setInterval(() => runHeartbeat(), hbMs);
  }, 60_000); // 启动 1 分钟后开始第一次心跳

  startServer();
  if (!crashGuard.markHealthy(boot.state.generation)) {
    throw new Error("crash guard refused healthy marker for current generation");
  }

  log(`ready: triage every ${triageMs / 60000}m, heartbeat every ${hbMs / 60000}m`);
}

if(import.meta.main)main().catch(error=>{console.error(`Ownward startup failed: ${error instanceof Error?error.message:String(error)}`);process.exit(78);});
