import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerServer } from "./server.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Runner health CLI control snapshots", () => {
  test("quiesce/resume return complete ping schema with the resulting drain state", async () => {
    const data = mkdtempSync(join(tmpdir(), "ownward-health-cli-")); roots.push(data);
    const server = new RunnerServer(data, () => { throw new Error("unused"); }); server.start();
    try {
      const invoke = async (flag: string) => { const proc = Bun.spawn([process.execPath, join(import.meta.dir, "health.ts"), flag], { env: { ...process.env, OWNWARD_DATA_ROOT: data }, stdout: "pipe", stderr: "pipe" }); const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); return { exitCode, stdout, stderr }; };
      const quiesce = await invoke("--quiesce"); expect(quiesce.exitCode, quiesce.stderr).toBe(0); const q = JSON.parse(quiesce.stdout); expect(q).toMatchObject({ ok: true, pid: process.pid, draining: true, activeRuns: [], runnerApiVersion: 1 }); expect(q.capabilities).toContain("resume");expect(q.buildIdentity).toMatch(/^[a-f0-9]{64}$/);
      const resume = await invoke("--resume"); expect(resume.exitCode, resume.stderr).toBe(0); const r = JSON.parse(resume.stdout); expect(r).toMatchObject({ ok: true, pid: process.pid, draining: false, activeRuns: [], runnerApiVersion: 1 });
    } finally { server.stop(); }
  });
});
