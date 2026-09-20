import { describe, expect, test } from "bun:test";
import { decideChannels, DEFAULT_COOLDOWN_MS, type PolicyInput } from "./notify-policy.ts";

const base: PolicyInput = {
  level: "act", source: "dispatch", active: false, larkSkipSources: ["lark"],
  macosEnabled: true, larkEnabled: true, now: 1_800_000_000_000,
  cooldownMs: DEFAULT_COOLDOWN_MS, quiet: false,
};

describe("通知通道策略", () => {
  test("工作台在前台时，飞书和横幅都不推——人正看着 feed", () => {
    expect(decideChannels({ ...base, active: true })).toMatchObject({ macos: false, lark: false });
    // act 也一样压住：用户的规则是「窗口激活就不推」，不分级别
    expect(decideChannels({ ...base, active: true, level: "act" }).reason).toContain("前台");
  });

  test("只有 act 进飞书；fyi 留在横幅和 feed", () => {
    expect(decideChannels(base)).toMatchObject({ macos: true, lark: true });
    expect(decideChannels({ ...base, level: "fyi" })).toMatchObject({ macos: true, lark: false });
    expect(decideChannels({ ...base, level: "silent" })).toMatchObject({ macos: false, lark: false });
  });

  test("飞书来源不回发飞书（人就在飞书里）", () => {
    expect(decideChannels({ ...base, source: "lark" })).toMatchObject({ macos: true, lark: false });
    // 会议提醒改挂 calendar 来源，正是为了绕开这条跳过规则
    expect(decideChannels({ ...base, source: "calendar" }).lark).toBe(true);
  });

  test("同一件事冷却窗口内只推一次——多轮接力任务每轮都会 reap 出一次结束", () => {
    const key = "task-end:20260919-oe5a";
    expect(decideChannels({ ...base, key, lastSentAt: base.now - 60_000 })).toMatchObject({ macos: false, lark: false });
    expect(decideChannels({ ...base, key, lastSentAt: base.now - DEFAULT_COOLDOWN_MS - 1 })).toMatchObject({ lark: true });
    // 没给 key 的通知不受影响
    expect(decideChannels({ ...base, lastSentAt: base.now - 60_000 }).lark).toBe(true);
  });

  test("静默时段只压推送，关掉的通道各自独立生效", () => {
    expect(decideChannels({ ...base, quiet: true })).toMatchObject({ macos: false, lark: false });
    expect(decideChannels({ ...base, larkEnabled: false })).toMatchObject({ macos: true, lark: false });
    expect(decideChannels({ ...base, macosEnabled: false })).toMatchObject({ macos: false, lark: true });
  });
});

describe("压制规则的例外", () => {
  test("force：手动自测穿透前台、静默和冷却", () => {
    const forced = { ...base, force: true, active: true, quiet: true, key: "k", lastSentAt: base.now };
    expect(decideChannels(forced)).toMatchObject({ macos: true, lark: true });
  });

  test("quietExempt：会议/止损在静默时段照推，但仍受前台和冷却约束", () => {
    expect(decideChannels({ ...base, quiet: true, quietExempt: true })).toMatchObject({ lark: true });
    expect(decideChannels({ ...base, quiet: true, quietExempt: true, active: true }).lark).toBe(false);
    expect(decideChannels({ ...base, quiet: true, quietExempt: true, key: "m", lastSentAt: base.now - 60_000 }).lark).toBe(false);
  });
});
