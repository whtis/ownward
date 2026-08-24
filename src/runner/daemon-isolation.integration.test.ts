import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { RunnerClient } from "./client.ts";
import { runnerPaths } from "./capability.ts";

const roots: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch {} await child.exited.catch(() => -1); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function spawnRunner(dataRoot: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "testing/entry-test.ts")], { env: { ...process.env, NODE_ENV: "test", OWNWARD_RUNNER_ALLOW_FAKE: "1", OWNWARD_RUNNER_TEST_ROOT: "1", OWNWARD_DATA_ROOT: dataRoot }, stdout: "ignore", stderr: "pipe" });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    if (existsSync(runnerPaths(dataRoot).socket)) { try { const client = new RunnerClient(dataRoot, 50), ping = await client.request("ping", {}, 50); client.close(); if (ping.body.pid === child.pid) return child; } catch {} }
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
    await Bun.sleep(10);
  }
  throw new Error("Runner start timeout");
}

describe("daemon and Runner process ownership", () => {
  test("SIGKILL daemon does not change Runner PID or active Run ownership", async () => {
    const data = mkdtempSync(join(tmpdir(), "ownward-daemon-isolation-")); roots.push(data);
    const runner = await spawnRunner(data), client = new RunnerClient(data);
    await client.request("submit", { commandId: "survive-daemon", kind: "start-run", runId: "run-survive-daemon", sessionId: "session-survive-daemon", providerId: "fake", input: JSON.stringify({ prompt: "fixture", plan: { delayMs: 500 } }) });
    let active: string[] = [];
    for (let i = 0; i < 50; i++) { active = (await client.request("ping", {})).body.activeRuns as string[]; if (active.includes("survive-daemon")) break; await Bun.sleep(5); }
    expect(active).toContain("survive-daemon");

    const daemon = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { env: { ...process.env, OWNWARD_DATA_ROOT: data }, stdout: "ignore", stderr: "ignore" });
    children.push(daemon); const daemonPid = daemon.pid;
    daemon.kill("SIGKILL"); await daemon.exited; children.splice(children.indexOf(daemon), 1);

    const after = await client.request("ping", {});
    expect(after.body.pid).toBe(runner.pid);
    expect(after.body.pid).not.toBe(daemonPid);
    expect(after.body.activeRuns).toContain("survive-daemon");
    client.close();
  });
});
