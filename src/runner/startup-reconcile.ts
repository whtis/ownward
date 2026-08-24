import { RunnerCommandJournal, RunnerEventJournal, type RunnerCommandRecord, type RunnerEventRecord } from "./journals.ts";

const terminalTypes = new Set<RunnerEventRecord["type"]>(["completed", "failed", "interrupted", "unknown-outcome"]);

function recoveryEventId(commandId: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(commandId).digest("hex");
  return `startup-reconcile:${digest}`;
}

export interface RunnerStartupReconcileResult {
  reconciled: RunnerEventRecord[];
  untouchedAccepted: string[];
  diagnostics: { acceptedWithoutDispatch: number; recoveredUnknownOutcome: number };
}

/**
 * Runner 启动时只收敛「已有 started、但没有 durable 终态」的 command。
 * accepted 且无事件的 command 保持原样，绝不自动 replay。
 */
export function reconcileRunnerStartup(dataRoot: string, now = new Date().toISOString()): RunnerStartupReconcileResult {
  const commands = new RunnerCommandJournal(dataRoot).readStrict();
  const journal = new RunnerEventJournal(dataRoot);
  const events = journal.readStrict();
  const byCommand = new Map<string, RunnerEventRecord[]>();
  for (const event of events) {
    const current = byCommand.get(event.commandId) ?? [];
    current.push(event);
    byCommand.set(event.commandId, current);
  }

  const reconciled: RunnerEventRecord[] = [];
  const untouchedAccepted: string[] = [];
  for (const command of commands) {
    const history = byCommand.get(command.commandId) ?? [];
    if (!history.length) {
      untouchedAccepted.push(command.commandId);
      continue;
    }
    if ((!history.some((event) => event.type === "dispatching") && !history.some((event) => event.type === "started")) || history.some((event) => terminalTypes.has(event.type))) continue;
    const result = journal.append(recoveryEvent(command, now));
    reconciled.push(result.record);
  }
  return { reconciled, untouchedAccepted, diagnostics: { acceptedWithoutDispatch: untouchedAccepted.length, recoveredUnknownOutcome: reconciled.length } };
}

function recoveryEvent(command: RunnerCommandRecord, at: string) {
  return {
    eventId: recoveryEventId(command.commandId),
    type: "unknown-outcome" as const,
    at,
    commandId: command.commandId,
    runId: command.runId,
    sessionId: command.sessionId,
    providerId: command.providerId,
    reason: "runner_lost_ownership" as const,
  };
}
