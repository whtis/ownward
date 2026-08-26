import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("narrow directory controls", () => {
  test("real Chrome keeps every new-directory row inside a 320px viewport", async () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const root = mkdtempSync(join(tmpdir(), "ownward-dir-geometry-")); roots.push(root);
    const html = join(root, "index.html"), css = new URL("./style.css", import.meta.url).pathname;
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${css}">
      <div class="modal" style="width:296px">
        <div class="row dir-input-row"><input type="text"><button class="icon-btn">目录</button></div>
        <div class="row dir-input-row"><input type="text"><button class="icon-btn">目录</button><button class="button ghost sm">添加</button></div>
      </div>
      <script>const rows=[...document.querySelectorAll('.dir-input-row')],modal=document.querySelector('.modal');document.body.dataset.geometry=JSON.stringify({modal:[modal.clientWidth,modal.scrollWidth],rows:rows.map(row=>[row.clientWidth,row.scrollWidth]),inputs:rows.map(row=>row.querySelector('input').getBoundingClientRect().width)});</script>`);
    const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--window-size=320,800", "--dump-dom", `file://${html}`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const encoded = out.match(/data-geometry="([^"]+)"/)?.[1].replaceAll("&quot;", '"');
    expect(encoded).toBeTruthy();
    const geometry = JSON.parse(encoded!);
    expect(geometry.modal[1]).toBeLessThanOrEqual(geometry.modal[0]);
    for (const [client, scroll] of geometry.rows) expect(scroll).toBeLessThanOrEqual(client);
    for (const width of geometry.inputs) expect(width).toBeGreaterThan(0);
  });
});
