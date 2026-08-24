import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertUserAgent, isProtectedSchedule, runScheduleNow, toggleSchedule, updateSchedule } from "./schedules.ts";

describe("protected Runner schedule", () => {
  test("Runner 永不可编辑，run/toggle/update 在调用 launchctl 前 fail closed", async () => {
    expect(isProtectedSchedule("ai.ownward.runner")).toBe(true); expect(isProtectedSchedule("example.job")).toBe(false);
    await expect(runScheduleNow("ai.ownward.runner")).rejects.toThrow("受保护");
    await expect(toggleSchedule("ai.ownward.runner", "/tmp/not-used.plist", false)).rejects.toThrow("受保护");
    await expect(updateSchedule("ai.ownward.runner", "/tmp/not-used.plist", { mode: "daily" })).rejects.toThrow("受保护");
  });
});

// 路径校验是 launchctl bootstrap 前唯一的门：`..`/symlink 穿越 = 以当前用户执行任意命令
describe("assertUserAgent", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-guard-"));
  const base = join(root, "LaunchAgents");
  mkdirSync(base, { recursive: true });
  const inside = join(base, "ai.test.plist");
  writeFileSync(inside, "<plist/>");
  const outside = join(root, "evil.plist");
  writeFileSync(outside, "<plist/>");

  test("目录内的 plist 放行", () => {
    expect(() => assertUserAgent(inside, base)).not.toThrow();
  });

  test("`..` 穿越被拒：字符串前缀匹配但真实路径在目录外", () => {
    const raw = base + "/../evil.plist";
    expect(raw.startsWith(base)).toBe(true); // 旧实现（裸 startsWith）会放行这个
    expect(() => assertUserAgent(raw, base)).toThrow(/只允许/);
  });

  test("symlink 指向目录外被拒", () => {
    const link = join(base, "link.plist");
    symlinkSync(outside, link);
    expect(() => assertUserAgent(link, base)).toThrow(/只允许/);
  });

  test("同前缀兄弟目录（LaunchAgents-evil/）被拒", () => {
    const sibling = base + "-evil";
    mkdirSync(sibling, { recursive: true });
    const f = join(sibling, "x.plist");
    writeFileSync(f, "<plist/>");
    expect(() => assertUserAgent(f, base)).toThrow(/只允许/);
  });

  test("不存在的路径直接拒绝", () => {
    expect(() => assertUserAgent(join(base, "nope.plist"), base)).toThrow(/不存在|不可访问/);
  });
});
