import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beginClaudeProviderRun, claudeResultOutcome, finishClaudeProviderResult, restoreClaudeAfterDispatchGate } from "../agent-session.ts";
import { acceptCodexProviderRun, dispatchCodexProviderProcess, finishCodexProviderExit, handleCodexProviderLine,
  interruptCodexProviderRun } from "../codex-session.ts";
import { RunRepository } from "./repository.ts";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "ownward-provider-run-")); roots.push(r); return r; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function codexSession(dataRoot: string) {
  const proc = {} as any;
  const s: any = { taskId: "task", cwd: "/tmp", control: "ownward", runSidecarDeps: { dataRoot },
    proc, turn: "running", messages: [], tokens: {}, lastActivityAt: 0 };
  s.activeRun = acceptCodexProviderRun(s);
  dispatchCodexProviderProcess(s.activeRun, () => undefined, s.runSidecarDeps);
  return { s, proc };
}

describe("Provider Run lifecycle", () => {
  test("Claude journal gate 回滚只杀本轮新 spawn，复用中的健康进程保持存活", () => {
    const gateError = Object.assign(new Error("sanitized"), { code: "RUN_DISPATCH_JOURNAL_UNAVAILABLE" });
    for (const spawnedForTurn of [false, true]) {
      let killed = 0, persisted = 0;
      const proc = { kill(signal: string) { expect(signal).toBe("SIGKILL"); killed++; } } as any;
      const s: any = { proc, alive: true, turn: "running", autoCompacting: true };
      expect(restoreClaudeAfterDispatchGate(s, gateError, spawnedForTurn, () => { persisted++; })).toBe(true);
      expect(s).toMatchObject({ turn: "idle", autoCompacting: false, alive: spawnedForTurn ? false : true, proc: spawnedForTurn ? null : proc });
      expect(killed).toBe(spawnedForTurn ? 1 : 0);
      expect(persisted).toBe(1);
    }
  });
  test("Run journal gate 失败时 Claude send 与 Codex spawn callback 都不执行", () => {
    const broken = { append() { throw new Error("SECRET prompt"); } };
    let sent = false;
    expect(() => beginClaudeProviderRun({ taskId: "private", cwd: "/tmp", control: "ownward", runSidecarDeps: { repository: broken } }, () => { sent = true; return true; })).toThrow("Run dispatch journal unavailable");
    expect(sent).toBe(false);

    const h: any = { commandId: "c", runId: "r", taskId: "private", sessionId: "s", providerId: "codex", active: true, dispatching: false, started: false, terminal: false };
    let spawned = false;
    expect(() => dispatchCodexProviderProcess(h, () => { spawned = true; }, { repository: broken })).toThrow("Run dispatch journal unavailable");
    expect(spawned).toBe(false);
  });
  test("Claude 中断请求与成功 result 竞态时，以成功终帧为权威", () => {
    expect(claudeResultOutcome(false, true)).toBe("completed");
    expect(claudeResultOutcome(true, true)).toBe("interrupted");
    expect(claudeResultOutcome(true, false)).toBe("failed");
  });

  test("Claude 真实 stdin Provider 边界区分发送失败与成功 result，result 不伪造退出码", () => {
    const failedRoot = root(), failed = beginClaudeProviderRun({ taskId: "stdin-fail", cwd: "/tmp", control: "ownward", runSidecarDeps: { dataRoot: failedRoot } }, () => false);
    expect(failed.started).toBe(false);
    expect(new RunRepository(failedRoot).readStrict().map((e) => e.type)).toEqual(["command-accepted", "run-dispatching", "run-failed"]);

    const r = root(), deps = { dataRoot: r };
    const h = beginClaudeProviderRun({ taskId: "claude", cwd: "/tmp", control: "ownward", runSidecarDeps: deps }, () => true);
    finishClaudeProviderResult(h, false, true, { inputTokens: 4, outputTokens: 1 }, deps);
    const events = new RunRepository(r).readStrict();
    expect(events.map((e) => e.type)).toEqual(["command-accepted", "run-dispatching", "run-started", "run-completed"]);
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 4, outputTokens: 1 } });
    expect(events.at(-1)).not.toHaveProperty("providerExitCode");
  });

  test("Codex 真实 JSONL 入站边界写 accepted→started→terminal，旧 proc 不能污染新 Run", () => {
    const r = root(), { s, proc } = codexSession(r), oldProc = {} as any;
    handleCodexProviderLine(s, oldProc, JSON.stringify({ type: "turn.failed", error: { message: "late" } }));
    expect(new RunRepository(r).readStrict().map((e) => e.type)).toEqual(["command-accepted", "run-dispatching"]);
    handleCodexProviderLine(s, proc, JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }));
    const events = new RunRepository(r).readStrict();
    expect(events.map((e) => e.type)).toEqual(["command-accepted", "run-dispatching", "run-started", "run-completed"]);
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2 } });
    expect(events.at(-1)).not.toHaveProperty("providerExitCode");
  });

  test("Codex Provider exit 保留原始 0，中断与失败是不同 terminal", () => {
    const exitedRoot = root(), exited = codexSession(exitedRoot);
    finishCodexProviderExit(exited.s, 0);
    expect(new RunRepository(exitedRoot).readStrict().at(-1)).toMatchObject({
      type: "run-failed", providerExitCode: 0, reason: "provider_exit_without_terminal",
    });

    const interruptedRoot = root(), interrupted = codexSession(interruptedRoot);
    interruptCodexProviderRun(interrupted.s);
    expect(new RunRepository(interruptedRoot).readStrict().at(-1)).toMatchObject({ type: "run-interrupted", reason: "user_interrupt" });
    expect(new RunRepository(interruptedRoot).readStrict().at(-1)).not.toHaveProperty("providerExitCode");
  });
});
