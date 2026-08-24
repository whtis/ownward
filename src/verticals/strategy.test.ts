import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ScopedScheduler, VerticalContext } from "../kernel/extensions/contracts.ts";
import { ExtensionRuntime } from "../kernel/extensions/runtime.ts";
import { createStrategyVertical, shouldRunMarketMonitor, strategyVerticalConfig } from "./strategy.ts";
import type { StrategyDomainAdapter } from "./strategy-domain-adapter.ts";

function fakeDomain(overrides: Partial<StrategyDomainAdapter> = {}): StrategyDomainAdapter {
  return {
    route: async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
    scan: async () => null,
    monitor: async () => null,
    ...overrides,
  };
}

function harness(domain: Record<string, unknown>, now: Date) {
  const jobs = new Map<string, (signal: AbortSignal) => Promise<void> | void>();
  const scheduler: ScopedScheduler = { every(id, _interval, job) { jobs.set(id, job); } };
  let scans = 0, monitors = 0;
  const vertical = createStrategyVertical({ domain: fakeDomain({ scan: async () => { scans++; return null; }, monitor: async () => { monitors++; } }), now: () => now });
  vertical.activate({ id: "strategy", config: { domain }, scheduler, log() {} } as VerticalContext);
  return { vertical, jobs, scans: () => scans, monitors: () => monitors };
}

describe("strategy vertical lifecycle", () => {
  test("strategy.enabled 与 verticals.strategy.enabled 分属 domain 和插件生命周期", () => {
    expect(strategyVerticalConfig({ enabled: false }, {}, "Asia/Shanghai")).toMatchObject({ enabled: true, domain: { enabled: false } });
    expect(strategyVerticalConfig({ enabled: true }, { enabled: false }, "Asia/Shanghai")).toMatchObject({ enabled: false, domain: { enabled: true } });
  });
  test("旧 vertical 领域字段与显式 domain override 都迁移到领域配置", () => {
    expect(strategyVerticalConfig({ enabled: true, scanTimes: ["05:10"] }, { scanTimes: ["06:00"], timezone: "America/New_York", monitor: { enabled: false }, domain: { scanTimes: ["07:00"] } }, "Asia/Shanghai")).toEqual({
      enabled: true, domain: { enabled: true, scanTimes: ["07:00"], monitor: { enabled: false }, timezone: "America/New_York" },
    });
  });
  test("domain disabled 只停 scheduler，页面和旧 API route 仍可用", async () => {
    const h = harness({ enabled: false }, new Date("2026-08-14T21:10:00Z"));
    expect(h.jobs.size).toBe(0);
    expect((await h.vertical.route?.({ request: new Request("http://x/api/strategy"), url: new URL("http://x/api/strategy"), signal: new AbortController().signal }))?.status).toBe(200);
    expect(h.vertical.health?.()).toEqual({ ok: true });
  });

  test("复用旧扫描语义：周六照常扫描，同一分钟幂等", async () => {
    const h = harness({ enabled: true, timezone: "Asia/Shanghai", scanTimes: ["05:10"], monitor: { enabled: false } }, new Date("2026-08-14T21:10:00Z"));
    const scan = h.jobs.get("scan-clock")!;
    await scan(new AbortController().signal); await scan(new AbortController().signal);
    expect(h.scans()).toBe(1);
  });

  test("跨夜窗口只覆盖真实交易日：周六凌晨属于周五，周六晚和周一凌晨关闭", () => {
    expect(shouldRunMarketMonitor(new Date("2026-08-14T19:00:00Z"), "Asia/Shanghai", "21:30", "04:05")).toBeTrue();
    expect(shouldRunMarketMonitor(new Date("2026-08-15T14:00:00Z"), "Asia/Shanghai", "21:30", "04:05")).toBeFalse();
    expect(shouldRunMarketMonitor(new Date("2026-08-16T19:00:00Z"), "Asia/Shanghai", "21:30", "04:05")).toBeFalse();
    expect(shouldRunMarketMonitor(new Date("2026-08-14T12:00:00Z"), "Asia/Shanghai", "21:30", "04:05")).toBeFalse();
  });
  test("runtime 中 strategy domain=false 保持 Vertical ready 和旧 API", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-strategy-runtime-")), runtime = new ExtensionRuntime({ dataRoot, config: { verticals: { strategy: strategyVerticalConfig({ enabled: false }, {}, "Asia/Shanghai") } }, builtins: [{ manifest: (await import("./strategy.ts")).manifest, legacyRoutes: ["/strategy", "/api/strategy"], load: async () => createStrategyVertical({ domain: fakeDomain() }) }] });
    try { await runtime.start(); expect(runtime.statuses()[0]).toMatchObject({ state: "ready", consecutiveFailures: 0 }); const response = await runtime.route(new Request("http://x/api/strategy"), new URL("http://x/api/strategy")); expect(response?.status).toBe(200); expect((await runtime.health())[0].report).toMatchObject({ ok: true, scheduler: { ok: true, jobs: {} } }); }
    finally { await runtime.stop(); rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test("Vertical 只能通过 adapter 访问 legacy strategy domain", () => {
    const source = readFileSync(join(import.meta.dir, "strategy.ts"), "utf8");
    expect(source).not.toContain("../strategy/api.ts");
    expect(source).not.toContain("../strategy/scan.ts");
    const adapter = readFileSync(join(import.meta.dir, "strategy-domain-adapter.ts"), "utf8");
    expect(adapter).toContain("../strategy/api.ts");
    expect(adapter).toContain("../strategy/scan.ts");
  });
});
