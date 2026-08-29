// 每日 12:30 统一任务的接线与纯逻辑（源码断言）。
// 行为面：daemon 60s tick 调 sweepMidday，到点跑 日报 + transcript 清理两部分（邮件精选已迁至 corp-outlook vertical）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MIDDAY_TIME } from "./midday.ts";

const src = readFileSync(join(import.meta.dir, "midday.ts"), "utf8");
const daemon = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");

describe("midday 统一任务", () => {
  test("触发时点 12:30；日报有 feature 开关，清理常开", () => {
    expect(MIDDAY_TIME).toBe("12:30");
    expect(src).toContain('featureEnabled("digest")');
    expect(src).toContain("sweepDaemonTranscripts()");
  });

  test("日报重试到 18:00；周末昨天不写", () => {
    expect(src).toContain("DIGEST_RETRY_UNTIL");   // 18:00 的唯一定义在 daily-digest.ts
    expect(src).toContain("dow === 0 || dow === 6");
  });

  test("邮件精选已迁出 base（公司 vertical corp-outlook 承担）", () => {
    expect(src).not.toContain("curateMailPicks");
    expect(src).not.toContain("listMails");
    expect(src).not.toContain("runMailPickPart");
    expect(src).not.toContain('featureEnabled("mailPick")');
  });

  test("daemon 接线：60s tick 调 sweepMidday；旧的 24:00 日报/6h 清理定时器已移除", () => {
    expect(daemon).toContain("sweepMidday()");
    expect(daemon).not.toContain("sweepDigest");
    expect(daemon).not.toContain("6 * 3600_000");
    expect(daemon).not.toContain("sweepDaemonTranscripts");   // 只许 midday.ts 调
  });
});
