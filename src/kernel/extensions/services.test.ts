import { describe, expect, test } from "bun:test";
import { SchedulerScope, schedulerRetryDelay } from "./services.ts";

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
