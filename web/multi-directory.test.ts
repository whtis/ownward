import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(import.meta.dir, "app.js"), "utf8");
const tasks = readFileSync(join(import.meta.dir, "tasks.js"), "utf8");
const html = readFileSync(join(import.meta.dir, "index.html"), "utf8");

describe("multi-directory UI contract", () => {
  test("new work keeps explicit removable extra directory chips and sends them only for this dispatch", () => {
    expect(html).toContain('id="w-extra-browse" title="添加附加目录" aria-label="添加附加目录"');
    expect(html).not.toContain('id="w-extra-input"');
    expect(html).not.toContain('id="w-extra-add"');
    expect(html).toContain('id="w-extra-chips"');
    expect(app).toContain("let workExtraDirs = []");
    expect(app).toContain("workExtraDirs.splice(+b.dataset.i, 1)");
    expect(app).toContain('const removeLabel = `移除附加目录：${name}`');
    expect(app).toContain('aria-label="${esc(removeLabel)}"');
    expect(app).toContain("const submitExtraDirs = [...new Set(workExtraDirs)].filter((d) => d !== dir)");
    expect(app).toContain("extraDirs: submitExtraDirs.length ? submitExtraDirs : undefined");
    expect(app).toContain('const closeWork = () => { overlay.dataset.open = "false"; workExtraDirs = []; renderWorkExtraDirs(); }');
  });

  test("terminal disables and clears extra directories, while successful additions refresh reusable candidates", () => {
    expect(app).toContain('$("#w-extra-browse").disabled = !enabled');
    expect(app).toContain('terminal 模式已清除附加目录');
    expect(app).toContain('await refreshProjectCandidates()');
    expect(app).toContain('status.insertAdjacentHTML("beforeend"');
    expect(html).toContain('id="add-dir-status"');
  });

  // 目录从头部挪到输入框下面的信息条：只显主目录末段 + 附加数量，完整路径进 title——
  // 头部一行横着摆十来个徽标（额度/分支/token/ctx/模型/深度/目录）谁也读不清
  test("session meta bar renders the main directory with a full-path title and an extra-dir count", () => {
    expect(tasks).toContain('<div class="session-meta" aria-label="会话状态">');
    expect(tasks).toContain('`主目录 ${dev.cwd}`');
    expect(tasks).toContain('extraDirs.map((d) => `附加 ${d}`)');
    expect(tasks).toContain('${extraDirs.length ? ` +${extraDirs.length}` : ""}');
    expect(tasks).toContain('onclick="devAddDir(\'${jsq(t.id)}\')">＋目录</button>');
    expect(tasks).toContain('<span class="title">${esc(t.project)}</span>${pills}');
    expect(tasks).not.toContain('${pills}${dirs}');
  });
});
