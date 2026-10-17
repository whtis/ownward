// 周期职责卡的退出入口：逾期/失败/待审的卡要能直接在卡上跳过或标已填写，
// 区头有「跳过全部逾期」——原先失败卡只能重试，过去几天的卡永远卡在今日页。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const today = readFileSync(join(import.meta.dir, "..", "web", "today.js"), "utf8");
const block = today.slice(today.indexOf("const routineOverdueCount"), today.indexOf("async function genRoutine("));

function harness() {
  const calls: any[] = [], toasts: string[] = [];
  let reloads = 0;
  const jsq = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const post = async (path: string, body: any) => {
    calls.push({ path, body });
    return path.endsWith("skip-overdue") ? { ok: true, count: 2, msg: "已跳过 2 项逾期职责" } : { ok: true, msg: "ok:" + path };
  };
  const api = Function("jsq", "post", "toast", "loadToday",
    `${block}; return { routinesHeadHtml, routineExitHtml, skipRoutineOcc, markRoutineWrittenOcc, skipAllOverdueRoutines };`,
  )(jsq, post, (m: string) => toasts.push(m), () => { reloads++; });
  return { api, calls, toasts, reloads: () => reloads };
}

const card = (over: any) => ({ id: "daily", name: "日报", date: "2026-10-12", time: "18:00", isToday: false, overdue: false, status: "upcoming", ...over });

describe("routine 卡退出入口", () => {
  test("逾期 / 失败 / 待审：给 [跳过] 和更多菜单（跳过本次交付、标为已手动填写）", () => {
    const { api } = harness();
    for (const r of [card({ overdue: true, status: "draft" }), card({ isToday: true, status: "failed" }), card({ isToday: true, status: "draft", date: "2026-10-15" })]) {
      const html = api.routineExitHtml(r);
      expect(html).toContain(`<button class="button sm ghost" onclick="skipRoutineOcc('daily','${r.date}')">跳过</button>`);
      expect(html).toContain('<details class="more">');
      expect(html).toContain(`<button onclick="skipRoutineOcc('daily','${r.date}')">跳过本次交付</button>`);
      expect(html).toContain(`<button onclick="markRoutineWrittenOcc('daily','${r.date}')">标为已手动填写</button>`);
      expect(html).toContain('<span style="flex:1"></span>');       // 右对齐
    }
  });

  test("待生成 / 写入中 / 已收尾 / 未到期的卡不给退出入口", () => {
    const { api } = harness();
    for (const status of ["pending", "writing", "written", "skipped", "upcoming"]) expect(api.routineExitHtml(card({ isToday: true, status }))).toBe("");
    expect(api.routineExitHtml(card({ overdue: true, status: "writing" }))).toBe("");   // 写入任务还在跑
  });

  test("id/date 里的引号被转义，拼不出 onclick 注入", () => {
    const { api } = harness();
    expect(api.routineExitHtml(card({ id: "a'b", overdue: true, status: "draft" }))).toContain("skipRoutineOcc('a\\'b','2026-10-12')");
  });

  test("区头：有逾期/失败才出「跳过全部逾期 (n)」，写入中不计数", () => {
    const { api } = harness();
    expect(api.routinesHeadHtml([])).toBe("");
    expect(api.routinesHeadHtml([card({ isToday: true, status: "pending" }), card({ overdue: true, status: "writing" })])).toBe("");
    const html = api.routinesHeadHtml([card({ overdue: true, status: "draft" }), card({ overdue: true, status: "failed" }), card({ isToday: true, status: "failed" }), card({ overdue: true, status: "writing" })]);
    expect(html).toBe('<button class="button sm ghost" onclick="skipAllOverdueRoutines()">跳过全部逾期 (3)</button>');
  });

  test("渲染接线：卡片 foot 挂退出入口、区头有容器", () => {
    expect(today).toContain('<div id="td-routines-head"></div>');
    expect(today).toContain('$("#td-routines-head").innerHTML = routinesHeadHtml(');
    expect(today).toMatch(/<div class="foot">\$\{act\}.*\$\{routineExitHtml\(r\)\}<\/div>/);
  });
});

describe("routine 退出动作", () => {
  test("跳过 / 标已填写 / 一键跳过全部逾期：调对端点、toast、刷新今日页", async () => {
    const h = harness();
    await h.api.skipRoutineOcc("daily", "2026-10-12");
    await h.api.markRoutineWrittenOcc("daily", "2026-10-09");
    await h.api.skipAllOverdueRoutines();
    expect(h.calls).toEqual([
      { path: "/api/routines/skip", body: { id: "daily", date: "2026-10-12" } },
      { path: "/api/routines/written", body: { id: "daily", date: "2026-10-09" } },
      { path: "/api/routines/skip-overdue", body: {} },
    ]);
    expect(h.toasts).toEqual(["ok:/api/routines/skip", "ok:/api/routines/written", "已跳过 2 项逾期职责"]);
    expect(h.reloads()).toBe(3);
  });
});
