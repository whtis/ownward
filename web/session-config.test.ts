import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const tasks = readFileSync(new URL("./tasks.js", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.js", import.meta.url), "utf8");
const tempRoots: string[] = [];

afterEach(() => { while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true }); });

describe("dispatch and live session model configuration", () => {
  test("dispatch exposes the exact model-specific effort matrix", () => {
    expect(html).toContain('id="w-model"');
    expect(html).toContain('id="w-effort"');
    expect(app).toContain("WORK_PROVIDER_CAPABILITIES");
    expect(app).toContain('defaultModel: "gpt-5.6-sol"');
    expect(app).toContain('models: Object.freeze(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"])');
    expect(app).toContain('"gpt-6-astra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"])');
    expect(app).toContain('"gpt-5.6-sol": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"])');
    expect(app).toContain('"gpt-5.6-terra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"])');
    expect(app).toContain('"gpt-5.6-luna": Object.freeze(["low", "medium", "high", "xhigh", "max"])');
    expect(app).toContain('"gpt-5.5": Object.freeze(["low", "medium", "high", "xhigh"])');
    expect(app).toContain('"gpt-5.3-codex-spark": Object.freeze(["low", "medium", "high", "xhigh"])');
    expect(app).not.toContain('"gpt-5.4"');   // 官方目录 2026-09 已下线，别再画回来
    expect(app).not.toContain('"gpt-5.5-pro"');
    // 内置表只是兜底：页面载入和打开派发弹窗时都会用 /api/providers/catalog 覆盖
    expect(app).toContain("function applyProviderCatalog(catalog)");
    expect(app).toContain('getJSON("/api/providers/catalog")');
    expect(app).toContain("refreshProviderCatalog(),   // Provider 模型目录");
    expect(app).toContain("refreshProviderCatalog().then((changed) => { if (changed && overlay.dataset.open === \"true\") fillWorkProviderOptions(");
    // minimal 只属于 CodeBuddy（`codebuddy --help`），Claude 五档不许带它
    expect(app).toContain('efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),\n    defaultModel: "", handoffModel: "sonnet"');
    expect(app).toContain('efforts: Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"])');
    expect(app).not.toContain('"kimi-k3-1"');   // 2026-09 已下线的 CodeBuddy 型号
    expect(app).toContain('effort: $("#w-effort").value || undefined');
  });

  test("explicit dispatch defaults are applied before the Codex fallback", () => {
    expect(app).toContain('model: d.model || "", effort: d.effort || "", useProviderDefault: !d.model');
    expect(app).toContain('providerId === "codex" && selection.useProviderDefault !== false ? capability.defaultModel');
  });

  test("one dialog handles cross-provider handoff and same-provider reconfiguration", () => {
    expect(html).toContain('id="session-config-dialog"');
    expect(tasks).toContain("function sessionConfigIsNoop");
    expect(tasks).toContain('providerId === dialog?.dataset.currentProvider');
    expect(tasks).toContain('model: model || undefined, effort: effort || undefined');
    expect(tasks).toContain('sameProvider ? await post("/api/dev/reconfigure", { id, model: payload.model, effort: payload.effort }) : await post("/api/dev/handoff", payload)');
    expect(tasks).toContain('reason: sameProvider ? "manual-reconfigure" : "manual-handoff"');
    expect(tasks).toContain("sameProvider && !currentModel");
    expect(tasks).toContain("fillSessionConfigEfforts(effort, sameProvider, sameProvider)");
    expect(tasks).toContain('workProviderEfforts(values.providerId, values.model).includes(values.effort)');
    expect(tasks).toContain("沿用有界历史");
    expect(tasks).toContain("将就地切换模型/思考深度，沿用当前会话（不接力，下一轮生效）");
    expect(tasks).toContain('sessionConfigStatus(sameProvider ? "正在就地切换配置…" : "正在创建接力会话并应用配置…", "busy")');
    expect(tasks).toContain('sessionConfigStatus(`${applied ? "配置已应用，但刷新失败" : "应用失败"}');
  });

  test("task detail and Settings expose the active/default effort", () => {
    // 模型 · 深度合成一个可点的 chip，落在输入框下面的信息条里（点它就是原来的「引擎 / 模型…」按钮）
    expect(tasks).toContain('function sessionMetaHtml(t, dev)');
    expect(tasks).toContain('${esc(dev.model || "默认")} · ${esc(dev.effort || "默认")}</button>');
    expect(tasks).toContain("${sessionMetaHtml(t, dev)}");
    // 接力/换 ref 之后，之前那个引擎的原生会话 ID 与恢复命令要能在会话页查到（服务端拼命令，前端只展示+复制）——
    // 但日常几乎不用，所以收在头部「谱系」按钮后的弹窗里，不再常驻输入框上方（原 <details open> 每次重绘都自己弹开）
    expect(html).toContain('id="lineage-dialog"');
    expect(tasks).toContain("function lineageRows(lineage)");
    expect(tasks).toContain("function openLineage()");
    expect(tasks).toContain('onclick="openLineage()">谱系</button>');
    expect(tasks).not.toContain('<details class="lineage"');
    expect(tasks).toContain("${queue}${resume}\n");
    expect(tasks).toContain("会话谱系与恢复命令");
    expect(tasks).toContain("尚无原生会话 ID");
    expect(tasks).toContain("copyResumeCmd('${jsq(resume.cmd)}')");
    // 额度：每个会话头部按引擎显示对应家的窗口（/api/usage 两家都给），跟慢数据一起 60s 刷、就地换内容
    expect(tasks).toContain('getJSON("/api/usage").catch(() => null)');
    expect(tasks).toContain("function usagePillHtml(backend)");
    expect(tasks).toContain('id="tk-usage" data-backend=');
    expect(tasks).toContain("if (us && JSON.stringify(us) !== JSON.stringify(Tasks.usage)) { Tasks.usage = us; renderUsagePill(); }");
    expect(tasks).toContain('<b>思考深度</b>${esc(dev.effort || "Provider 默认")}');
    expect(settings).toContain('pointer==="/dispatch/defaults/effort"');
    expect(settings).toContain('pointer==="/dispatch/defaults/model"');
    expect(settings).toContain('efforts=workProviderEfforts(provider,dispatchDefaultModel())');
    expect(settings).toContain('path==="/dispatch/defaults/model"');
    expect(settings).toContain('effort:"默认思考深度"');
  });

  test("real Chrome: lineage lives behind a head button, usage pill follows the session engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-lineage-usage-")); tempRoots.push(root);
    const fixture = join(root, "index.html");
    const appUrl = new URL("./app.js", import.meta.url).href;
    const feedUrl = new URL("./feed.js", import.meta.url).href;
    const tasksUrl = new URL("./tasks.js", import.meta.url).href;
    writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><body>
      <div id="toast"></div><div id="tk-detail"></div><dialog id="lineage-dialog"><div id="lineage-body"></div></dialog>
      <script>window.__runtimeErrors=[];addEventListener("error",event=>window.__runtimeErrors.push(event.message));addEventListener("unhandledrejection",event=>window.__runtimeErrors.push(String(event.reason)));</script>
      <script src="${appUrl}"></script><script src="${feedUrl}"></script><script src="${tasksUrl}"></script>
      <script>
        const soon=new Date(Date.now()+3*3600e3+10*60e3).toISOString(),later=new Date(Date.now()+2*86400e3+2*3600e3).toISOString();
        Tasks.usage={claude:{windows:[{label:"5h",seconds:18000,percent:46,resetsAt:soon},{label:"周",seconds:604800,percent:42,resetsAt:later}]},codex:{windows:[{label:"周",seconds:604800,percent:91,resetsAt:later}],plan:"pro"}};
        Tasks.dev={backend:"claude",providerId:"claude",model:"sonnet",effort:"medium",turn:"idle",pending:[],queued:[],control:"ownward",ctxTokens:670000,ctxWindow:1000000,lineage:[
          {sessionId:"s1",providerId:"codex",model:"gpt-5.6-sol",effort:"high",cwd:"/p",nativeRef:"0000-old",resume:{cmd:"codex resume 0000-old"},createdAt:"2026-09-07T01:00:00Z",handedOffAt:"2026-09-07T02:00:00Z",reason:"manual-handoff",current:false,previousRefs:[{nativeRef:"0000-prev",resume:{cmd:"codex resume 0000-prev"}}]},
          {sessionId:"s2",providerId:"claude",model:"sonnet",effort:"medium",cwd:"/p",nativeRef:null,resume:null,createdAt:"2026-09-07T02:00:00Z",current:true}]};
        const t={id:"task-1",project:"p",title:"t",engine:true,status:"running",mode:"claude-bg"};
        document.querySelector("#tk-detail").innerHTML=detailHead(t)+sessionMetaHtml(t,Tasks.dev);
        const head=document.querySelector("#tk-detail").innerHTML;
        const pill=document.querySelector("#tk-usage .tag");
        const claudePill={text:pill?.textContent,tone:pill?.dataset.tone??null,inlineDetails:!!document.querySelector("details.lineage"),hasButton:!!document.querySelector('button[onclick="openLineage()"]')};
        // 信息条左右分家：左 .meta-read 全是只读读数，右 .meta-act 全是能点的按钮；ctx% 用 provider 回报的窗口算
        const metaEl=document.querySelector(".session-meta");
        const ctxEl=metaEl.querySelector(".meta-read .meta-item.mono");
        const meta={readButtons:metaEl.querySelectorAll(".meta-read button").length,actButtons:[...metaEl.querySelectorAll(".meta-act > *")].map(e=>e.tagName+":"+e.textContent.trim()),readTexts:[...metaEl.querySelectorAll(".meta-read > *")].map(e=>e.className.split(" ")[0]),ctx:ctxEl?.textContent,ctxTone:ctxEl?.dataset.tone??null,ctxTitle:ctxEl?.title};
        // 没回报窗口时按模型名估：fable/opus/sonnet 一律 1M，haiku 200k（以前一律 200k，1M 会话显示 300%+）
        const est=(model,ctxTokens)=>{const h=document.createElement("div");h.innerHTML=ctxPillHtml({backend:"claude",model,ctxTokens});const e=h.firstElementChild;return {text:e.textContent,tone:e.dataset.tone??null,title:e.title};};
        const ctxEst={opus:est("opus",670000),haiku:est("haiku",150000),codex:(()=>{const h=document.createElement("div");h.innerHTML=ctxPillHtml({backend:"codex",ctxTokens:286541});return h.firstElementChild.textContent;})()};
        openLineage();
        const dialog=document.querySelector("#lineage-dialog");
        const lineage={open:dialog.open,title:document.querySelector("#lineage-title").textContent,rows:dialog.querySelectorAll(".lineage-row").length,count:dialog.querySelector(".lineage-count").textContent,replaced:dialog.textContent.includes("已被 /new 换掉"),noRef:dialog.textContent.includes("尚无原生会话 ID"),copyButtons:dialog.querySelectorAll("button.button.sm").length};
        document.querySelector("#lineage-close").click();
        const closed=!dialog.open;
        // 额度按引擎：同一份 usage，codex 会话显 codex 的窗口且 91% 变红
        Tasks.dev={...Tasks.dev,backend:"codex",providerId:"codex",lineage:[]};
        document.querySelector("#tk-detail").innerHTML=detailHead(t)+sessionMetaHtml(t,Tasks.dev);
        const codexPillEl=document.querySelector("#tk-usage .tag");
        const codexPill={text:codexPillEl?.textContent,tone:codexPillEl?.dataset.tone??null,hasButton:!!document.querySelector('button[onclick="openLineage()"]')};
        // 60s 刷新：就地换内容，不重渲会话
        Tasks.usage={claude:null,codex:{windows:[{label:"周",seconds:604800,percent:12}]}};renderUsagePill();
        const refreshed=document.querySelector("#tk-usage .tag")?.textContent;
        Tasks.usage=null;renderUsagePill();
        const emptied=document.querySelector("#tk-usage").innerHTML;
        document.body.dataset.runtime=JSON.stringify({claudePill,meta,ctxEst,lineage,closed,codexPill,refreshed,emptied,errors:window.__runtimeErrors});
      </script>`);
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    // 独立 profile + 关掉首次运行/崩溃上报：用用户默认 profile 起 headless 在忙机器上会卡住几十秒到几分钟
    const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", `--user-data-dir=${join(root, "chrome-profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-crash-reporter", "--disable-breakpad", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--dump-dom", `file://${fixture}`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const encoded = out.match(/data-runtime="([^"]+)"/)?.[1].replaceAll("&quot;", '"');
    expect(encoded).toBeTruthy();
    expect(JSON.parse(encoded!)).toEqual({
      claudePill: { text: "额度 5h 46%(3h10m) · 周 42%(2d2h)", tone: null, inlineDetails: false, hasButton: true },
      // 左读右改：左边没有任何按钮，右边只有按钮；670k / 1M = 67%（以前按 200k 算成 335%）
      meta: { readButtons: 0, actButtons: ["BUTTON:sonnet · medium", "BUTTON:＋目录", "BUTTON:谱系"], readTexts: ["meta-item", "usage-pill"], ctx: "ctx 670k · 67%", ctxTone: null, ctxTitle: "上下文占用（窗口 1000k，超阈值会自动压缩）" },
      ctxEst: { opus: { text: "ctx 670k · 67%", tone: null, title: "上下文占用（窗口 1000k，按模型估算，超阈值会自动压缩）" }, haiku: { text: "ctx 150k · 75%", tone: "warn", title: "上下文占用（窗口 200k，按模型估算，超阈值会自动压缩）" }, codex: "ctx 287k" },
      lineage: { open: true, title: "会话谱系与恢复命令", rows: 3, count: "3 个原生会话", replaced: true, noRef: true, copyButtons: 2 },
      closed: true,
      codexPill: { text: "额度 周 91%(2d2h)", tone: "bad", hasButton: false },
      refreshed: "额度 周 12%",
      emptied: "",
      errors: [],
    });
  }, 60_000);   // headless Chrome 在忙机器上冷起要几十秒；用例本身几毫秒

  test("real Chrome loads the scripts and drives the unified dialog without runtime errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-session-config-")); tempRoots.push(root);
    const fixture = join(root, "index.html");
    const appUrl = new URL("./app.js", import.meta.url).href;
    const feedUrl = new URL("./feed.js", import.meta.url).href;
    const tasksUrl = new URL("./tasks.js", import.meta.url).href;
    writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><body>
      <div id="toast"></div><dialog id="session-config-dialog"><div id="session-config-body"></div></dialog>
      <script>window.__runtimeErrors=[];addEventListener("error",event=>window.__runtimeErrors.push(event.message));addEventListener("unhandledrejection",event=>window.__runtimeErrors.push(String(event.reason)));</script>
      <script src="${appUrl}"></script><script src="${feedUrl}"></script><script src="${tasksUrl}"></script>
      <script>
        Tasks.dev={backend:"codex",providerId:"codex",model:"gpt-5.6-sol",effort:"medium",turn:"idle",pending:[],queued:[],control:"ownward"};
        openSessionConfig("task-1");
        const initialDisabled=document.querySelector("#session-config-submit").disabled;
        const explicitHasModelReset=!!document.querySelector('#session-config-model option[value=""]');
        const explicitHasEffortReset=!!document.querySelector('#session-config-effort option[value=""]');
        const codexEffort=document.querySelector("#session-config-effort");codexEffort.value="ultra";codexEffort.dispatchEvent(new Event("change"));
        const codexModel=document.querySelector("#session-config-model");codexModel.value="gpt-5.6-luna";codexModel.dispatchEvent(new Event("change"));
        const luna={effort:codexEffort.value,hasUltra:!!codexEffort.querySelector('option[value="ultra"]'),disabled:document.querySelector("#session-config-submit").disabled};
        const provider=document.querySelector("#session-config-provider");provider.value="claude";provider.dispatchEvent(new Event("change"));
        const model=document.querySelector("#session-config-model").value,effort=document.querySelector("#session-config-effort").value,targetDisabled=document.querySelector("#session-config-submit").disabled;
        document.querySelector("#session-config-dialog").close();
        Tasks.dev={backend:"codex",providerId:"codex",model:"gpt-5.5-pro",effort:"xhigh",turn:"idle",pending:[],queued:[],control:"ownward"};
        openSessionConfig("legacy-task");
        const legacyEffort=document.querySelector('#session-config-effort option[value="xhigh"]');
        const legacy={model:document.querySelector("#session-config-model").value,effort:document.querySelector("#session-config-effort").value,effortDisabled:legacyEffort?.disabled===true,disabled:document.querySelector("#session-config-submit").disabled};
        document.querySelector("#session-config-dialog").close();
        Tasks.dev={backend:"codex",providerId:"codex",model:"",effort:"medium",turn:"idle",pending:[],queued:[],control:"ownward"};
        openSessionConfig("model-sentinel");
        document.querySelector("#session-config-effort").value="high";document.querySelector("#session-config-effort").dispatchEvent(new Event("change"));
        const modelSentinel={model:document.querySelector("#session-config-model").value,effort:document.querySelector("#session-config-effort").value,disabled:document.querySelector("#session-config-submit").disabled,status:document.querySelector("#session-config-status").textContent};
        document.querySelector("#session-config-dialog").close();
        Tasks.dev={backend:"codex",providerId:"codex",model:"gpt-5.6-sol",effort:"",turn:"idle",pending:[],queued:[],control:"ownward"};
        openSessionConfig("effort-sentinel");
        document.querySelector("#session-config-model").value="gpt-5.6-luna";document.querySelector("#session-config-model").dispatchEvent(new Event("change"));
        const effortSentinel={model:document.querySelector("#session-config-model").value,effort:document.querySelector("#session-config-effort").value,disabled:document.querySelector("#session-config-submit").disabled};
        document.body.dataset.runtime=JSON.stringify({initialDisabled,explicitHasModelReset,explicitHasEffortReset,luna,model,effort,targetDisabled,legacy,modelSentinel,effortSentinel,matrix:WORK_CODEX_MODEL_EFFORTS,models:workProviderCapability("codex").models,errors:window.__runtimeErrors});
      </script>`);
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--dump-dom", `file://${fixture}`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const encoded = out.match(/data-runtime="([^"]+)"/)?.[1].replaceAll("&quot;", '"');
    expect(encoded).toBeTruthy();
    expect(JSON.parse(encoded!)).toEqual({
      initialDisabled: true,
      explicitHasModelReset: false,
      explicitHasEffortReset: false,
      luna: { effort: "medium", hasUltra: false, disabled: false },
      model: "sonnet",
      effort: "medium",
      targetDisabled: false,
      legacy: { model: "gpt-5.5-pro", effort: "xhigh", effortDisabled: true, disabled: true },
      modelSentinel: { model: "", effort: "high", disabled: false, status: "将就地切换模型/思考深度，沿用当前会话（不接力，下一轮生效）" },
      effortSentinel: { model: "gpt-5.6-luna", effort: "", disabled: false },
      matrix: {
        "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
        "gpt-5.5": ["low", "medium", "high", "xhigh"],
        "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
      },
      models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"],
      errors: [],
    });
  }, 15_000);
});
