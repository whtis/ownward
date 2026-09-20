import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { isWorkbenchActive, markPresence, presenceState, resetPresence, DEFAULT_ACTIVE_WINDOW_MS } from "./presence.ts";

describe("工作台前台状态", () => {
  test("上报后进入前台态，过窗口自动过期（客户端失焦就不再上报）", () => {
    resetPresence();
    expect(isWorkbenchActive()).toBe(false);
    const t = Date.now();
    markPresence("web", t);
    expect(isWorkbenchActive(t + 1_000)).toBe(true);
    expect(isWorkbenchActive(t + DEFAULT_ACTIVE_WINDOW_MS + 1)).toBe(false);
    expect(presenceState(t + 1_000)).toMatchObject({ active: true, client: "web" });
    resetPresence();
  });
});

describe("前后端接线", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const workbench = readFileSync(new URL("./workbench.ts", import.meta.url), "utf8");

  test("聚焦且最近有人操作才上报：锁屏/离开时不能算在场，否则飞书兜底失效", () => {
    expect(app).toContain("document.hasFocus() && !document.hidden");
    expect(app).toContain("Date.now() - lastInteractionAt < PRESENCE_IDLE_MS");
    expect(app).toContain('post("/api/presence", { client: "web" })');
    expect(app).toContain("setInterval(pingPresence, 30000)");
  });

  test("服务端有对应路由", () => {
    expect(workbench).toContain('p === "/api/presence"');
    expect(workbench).toContain("markPresence");
  });
});

describe("压制规则的例外", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

  test("会议提醒和止损不受静默时段影响——错过这次就没有下次", () => {
    expect(read("./calendar.ts")).toContain("quietExempt: true");
    expect(read("./strategy/scan.ts")).toContain("quietExempt: true");
  });

  test("手动自测强推，且如实回报有没有真发出去", () => {
    expect(read("./server.ts")).toContain("force: true");
    expect(read("./server.ts")).toContain("通道都没发出去");
    expect(read("./notify.ts")).toContain('notify(text, { source: "system", level: "act", force: true })');
  });

  test("同一任务的不同审批各推各的（冷却键带 requestId）", () => {
    expect(read("./agent-session.ts")).toContain("key: `approval:${s.taskId}:${requestId}`");
    expect(read("./kernel/sessions/approval-sweep.ts")).toContain("key: `approval:${taskId}:${p.requestId}`");
  });
});

describe("通知级别接线", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

  test("任务跑完只留 feed/横幅，失败才进飞书并带上处理入口", () => {
    const daemon = read("./daemon.ts");
    expect(daemon).toContain('{ source: "dispatch", level: "fyi", key: `task-end:${t.id}` }');
    expect(daemon).toContain("key: `task-fail:${t.id}`");
    expect(daemon).toContain('text: "打开任务"');
  });

  test("会议提醒不再被 larkSkipSources 吞掉，且带入会按钮", () => {
    const cal = read("./calendar.ts");
    expect(cal).toContain('source: "calendar"');
    expect(cal).toContain('text: "入会"');
    expect(cal).not.toContain('{ source: "lark", link: m.meetingUrl');
  });

  test("飞书卡片没有按钮时不发空 action 元素（飞书会拒整张卡）", () => {
    expect(read("./lark-cards.ts")).toContain("...(actions.length ? [{ tag: \"action\", actions }] : [])");
  });
});
