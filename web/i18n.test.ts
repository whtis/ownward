import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempRoots: string[] = [];
afterEach(() => { while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true }); });

/** 真 Chrome 里跑 i18n.js：lang 写进 localStorage 后加载，返回页面里 data-result 的 JSON */
async function runInChrome(lang: "en" | "zh", body: string, checks: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "ownward-i18n-")); tempRoots.push(root);
  const fixture = join(root, "index.html");
  writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
    <script>window.__errors=[];addEventListener("error",e=>window.__errors.push(e.message));localStorage.setItem("ownward-lang",${JSON.stringify(lang)});</script>
    <script src="${new URL("./i18n-en.js", import.meta.url).href}"></script>
    <script src="${new URL("./i18n.js", import.meta.url).href}"></script>
    <body>${body}
    <script>${checks}</script>`);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--dump-dom", `file://${fixture}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0);
  const encoded = out.match(/data-result="([^"]+)"/)?.[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  expect(encoded).toBeTruthy();
  return JSON.parse(encoded!);
}

const BODY = `
  <button id="static">设置</button>
  <span id="tpl">5 件待分流</span>
  <div class="msg" data-role="user"><div class="who" id="who">我 · 10:30</div><div class="bubble" id="user-bubble">设置</div></div>
  <div class="msg" data-role="system"><div class="bubble" id="notice">⚠️ 这一轮没跑起来（provider_input_invalid）：Claude cwd 不存在或不是目录</div></div>
  <div class="msg" data-role="system"><div class="bubble" id="bg-none">⚠️ 后台子代理已结束，但没有收到汇报</div></div>
  <div class="msg" data-role="system"><div class="bubble" id="bg-wait">⏳ 还有 3 个后台子代理在跑，跑完会自动汇报；期间发的消息会排到汇报之后（点中断可连同子代理一起停掉）</div></div>
  <div class="msg" data-role="system"><div class="bubble" id="bg-task">⚠️ 后台任务 bx1 → completed：Run full verify</div></div>
  <textarea id="ta" placeholder="负责什么、不负责什么">设置</textarea>
  <span id="partial">修复设置页</span>
  <span id="title" title="设置">x</span>
  <select id="sel"><option>设置</option><option value="v">设置</option></select>
  <div class="task-card-title" id="task-title">设置</div>
  <div id="later"></div>`;
// 第一段脚本动态插入（走 MutationObserver），第二段在微任务清空后读结果
const CHECKS = `
  document.getElementById("later").innerHTML = '<b id="dyn">立即分流</b>';
  </script><script>
  const $ = (id) => document.getElementById(id);
  document.body.dataset.result = JSON.stringify({
    lang: I18N.lang, htmlLang: document.documentElement.lang,
    static: $("static").textContent, tpl: $("tpl").textContent, who: $("who").textContent, userBubble: $("user-bubble").textContent,
    notice: $("notice").textContent, placeholder: $("ta").placeholder, taValue: $("ta").value, partial: $("partial").textContent,
    title: $("title").title, optNoValue: $("sel").options[0].textContent, optValue: $("sel").options[1].textContent, taskTitle: $("task-title").textContent, dyn: $("dyn").textContent, t: I18N.t("今日"), unknown: I18N.t("完全不在词典里的一句话"),
    bgNone: $("bg-none").textContent, bgWait: $("bg-wait").textContent, bgTask: $("bg-task").textContent,
    errors: window.__errors,
  });`;

describe("界面语言（i18n.js + i18n-en.js）", () => {
  test("real Chrome: English 模式翻界面文本，用户内容与输入框内容保持原样", async () => {
    const r = await runInChrome("en", BODY, CHECKS);
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ lang: "en", htmlLang: "en", static: "Settings", t: "Today", title: "Settings", dyn: "Triage now" });
    expect(r.tpl).toBe("5 to triage");                                   // {0} 模板
    expect(r.who).toBe("Me · 10:30");                                    // 「A · B」拼接标签
    expect(r.notice).toContain("Claude cwd does not exist or is not a directory");  // 服务端报错：模板 + 捕获段短语替换
    expect(r.notice).not.toMatch(/[㐀-鿿]/);
    // 会话系统提示带 emoji 前缀：剥掉前缀按正文查词典
    expect(r.bgNone).toBe("⚠️ Background subagent finished but no report was received");
    expect(r.bgWait).toMatch(/^⏳ 3 background subagents are still running/);
    expect(r.bgTask).toBe("⚠️ Background task bx1 → completed: Run full verify");
    expect(r.placeholder).not.toMatch(/[㐀-鿿]/);               // textarea 的 placeholder 是界面文本
    expect(r.userBubble).toBe("设置");                                   // 用户气泡不翻，哪怕整串等于界面词
    expect(r.taValue).toBe("设置");                                      // 输入框里用户写的字不翻
    expect(r.partial).toBe("修复设置页");                                // 不做子串替换
    expect(r.optNoValue).toBe("设置");                                   // 无 value 的 option 文字即值，不翻
    expect(r.optValue).toBe("Settings");
    expect(r.taskTitle).toBe("设置");                                    // 用户起的任务标题不翻
    expect(r.unknown).toBe("完全不在词典里的一句话");
  });

  test("real Chrome: 中文模式什么都不动", async () => {
    const r = await runInChrome("zh", BODY, CHECKS);
    expect(r).toMatchObject({ lang: "zh", htmlLang: "zh-CN", static: "设置", tpl: "5 件待分流", who: "我 · 10:30", dyn: "立即分流", t: "今日" });
  });

  test("词典里每条译文的 {N} 占位与原文一致", () => {
    const win: any = {}; new Function("window", readFileSync(new URL("./i18n-en.js", import.meta.url), "utf8"))(win);
    const placeholders = (s: string) => (s.match(/\{\d+\}/g) || []).sort().join(",");
    const bad = Object.entries(win.I18N_EN as Record<string, string>).filter(([zh, en]) => placeholders(zh) !== placeholders(en));
    expect(bad).toEqual([]);
    expect(Object.keys(win.I18N_EN).length).toBeGreaterThan(3000);
  });
});
