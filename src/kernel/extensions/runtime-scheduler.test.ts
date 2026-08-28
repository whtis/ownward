import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExtensionRuntime } from "./runtime.ts";
import type { OwnwardVertical, VerticalManifest } from "./contracts.ts";

const roots: string[] = [], runtimes: ExtensionRuntime[] = [];
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map((r) => r.stop())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("runtime scheduler isolation", () => {
  test("scheduled job error only degrades scheduler health, not route breaker", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-scheduler-")); roots.push(dataRoot);
    const manifest: VerticalManifest = { id: "scheduled", name: "Scheduled", version: "1.0.0", kernelApiVersion: 1, entry: "builtin:scheduled", capabilities: ["scheduler"], routes: ["/api/verticals/scheduled/view"] };
    const module: OwnwardVertical = { activate(ctx) { ctx.scheduler!.every("failure", 1_000, () => { throw new Error("job failed"); }); }, route() { return Response.json({ ok: true }); }, health() { return { ok: true }; } };
    const runtime = new ExtensionRuntime({ dataRoot, builtins: [{ manifest, load: async () => module }] }); runtimes.push(runtime);
    await runtime.start(); await Bun.sleep(1_050);
    expect(runtime.statuses()[0]).toMatchObject({ state: "ready", consecutiveFailures: 0 });
    const report = (await runtime.health())[0].report!;
    expect(report.ok).toBeFalse(); expect((report.scheduler as any).jobs.failure.consecutiveFailures).toBe(1);
    const response = await runtime.route(new Request("http://x/api/verticals/scheduled/view"), new URL("http://x/api/verticals/scheduled/view"));
    expect(response?.status).toBe(200);
    expect(runtime.statuses()[0]).toMatchObject({ state: "ready", consecutiveFailures: 0 });
  });

  test("失败的 builtin 冷却后经 route 半开有界重激活并恢复", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-recover-")); roots.push(dataRoot);
    let activateCount = 0;
    const manifest: VerticalManifest = { id: "flaky", name: "Flaky", version: "1.0.0", kernelApiVersion: 1, entry: "builtin:flaky", capabilities: ["scheduler"], routes: ["/api/verticals/flaky/view"] };
    const module: OwnwardVertical = {
      activate(ctx) { activateCount++; ctx.scheduler!.every("noop", 3_600_000, async () => {}); },
      deactivate() {},
      // 首次激活期间路由超时(300ms > routeTimeoutMs)；重激活后立即返回
      async route() { if (activateCount <= 1) { await Bun.sleep(300); return Response.json({ ok: false }); } return Response.json({ ok: true }); },
      health() { return { ok: true }; },
    };
    const rt = new ExtensionRuntime({ dataRoot, builtins: [{ manifest, load: async () => module }], routeTimeoutMs: 50, restartBaseMs: 5 }); runtimes.push(rt);
    await rt.start();
    const call = () => rt.route(new Request("http://x/api/verticals/flaky/view"), new URL("http://x/api/verticals/flaky/view"));
    // 3 次超时 → 熔断 failed
    for (let i = 0; i < 3; i++) expect((await call())?.status).toBe(504);
    expect(rt.statuses()[0].state).toBe("failed");
    // 冷却后再来一次：route 半开重激活(activateCount→2，旧 scheduler 先被停)，本次请求恢复正常
    await Bun.sleep(20);
    expect((await call())?.status).toBe(200);
    expect(activateCount).toBeGreaterThanOrEqual(2);
    expect(rt.statuses()[0]).toMatchObject({ state: "ready", consecutiveFailures: 0 });
  });

  test("持续失败的 builtin 重激活次数有上限，不无限热重启", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-recover-cap-")); roots.push(dataRoot);
    let activateCount = 0;
    const manifest: VerticalManifest = { id: "broken", name: "Broken", version: "1.0.0", kernelApiVersion: 1, entry: "builtin:broken", capabilities: [], routes: ["/api/verticals/broken/view"] };
    const module: OwnwardVertical = { activate() { activateCount++; }, deactivate() {}, async route() { await Bun.sleep(300); return Response.json({ ok: false }); }, health() { return { ok: true }; } };
    const rt = new ExtensionRuntime({ dataRoot, builtins: [{ manifest, load: async () => module }], routeTimeoutMs: 30, restartBaseMs: 1 }); runtimes.push(rt);
    await rt.start();
    const call = () => rt.route(new Request("http://x/api/verticals/broken/view"), new URL("http://x/api/verticals/broken/view"));
    // 一直失败：反复请求，每次冷却后半开都会再激活一次，直到超上限后维持 failed
    for (let i = 0; i < 30; i++) { await call(); await Bun.sleep(3); }
    // 初激活 1 次 + 最多 MAX_BUILTIN_RESTARTS 次重激活，绝不会无上限增长
    expect(activateCount).toBeLessThanOrEqual(1 + 5);
    expect(rt.statuses()[0].state).toBe("failed");
  });
});
