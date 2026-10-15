// Ownward CLI：手动触发与状态检查。
// 用法: own <status|test-notify|triage-now|heartbeat-now|logs|work|tasks|done>
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { devCliService } from "./dev-cli-service.ts";
import { ROOT, run } from "./util.ts";
import { harvestTask } from "./harvest.ts";
import { runHeartbeat } from "./heartbeat.ts";
import { notifyLark } from "./notify.ts";
import { queueSize } from "./spool.ts";
import { runTriage } from "./triage.ts";
import { DATA, fmt } from "./util.ts";

const cmd = process.argv[2];
const { applyEvolve, loadTasks, startEvolve, startWork, updateTask } = devCliService;

switch (cmd) {
  case "status": {
    const pidFile = join(DATA, "daemon.pid");
    let daemon = "not running";
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
      try { process.kill(pid, 0); daemon = `running (pid ${pid})`; } catch { daemon = `stale pid ${pid}`; }
    }
    console.log(`daemon:  ${daemon}`);
    console.log(`queue:   ${queueSize()} pending event(s)`);
    console.log(`time:    ${fmt(new Date(), "datetime")}`);
    break;
  }
  case "test-notify": {
    const ok = await notifyLark(process.argv[3] || `✅ Ownward 测试通知 ${fmt(new Date(), "datetime")}`);
    process.exit(ok ? 0 : 1);
  }
  case "triage-now":
    await runTriage();
    break;
  case "heartbeat-now":
    await runHeartbeat();
    break;
  case "logs": {
    const f = join(DATA, "logs", "daemon.log");
    if (existsSync(f)) {
      const lines = readFileSync(f, "utf8").split("\n");
      console.log(lines.slice(-40).join("\n"));
    } else console.log("(no log file yet)");
    break;
  }
  case "work": {
    // own work <项目目录> <任务描述> [--bg] [--codex] [--worktree|--no-worktree] [--branch <名>] [--role <角色id>|--no-role]
    const rest = process.argv.slice(3);
    const flags = new Set(rest.filter((a) => a.startsWith("--")));
    const valueOf = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
    const branch = valueOf("--branch");
    const roleArg = valueOf("--role");
    const takesValue = new Set(["--branch", "--role"].map((f) => rest.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
    const pos = rest.filter((a, i) => !a.startsWith("--") && !takesValue.has(i));
    const [dir, ...taskParts] = pos;
    if (!dir || !taskParts.length) {
      console.error('用法: own work <项目目录> "<任务描述>" [--bg] [--codex] [--worktree|--no-worktree] [--branch <名>] [--role <角色id>|--no-role]');
      process.exit(1);
    }
    const t = await startWork(dir, taskParts.join(" "), {
      bg: flags.has("--bg"),
      codex: flags.has("--codex"),
      worktree: flags.has("--worktree") ? true : flags.has("--no-worktree") ? false : undefined,
      branch,
      // 与工作台派发同一套：缺省按目录找项目 Owner（没有就建），--no-role 不带
      role: flags.has("--no-role") ? "none" : roleArg || "auto",
    });
    console.log(`✅ [${t.id}] ${t.mode} @ ${t.cwd}${t.branch ? ` (${t.branch})` : ""}`);
    if (t.roleName) console.log(`   角色: ${t.roleName}（${t.roleId}）`);
    else if (t.roleNote) console.log(`   没带上角色: ${t.roleNote}`);
    if (t.mode !== "terminal") console.log(`   日志: ${t.logFile}\n   结束后 daemon 会自动通知并收割`);
    else console.log(`   结束后跑: own done ${t.id}`);
    break;
  }
  case "tasks": {
    const tasks = loadTasks();
    if (!tasks.length) { console.log("(还没有任务)"); break; }
    for (const t of tasks.slice(-20)) {
      const dur = t.endedAt
        ? `${Math.round((+new Date(t.endedAt) - +new Date(t.startedAt)) / 60000)}m`
        : `${Math.round((Date.now() - +new Date(t.startedAt)) / 60000)}m~`;
      console.log(`[${t.id}] ${t.status.padEnd(7)} ${t.mode.padEnd(9)} ${dur.padStart(5)}  ${t.project}  ${t.task.slice(0, 50)}${t.harvested ? "  📝" : ""}`);
    }
    break;
  }
  case "done": {
    const id = process.argv[3];
    const t = loadTasks().find((x) => x.id === id);
    if (!t) { console.error(`任务不存在: ${id}`); process.exit(1); }
    updateTask(id, { status: "done", endedAt: t.endedAt || new Date().toISOString() });
    if (!t.harvested && !process.argv.includes("--no-harvest")) {
      console.log("收割中…");
      const note = await harvestTask({ ...t, status: "done" });
      if (note) { updateTask(id, { harvested: true }); console.log(`📝 ${note}`); }
      else console.log("(没有可收割的过程数据)");
    }
    // 结构化飞行记录：terminal 任务不走 daemon reap，收尾时在这条链上补一份（兜底 canonical task）
    try {
      const p = await devCliService.writeFlightRecord({ ...t, status: "done" });
      if (p) console.log(`✈️  飞行记录: ${p}`);
    } catch (e) { console.error(`飞行记录失败: ${e}`); }
    if (t.branch) console.log(`worktree 留在 ${t.cwd}，合并后可: git -C ${t.projectDir} worktree remove ${t.cwd}`);
    break;
  }
  case "evolve": {
    // own evolve "<需求>" —— 派 agent 改 Ownward 自己
    const requirement = process.argv.slice(3).join(" ").trim();
    if (!requirement) { console.error('用法: own evolve "<需求>"'); process.exit(1); }
    const t = await startEvolve(requirement);
    console.log(`🧬 演进任务已派发 [${t.id}] @ ${t.cwd} (${t.branch})`);
    console.log("   完成后自动跑 verify，通过会通知你审批上线");
    break;
  }
  case "apply": {
    const id = process.argv[3];
    if (!id) { console.error("用法: own apply <演进任务id>"); process.exit(1); }
    try { console.log("🚀 " + await applyEvolve(id)); }
    catch (e) { console.error(`❌ ${e instanceof Error ? e.message : e}`); process.exit(1); }
    break;
  }
  case "rollback": {
    try {
      const { dispatchDeployHelper } = await import("./deploy-helper.ts");
      const label = await dispatchDeployHelper("rollback", [], `manual-rollback-${Date.now()}`);
      console.log(`回滚已交给独立 helper：${label}`);
    } catch (e) {
      console.error(`❌ ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    break;
  }
  case "worktrees": {
    // own worktrees [clean] [--force] [--include-unmerged] [--keep-branch] [名字…]
    const rest = process.argv.slice(3);
    const sub = rest[0] === "clean" ? "clean" : "list";
    const names = rest.slice(sub === "clean" ? 1 : 0).filter((a) => !a.startsWith("--"));
    const force = rest.includes("--force"), withUnmerged = rest.includes("--include-unmerged"), keepBranch = rest.includes("--keep-branch");
    const wt = await import("./worktrees.ts");
    if (sub === "list") {
      const { root, entries, totalKb } = await wt.listWorktrees();
      const days = wt.worktreeRetentionDays();
      console.log(`worktreeRoot: ${root}（${entries.length} 个，共 ${(totalKb / 1024 / 1024).toFixed(1)}G；自动清理：${days ? `${days} 天没动的「可清理」项` : "关闭，config dispatch.worktreeRetentionDays"}）`);
      for (const e of entries) {
        console.log(`  ${e.state.padEnd(9)} ${(`${Math.round(e.sizeKb / 1024)}M`).padStart(7)}  ${e.name}${e.branch ? `  [${e.branch}]` : ""}  ${e.reason}`);
      }
      const clean = entries.filter((e) => e.state === "clean");
      if (clean.length) console.log(`\n可安全清理 ${clean.length} 个 / ${(clean.reduce((s, e) => s + e.sizeKb, 0) / 1024 / 1024).toFixed(1)}G：own worktrees clean`);
      break;
    }
    const r = await wt.cleanupWorktrees({
      ...(names.length ? { names } : { states: withUnmerged ? ["clean", "unmerged"] : ["clean"] }),
      force, keepBranch,
    });
    for (const item of r.results) console.log(`  ${item.ok ? "✅" : "⏭ "} ${item.name}: ${item.msg}`);
    const left = Object.entries(r.skipped).map(([s, n]) => `${s} ${n}`).join("、");
    console.log(`释放 ${(r.freedKb / 1024 / 1024).toFixed(1)}G${left ? `；未动：${left}` : ""}`);
    break;
  }
  case "sessions-migrate": {
    const { migrateLegacySessions } = await import("./sessions/repository.ts");
    const apply = process.argv.includes("--apply");
    try {
      const report = migrateLegacySessions(DATA, { dryRun: !apply });
      console.log(JSON.stringify(report, null, 2));
      if (report.conflicts.length || report.invalidFiles.length) process.exit(2);
    } catch (e) { console.error(`❌ ${e instanceof Error ? e.message : e}`); process.exit(1); }
    break;
  }
  default:
    console.log("Ownward\nusage: own <status|test-notify [text]|triage-now|heartbeat-now|logs|work|tasks|done <id>|evolve \"<需求>\"|apply <id>|rollback|worktrees [clean [--force] [--include-unmerged] [--keep-branch] [名字…]]|sessions-migrate [--apply]>");
    process.exit(1);
}
