// tasks.js 是浏览器普通脚本；截取纯状态函数执行，避免伪造整套 DOM。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "..", "web", "tasks.js"), "utf8");
const body = source.slice(source.indexOf("function sessionState("), source.indexOf("function tabsSave("));
const runtime = { selKind: "task", sel: null as string | null, dev: null as any };
const sessionState = new Function("Tasks", `${body}\nreturn sessionState;`)(runtime) as (kind: string, item: any) => any;
const handoffBody = source.slice(source.indexOf("function handoffState("), source.indexOf("function tabsSave("));
const handoffState = new Function(`${handoffBody}\nreturn handoffState;`)() as (dev: any) => { disabled: boolean; reason: string };
const errorCodeBody = source.slice(source.indexOf("function handoffErrorCode("), source.indexOf("function tabsSave("));
const handoffErrorCode = new Function(`${errorCodeBody}\nreturn handoffErrorCode;`)() as (result: any) => string;

describe("task session status badges", () => {
  test("pending has priority over uncertain, running and failure", () => {
    expect(sessionState("task", { id: "t", status: "exited", exitCode: 1, uncertain: true, runnerState: { pending: [{ toolName: "AskUserQuestion" }] } })).toMatchObject({ key: "pending", label: "待答复" });
  });

  test("selected session uses live pending before the list snapshot", () => {
    runtime.sel = "t"; runtime.dev = { pending: [{ toolName: "Bash" }], turn: "idle" };
    expect(sessionState("task", { id: "t", status: "done", runnerState: { pending: [] } }).key).toBe("pending");
    runtime.sel = null; runtime.dev = null;
  });

  test("maps uncertain, running, failed and completed states", () => {
    expect(sessionState("task", { uncertain: true, status: "running" }).key).toBe("uncertain");
    expect(sessionState("task", { status: "running" }).key).toBe("running");
    expect(sessionState("task", { status: "exited", exitCode: 2 }).key).toBe("failed");
    expect(sessionState("task", { status: "done" }).key).toBe("done");
    expect(sessionState("task", { status: "exited", exitCode: 0 }).key).toBe("done");
  });

  test("missing or incomplete data is never called completed", () => {
    expect(sessionState("task", null)).toBeNull();
    expect(sessionState("task", { status: "exited" }).key).toBe("uncertain");
    expect(sessionState("task", {})).toBeNull();
  });

  test("inactive external sessions have no badge", () => {
    expect(sessionState("cc", { active: false })).toBeNull();
    expect(sessionState("cc", { active: true }).key).toBe("running");
  });

  test("recent snapshots refresh on the detail cadence with a re-entry guard", () => {
    const timer = source.slice(source.indexOf("Tasks.timer = setInterval"), source.indexOf("hide() { clearInterval"));
    expect(timer).toContain("refreshRecentSessions();");
    expect(timer).toContain("}, 2500)");
    expect(source).toContain("if (Tasks.recentBusy) return;");
  });
});

describe("task provider handoff", () => {
  test("allows an idle Ownward-controlled session", () => {
    expect(handoffState({ turn: "idle", pending: [], queued: [], control: "ownward" })).toEqual({ disabled: false, reason: "" });
  });

  test("blocks unsafe handoff states with an explanation", () => {
    expect(handoffState({ turn: "running" }).reason).toContain("运行中");
    expect(handoffState({ turn: "idle", pending: [{}] }).reason).toContain("待答复");
    expect(handoffState({ turn: "idle", pending: [], queued: [{}] }).reason).toContain("排队");
    expect(handoffState({ turn: "idle", pending: [], queued: [], control: "observing" }).reason).toContain("输入权");
  });

  test("renders provider identity and handoff events from the live session", () => {
    expect(source).toContain("dev?.backend || dev?.providerId || t.mode");
    expect(source).toContain('m.role === "system" && m.name === "handoff"');
    expect(source).toContain('model: model || undefined, effort: effort || undefined');
    expect(source).toContain('post("/api/dev/handoff", payload)');
    expect(source).toContain('"manual-reconfigure" : "manual-handoff"');
  });

  test("unknown outcomes require a second explicit confirmation without replay", () => {
    expect(handoffErrorCode({ errorCode: "SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED" })).toBe("SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED");
    expect(handoffErrorCode({ code: "fallback" })).toBe("fallback");
    expect(source).toContain("confirmUnknownOutcome: true");
    expect(source).toContain("系统不会重放旧命令");
  });

  test("all handoff exits restore the disabled control", () => {
    const fn = source.slice(source.indexOf("async function submitSessionConfig("), source.indexOf("function tabsSave("));
    expect(fn).toContain("} finally {");
    expect(fn).toContain("control.disabled = false;");
    expect(fn).toContain("配置已应用，但刷新失败");
  });
});
