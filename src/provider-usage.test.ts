import { describe, expect, test } from "bun:test";
import { codexUsage, fromClaudeUsage, parseCodexUsage, providersUsage, readCodexAuth, windowLabel } from "./provider-usage.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

describe("provider usage windows", () => {
  test("window labels read like the statusline (5h / 周 / N天 / Nh)", () => {
    expect(windowLabel(18_000)).toBe("5h");
    expect(windowLabel(604_800)).toBe("周");
    expect(windowLabel(86_400 * 30)).toBe("30天");
    expect(windowLabel(3_600)).toBe("1h");
    expect(windowLabel(90)).toBe("2m");
  });

  test("Claude usage maps 5h + weekly windows and keeps reset timestamps", () => {
    // Anthropic 的 resets_at 是 6 位小数 + "+00:00"，出口统一成标准 ISO（iOS/Android 只解析一种格式）
    expect(fromClaudeUsage({ fiveHourPercent: 46.4, weeklyPercent: 42, fiveHourResetsAt: "2026-09-07T14:49:59.540954+00:00", weeklyResetsAt: "2026-09-09T13:59:59Z" }, NOW)).toEqual({
      windows: [
        { label: "5h", seconds: 18_000, percent: 46, resetsAt: "2026-09-07T14:49:59.540Z" },
        { label: "周", seconds: 604_800, percent: 42, resetsAt: "2026-09-09T13:59:59.000Z" },
      ],
      fetchedAt: "2026-09-07T12:00:00.000Z",
    });
    expect(fromClaudeUsage({ fiveHourPercent: 130 }, NOW)?.windows).toEqual([{ label: "5h", seconds: 18_000, percent: 100 }]);
    expect(fromClaudeUsage(null)).toBeNull();
  });

  test("Codex wham/usage: Pro plan exposes only the weekly window, ordered shortest first", () => {
    // 2026-09-07 真实响应形状（值改过）：主窗口就是周窗口，次窗口为空；Spark 的按模型额度在 additional_rate_limits 里，不混进来
    const real = {
      plan_type: "pro",
      rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 23, limit_window_seconds: 604_800, reset_after_seconds: 358_695, reset_at: 1_789_140_157 }, secondary_window: null },
      additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: 1_788_799_462 } } }],
    };
    expect(parseCodexUsage(real, NOW)).toEqual({
      windows: [{ label: "周", seconds: 604_800, percent: 23, resetsAt: new Date(1_789_140_157 * 1000).toISOString() }],
      plan: "pro",
      fetchedAt: "2026-09-07T12:00:00.000Z",
    });
    const plus = parseCodexUsage({ plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_after_seconds: 100 },
      secondary_window: { used_percent: 12.6, limit_window_seconds: 18_000, reset_after_seconds: 600 },
    } }, NOW);
    expect(plus?.windows.map((w) => `${w.label}:${w.percent}`)).toEqual(["5h:13", "周:61"]);
    expect(plus?.windows[0].resetsAt).toBe(new Date(NOW + 600_000).toISOString());   // 没给 reset_at 时按 reset_after_seconds 推
    expect(parseCodexUsage({ rate_limit: null }, NOW)).toBeNull();
    expect(parseCodexUsage(undefined, NOW)).toBeNull();
  });

  test("Codex auth: OAuth tokens are picked up, API-key mode and missing files yield null", () => {
    const home = mkdtempSync(join(tmpdir(), "ownward-codex-home-"));
    try {
      expect(readCodexAuth(home)).toBeNull();
      writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x", auth_mode: "apikey", tokens: null }));
      expect(readCodexAuth(home)).toBeNull();
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok", account_id: "acc", id_token: "id", refresh_token: "r" } }));
      expect(readCodexAuth(home)).toEqual({ accessToken: "tok", accountId: "acc" });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("codexUsage sends the ChatGPT account header and swallows transport failures", async () => {
    const seen: unknown[] = [];
    const usage = await codexUsage({
      readAuth: () => ({ accessToken: "tok", accountId: "acc" }),
      fetchJson: async (auth) => { seen.push(auth); return { plan_type: "plus", rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 } } }; },
      now: () => NOW,
    });
    expect(seen).toEqual([{ accessToken: "tok", accountId: "acc" }]);
    expect(usage?.windows).toEqual([{ label: "5h", seconds: 18_000, percent: 5, resetsAt: "2027-01-15T08:00:00.000Z" }]);
    expect(await codexUsage({ readAuth: () => null, fetchJson: async () => { throw new Error("must not fetch without auth"); } })).toBeNull();
    expect(await codexUsage({ readAuth: () => ({ accessToken: "tok" }), fetchJson: async () => { throw new Error("network down"); } })).toBeNull();
  });

  test("providersUsage answers both providers together and caches each for a minute", async () => {
    let claudeCalls = 0, codexCalls = 0;
    const deps = {
      claude: async () => { claudeCalls++; return { windows: [{ label: "5h", seconds: 18_000, percent: 40 }], fetchedAt: "x" }; },
      codex: async () => { codexCalls++; return null; },
    };
    const first = await providersUsage(deps);
    expect(first.claude?.windows[0].percent).toBe(40);
    expect(first.codex).toBeNull();
    await providersUsage(deps);
    expect([claudeCalls, codexCalls]).toEqual([1, 1]);   // 第二次命中缓存：头部轮询与系统页不该各打一次接口
  });
});
