import { expect, test } from "bun:test";
import { createScopedActions, type ActionScopePort } from "./action-scope.ts";

function fixture() {
  const rows = [
    { id: "github:one", source: "github", kind: "review", title: "PR 一号", reason: "有新评审", state: "open" as const, createdAt: "2026-08-21T00:00:00Z", ref: { url: "https://github.test/o/r/pull/1" }, secret: "hidden" },
    { id: "evolve:one", source: "evolve", kind: "approve", title: "演进", reason: "待上线", state: "open" as const, createdAt: "2026-08-21T00:00:00Z", ref: { task_id: "task" }, secret: "hidden" },
  ];
  const calls: string[] = [];
  const port: ActionScopePort = {
    list: () => rows,
    open: (action) => { calls.push(`open:${action.id}:${action.source}`); rows.push({ ...action, state: "open", createdAt: "2026-08-21T00:00:01Z", secret: "n/a" } as any); },
    resolveExact: (id, resolution) => { calls.push(`${id}:${resolution}`); return true; },
    setState: (id, state) => { calls.push(`set:${id}:${state}`); return true; },
  };
  return { rows, calls, port };
}

test("scoped Action Service filters source, clones full DTO, and resolves exact authorized ids only", () => {
  const { calls, port } = fixture();
  const actions = createScopedActions(["github"], port, "github");
  expect(actions.list()).toEqual([{ id: "github:one", source: "github", kind: "review", title: "PR 一号", reason: "有新评审", state: "open", createdAt: "2026-08-21T00:00:00Z", ref: { url: "https://github.test/o/r/pull/1" } }]);
  expect(actions.resolve("github", "ignored")).toBeFalse();
  expect(actions.resolve("evolve:one", "ignored")).toBeFalse();
  expect(actions.resolve("github:one", "ignored")).toBeTrue();
  expect(calls).toEqual(["github:one:ignored"]);
});

test("open 强制属主 source 与 id 前缀；dismiss 只碰本 scope", () => {
  const { calls, port } = fixture();
  const actions = createScopedActions(["desk"], port, "desk");
  // 伪造他源前缀 / 非法 kind / 空 title 全拒
  expect(actions.open({ id: "github:sneak", kind: "review", title: "x", reason: "y" })).toBeFalse();
  expect(actions.open({ id: "desk:a", kind: "hack" as any, title: "x", reason: "y" })).toBeFalse();
  expect(actions.open({ id: "desk:a", kind: "decide", title: "", reason: "y" })).toBeFalse();
  expect(calls).toEqual([]);
  expect(actions.open({ id: "desk:a", kind: "decide", title: "标题", reason: "理由", ref: { note: "n" } })).toBeTrue();
  expect(calls).toEqual(["open:desk:a:desk"]);
  // dismiss：他源拒、本源放行
  expect(actions.dismiss("github:one")).toBeFalse();
  expect(actions.dismiss("desk:a")).toBeTrue();
  expect(calls.at(-1)).toBe("set:desk:a:dismissed");
});
