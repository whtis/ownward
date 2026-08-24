import { describe, expect, test } from "bun:test";
import { RUNNER_PERM_TIMEOUT_MS, classifyApprovals, type ApprovalCommandLike, type ApprovalEventLike } from "./approval-sweep.ts";

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
