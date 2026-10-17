import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RUNNER_PERM_TIMEOUT_MS, approvalRuleToRemember, approveAllGranted, classifyApprovals, sweepRunnerApprovals, type ApprovalCommandLike, type ApprovalEventLike } from "./approval-sweep.ts";
import { KernelSessionService } from "./service.ts";
import { SessionRepository } from "../../sessions/repository.ts";
import { RunnerEventJournal } from "../../runner/journals.ts";
import { RunnerServer, type RunnerProvider } from "../../runner/server.ts";
import { readRunJournalStrict, reduceRuns } from "../../runs/repository.ts";

const NOW = Date.parse("2026-08-20T10:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ev = (o: Partial<ApprovalEventLike>): ApprovalEventLike => ({ type: "approval-requested", commandId: "cmd-1", sessionId: "s1", runId: "r1", approvalRequestId: "req-1", at: iso(60_000), ...o });
const cmd = (o: Partial<ApprovalCommandLike>): ApprovalCommandLike => ({ commandId: "resp-1", kind: "approval-response", sessionId: "s1", approvalRequestId: "req-1", ...o });

// Runner 模式审批曾经既无通知也无超时（legacy 的 sweepPendingPerms 只挂在 mode=off），
// classify 是这条链的判定核心：pending/stale/resolved 三态必须准确
describe("classifyApprovals", () => {
  test("无答复且 turn 未终结 → pending，未超 6h 不算 stale", () => {
    const { pending, resolved } = classifyApprovals([ev({})], [], NOW);
    expect(resolved).toEqual([]);
    expect(pending).toHaveLength(1);
    expect(pending[0].stale).toBe(false);
    expect(pending[0].requestId).toBe("req-1");
  });

  test("超过 6 小时 → stale", () => {
    const { pending } = classifyApprovals([ev({ at: iso(RUNNER_PERM_TIMEOUT_MS + 60_000) })], [], NOW);
    expect(pending[0].stale).toBe(true);
  });

  test("答复命令已落终态 → resolved(answered)，带答复 commandId", () => {
    const events = [ev({}), ev({ type: "completed", commandId: "resp-1", approvalRequestId: undefined })];
    const { pending, resolved } = classifyApprovals(events, [cmd({})], NOW);
    expect(pending).toEqual([]);
    expect(resolved).toEqual([{ sessionId: "s1", requestId: "req-1", resolution: "answered", answeredBy: "resp-1" }]);
  });

  test("答复命令还没终态 → 仍算 pending（in-flight 答复不许提前 resolve）", () => {
    const { pending, resolved } = classifyApprovals([ev({})], [cmd({})], NOW);
    expect(resolved).toEqual([]);
    expect(pending).toHaveLength(1);
  });

  test("产生审批的 turn 命令已终结 → resolved(turn-ended)，不再当 pending", () => {
    const events = [ev({}), ev({ type: "interrupted", approvalRequestId: undefined })]; // 同 commandId cmd-1
    const { pending, resolved } = classifyApprovals(events, [], NOW);
    expect(pending).toEqual([]);
    expect(resolved).toEqual([{ sessionId: "s1", requestId: "req-1", resolution: "turn-ended" }]);
  });

  test("多会话互不串扰：另一个会话的答复不消掉本会话的 pending", () => {
    const events = [ev({}), ev({ sessionId: "s2", commandId: "cmd-2", approvalRequestId: "req-1" }), ev({ type: "completed", commandId: "resp-2", approvalRequestId: undefined })];
    const commands = [cmd({ commandId: "resp-2", sessionId: "s2" })];
    const { pending, resolved } = classifyApprovals(events, commands, NOW);
    expect(pending.map((p) => p.sessionId)).toEqual(["s1"]);
    expect(resolved.map((r) => r.sessionId)).toEqual(["s2"]);
  });

  test("非 approval-response 的命令不算答复", () => {
    const events = [ev({}), ev({ type: "completed", commandId: "resp-1", approvalRequestId: undefined })];
    const { pending } = classifyApprovals(events, [cmd({ kind: "send-input" })], NOW);
    expect(pending).toHaveLength(1);
  });
});

// Runner 模式「总是批准」曾经只透传 remember、从不落规则：点「总是（全局）」同类命令下一条照弹。
// 规则键必须和 legacy 同一套 patternFor 归纳，否则老规则在 Runner 会话里命不中
describe("approvalRuleToRemember", () => {
  test("Bash 按命令首词/高危键记忆，普通工具按工具名", () => {
    expect(approvalRuleToRemember({ toolName: "Bash", input: { command: "curl -s http://127.0.0.1:4517/api/x" } })).toMatchObject({ kind: "bash", pattern: "curl", toolName: "Bash" });
    expect(approvalRuleToRemember({ toolName: "Bash", input: { command: "git -C repo push --force origin x" } })).toMatchObject({ kind: "bash", pattern: "git push --force" });
    expect(approvalRuleToRemember({ toolName: "WebFetch", input: { url: "https://x" } })).toMatchObject({ kind: "tool", pattern: "WebFetch" });
  });

  test("问题类与认不出工具的载荷不记忆", () => {
    expect(approvalRuleToRemember({ kind: "question", question: "选哪个？", options: ["A", "B"] })).toBeNull();
    expect(approvalRuleToRemember({ input: { command: "ls" } })).toBeNull();
    expect(approvalRuleToRemember(null)).toBeNull();
  });
});

// 2026-10-17：没选 bypass 派出去的会话在轮次里切到「全部放行」，只改了下一轮的启动参数——本轮的 CLI 仍按逐条审批在跑，
// 之后冒出来的审批要由投影替人放行：不开 Action、不弹横幅/飞书卡，只记审计
describe("sweepRunnerApprovals：会话已切到全部放行", () => {
  test("只有 bypass/full-access 算全部放行", () => {
    expect([undefined, "workspace", "full-access", "bypass"].map(approveAllGranted)).toEqual([false, false, true, true]);
  });
  test("本轮再冒出来的工具审批直接放行、只记审计", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-approval-sweep-")), cwd = join(root, "repo"); mkdirSync(cwd);
    new SessionRepository(root).reserve({ taskId: "task", providerId: "claude", cwd, access: "full-access" });
    let release!: () => void; const answered = new Promise<void>((resolve) => { release = resolve; }), responses: string[] = [];
    const ev = (command: any, type: string, extra: Record<string, unknown> = {}) => ({ eventId: `${command.commandId}:${type}`, type, at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, ...extra }) as any;
    const provider: RunnerProvider = { async *execute(command, input) {
      if (command.kind === "approval-response") { responses.push(JSON.parse(input).response); yield ev(command, "started"); yield ev(command, "completed"); release(); return; }
      yield ev(command, "started");
      yield ev(command, "approval-requested", { approvalRequestId: "req-1", payload: JSON.stringify({ kind: "tool", toolName: "Bash", input: { command: "grep -n fail /tmp/verify.log" } }) });
      await answered; yield ev(command, "completed");
    } };
    const server = new RunnerServer(root, () => provider); server.start();
    try {
      await new KernelSessionService(root, { mode: "runner", roots: [root] }).send("task", { text: "go" });
      // 审批答复要绑当前 active run：等审批落盘、run 投影成 running 再扫
      for (let i = 0; i < 300; i++) { if (new RunnerEventJournal(root).readStrict().some((e) => e.type === "approval-requested") && reduceRuns(readRunJournalStrict(root)).some((r) => r.status === "running")) break; await Bun.sleep(10); }
      await sweepRunnerApprovals(root);
      expect(responses).toEqual(["allow"]);
      const audit = readFileSync(join(root, "approval-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(audit).toEqual([expect.objectContaining({ taskId: "task", requestId: "req-1", decision: "auto-allow", by: "system", kind: "bash", pattern: "grep" })]);
      const sweepState = join(root, "kernel", "approval-sweep.json");
      expect(existsSync(sweepState) ? Object.keys(JSON.parse(readFileSync(sweepState, "utf8")).notified) : []).toEqual([]);   // 没弹过卡
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});
