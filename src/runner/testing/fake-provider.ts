import type { RunnerCommandRecord, RunnerEventRecord, RunnerReasonCode } from "../journals.ts";

export interface FakeProviderPlan {
  deltas?: string[];
  nativeRef?: string;
  approval?: { requestId: string; prompt: string };
  terminal?: "completed" | "failed" | "interrupted";
  reason?: RunnerReasonCode;
  exitCode?: number;
}
export type FakeProviderEvent = Omit<RunnerEventRecord, "schemaVersion" | "eventId" | "sequence" | "at" | "payloadRef" | "payloadSha256" | "payloadBytes"> & { eventId: string; at: string; payload?: string };

/** Contract test 专用的确定性 Provider；生产 Runner 不得注册它。 */
export class FakeProvider {
  constructor(private readonly plan: FakeProviderPlan = {}, private readonly epoch = "2026-01-01T00:00:00.000Z") {
    if (process.env.NODE_ENV !== "test") throw new Error("FakeProvider 只能在 NODE_ENV=test 的 contract tests 中构造");
  }
  events(command: RunnerCommandRecord): FakeProviderEvent[] {
    if (command.kind !== "start-run") throw new Error("FakeProvider 只接受 start-run command");
    let sequence = 0; const commandHash = new Bun.CryptoHasher("sha256").update(command.commandId).digest("hex").slice(0, 24);
    const event = (type: FakeProviderEvent["type"], extra: Partial<FakeProviderEvent> = {}): FakeProviderEvent => ({
      eventId: `fake:${commandHash}:${++sequence}`, type, at: this.at(sequence), commandId: command.commandId,
      runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, ...extra,
    });
    const result: FakeProviderEvent[] = [event("started", { nativeRef: this.plan.nativeRef ?? `fake:${command.runId}` })];
    for (const delta of this.plan.deltas ?? ["fake-delta"]) result.push(event("delta", { payload: delta }));
    if (this.plan.approval) result.push(event("approval-requested", { approvalRequestId: this.plan.approval.requestId, payload: this.plan.approval.prompt }));
    const terminal = this.plan.terminal ?? "completed";
    result.push(event(terminal, { ...(this.plan.reason ? { reason: this.plan.reason } : {}), ...(this.plan.exitCode !== undefined ? { exitCode: this.plan.exitCode } : {}) }));
    return result;
  }
  private at(sequence: number): string { return new Date(new Date(this.epoch).getTime() + sequence).toISOString(); }
}
