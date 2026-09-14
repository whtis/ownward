import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(import.meta.dir, "app.js"), "utf8");
const html = readFileSync(join(import.meta.dir, "index.html"), "utf8");
const css = readFileSync(join(import.meta.dir, "style.css"), "utf8");

// 「最近目录」不能只靠 datalist：目录框一旦预填了默认目录，浏览器按当前值过滤，候选一条都不冒出来。
describe("dispatch recent directories contract", () => {
  test("recent directories render as an always-visible chip row under the directory input", () => {
    expect(html).toContain('<datalist id="w-dir-list"></datalist>\n    <div class="dir-chips recent-dirs" id="w-dir-recent"');
    expect(app).toContain('const wrap = $("#w-dir-recent")');
    expect(app).toContain("wrap.hidden = !dirs.length");
    expect(app).toContain('$$("#w-dir-recent button").forEach((b) => b.addEventListener("click", () => { $("#w-dir").value = b.dataset.dir; $("#w-task").focus(); }))');
    expect(css).toContain(".recent-dirs { flex-wrap:nowrap; overflow-x:auto;");
    expect(css).toContain(".recent-dirs[hidden] { display:none; }");   // .dir-chips 的 display:flex 会盖掉 hidden 属性
  });

  test("opening the dialog renders cached candidates immediately and refreshes them in the background", () => {
    const openWork = app.slice(app.indexOf("const openWork = (dir) =>"), app.indexOf("const closeWork ="));
    expect(openWork.indexOf("paintProjectCandidates();")).toBeGreaterThan(-1);
    expect(openWork.indexOf("paintProjectCandidates();")).toBeLessThan(openWork.indexOf("refreshProjectCandidates();"));
    const paint = app.slice(app.indexOf("const paintProjectCandidates = () =>"), app.indexOf("let projectsSeq = 0"));
    expect(paint).toContain("renderRecentDirs();");
    // 乱序返回的旧结果不能盖掉新结果（打开弹窗的后台刷新 vs 追加目录后的刷新）
    expect(app).toContain("if (seq !== projectsSeq) return;");
  });
});
