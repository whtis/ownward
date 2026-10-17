import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempRoots: string[] = [];
afterEach(() => { while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true }); });

/** 真 Chrome 里加载 share-card.js 跑 checks，返回页面里 data-result 的 JSON（同 i18n.test.ts 的路子） */
async function runInChrome(checks: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "ownward-share-")); tempRoots.push(root);
  const fixture = join(root, "index.html");
  writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
    <script>window.__errors=[];addEventListener("error",e=>window.__errors.push(e.message));function toast(){}</script>
    <link rel="stylesheet" href="${new URL("./style.css", import.meta.url).href}">
    <script src="${new URL("./share-card.js", import.meta.url).href}"></script>
    <body><div id="tk-detail"></div>
    <script>${checks}</script>`);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--virtual-time-budget=5000", "--dump-dom", `file://${fixture}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0);
  const encoded = out.match(/data-result="([^"]+)"/)?.[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  expect(encoded).toBeTruthy();
  return JSON.parse(encoded!);
}

const SAMPLE = [
  { role: "user", text: "帮我看看 /Users/alice/code/app 里为什么登录页闪退，token=ghp_abcdefghijklmnopqrstuvwxyz0123 是测试用的" },
  { role: "assistant", text: "## 结论\n闪退来自 `LoginView` 里对空 **session** 的强制解包。\n\n- 复现：冷启动后立刻点登录\n- 修复：改成 `guard let`\n\n```swift\nguard let s = session else { return }\n```\n\n> 已跑 `ios/build.sh --test`，84 个测试全过。\n\nSee https://example.com/very/long/link/that/should/wrap/nicely for details and a fairly long English sentence that has to wrap across lines." },
];

