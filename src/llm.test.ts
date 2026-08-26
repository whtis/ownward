import { describe, expect, test } from "bun:test";
import { isFailoverEligible, reportFailover, runWithFailover, safeProviderReason, shouldNotifyFailover } from "./llm.ts";

describe("background LLM failover", () => {
  test("Claude quota exhaustion falls back to Codex and reports once", async () => {
    const calls: string[] = [], reports: string[] = [];
    const value = await runWithFailover("claude", "codex", async (engine) => {
      calls.push(engine);
      return engine === "claude" ? { value: null, error: "weekly usage limit reached" } : { value: { title: "ok" } };
    }, async (state) => { reports.push(state); });
    expect(value).toEqual({ title: "ok" });
    expect(calls).toEqual(["claude", "codex"]);
    expect(reports).toEqual(["fallback"]);
  });

  test("does not hide malformed output behind provider failover", async () => {
    const calls: string[] = [];
    expect(await runWithFailover("claude", "codex", async (engine) => {
      calls.push(engine); return { value: null, error: "response was not JSON" };
    }, async () => {})).toBeNull();
    expect(calls).toEqual(["claude"]);
  });

  test("recognizes provider availability failures", () => {
    for (const error of ["rate limit 429", "authentication expired", "service unavailable", "quota exceeded", "You've hit your limit · resets tomorrow", "You've hit your weekly limit · resets Aug 26 at 10pm (Asia/Shanghai)", "Please run /login"]) expect(isFailoverEligible(error)).toBe(true);
    expect(isFailoverEligible("invalid JSON response")).toBe(false);
  });

  test("observer and state failures never discard a valid result", async () => {
    const primary = await runWithFailover("claude", "codex", async () => ({ value: { ok: "primary" } }), undefined, () => { throw new Error("disk full"); });
    const fallback = await runWithFailover("claude", "codex", async (engine) => engine === "claude"
      ? { value: null, error: "quota exceeded" } : { value: { ok: "fallback" } }, async () => { throw new Error("notify down"); });
    expect(primary).toEqual({ ok: "primary" });
    expect(fallback).toEqual({ ok: "fallback" });
  });

  test("real failover reporter tolerates storage and notification failures", async () => {
    const value = await runWithFailover("claude", "codex", async (engine) => engine === "claude"
      ? { value: null, error: "quota exceeded" } : { value: { ok: true } },
    (state, primary, fallback, error) => reportFailover(state, primary, fallback, error, {
      update: () => { throw new Error("state read-only"); },
      send: async () => { throw new Error("feed read-only"); },
    }));
    expect(value).toEqual({ ok: true });
  });

  test("alternating fallback and failed states share a cooldown", async () => {
    let stored: any = {}, sends = 0, now = Date.parse("2026-08-25T00:00:00Z");
    const update = (mutate: (s: any) => void) => { mutate(stored); };
    const send = async () => { sends++; return true; };
    await reportFailover("fallback", "claude", "codex", "quota exceeded SECRET", { update, send, now: () => now });
    now += 60_000;
    await reportFailover("failed", "claude", "codex", "quota exceeded DIFFERENT_SECRET", { update, send, now: () => now });
    now += 6 * 3600_000;
    await reportFailover("fallback", "claude", "codex", "quota exceeded", { update, send, now: () => now });
    expect(sends).toBe(2);
    expect(stored.llmFailoverNotice.state).toBe("fallback");
  });

  test("primary recovery clears active notice but preserves cooldown across flapping", async () => {
    let stored: any = {}, sends = 0, now = Date.parse("2026-08-25T00:00:00Z");
    const update = (mutate: (s: any) => void) => mutate(stored);
    const reporter = (state: "fallback" | "failed", primary: any, fallback: any, error: string) => reportFailover(state, primary, fallback, error, { update, send: async () => { sends++; return true; }, now: () => now });
    const failThenFallback = () => runWithFailover("claude", "codex", async (engine) => engine === "claude" ? { value: null, error: "quota exceeded" } : { value: { ok: true } }, reporter, () => { delete stored.llmFailoverNotice; });
    const success = () => runWithFailover("claude", "codex", async () => ({ value: { ok: true } }), reporter, () => { delete stored.llmFailoverNotice; });
    await failThenFallback(); await success(); now += 60_000; await failThenFallback(); await success();
    expect(sends).toBe(1);
    expect(stored.llmFailoverNotice).toBeUndefined();
    expect(stored.llmFailoverLastNotifiedAt).toBeTruthy();
  });

  test("user-visible state and notification contain only classified reasons", async () => {
    let stored: any, text = "";
    await reportFailover("fallback", "claude", "codex", "quota exceeded token=SUPER_SECRET path=/private/x", {
      update: (mutate) => { const state: any = {}; mutate(state); stored = state.llmFailoverNotice; },
      send: async (message) => { text = message; return true; },
      now: () => 1_800_000_000_000,
    });
    expect(safeProviderReason("quota exceeded token=secret")).toBe("额度已耗尽");
    expect(safeProviderReason("You've hit your weekly limit · resets Aug 26 at 10pm (Asia/Shanghai)")).toBe("额度已耗尽");
    expect(JSON.stringify(stored) + text).not.toContain("SUPER_SECRET");
    expect(text).toContain("额度已耗尽");
  });
});
