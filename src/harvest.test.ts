import { describe, expect, test } from "bun:test";
import { flightMaterial, harvestRetryDelay, harvestRetryEligible, selectHarvestBudget } from "./harvest.ts";

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

// 2026-10-17：长任务的飞行记录前 12k 全是「执行的命令」，一刀切让「改动」「结论」进不了总结，
// 模型只看到半截排查就自己编结局（把已经修好的 config.toml 写成「改配置不能根治」）
describe("flightMaterial 按段分预算", () => {
  const record = (commands: number, conclusion = "第 1 轮：根因是 config.toml 的孤儿键，已清理并备份") => [
    "---", "type: flight_record", "---", "", "# ✈️ 飞行记录 · demo · t1", "",
    "## Prompts", "1. **任务**：修两个 bug", "2. **追问 1**：go ahead", "",
    "## 审批决策", "(无高危操作或未触发审批)", "",
    "## 执行的命令", "```bash", ...Array.from({ length: commands }, (_, i) => `cat file-${i}.txt | head -20   # 第 ${i} 条命令`), "```", "",
    "## 改动", "abc123 fix: 修好了", "",
    "## 结论", conclusion, "",
    "## 未完成项", "(计划全部完成或无计划)", "", "---", "关联项目：[[demo]]", "",
  ].join("\n");
  test("没超预算原样返回", () => {
    const small = record(5);
    expect(flightMaterial(small)).toBe(small);
  });
  test("超长时结论、改动、Prompts 完整保留，命令段留头尾省中间", () => {
    const out = flightMaterial(record(2_000), 6_000);
    expect(out.length).toBeLessThanOrEqual(6_000);
    for (const kept of ["## Prompts", "**追问 1**：go ahead", "## 改动", "abc123 fix: 修好了", "## 结论", "已清理并备份", "## 未完成项", "关联项目"]) expect(out).toContain(kept);
    expect(out).toContain("# 第 0 条命令");      // 头
    expect(out).toContain("# 第 1999 条命令");   // 尾：最新进展
    expect(out).toMatch(/…（中间省略 \d+ 行命令，完整列表见飞行记录）…/);
    expect(out.indexOf("## 执行的命令")).toBeLessThan(out.indexOf("## 改动"));   // 段落顺序不变
  });
  test("连非命令段都放不下时，结论最先保住", () => {
    const out = flightMaterial(record(10, "结论".repeat(3_000)), 2_000);
    expect(out).toContain("## 结论");
    expect(out).toContain("…(本段截断)…");
    expect(out.length).toBeLessThan(2_400);
  });
});
