import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(import.meta.dir, "app.js"), "utf8");
const tasks = readFileSync(join(import.meta.dir, "tasks.js"), "utf8");
const html = readFileSync(join(import.meta.dir, "index.html"), "utf8");

describe("multi-directory UI contract", () => {
  test("new work keeps explicit removable extra directory chips and sends them only for this dispatch", () => {
    expect(html).toContain('id="w-extra-input"');
    expect(html).toContain('id="w-extra-chips"');
    expect(app).toContain("let workExtraDirs = []");
    expect(app).toContain("workExtraDirs.splice(+b.dataset.i, 1)");
    expect(app).toContain("extraDirs: workExtraDirs.length ? [...workExtraDirs] : undefined");
    expect(app).toContain('const closeWork = () => { overlay.dataset.open = "false"; workExtraDirs = []; renderWorkExtraDirs(); }');
  });

  test("terminal disables and clears extra directories, while successful additions refresh reusable candidates", () => {
    expect(app).toContain('el.disabled = !enabled');
    expect(app).toContain('terminal 模式已清除附加目录');
    expect(app).toContain('await refreshProjectCandidates()');
    expect(app).toContain('status.insertAdjacentHTML("beforeend"');
    expect(html).toContain('id="add-dir-status"');
  });

  test("session detail renders canonical main and additional directory chips with full-path titles", () => {
    expect(tasks).toContain('aria-label="当前会话目录"');
    expect(tasks).toContain('title="${esc(dev.cwd)}"');
    expect(tasks).toContain('(dev.extraDirs || []).map');
    expect(tasks).toContain('<span class="title">${esc(t.project)}</span>${pills}${dirs}');
    expect(tasks).not.toContain('</div>${dirs}` + repoPanelHtml(t)');
  });
});
