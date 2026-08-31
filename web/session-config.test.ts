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
    expect(app).toContain('models: Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"])');
    expect(app).toContain('"gpt-5.6-sol": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"])');
    expect(app).toContain('"gpt-5.6-terra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"])');
    expect(app).toContain('"gpt-5.6-luna": Object.freeze(["low", "medium", "high", "xhigh", "max"])');
    expect(app).toContain('"gpt-5.5": Object.freeze(["low", "medium", "high", "xhigh"])');
    expect(app).toContain('"gpt-5.4": Object.freeze(["low", "medium", "high", "xhigh"])');
    expect(app).not.toContain('"gpt-5.5-pro"');
    expect(app).not.toContain('minimal: "minimal"');
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
    expect(tasks).toContain('post("/api/dev/handoff", payload)');
    expect(tasks).toContain('reason: providerId === dialog.dataset.currentProvider ? "manual-reconfigure" : "manual-handoff"');
    expect(tasks).toContain("sameProvider && !currentModel");
    expect(tasks).toContain("fillSessionConfigEfforts(effort, sameProvider, sameProvider)");
    expect(tasks).toContain('workProviderEfforts(values.providerId, values.model).includes(values.effort)');
    expect(tasks).toContain("沿用有界历史");
    expect(tasks).toContain('sessionConfigStatus("正在创建接力会话并应用配置…", "busy")');
    expect(tasks).toContain('sessionConfigStatus(`${applied ? "配置已应用，但刷新失败" : "应用失败"}');
  });

  test("task detail and Settings expose the active/default effort", () => {
    expect(tasks).toContain('title="当前思考深度">深度 ${esc(dev?.effort || "默认")}');
    expect(tasks).toContain('<b>思考深度</b>${esc(dev.effort || "Provider 默认")}');
    expect(settings).toContain('pointer==="/dispatch/defaults/effort"');
    expect(settings).toContain('pointer==="/dispatch/defaults/model"');
    expect(settings).toContain('efforts=workProviderEfforts(provider,dispatchDefaultModel())');
    expect(settings).toContain('path==="/dispatch/defaults/model"');
    expect(settings).toContain('effort:"默认思考深度"');
  });

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
      modelSentinel: { model: "", effort: "high", disabled: false, status: "将创建同 Provider 的新会话并沿用有界历史" },
      effortSentinel: { model: "gpt-5.6-luna", effort: "", disabled: false },
      matrix: {
        "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
        "gpt-5.5": ["low", "medium", "high", "xhigh"],
        "gpt-5.4": ["low", "medium", "high", "xhigh"],
      },
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
      errors: [],
    });
  }, 15_000);
});
