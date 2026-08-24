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
});
