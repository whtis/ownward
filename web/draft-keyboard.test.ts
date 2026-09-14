import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const app = readFileSync(join(import.meta.dir, "app.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "style.css"), "utf8");

// 手机浏览器弹键盘时 fixed 弹窗不跟着缩，审草稿的长正文被键盘盖住：
// visualViewport → CSS 变量，草稿弹窗在窄屏下贴合可视视口。
describe("draft modal keyboard avoidance", () => {
  test("app syncs visual viewport height and offset into CSS variables at init", () => {
    expect(app).toContain("function bindVisualViewport()");
    expect(app).toContain('root.setProperty("--vv-h", `${h}px`)');
    expect(app).toContain('root.setProperty("--vv-top", `${top}px`)');
    expect(app).toContain("if (key === last) return;");   // 值没变不重写样式
    expect(app).toContain('vv.addEventListener("resize", sync)');
    expect(app).toContain('vv.addEventListener("scroll", sync)');
    const init = app.slice(app.indexOf("async function appInit()"));
    expect(init).toContain("bindVisualViewport();");
  });

  test("narrow-screen draft overlay follows the visual viewport with a dvh fallback", () => {
    const mobile = css.slice(css.indexOf("@media (max-width:700px) {"));
    expect(mobile).toContain("#draft-overlay { top:var(--vv-top, 0px); height:var(--vv-h, 100dvh); bottom:auto;");
    expect(mobile).toContain("#draft-overlay .modal.draft { width:100%; box-sizing:border-box; height:auto; max-height:none;");
    expect(mobile).toContain("#draft-overlay .modal.draft #d-text { min-height:96px; }");
  });

  test("real Chrome keeps the whole draft editor above a keyboard-shrunk visual viewport", async () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const root = mkdtempSync(join(tmpdir(), "ownward-draft-keyboard-")); roots.push(root);
    const html = join(root, "index.html"), css = new URL("./style.css", import.meta.url).pathname;
    // 手机竖屏窗口，键盘弹起后可视视口只剩 380px（--vv-h 由 app.js 的 visualViewport 同步）
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${css}">
      <style>:root{--vv-h:380px;--vv-top:0px}</style>
      <div class="overlay" id="draft-overlay" data-open="true">
        <div class="modal draft" role="dialog">
          <h2 id="d-title">周报 · 2026-09-02</h2>
          <textarea id="d-text">${"很长的草稿正文，一行接一行。\n".repeat(80)}</textarea>
          <div class="actions"><span id="d-autosave" class="quiet">已自动保存</span><button class="button ghost">关闭</button><button class="button danger">跳过本次</button><button class="button secondary">保存草稿</button><button class="button primary">写入文档</button></div>
        </div>
      </div>
      <script>const r=(s)=>{const b=document.querySelector(s).getBoundingClientRect();return [Math.round(b.top),Math.round(b.bottom),Math.round(b.height)]};const m=document.querySelector('.modal.draft');document.body.dataset.geometry=JSON.stringify({overlay:r('#draft-overlay'),text:r('#d-text'),actions:r('.actions'),modalRight:Math.round(m.getBoundingClientRect().right),viewportWidth:window.innerWidth,actionsScroll:[m.querySelector('.actions').scrollWidth,m.querySelector('.actions').clientWidth]});</script>`);
    const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--window-size=390,800", "--dump-dom", `file://${html}`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const encoded = out.match(/data-geometry="([^"]+)"/)?.[1].replaceAll("&quot;", '"');
    expect(encoded).toBeTruthy();
    const g = JSON.parse(encoded!);
    expect(g.overlay[1]).toBeLessThanOrEqual(380);            // 弹窗整体收进可视视口，不再伸到键盘底下
    expect(g.actions[1]).toBeLessThanOrEqual(380);            // 保存/写入按钮露在键盘上方
    expect(g.text[1]).toBeLessThanOrEqual(g.actions[0]);      // 编辑区在按钮之上，不重叠
    expect(g.text[2]).toBeGreaterThanOrEqual(96);             // 编辑区仍有可读高度
    expect(g.modalRight).toBeLessThanOrEqual(g.viewportWidth);  // 弹窗横向不出屏（100% + 内边距要算进 box-sizing；headless Chrome 窗口有最小宽度，按实际视口比）
    expect(g.actionsScroll[0]).toBeLessThanOrEqual(g.actionsScroll[1]);  // 按钮行换行而不是被裁掉
  });
});
