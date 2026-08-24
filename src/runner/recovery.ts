import type { RunSnapshot } from "../runs/repository.ts";
import type { RunnerCommandRecord } from "./journals.ts";

export type RunnerRecoveryDecision =
  | { commandId: string; runId: string; action: "manual-confirm"; reason: "accepted_not_replayable" }
  | { commandId: string; runId: string; action: "manual-inspect"; reason: "run_snapshot_missing" }
  | { commandId: string; runId: string; action: "mark-unknown-outcome"; reason: "dispatching_outcome_unprovable" }
  | { commandId: string; runId: string; action: "observe"; reason: "running_or_terminal" };

/**
 * 重启恢复只给出检查计划，不执行 Provider 命令。accepted 也可能已经被旧进程取走，dispatching 更已越过
 * 投递尝试边界；两者都禁止自动 replay。真正的 unknown-outcome append 仍由 RunRepository 完成。
 */
export function planRunnerRecovery(commands: readonly RunnerCommandRecord[], runs: readonly RunSnapshot[]): RunnerRecoveryDecision[] {
  const byRun = new Map(runs.map((r) => [r.runId, r]));
  const seenRuns = new Set<string>();
  return commands.filter((command) => {
    if (!["start-run", "resume-run", "send-input"].includes(command.kind) || seenRuns.has(command.runId)) return false;
    seenRuns.add(command.runId); return true;
  }).map((command) => {
    const run = byRun.get(command.runId);
    if (!run) return { commandId: command.commandId, runId: command.runId, action: "manual-inspect", reason: "run_snapshot_missing" };
    switch (run.status) {
      case "accepted": return { commandId: command.commandId, runId: command.runId, action: "manual-confirm", reason: "accepted_not_replayable" };
      case "dispatching": return { commandId: command.commandId, runId: command.runId, action: "mark-unknown-outcome", reason: "dispatching_outcome_unprovable" };
      case "running": case "completed": case "failed": case "interrupted": case "unknown_outcome":
        return { commandId: command.commandId, runId: command.runId, action: "observe", reason: "running_or_terminal" };
      default: return assertNever(run.status);
    }
  });
}

function assertNever(value: never): never { throw new Error(`未知 Run 状态: ${String(value)}`); }
