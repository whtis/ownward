import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CrashGuard, nextBootState, type BootState } from "./crash-guard.ts";

function state(n: number[], healthy = false): BootState {
  return { schemaVersion: 1, generation: "old", pid: 1, startedAt: 1, healthy, unexpectedFailures: n };
}

describe("crash guard", () => {
  test("主动重启清零且不把上一代计为 crash", () => {
    const d = nextBootState(state([10, 20, 30]), 40, 2, "new", true, 120, 4);
    expect(d.previousCounted).toBe(false);
    expect(d.state.unexpectedFailures).toEqual([]);
    expect(d.shouldRollback).toBe(false);
  });

  test("healthy 上一代不计 crash", () => {
    expect(nextBootState(state([10], true), 40, 2, "new", false).state.unexpectedFailures).toEqual([10]);
  });

  test("刚 healthy 就短命仍计 crash，稳定超过观察窗后的偶发退出不计", () => {
    const recent = { ...state([10], true), healthyAt: 100 };
    expect(nextBootState(recent, 150, 2, "new", false, 120).previousCounted).toBe(true);
    const stable = { ...state([10], true), healthyAt: 100 };
    expect(nextBootState(stable, 221, 2, "new", false, 120).previousCounted).toBe(false);
  });

  test("四次未 healthy 的意外死亡才触发", () => {
    let s: BootState | null = null;
    let decision;
    for (let i = 0; i < 5; i++) {
      decision = nextBootState(s, 1000 + i, i + 1, `g${i}`, false);
      s = decision.state;
      expect(decision.shouldRollback).toBe(i === 4);
    }
  });

  test("ready 只标记当前 generation", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-crash-"));
    const guard = new CrashGuard(root);
    guard.begin(false, 1, 2, "g1");
    expect(guard.markHealthy("stale")).toBe(false);
    expect(guard.markHealthy("g1")).toBe(true);
    expect(guard.begin(false, 2, 3, "g2").previousCounted).toBe(false);
  });

  test("有效 rollback lease 抑制重复，过期后可重试", () => {
    const previous = { ...state([1, 2, 3, 4]), rollbackRequestedAt: 5 };
    const next = nextBootState(previous, 5, 2, "new", false, 120, 4);
    expect(next.shouldRollback).toBe(false);
    expect(next.state.rollbackRequestedAt).toBe(5);
    expect(nextBootState(next.state, 6, 3, "newer", false, 120, 4).shouldRollback).toBe(false);
    expect(nextBootState(next.state, 126, 3, "retry", false, 1_000, 4, 120).shouldRollback).toBe(true);
  });

  test("helper 派发失败未建立 lease，下一代仍会重试 rollback", () => {
    const previous = state([1, 2, 3, 4]);
    const failedDispatch = nextBootState(previous, 5, 2, "new", false, 120, 4);
    expect(failedDispatch.shouldRollback).toBe(true);
    // 没调用 markRollbackRequested，就没有租约；模拟下一代启动仍应派发。
    expect(nextBootState(failedDispatch.state, 6, 3, "retry", false, 120, 4).shouldRollback).toBe(true);
  });
});
