import { SessionRepository } from "../../sessions/repository.ts";
import { RunnerCommandJournal, RunnerEventJournal } from "../../runner/journals.ts";
import { SessionRunnerBridgeStore } from "./bridge-store.ts";
import { effectiveSessionMigrationMode } from "./contracts.ts";
import { cfg, DATA } from "../../util.ts";

/** Lowest-level guard for every legacy Provider mutation, including non-HTTP callers. */
export function assertLegacyWriteAllowed(taskId: string, dataRoot = DATA): void {
  let identities = [taskId];
  try { const session = new SessionRepository(dataRoot).getByTaskId(taskId); if (session) identities = [session.id, ...session.taskIds]; }
  catch { /* Strict journals below still prevent crossing unresolved Runner ownership. */ }
  if (effectiveSessionMigrationMode(cfg.architecture?.sessionRunnerMode, identities, cfg.architecture?.sessionRunnerTaskIds) === "runner") throw Object.assign(new Error("该会话由 Runner 持有，拒绝 legacy 写入"), { code: "SESSION_RUNNER_OWNED" });
  try {
    const terminals = new Set(new RunnerEventJournal(dataRoot).readStrict().filter((e) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(e.type)).map((e) => e.commandId));
    const bridge = new SessionRunnerBridgeStore(dataRoot).list().some((c) => identities.includes(c.sessionId) && !c.terminal && !terminals.has(c.commandId));
    const runner = new RunnerCommandJournal(dataRoot).readStrict().some((c) => identities.includes(c.sessionId) && !terminals.has(c.commandId));
    if (bridge || runner) throw Object.assign(new Error("Runner 命令尚未收敛，拒绝 legacy 写入"), { code: "SESSION_RUNNER_DRAIN_REQUIRED" });
  } catch (error: any) { if (error?.code) throw error; throw Object.assign(new Error("Runner journal 无法验证，拒绝 legacy 写入"), { code: "SESSION_RUNNER_JOURNAL_INVALID" }); }
}
