// 审草稿弹窗的「不丢稿」契约。回归背景：关闭按钮、点遮罩、Esc 三条路原先都只是把
// data-open 拨成 false，textarea 里改了一半的内容一个字都不存——误触遮罩就白写一遍。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const today = readFileSync(join(import.meta.dir, "..", "web", "today.js"), "utf8");
const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "style.css"), "utf8");
const block = today.slice(today.indexOf("let draftTimer = null"), today.indexOf("function bindDraftModal()"));

function harness(draft = "原稿", saveOk = true) {
  const calls: any[] = [], stamps: string[] = [], dom: any = {
    "#d-text": { value: draft },
    "#d-autosave": { textContent: "", style: {} },
  };
  const overlay = { dataset: { open: "true" } };
  const Today: any = { draftCtx: { id: "standup", date: "2026-09-01" } };
  const post = async (path: string, body: any) => { calls.push({ path, body }); return saveOk ? { ok: true } : { ok: false, msg: "写不进去" }; };
  const $ = (sel: string) => { const node = dom[sel]; if (sel === "#d-autosave") { const proxy = node; Object.defineProperty(proxy, "textContent", { set: (v) => stamps.push(v), get: () => stamps.at(-1) ?? "", configurable: true }); } return node; };
  const api = Function("$", "post", "Today", "setTimeout", "clearTimeout", `${block}; return { saveDraftNow, closeDraft };`)($, post, Today, () => 0, () => {});
  return { api, calls, stamps, dom, overlay, Today };
}

describe("routine 草稿弹窗不丢稿", () => {
  test("改过就存，存的是最新文本", async () => {
    const h = harness();
    h.dom["#d-text"].value = "改到一半";
    expect(await h.api.saveDraftNow(false)).toBeTrue();
    expect(h.calls).toEqual([{ path: "/api/routines/draft", body: { id: "standup", date: "2026-09-01", content: "改到一半" } }]);
  });

  test("没改就不写：别拿无谓的写覆盖文件", async () => {
    const h = harness();
    await h.api.saveDraftNow(false);            // 基线还是空串，第一次会写
    h.calls.length = 0;
    await h.api.saveDraftNow(false);            // 内容没变
    expect(h.calls).toEqual([]);
  });

  test("关闭前先把没存的刷出去，然后才真的关", async () => {
    const h = harness();
    h.dom["#d-text"].value = "误触前写的这段";
    await h.api.closeDraft(h.overlay);
    expect(h.calls.at(-1)?.body.content).toBe("误触前写的这段");
    expect(h.overlay.dataset.open).toBe("false");
    expect(h.Today.draftCtx).toBeNull();
  });

  test("保存失败要看得见，不许假装存上了（规则 9）", async () => {
    const h = harness("原稿", false);
    h.dom["#d-text"].value = "改了";
    expect(await h.api.saveDraftNow(false)).toBeFalse();
    expect(h.stamps.at(-1)).toContain("写不进去");
  });
});

describe("审草稿弹窗可自由缩放", () => {
  test("弹窗自己带 resize 手柄，textarea 撑满剩余高度", () => {
    expect(html).toContain('class="modal draft"');
    const rule = css.slice(css.indexOf(".modal.draft {"), css.indexOf(".modal.draft .actions"));
    expect(rule).toContain("resize: both");
    expect(rule).toContain("overflow: auto");      // resize 只在 overflow 非 visible 时生效
    expect(rule).toContain("#d-text { flex: 1");
  });
});
