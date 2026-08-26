import { describe, expect, test } from "bun:test";
import { harvestRetryDelay, harvestRetryEligible, selectHarvestBudget } from "./harvest.ts";

describe("harvest retry fairness", () => {
  test("a failed task backs off so later tasks can consume the bounded budget", () => {
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const retry = { attempts: 1, lastAt: new Date(now).toISOString(), nextAt: new Date(now + harvestRetryDelay(1)).toISOString() };
    expect(harvestRetryEligible(retry, now + 10 * 60_000)).toBe(false);
    expect(harvestRetryEligible(retry, now + 20 * 60_000)).toBe(true);
    expect(harvestRetryEligible(undefined, now)).toBe(true);
  });

  test("backoff is exponential and capped", () => {
    expect(harvestRetryDelay(2)).toBe(harvestRetryDelay(1) * 2);
    expect(harvestRetryDelay(99)).toBe(6 * 3600_000);
  });

  test("production budget selection skips backed-off head items", () => {
    const now = Date.parse("2026-08-25T00:00:00Z"), future = new Date(now + 60_000).toISOString();
    const tasks = ["failed-1", "failed-2", "later-1", "later-2", "later-3"].map((id) => ({ id }));
    const retries = Object.fromEntries(["failed-1", "failed-2"].map((id) => [id, { attempts: 1, lastAt: new Date(now).toISOString(), nextAt: future }]));
    expect(selectHarvestBudget(tasks, retries, now).map((task) => task.id)).toEqual(["later-1", "later-2"]);
  });
});
