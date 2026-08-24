import { FakeProvider } from "./fake-provider.ts";
import type { RunnerProvider } from "../server.ts";

type FakeInput = { prompt: string; plan?: { deltas?: string[]; nativeRef?: string; terminal?: "completed" | "failed" | "interrupted"; reason?: "provider_exit" | "provider_protocol_error" | "approval_denied" | "user_interrupt" | "runner_lost_ownership" | "test_fixture"; exitCode?: number; delayMs?: number } };

export class FakeRunnerProvider implements RunnerProvider {
  async *execute(command: Parameters<RunnerProvider["execute"]>[0], input: string) {
    if (process.env.NODE_ENV !== "test" || process.env.OWNWARD_RUNNER_ALLOW_FAKE !== "1") throw new Error("Fake Provider 需要显式 test 双门");
    const fixture = JSON.parse(input) as FakeInput, plan = fixture.plan;
    if (!fixture || typeof fixture.prompt !== "string" || (fixture.plan !== undefined && (!fixture.plan || typeof fixture.plan !== "object" || Array.isArray(fixture.plan)))) throw new Error("Fake input fixture 非法");
    if (plan && (Object.keys(plan).some((key) => !["deltas", "nativeRef", "terminal", "reason", "exitCode", "delayMs"].includes(key)) || (plan.delayMs !== undefined && (!Number.isSafeInteger(plan.delayMs) || plan.delayMs < 0 || plan.delayMs > 5_000)) || (plan.deltas !== undefined && (!Array.isArray(plan.deltas) || plan.deltas.length > 20 || plan.deltas.some((delta) => typeof delta !== "string" || Buffer.byteLength(delta) > 64 * 1024))))) throw new Error("Fake plan 超出测试限制");
    if (plan?.delayMs) await Bun.sleep(plan.delayMs);
    const provider = new FakeProvider({ deltas: plan?.deltas, nativeRef: plan?.nativeRef, terminal: plan?.terminal, reason: plan?.reason, exitCode: plan?.exitCode });
    for (const event of provider.events(command)) yield event;
  }
}
