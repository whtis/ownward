import { mutateTasksAt } from "../../dispatch.ts";
import { RunnerCommandJournal, RunnerEventJournal } from "../../runner/journals.ts";
import { readRunJournalStrict, reduceRuns } from "../../runs/repository.ts";
import { SessionRepository } from "../../sessions/repository.ts";

export interface LegacyStartupCloseAudit {
  taskId: string;
  sessionId: string;
  outcome: "closed" | "kept-runner-owned" | "kept-external-lease";
  reason: string;
}

export interface LegacyStartupCloseResult {
  closed: number;
  audits: LegacyStartupCloseAudit[];
}

/**
 * Hard-cut 后的一次性启动收尾：旧 daemon 留下的 legacy running 不能永远挂起。
 *
 * 这不是持续 reconcile。调用方只能在 daemon 单实例锁内、启动阶段调用一次。
 * Runner 三份 journal 与 SessionRepository 先严格全量读取；任一损坏都在写 tasks 前抛错。
 */
export function closeLegacyRunningAtStartup(
  dataRoot: string,
  now = new Date().toISOString(),
  audit: (entry: LegacyStartupCloseAudit) => void = () => {},
): LegacyStartupCloseResult {
  const audits: LegacyStartupCloseAudit[] = [];
  let closed = 0;
  mutateTasksAt(dataRoot, (tasks) => {
    const commands = new RunnerCommandJournal(dataRoot).readStrict();
    new RunnerEventJournal(dataRoot).readStrict();
    const runs = reduceRuns(readRunJournalStrict(dataRoot));
    const sessions = new SessionRepository(dataRoot).list();
    const runnerSessions = new Set(commands.map((command) => command.sessionId));
    const runnerTasks = new Set(runs.map((run) => run.taskId));
    const acceptedCommands = new Map(commands.map((command) => [command.sessionId, command]));
    for (const run of runs) runnerSessions.add(run.sessionId);

    for (const task of tasks) {
      if (task.status !== "running" || !task.engine || task.mode === "terminal") continue;
      const session = sessions.find((candidate) => candidate.taskIds.includes(task.id));
      if(!session){const run=runs.find(candidate=>candidate.taskId===task.id),pendingFresh=task.launchState==="pending"&&Date.parse(now)-Date.parse(task.startedAt)<5*60_000;if(run){task.launchState="accepted";task.launchAcceptedAt=run.startedAt??now;task.commandId=run.commandId;task.runId=run.runId;const entry={taskId:task.id,sessionId:run.sessionId,outcome:"kept-runner-owned" as const,reason:"runner-run-or-command-exists"};audits.push(entry);continue;}if(pendingFresh){audits.push({taskId:task.id,sessionId:task.id,outcome:"kept-runner-owned",reason:"fresh-launch-pending"});continue;}if(task.launchState==="pending"){task.status="exited";task.exitCode=130;task.endedAt=now;closed++;audits.push({taskId:task.id,sessionId:task.id,outcome:"closed",reason:"task-registered-before-session-reserve"});}continue;}
      if(task.launchState==="pending"&&session.source==="legacy"&&session.nativeRef===null&&!runnerTasks.has(task.id)&&!runnerSessions.has(session.id)){const pendingFresh=Date.parse(now)-Date.parse(task.startedAt)<5*60_000;if(pendingFresh){audits.push({taskId:task.id,sessionId:session.id,outcome:"kept-runner-owned",reason:"fresh-launch-pending"});continue;}task.status="exited";task.exitCode=130;task.endedAt=now;closed++;audits.push({taskId:task.id,sessionId:session.id,outcome:"closed",reason:"task-registered-before-session-reserve"});continue;}
      if (session.source !== "legacy" && !(session.source === "native" && session.nativeRef === null)) continue;
      let entry: LegacyStartupCloseAudit;
      const accepted=acceptedCommands.get(session.id);
      if(accepted&&task.launchState!=="accepted"){task.launchState="accepted";task.launchAcceptedAt=accepted.acceptedAt;task.commandId=accepted.commandId;task.runId=accepted.runId;}
      const pendingFresh=task.launchState==="pending"&&Date.parse(now)-Date.parse(task.startedAt)<5*60_000;
      if (runnerTasks.has(task.id) || runnerSessions.has(session.id)) {
        entry = { taskId: task.id, sessionId: session.id, outcome: "kept-runner-owned", reason: "runner-run-or-command-exists" };
      } else if(pendingFresh){
        entry={taskId:task.id,sessionId:session.id,outcome:"kept-runner-owned",reason:"fresh-launch-pending"};
      } else if (session.control === "observing" || session.control === "external") {
        entry = { taskId: task.id, sessionId: session.id, outcome: "kept-external-lease", reason: `session-control-${session.control}` };
      } else {
        task.status = "exited";
        task.exitCode = 130;
        task.endedAt = now;
        closed++;
        entry = {
          taskId: task.id,
          sessionId: session.id,
          outcome: "closed",
          reason: session.source === "native" ? "native-create-died-before-runner-accept" : "legacy-owner-lost-on-daemon-restart",
        };
      }
      audits.push(entry);
    }
    return tasks;
  });
  for (const entry of audits) audit(entry);
  return { closed, audits };
}
