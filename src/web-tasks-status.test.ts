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

  test("recent snapshots stay on the slow auxiliary cadence", () => {
    const timer = source.slice(source.indexOf("Tasks.timer = setInterval"), source.indexOf("hide() { clearInterval"));
    expect(timer).not.toContain("refreshRecentSessions();");
    expect(timer).toContain("}, 10000)");
    expect(timer).toContain("if (++Tasks.auxTick % 6 === 0) loadTasksAux().then(renderTaskList)");
    expect(source).toContain('getJSON("/api/dev/recent")');
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

// 2026-10-17：没选 bypass 派出去的 claude 会话在会话里放不开——沙箱开关只给 codex，「总是（全局）」也只记一类命令
const approveAllBody = source.slice(source.indexOf("function canApproveAll("), source.indexOf("function rememberScope("));
const canApproveAllWith = (S: any) => new Function("S", `${approveAllBody}\nreturn canApproveAll;`)(S) as (dev: any) => boolean;
const scopeBody = source.slice(source.indexOf("function rememberScope("), source.indexOf("async function devInterrupt("));
const rememberScope = new Function(`${scopeBody}\nreturn rememberScope;`)() as (perm: any) => string;

describe("会话里切「全部放行」", () => {
  test("只有 claude/codebuddy 的 Runner 会话有开关；放开要 allowFullAccess，已放开的总能切回", () => {
    const allowed = canApproveAllWith({ state: { allowFullAccess: true } }), locked = canApproveAllWith({ state: { allowFullAccess: false } });
    expect(allowed({ providerId: "claude", operability: "active" })).toBe(true);
    expect(allowed({ providerId: "codebuddy", operability: "active" })).toBe(true);
    expect(allowed({ providerId: "codex", operability: "active" })).toBe(false);   // codex 走沙箱开关
    expect(allowed({ providerId: "claude" })).toBe(false);                          // legacy 会话没有 operability，不支持热切换
    expect(allowed({ providerId: "claude", operability: "read-only" })).toBe(false);
    expect(locked({ providerId: "claude", operability: "active" })).toBe(false);
    expect(locked({ providerId: "claude", operability: "active", fullAccess: true })).toBe(true);
  });

  test("审批卡说清「总是」记住的是哪一类", () => {
    expect(rememberScope({ remember: { kind: "bash", pattern: "cd" } })).toBe("「cd」这类命令");
    expect(rememberScope({ remember: { kind: "tool", pattern: "WebFetch" } })).toBe("WebFetch 工具");
    expect(rememberScope({ remember: { kind: "bash", pattern: "B=https://raw.githubusercontent.com/example/project/master;" } })).toBe("「B=https://raw.githubusercontent.…」这类命令");
    expect(rememberScope({ toolName: "Bash" })).toBe("");   // 老 daemon 不带 remember：不画提示
  });

  test("审批卡与会话头都接上了全部放行", () => {
    const card = source.slice(source.indexOf("const perms = (dev.pending || []).map("), source.indexOf("// AskUserQuestion：真选项按钮"));
    expect(card).toContain("canApproveAll(dev) && !dev.fullAccess");
    expect(card).toContain("devSetAccess('${esc(t.id)}',true,'${esc(dev.providerId)}')");
    const head = source.slice(source.indexOf("function detailHead("), source.indexOf("function ctxWindowOf("));
    expect(head).toContain("canApproveAll(dev)");
    expect(head).toContain("⚡ 全部放行");
  });
});
