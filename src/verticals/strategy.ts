import type { OwnwardVertical, VerticalContext, VerticalManifest } from "../kernel/extensions/contracts.ts";
import type { StrategyDomainAdapter } from "./strategy-domain-adapter.ts";

export function localParts(now: Date, timezone: string): { date: string; time: string } { const value = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(now), [date, rawTime] = value.split(" "); return { date, time: rawTime.slice(0, 5) }; }
export function inStrategyWindow(time: string, start: string, end: string): boolean { return start > end ? time >= start || time < end : time >= start && time < end; }
export function shouldRunMarketMonitor(now: Date, timezone: string, start: string, end: string): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now), weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day), time = localParts(now, timezone).time;
  if (start <= end) return weekday && time >= start && time < end;
  if (time >= start) return weekday; // 跨夜晚段：周一至周五开盘
  return time < end && ["Tue", "Wed", "Thu", "Fri", "Sat"].includes(day); // 凌晨段属于前一交易日
}
export function strategyVerticalConfig(strategy: Record<string, unknown> | undefined, vertical: Record<string, unknown> | undefined, timezone: string): Record<string, unknown> {
  const { enabled, domain, ...legacyDomainOverrides } = vertical ?? {};
  return { enabled: enabled !== false, domain: { ...strategy, timezone, ...legacyDomainOverrides, ...(domain && typeof domain === "object" && !Array.isArray(domain) ? domain as Record<string, unknown> : {}) } };
}

export const manifest: VerticalManifest = {
  id: "strategy", name: "Strategy", version: "1.0.0", kernelApiVersion: 1, entry: "builtin:strategy",
  capabilities: ["storage", "scheduler"],
  routes: ["/api/verticals/strategy/view", "/api/verticals/strategy/refresh", "/api/verticals/strategy/scan", "/api/verticals/strategy/thesis"],
  navigation: [{ id: "strategy", label: "策略", href: "/strategy" }],
  assets: [{ path: "/verticals/strategy/index.html", file: "web/strategy.html", contentType: "text/html; charset=utf-8" }],
  commands: [{ id: "scan", title: "扫描持仓" }],
};
export function createStrategyVertical(deps: { domain: StrategyDomainAdapter; now?: () => Date }): OwnwardVertical { let ready = false; return {
  manifest,
  activate(ctx) {
    ready = true; const c = (ctx.config as any).domain ?? {}; if (!c.enabled || !ctx.scheduler) return;
    let lastScanFired = "";
    ctx.scheduler.every("scan-clock", 30_000, async () => { const now = deps.now?.() ?? new Date(), parts = localParts(now, String(c.timezone || "Asia/Shanghai")), hhmm = parts.time, stamp = `${parts.date} ${hhmm}`; if ((c.scanTimes ?? []).includes(hhmm) && lastScanFired !== stamp) { lastScanFired = stamp; await deps.domain.scan(); } });
    if (c.monitor?.enabled) ctx.scheduler.every("market-monitor", Math.max(1, Number(c.monitor.intervalMin || 10)) * 60_000, async () => { const now=deps.now?.() ?? new Date(), timezone=String(c.timezone||"Asia/Shanghai"); if(shouldRunMarketMonitor(now,timezone,String(c.monitor.start),String(c.monitor.end))) await deps.domain.monitor(); });
  },
  deactivate() { ready = false; },
  route({ request, url }) {
    const map: Record<string, string> = { "/api/verticals/strategy/view": "/api/strategy", "/api/verticals/strategy/refresh": "/api/strategy/refresh", "/api/verticals/strategy/scan": "/api/strategy/scan", "/api/verticals/strategy/thesis": "/api/strategy/thesis", "/verticals/strategy/index.html": "/strategy" };
    const mapped = map[url.pathname]; if (!mapped) return deps.domain.route(request, url); const legacy = new URL(url); legacy.pathname = mapped; return deps.domain.route(request, legacy);
  },
  health() { return { ok: ready }; },
}; }
export default createStrategyVertical;
