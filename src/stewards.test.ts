import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Action } from "./actions.ts";
import type { WorkTask } from "./dispatch.ts";
import { useVaultForTest, type Role } from "./roles.ts";
import { listStewards, stewardSummary, type StewardDeps } from "./stewards.ts";

const role = (id: string, extra: Partial<Role> = {}): Role => ({
  id, name: id.toUpperCase(), description: "", icon: "code", color: "", projects: [id], instructions: "",
  type: "project", parentRoleId: "", primaryProject: id, dirs: [], origin: "auto", history: [],
  status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", scope: "", ...extra,
});
const task = (id: string, extra: Partial<WorkTask> = {}): WorkTask => ({
  id, project: "x", projectDir: "/x", cwd: "/x", task: "t", mode: "claude-bg", startedAt: "", status: "running", ...extra,
});
const action = (id: string, extra: Partial<Action> = {}): Action => ({
  id, kind: "follow_up", source: "github", title: "t", reason: "r", state: "open", createdAt: "", updatedAt: "", ref: {}, ...extra,
});
const deps = (d: Partial<StewardDeps>): StewardDeps => ({
  roles: () => [], tasks: () => [], actions: () => [], gitStatus: async () => null, daysSinceLog: () => undefined, ...d,
});

const cleanup: string[] = [];
afterEach(() => {
  useVaultForTest(null);
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ownward-stewards-")); cleanup.push(d); return d; };

describe("listStewards", () => {
  test("presence：busy > attention > normal，并按此排序", async () => {
    const list = await listStewards(deps({
      roles: () => [role("calm"), role("dirty"), role("runner")],
      tasks: () => [task("T1", { roleId: "runner" })],
      actions: () => [action("github:pr:dirty:12")],
    }));
    expect(list.map((s) => [s.id, s.presence])).toEqual([["runner", "busy"], ["dirty", "attention"], ["calm", "normal"]]);
    expect(list[0]).toMatchObject({ runningTaskCount: 1, openActionCount: 0, summary: "1 个任务进行中", origin: "auto", type: "project", primaryProject: "runner", icon: "code" });
    expect(list[1]).toMatchObject({ openActionCount: 1, summary: "1 件待办行动" });
    expect(list[2].summary).toBe("暂无阻塞");
  });

  test("busy 盖过 attention：同时有待办和脏工作区仍是工作中，摘要全列", async () => {
    const dir = tmp();
    const [s] = await listStewards(deps({
      roles: () => [role("app", { dirs: [dir] })],
      tasks: () => [task("T1", { project: "App" })],          // 未绑角色：按项目名（大小写不敏感）归属
      actions: () => [action("a1", { ref: { url: "https://github.com/org/app/pull/3" } })],
      gitStatus: async () => ({ changes: 2 }),
    }));
    expect(s.presence).toBe("busy");
    expect(s.gitDirty).toBeTrue();
    expect(s.summary).toBe("1 个任务进行中 · 1 件待办行动 · 2 个未提交改动");
  });

  test("任务绑了别的角色就不按项目二次归属；adopted / 已结束的不算", async () => {
    const [s] = await listStewards(deps({
      roles: () => [role("app")],
      tasks: () => [
        task("T1", { project: "app", roleId: "lead-x" }),
        task("T2", { project: "app", kind: "adopted" }),
        task("T3", { project: "app", status: "exited" }),
      ],
    }));
    expect(s.runningTaskCount).toBe(0);
    expect(s.presence).toBe("normal");
  });

  test("行动项归属：经 task_id 找到任务的角色；只算 open；不相干的不算", async () => {
    const list = await listStewards(deps({
      roles: () => [role("app"), role("web")],
      tasks: () => [task("T9", { roleId: "web", status: "exited" })],
      actions: () => [
        action("evolve:T9", { ref: { task_id: "T9" } }),
        action("github:app:1", { state: "snoozed" }),
        action("lark:chat:zzz"),
      ],
    }));
    const by = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(by.web.openActionCount).toBe(1);
    expect(by.app.openActionCount).toBe(0);
  });

  test("git 干净 → 「代码分支干净 · 暂无阻塞」；主目录不存在就不查 git", async () => {
    const dir = tmp(), calls: string[] = [];
    const list = await listStewards(deps({
      roles: () => [role("clean", { dirs: [dir] }), role("gone", { dirs: [join(dir, "missing")] })],
      gitStatus: async (d) => { calls.push(d); return { changes: 0 }; },
    }));
    expect(calls).toEqual([dir]);
    const by = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(by.clean).toMatchObject({ gitDirty: false, presence: "normal", summary: "代码分支干净 · 暂无阻塞" });
    expect(by.gone).not.toHaveProperty("gitDirty");
  });

  test("工作日志超过 5 天 → attention；正好 5 天不算", async () => {
    const list = await listStewards(deps({
      roles: () => [role("stale"), role("fresh")],
      daysSinceLog: (r) => (r.id === "stale" ? 9 : 5),
    }));
    const by = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(by.stale).toMatchObject({ presence: "attention", daysSinceLog: 9, summary: "9 天没有工作日志" });
    expect(by.fresh).toMatchObject({ presence: "normal", daysSinceLog: 5 });
  });

  test("归档角色不出现；origin 空串 = manual；lead 没有 primaryProject 字段", async () => {
    const list = await listStewards(deps({
      roles: () => [role("old", { status: "archived" }), role("boss", { type: "lead", origin: "", primaryProject: "", projects: [] })],
    }));
    expect(list.map((s) => s.id)).toEqual(["boss"]);
    expect(list[0]).toMatchObject({ type: "lead", origin: "manual" });
    expect(list[0]).not.toHaveProperty("primaryProject");
  });

  test("默认实现：读 vault 项目 log/ 的 mtime、对主目录跑真实 git status", async () => {
    const vault = tmp(), repo = tmp();
    useVaultForTest(vault);
    const logDir = join(vault, "projects", "app", "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "2026-09.md"), "x");
    const old = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(join(logDir, "2026-09.md"), old, old);
    writeFileSync(join(logDir, "notes.md"), "不是月度日志，不参与");
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "x");

    const [s] = await listStewards({ roles: () => [role("app", { dirs: [repo] })], tasks: () => [], actions: () => [] });
    expect(s.daysSinceLog).toBe(8);
    expect(s.gitDirty).toBeTrue();
    expect(s.presence).toBe("attention");
    expect(s.summary).toBe("1 个未提交改动 · 8 天没有工作日志");
  });
});

test("stewardSummary：git 未知时不说「代码分支干净」", () => {
  expect(stewardSummary({ runningTaskCount: 0, openActionCount: 0 })).toBe("暂无阻塞");
  expect(stewardSummary({ runningTaskCount: 0, openActionCount: 0, gitDirty: false })).toBe("代码分支干净 · 暂无阻塞");
});
