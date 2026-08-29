import { describe, expect, test } from "bun:test";
import { DIGEST_MAX_ATTEMPTS, digestRetryDecision } from "./daily-digest.ts";

// 日报失败重试门（2026-08-21：02:00 撞限额后以前直接占坑放弃，两天日报就这么没的）
describe("digestRetryDecision", () => {
  const d = "2026-08-21";
  const t = (s: string) => Date.parse(`${d}T${s}:00+08:00`);
  test("今天已成功 → done；没试过 → run", () => {
    expect(digestRetryDecision({ lastDigestDate: d }, d, "02:00", t("02:00"))).toBe("done");
    expect(digestRetryDecision({}, d, "02:00", t("02:00"))).toBe("run");
    expect(digestRetryDecision({ lastDigestDate: "2026-08-20" }, d, "02:00", t("02:00"))).toBe("run");
  });
  test("失败后不到一小时 → wait；满一小时 → run", () => {
    const st = { digestRetry: { date: d, attempts: 1, lastAt: new Date(t("02:00")).toISOString() } };
    expect(digestRetryDecision(st, d, "02:30", t("02:30"))).toBe("wait");
    expect(digestRetryDecision(st, d, "03:00", t("03:00"))).toBe("run");
  });
  test("次数用尽或过了 18:00 → give-up；已放弃 → done", () => {
    const base = { date: d, lastAt: new Date(t("01:00")).toISOString() };
    expect(digestRetryDecision({ digestRetry: { ...base, attempts: DIGEST_MAX_ATTEMPTS } }, d, "03:00", t("03:00"))).toBe("give-up");
    expect(digestRetryDecision({ digestRetry: { ...base, attempts: 2 } }, d, "18:01", t("18:01"))).toBe("give-up");
    expect(digestRetryDecision({ digestRetry: { ...base, attempts: 2, gaveUp: true } }, d, "03:00", t("03:00"))).toBe("done");
  });
  test("昨天的重试记录不影响今天", () => {
    expect(digestRetryDecision({ digestRetry: { date: "2026-08-20", attempts: 8, lastAt: new Date(t("01:00")).toISOString(), gaveUp: true } }, d, "02:00", t("02:00"))).toBe("run");
  });
});
