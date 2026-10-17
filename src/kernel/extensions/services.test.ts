import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { VerticalManifest } from "./contracts.ts";
import { LifecycleCapability } from "./lifecycle.ts";
import { buildVerticalContext, SchedulerScope, schedulerRetryDelay } from "./services.ts";

describe("SchedulerScope", () => {
  test("job 失败使用独立指数退避，成功后恢复基础周期", () => {
    expect(schedulerRetryDelay(1_000, 1)).toBe(2_000);
    expect(schedulerRetryDelay(1_000, 3)).toBe(8_000);
    expect(schedulerRetryDelay(60_000, 20)).toBe(300_000);
  });

  test("job 错误进入 scheduler health，不关闭其他 job", async () => {
    const errors: unknown[] = [], scheduler = new SchedulerScope("test", (error) => errors.push(error), { minIntervalMs: 5, maxBackoffMs: 20 });
    let failingRuns = 0, healthyRuns = 0;
    scheduler.every("failing", 5, () => { failingRuns++; throw new Error("boom"); });
    scheduler.every("healthy", 5, () => { healthyRuns++; });
    await Bun.sleep(18);
    const health = scheduler.health();
    expect(errors.length).toBeGreaterThan(0);
    expect(failingRuns).toBeGreaterThan(0);
    expect(healthyRuns).toBeGreaterThan(1);
    expect(health.ok).toBeFalse();
    expect(health.jobs.failing.consecutiveFailures).toBeGreaterThan(0);
    expect(health.jobs.healthy.consecutiveFailures).toBe(0);
    scheduler.stop();
  });
});

describe("buildVerticalContext：events/notify（ADR 0003）", () => {
  const manifest = (capabilities: VerticalManifest["capabilities"]): VerticalManifest => ({ id: "acme", name: "Acme", version: "1.0.0", kernelApiVersion: 1, entry: "builtin", capabilities });
  const build = (capabilities: VerticalManifest["capabilities"], extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-ctx-"));
    try { return buildVerticalContext({ manifest: manifest(capabilities), dataRoot, config, logger: () => {}, scheduler: new SchedulerScope("acme", () => {}), ...extra }); }
    finally { rmSync(dataRoot, { recursive: true, force: true }); }
  };
  const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e?.code; } return "NO_ERROR"; };

  test("声明了才注入；urgent 授权从 config 透传；撤销后调用被生命周期闸拒绝", async () => {
    const published: unknown[] = [], grants: unknown[] = [], lifecycle = new LifecycleCapability("vertical", "acme");
    const ctx = build(["events", "notify"], {
      lifecycle,
      eventFactory: () => ({ publish: (events: unknown[]) => { published.push(...events); return { accepted: events.length, duplicates: 0 }; } }),
      notifyFactory: (_id: string, g: unknown) => { grants.push(g); return { send: () => ({ status: "queued" as const }) }; },
    }, { grantedNotifyUrgent: true });
    expect(await ctx.events!.publish([{ id: "a", type: "t", payload: {} }])).toEqual({ accepted: 1, duplicates: 0 });
    expect(await ctx.notify!.send({ key: "k", text: "t" })).toEqual({ status: "queued" });
    expect(grants).toEqual([{ urgent: true }]);
    lifecycle.revoke();
    expect(code(() => ctx.events!.publish([{ id: "b", type: "t", payload: {} }]))).toBe("EXTENSION_CAPABILITY_REVOKED");
    expect(code(() => ctx.notify!.send({ key: "k", text: "t" }))).toBe("EXTENSION_CAPABILITY_REVOKED");
    expect(published).toHaveLength(1);
    expect(build([], { eventFactory: () => { throw new Error("must not be built"); } }).events).toBeUndefined();
  });

  test("没装配 factory 时 fail closed", () => {
    expect(code(() => build(["events"]))).toBe("VERTICAL_SERVICE_UNAVAILABLE");
    expect(code(() => build(["notify"]))).toBe("VERTICAL_SERVICE_UNAVAILABLE");
  });
});
