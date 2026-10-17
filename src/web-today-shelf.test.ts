// 今天页的助理货架卡片与「一键排查」按钮：切出 today.js 里纯 HTML 生成那一段，
// 连同 app.js 的 esc/jsq/ageText 一起当函数体跑起来取符号（同 web-today-stage.test.ts）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const today = readFileSync(join(import.meta.dir, "..", "web", "today.js"), "utf8");
const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "style.css"), "utf8");
const block = today.slice(today.indexOf("/* ---- 助理货架 / 一键排查："), today.indexOf("/* ---- 助理货架 / 一键排查 end ---- */"));
const helpers = ["const esc =", "const jsq =", "function ageText("].map((head) => {
  const start = app.indexOf(head);
  return app.slice(start, app.indexOf("\n", head.startsWith("function") ? app.indexOf("\n}", start) + 1 : start));
}).join("\n");

const { tdShelfHtml, tdInvestigable, tdInvestigateBtn } = new Function(
  `${helpers}\n${block}\nreturn { tdShelfHtml, tdInvestigable, tdInvestigateBtn };`,
)() as Record<string, (...args: any[]) => any>;

const item = (extra: any = {}) => ({ id: "abc123", category: "risk", title: "CI <连挂>", detail: "main 连续失败", createdAt: new Date().toISOString(), expiresAt: "", ...extra });
const action = (extra: any = {}) => ({ id: "a'1", kind: "decide", source: "github", title: "t", reason: "r", state: "open", ref: {}, ...extra });

describe("tdShelfHtml", () => {
  test("类别配色、转义、采纳/忽略按钮", () => {
    const html = tdShelfHtml([item({ actionSuggestion: { kind: "task", label: "派 <排查>", prompt: "p" } })]);
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain("风险");
    expect(html).toContain("CI &lt;连挂&gt;");
    expect(html).toContain("main 连续失败");
    expect(html).toContain("tdShelfAdopt('abc123', this)");
    expect(html).toContain("采纳: 派 &lt;排查&gt;");
    expect(html).toContain("tdShelfDismiss('abc123')");
  });
  test("没有建议只给忽略；suggestion=accent、pattern=ok", () => {
    const html = tdShelfHtml([item({ category: "suggestion" }), item({ id: "p", category: "pattern" })]);
    expect(html).not.toContain("采纳");
    expect(html).toContain('data-tone="accent"');
    expect(html).toContain('data-tone="ok"');
    expect(html.match(/忽略/g)).toHaveLength(2);
  });
  test("空列表不画任何东西", () => {
    expect(tdShelfHtml([])).toBe("");
  });
});

describe("一键排查", () => {
  test("follow_up / 标题原因含 CI·失败·crash 才算；审核类和货架开的不算", () => {
    expect(tdInvestigable(action({ kind: "review" }))).toBeFalse();   // 审核是人的活，没有根因可查
    expect(tdInvestigable(action({ kind: "review", title: "Prod Deploy CI 失败" }))).toBeTrue();
    expect(tdInvestigable(action({ kind: "follow_up", source: "assistant" }))).toBeFalse();
    expect(tdInvestigable(action({ kind: "review", source: "assistant", title: "集中审核项目记忆候选（43 条）", reason: "已挂 18.6h" }))).toBeFalse();
    expect(tdInvestigable(action({ kind: "follow_up" }))).toBeTrue();
    expect(tdInvestigable(action({ title: "CI 挂了" }))).toBeTrue();
    expect(tdInvestigable(action({ reason: "部署失败" }))).toBeTrue();
    expect(tdInvestigable(action({ reason: "App Crash on launch" }))).toBeTrue();
    expect(tdInvestigable(action({ title: "Decide on special pricing" }))).toBeFalse();   // 别把单词里的 ci 当 CI
    expect(tdInvestigable(action({ kind: "reply" }))).toBeFalse();
  });
  test("没任务给「一键排查」；排查派的任务叫「查看排查任务」；别处挂的任务仍叫「查看任务」", () => {
    expect(tdInvestigateBtn(action({ title: "CI 失败" }))).toContain("tdInvestigate('a\\'1', this)");
    expect(tdInvestigateBtn(action({ kind: "follow_up", ref: { task_id: "T1", investigated_at: "x" } }))).toContain("查看排查任务");
    const other = tdInvestigateBtn(action({ kind: "follow_up", ref: { task_id: "T1" } }));
    expect(other).toContain("查看任务");
    expect(other).not.toContain("排查");
    expect(tdInvestigateBtn(action({ kind: "reply" }))).toBe("");
  });
});

test("样式就位", () => {
  expect(css).toContain(".today-shelf");
});