describe("会话分享图（share-card.js）", () => {
  test("real Chrome: 三种风格都能画出图，尺寸合理，无脚本错误", async () => {
    const r = await runInChrome(`
      const msgs = ${JSON.stringify(SAMPLE)};
      const out = {};
      for (const theme of ["warm", "night", "memo", "aurora"]) {
        const c = ShareCard.render({ theme, redact: true, title: "登录页闪退排查", project: "ios-app", provider: "claude · opus", agentName: "Claude", date: "2026年10月15日", messages: msgs });
        out[theme] = { w: c.width, h: c.height, png: c.toDataURL("image/png") };
      }
      document.body.dataset.result = JSON.stringify({ out, errors: window.__errors });`);
    expect(r.errors).toEqual([]);
    for (const theme of ["warm", "night", "memo", "aurora"]) {
      expect(r.out[theme].w).toBe(1170);                          // 390 逻辑宽（手机竖版）× 3 倍清晰度
      expect(r.out[theme].h).toBeGreaterThan(1200);
      expect(r.out[theme].png.length).toBeGreaterThan(20_000);     // 真画了东西，不是空图
      if (process.env.SHARE_CARD_DUMP) writeFileSync(join(process.env.SHARE_CARD_DUMP, `${theme}.png`), Buffer.from(r.out[theme].png.split(",")[1], "base64"));
    }
  });

  test("real Chrome: 选择态——默认选最近一问一答，点选切换，会话重渲染后选中标记还在，弹窗出预览图", async () => {
    const r = await runInChrome(`(async () => {
      const msgs = [{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "tool", text: "ls" }, { role: "user", text: "q2" }, { role: "assistant", text: "a2" }];
      const html = () => '<div class="session-scroll" id="tk-scroll">' + msgs.map((m, i) => '<div class="msg" data-role="' + m.role + '"' + (m.role === "tool" ? "" : ' data-share-i="' + (i + 10) + '"') + '><div class="bubble">' + m.text + '</div></div>').join("") + '</div>';
      const host = document.getElementById("tk-detail"); host.innerHTML = html();
      ShareCard.start({ title: "T", indices: msgs.map((m, i) => ({ i: i + 10, role: m.role })), resolve: (i) => msgs[i - 10] });
      const picked = () => [...document.querySelectorAll('.msg[data-picked="true"]')].map((e) => e.textContent);
      const first = picked();
      document.querySelector('[data-share-i="10"] .bubble').click();      // 点子元素也算点这条
      document.querySelector('[data-share-i="14"]').click();              // 再点一次取消
      host.innerHTML = html();                                            // 模拟轮询整块重渲染
      await new Promise((r) => setTimeout(r, 0));
      const afterRerender = picked(), mode = document.getElementById("tk-scroll").classList.contains("share-mode");
      document.querySelector(".share-bar .share-go").click();
      for (let k = 0; k < 50 && !document.querySelector("#share-dialog img")?.src; k++) await new Promise((r) => setTimeout(r, 50));
      const src = document.querySelector("#share-dialog img")?.src || "";
      document.querySelector(".share-bar .share-cancel").click();
      document.body.dataset.result = JSON.stringify({ first, afterRerender, mode, src: src.slice(0, 5), barGone: !document.querySelector(".share-bar"), cleared: !document.querySelector('.msg[data-picked="true"]'), errors: window.__errors });
    })().catch((e) => { document.body.dataset.result = JSON.stringify({ errors: [String(e)] }); });`);
    expect(r.errors).toEqual([]);
    expect(r.first).toEqual(["q2", "a2"]);
    expect(r.afterRerender).toEqual(["q1", "q2"]);
    expect(r.mode).toBe(true);
    expect(r.src).toBe("blob:");
    expect(r.barGone).toBe(true);
    expect(r.cleared).toBe(true);
  });

  test("real Chrome: 划选一段文字——只取选中部分（跨消息、保住列表/代码），浮钮「分享所选」直接出预览；选择态里划选标成部分", async () => {
    const r = await runInChrome(`(async () => {
      const msgs = [{ role: "user", text: "第一句。第二句。第三句。" }, { role: "assistant", text: "原文" }];
      document.getElementById("tk-detail").innerHTML = '<div class="session-scroll" id="tk-scroll">'
        + '<div class="msg" data-role="user" data-share-i="0"><div class="who">我</div><div class="bubble" id="u">第一句。第二句。第三句。</div></div>'
        + '<div class="msg" data-role="assistant" data-share-i="1"><div class="who">agent</div><div class="bubble" id="a"><p>开头一段话。</p><ul><li>要点甲</li><li>要点乙</li></ul><pre><code>run()</code></pre><p>结尾不要。</p></div></div></div>';
      // 等 close 事件真的派发完再看状态（headless 的虚拟时间会让定时器跑在 close 事件前面）
      const closeDlg = async () => { document.querySelector('#share-dialog [data-act="close"]').click(); await new Promise((r) => setTimeout(r, 0)); };   // 像人一样点 ✕
      window.tkShareStart = (o = {}) => ShareCard.start({ title: "T", indices: [{ i: 0, role: "user" }, { i: 1, role: "assistant" }], resolve: (i) => msgs[i], ...o });
      const u = document.getElementById("u").firstChild, a = document.getElementById("a");
      const sel = getSelection(), range = document.createRange();
      // 从提问的「第二句」选到回答的代码块（不含「结尾不要」）
      range.setStart(u, 4); range.setEnd(a.querySelector("pre code").firstChild, 5);
      sel.removeAllRanges(); sel.addRange(range);
      const frags = ShareCard._test.fragments();
      await new Promise((r) => setTimeout(r, 400));
      document.getElementById("tk-scroll").dispatchEvent(new Event("scroll"));   // 选完滚一下：按钮得还在
      await new Promise((r) => setTimeout(r, 100));
      const btn = document.querySelector(".share-sel-btn"), label = btn?.textContent;
      btn?.click();
      for (let k = 0; k < 50 && !document.querySelector("#share-dialog img")?.src; k++) await new Promise((r) => setTimeout(r, 50));
      const opened = !!document.querySelector("#share-dialog")?.open, src = (document.querySelector("#share-dialog img")?.src || "").slice(0, 5);
      await closeDlg();
      const exitedAfterOneShot = !document.querySelector(".share-bar") && !ShareCard.on;   // 划选进来的：关掉预览就整个退出
      window.tkShareStart();                                                                // 手动进选择态
      // 选择态里只划「第三句」：这条标成 partial
      const r2 = document.createRange(); r2.setStart(u, 8); r2.setEnd(u, 12); sel.removeAllRanges(); sel.addRange(r2);
      await new Promise((r) => setTimeout(r, 400));
      const label2 = document.querySelector(".share-sel-btn")?.textContent; document.querySelector(".share-sel-btn")?.click();
      const mark = document.querySelector('[data-share-i="0"]').dataset.picked;
      // 选择态：只是看看就关 → 留在选择态；下载过再关 → 退出
      document.querySelector(".share-bar .share-go").click(); await new Promise((r) => setTimeout(r, 300));
      await closeDlg(); const stayed = ShareCard.on && !!document.querySelector(".share-bar");
      document.querySelector(".share-bar .share-go").click();
      for (let k = 0; k < 50 && !document.querySelector("#share-dialog img")?.src.startsWith("blob:"); k++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {}; document.querySelector('[data-act="download"]').click(); HTMLAnchorElement.prototype.click = o;
      await closeDlg(); const exitedAfterDownload = !ShareCard.on && !document.querySelector(".share-bar");
      // 整段落在代码块里：仍是代码块
      const code = a.querySelector("pre code").firstChild, r3 = document.createRange(); r3.setStart(code, 1); r3.setEnd(code, 4); sel.removeAllRanges(); sel.addRange(r3);
      const inCode = ShareCard._test.fragments(); sel.removeAllRanges();
      document.body.dataset.result = JSON.stringify({ frags, label, opened, src, label2, mark, exitedAfterOneShot, stayed, exitedAfterDownload, inCode, errors: window.__errors });
    })().catch((e) => { document.body.dataset.result = JSON.stringify({ errors: [String(e)] }); });`);
    expect(r.errors).toEqual([]);
    expect(r.frags).toEqual([
      { i: 0, role: "user", text: "第二句。第三句。", partial: true },
      { i: 1, role: "assistant", text: "开头一段话。\n\n- 要点甲\n- 要点乙\n\n```\nrun()\n```", partial: true },
    ]);
    expect(r.label).toBe("分享所选");
    expect(r.opened).toBe(true);
    expect(r.src).toBe("blob:");
    expect(r.label2).toBe("加入所选");
    expect(r.mark).toBe("partial");
    expect(r.exitedAfterOneShot).toBe(true);
    expect(r.stayed).toBe(true);
    expect(r.exitedAfterDownload).toBe(true);
    expect(r.inCode).toEqual([{ i: 1, role: "assistant", text: "\`\`\`\nun(\n\`\`\`", partial: true }]);
  });

  test("real Chrome: 浮条贴在输入框上方；长选区滚出视野时「分享所选」卡在会话区内，不跑到顶栏上", async () => {
    const r = await runInChrome(`(async () => {
      document.body.style.margin = "0";
      const host = document.getElementById("tk-detail");
      host.style.cssText = "position:fixed;top:100px;left:300px;width:600px;bottom:0;display:flex;flex-direction:column";
      const items = Array.from({ length: 30 }, (_, i) => '<div class="msg" data-role="' + (i % 2 ? "assistant" : "user") + '" data-share-i="' + i + '"><div class="bubble">第 ' + i + ' 条消息，用来撑出滚动的长度。</div></div>').join("");
      host.innerHTML = '<div class="session-scroll" id="tk-scroll" style="flex:1;overflow:auto">' + items + '</div><div class="composer" style="height:120px">composer</div>';
      ShareCard.start({ title: "T", indices: [], resolve: () => ({ role: "user", text: "x" }) });
      const bar = document.querySelector(".share-bar").getBoundingClientRect(), comp = document.querySelector(".composer").getBoundingClientRect();
      ShareCard.stop();
      const sc = document.getElementById("tk-scroll"), first = sc.querySelector('[data-share-i="2"] .bubble').firstChild, last = sc.querySelector('[data-share-i="28"] .bubble').firstChild;
      const range = document.createRange(); range.setStart(first, 2); range.setEnd(last, 4); getSelection().removeAllRanges(); getSelection().addRange(range);
      sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 400));
      const btn = document.querySelector(".share-sel-btn").getBoundingClientRect(), box = sc.getBoundingClientRect();
      document.body.dataset.result = JSON.stringify({ barAbove: bar.bottom <= comp.top, barCenter: Math.round(bar.left + bar.width / 2) - Math.round(host.getBoundingClientRect().left + host.getBoundingClientRect().width / 2), inside: btn.top >= box.top && btn.bottom <= box.bottom && btn.left >= box.left && btn.right <= box.right, errors: window.__errors });
    })().catch((e) => { document.body.dataset.result = JSON.stringify({ errors: [String(e)] }); });`);
    expect(r.errors).toEqual([]);
    expect(r.barAbove).toBe(true);
    expect(Math.abs(r.barCenter)).toBeLessThanOrEqual(1);                      // 按会话区居中，不是按整个窗口
    expect(r.inside).toBe(true);
  });

  test("real Chrome: 隐去路径与密钥；Markdown 分块；中英混排折行不超宽", async () => {
    const r = await runInChrome(`
      const { redact, blocks, wrap } = ShareCard._test;
      const c = document.createElement("canvas").getContext("2d"); c.font = "15px sans-serif";
      const lines = wrap((s) => c.measureText(s).width, [{ text: "这是一段很长的中文混着 English words 和 supercalifragilisticexpialidocious-very-long-token 的文字，需要被折成多行。", style: "body" }], 200);
      document.body.dataset.result = JSON.stringify({
        red: redact("cd /Users/alice/x && export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv; Authorization: Bearer abcdefghijklmnop123; password: hunter2hunter"),
        kinds: blocks("# T\\n段落一\\n第二行\\n\\n- a\\n1. b\\n> q\\n\\n\`\`\`js\\nx()\\n\`\`\`\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n---").map((b) => b.type),
        maxW: Math.max(...lines.map((l) => l.w)), n: lines.length,
        boldCode: ShareCard._test.inline("前 **默认 \`standard\`** 后").map((r) => r.text).join("|"),
        errors: window.__errors,
      });`);
    expect(r.errors).toEqual([]);
    expect(r.red).not.toContain("alice");
    expect(r.red).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(r.red).not.toContain("abcdefghijklmnop123");
    expect(r.red).not.toContain("hunter2hunter");
    expect(r.red).toContain("~/x");
    expect(r.kinds).toEqual(["h", "p", "li", "li", "quote", "code", "table", "hr"]);
    expect(r.maxW).toBeLessThanOrEqual(200);
    expect(r.boldCode).toBe("前 |默认 standard| 后");
    expect(r.n).toBeGreaterThan(2);
  });
});
