import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireRunnerInstanceLock, RUNNER_INSTANCE_LOCK_GRACE_MS, runnerBootId } from "./instance-lock.ts";

const roots: string[] = [], root = () => { const r = mkdtempSync(join(tmpdir(), "ownward-instance-lock-")); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture(r: string, content: string) { const lock = join(r, "runner", ".instance-lock"); mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner.json"), content); return lock; }

describe("Runner instance lock recovery", () => {
  test("半写 owner 在 grace 内绝不抢占", () => { const r = root(); fixture(r, "{"); expect(() => acquireRunnerInstanceLock(r)).toThrow("正在初始化"); });
  test("同 bootId 的活 pid 即使 owner 很旧也拒绝，防 pid reuse 误判", () => { const r = root(), lock = fixture(r, JSON.stringify({ pid: process.pid, token: "live", at: 1, bootId: runnerBootId() })); utimesSync(lock, new Date(0), new Date(0)); expect(() => acquireRunnerInstanceLock(r)).toThrow("已由 pid"); });
  test("bootId 变化且过 grace 可原子回收", () => { const r = root(), lock = fixture(r, JSON.stringify({ pid: process.pid, token: "old", at: 1, bootId: "previous-boot" })); const old = new Date(Date.now() - RUNNER_INSTANCE_LOCK_GRACE_MS - 100); utimesSync(lock, old, old); const acquired = acquireRunnerInstanceLock(r); acquired.release(); });
});
