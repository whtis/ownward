// 今天页的「本周目标」卡与「领域管家」头像条：切出 today.js 纯 HTML 生成那一段，
// 连同 app.js 的 esc/jsq 一起当函数体跑起来取符号（同 web-today-shelf.test.ts）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const today = readFileSync(join(import.meta.dir, "..", "web", "today.js"), "utf8");
const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "style.css"), "utf8");
const block = today.slice(today.indexOf("/* ---- 本周目标 / 领域管家："), today.indexOf("/* ---- 本周目标 / 领域管家 end ---- */"));
const helpers = ["const esc =", "const jsq ="].map((head) => {
  const start = app.indexOf(head);
  return app.slice(start, app.indexOf("\n", start));
}).join("\n");

const load = (prelude = "") => new Function(
  `${helpers}\n${prelude}\n${block}\nreturn { tdGoalsHtml, tdGoalsWeek, tdStewardsHtml };`,
)() as Record<string, (...args: any[]) => any>;
const { tdGoalsHtml, tdGoalsWeek, tdStewardsHtml } = load();

const summary = {
  week: "2026-W42",
  goals: [
    { id: "g-aaaa1111", text: "上线 <目标> 卡片", done: false, project: "own'ward" },
    { id: "g-bbbb2222", text: "写周报", done: true },
  ],
};
const steward = (extra: any = {}) => ({ id: "app", name: "App <Owner>", icon: "code", type: "project", presence: "normal", summary: "代码分支干净 · 暂无阻塞", runningTaskCount: 0, openActionCount: 0, ...extra });

describe("本周目标卡", () => {
  test("复选框带勾选态、调 tdGoalToggle；文本与项目标签转义", () => {
    const html = tdGoalsHtml(summary);
    expect(html).toContain("tdGoalToggle('g-aaaa1111', this.checked, this)");
    expect(html).toContain("上线 &lt;目标&gt; 卡片");
    expect(html).toContain(`<span class="tag">own'ward</span>`);   // esc 不转单引号；属性外的文本节点里无害
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/ checked /g)).toHaveLength(1);
    expect(html).toContain('data-done="true"');
  });
  test("周标签带完成数；没有周就只给完成数", () => {
    expect(tdGoalsWeek(summary)).toBe("2026-W42 · 已完成 1/2");
    expect(tdGoalsWeek({ week: "", goals: summary.goals })).toBe("已完成 1/2");
  });
  test("没目标不画", () => {
    expect(tdGoalsHtml({ week: "", goals: [] })).toBe("");
    expect(tdGoalsHtml(null)).toBe("");
  });
});

describe("领域管家头像条", () => {
  test("presence 写进 data-presence、中文状态与摘要、点头像派任务", () => {
    const html = tdStewardsHtml([steward(), steward({ id: "o'k", presence: "busy", summary: "1 个任务进行中" }), steward({ id: "c", presence: "attention" })]);
    expect(html).toContain('data-presence="normal"');
    expect(html).toContain('data-presence="busy"');
    expect(html).toContain('data-presence="attention"');
    expect(html).toContain("tdStewardOpen('o\\'k')");
    expect(html).toContain("App &lt;Owner&gt;");
    expect(html).toContain("1 个任务进行中");
    expect(html).toContain('aria-label="工作中"');
    expect(html).toContain('aria-label="需关注"');
    expect(html).toContain('aria-label="在岗"');
  });
  test("未知 presence 当 normal；有 roleIconSvg 就用角色图标", () => {
    const { tdStewardsHtml: withIcon } = load(`function roleIconSvg(n) { return "<svg data-icon=" + n + "></svg>"; }`);
    const html = withIcon([steward({ presence: "weird" })]);
    expect(html).toContain('data-presence="normal"');
    expect(html).toContain("<svg data-icon=code></svg>");
  });
  test("空列表不画", () => {
    expect(tdStewardsHtml([])).toBe("");
  });
});

test("加载与挂载点就位", () => {
  expect(today).toContain('getJSON("/api/goals")');
  expect(today).toContain('getJSON("/api/roles/stewards")');
  expect(today).toContain('id="td-goals"');
  expect(today).toContain('id="td-stewards"');
  expect(today).toContain("🎯 本周长效目标 (Active Goals)");
  expect(css).toContain(".today-stewards");
  expect(css).toContain('.steward-card[data-presence="busy"] .presence-dot');
  expect(css).toContain(".goal-row");
});
