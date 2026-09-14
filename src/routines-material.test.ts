// 取材窗口的日期推算。月窗口的回归背景：周日 9/6 生成 8 月复盘时，原实现把目标月推到了 10 月，
// 于是取材成了 9 月 1–30 日——只有月初几天日志，草稿被迫拿 9 月的事冒充 8 月复盘。
import { describe, expect, test } from "bun:test";
import { materialDays, routineDueToday, validateRoutineMaterialPatch, type Routine } from "./routines.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const at = (iso: string) => new Date(`${iso}T12:00:00`);

describe("materialDays(month)", () => {
  test("周日 9/6（明天是 9 月第一个周一）→ 取 8 月整月", () => {
    const d = materialDays("month", at("2026-09-06"));
    expect(d[0]).toBe("2026-08-01");
    expect(d.at(-1)).toBe("2026-08-31");
    expect(d).toHaveLength(31);
  });
  test("周日 5/31（明天 6/1 是周一）→ 取 5 月", () => {
    const d = materialDays("month", at("2026-05-31"));
    expect([d[0], d.at(-1)]).toEqual(["2026-05-01", "2026-05-31"]);
  });
  test("周一 9/7 补做 → 按今天所在月往前推，仍是 8 月", () => {
    const d = materialDays("month", at("2026-09-07"));
    expect([d[0], d.at(-1)]).toEqual(["2026-08-01", "2026-08-31"]);
  });
  test("1 月生成 → 跨年取上一年 12 月", () => {
    const d = materialDays("month", at("2027-01-03"));   // 2027-01-03 是周日，明天 1/4 周一
    expect([d[0], d.at(-1)]).toEqual(["2026-12-01", "2026-12-31"]);
  });
  test("月中的周日不是「首个周一前夜」→ 仍按今天所在月往前推", () => {
    const d = materialDays("month", at("2026-09-20"));
    expect([d[0], d.at(-1)]).toEqual(["2026-08-01", "2026-08-31"]);
  });
});

test("月度触发按配置时区，月末前夜和跨年正确，普通周日不触发", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownward-routine-timezone-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ timezone: "America/Los_Angeles" }));
  try {
    const script = `import {routineDueToday,materialDays} from ${JSON.stringify(join(import.meta.dir, "routines.ts"))}; const r={cadence:"monthly",days:[]}; console.log(JSON.stringify([routineDueToday(r,new Date("2026-09-07T02:00:00Z")),routineDueToday(r,new Date("2026-09-14T02:00:00Z")),routineDueToday(r,new Date("2026-06-01T02:00:00Z")),materialDays("month",new Date("2026-06-01T02:00:00Z"))[0],materialDays("month",new Date("2027-01-04T02:00:00Z"))[0]]));`;
    const p = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, OWNWARD_CONFIG_ROOT: dir, OWNWARD_SOURCE_ROOT: join(import.meta.dir, ".."), OWNWARD_DATA_ROOT: join(dir, "data") } });
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    expect(JSON.parse(p.stdout.toString().trim())).toEqual([true, false, true, "2026-05-01", "2026-12-01"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("新配置字段拒绝未知频率、自引用、空人员与不存在的来源", () => {
  const rules = [{ id: "source", docUrl: "https://example.com/doc" }] as Routine[];
  expect(() => validateRoutineMaterialPatch({ cadence: "daily" as any }, rules, "monthly")).toThrow();
  expect(() => validateRoutineMaterialPatch({ people: [" "] }, rules, "monthly")).toThrow();
  expect(() => validateRoutineMaterialPatch({ people: ["A", " A "] }, rules, "monthly")).toThrow();
  expect(() => validateRoutineMaterialPatch({ refRoutines: ["monthly"] }, rules, "monthly")).toThrow();
  expect(() => validateRoutineMaterialPatch({ refRoutines: ["missing"] }, rules, "monthly")).toThrow();
  expect(() => validateRoutineMaterialPatch({ cadence: "monthly", people: ["A"], refRoutines: ["source"] }, rules, "monthly")).not.toThrow();
});

describe("materialDays(yesterday/week) 不受影响", () => {
  test("周一的昨天是上周五", () => {
    expect(materialDays("yesterday", at("2026-09-07"))).toEqual(["2026-09-04"]);
  });
  test("周五的周窗口是本周一到周五", () => {
    const d = materialDays("week", at("2026-09-04"));
    expect([d[0], d.at(-1), d.length]).toEqual(["2026-08-31", "2026-09-04", 5]);
  });
});
