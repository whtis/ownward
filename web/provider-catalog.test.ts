import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const tempRoots: string[] = [];
afterEach(() => { while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true }); });

describe("provider catalog and dispatch engine reset", () => {
  test("opening the dispatch dialog resets the engine together with model/effort (no codex+opus leftovers)", () => {
    const openWork = app.slice(app.indexOf("const openWork = (dir) =>"), app.indexOf("const closeWork ="));
    // 2026-09-05 实撞：defaults 只配了 model=opus 没配 provider，上一次派发选的 codex 留在 <select> 里，
    // 弹窗就画出「codex + opus」。引擎必须和模型一起回到默认值，没配引擎就按默认模型反查
    expect(openWork).toContain('$("#w-engine").value = d.provider');
    expect(openWork).toContain('|| workProviderForModel(d.model || "")');
    expect(openWork).toContain('|| "claude";');
    expect(openWork.indexOf('$("#w-engine").value = d.provider')).toBeLessThan(openWork.indexOf("fillWorkProviderOptions({ model: d.model"));
  });

  test("real Chrome: model→provider lookup and applying the server catalog replace the built-in tables", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-provider-catalog-")); tempRoots.push(root);
    const fixture = join(root, "index.html");
    const appUrl = new URL("./app.js", import.meta.url).href;
    writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><body>
      <div id="toast"></div>
      <script>window.__runtimeErrors=[];addEventListener("error",event=>window.__runtimeErrors.push(event.message));</script>
      <script src="${appUrl}"></script>
      <script>
        const before={opus:workProviderForModel("opus"),sol:workProviderForModel("gpt-5.6-sol"),hy3:workProviderForModel("hy3"),none:workProviderForModel("nope"),blank:workProviderForModel("")};
        const rejectedGarbage=applyProviderCatalog({codex:{models:[]}});
        const rejectedShape=applyProviderCatalog(null);
        const applied=applyProviderCatalog({
          claude:{label:"Claude Code",models:["fable","opus","sonnet","haiku"],efforts:["low","medium","high","xhigh","max"]},
          codebuddy:{label:"CodeBuddy",models:["hy3"],efforts:["low","medium","high","xhigh","max"]},
          codex:{label:"Codex",source:"official-cache",defaultModel:"gpt-5.6-sol",models:[
            {slug:"gpt-7-nova",displayName:"GPT-7-Nova",efforts:["low","medium","high","ultra"],defaultEffort:"medium",fast:{name:"Fast",description:"2x"}},
            {slug:"gpt-5.6-sol",displayName:"GPT-5.6-Sol",efforts:["low","medium","high","xhigh","max","ultra"],defaultEffort:"low",fast:null},
            {slug:"broken",efforts:"nope"},
          ]},
        });
        const after={models:workProviderCapability("codex").models,nova:workProviderEfforts("codex","gpt-7-nova"),novaDefault:workProviderDefaultEffort("codex","gpt-7-nova"),gone:workProviderEfforts("codex","gpt-5.5"),provider:workProviderForModel("gpt-7-nova"),codebuddy:workProviderCapability("codebuddy").models,claudeEfforts:workProviderEfforts("claude","opus"),source:WORK_PROVIDER_CATALOG_SOURCE,info:WORK_CODEX_MODEL_INFO["gpt-7-nova"]};
        document.body.dataset.runtime=JSON.stringify({before,rejectedGarbage,rejectedShape,applied,after,errors:window.__runtimeErrors});
      </script>`);
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--dump-dom", `file://${fixture}`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const encoded = out.match(/data-runtime="([^"]+)"/)?.[1].replaceAll("&quot;", '"');
    expect(encoded).toBeTruthy();
    expect(JSON.parse(encoded!)).toEqual({
      before: { opus: "claude", sol: "codex", hy3: "codebuddy", none: "", blank: "" },
      rejectedGarbage: false,
      rejectedShape: false,
      applied: true,
      after: {
        models: ["gpt-7-nova", "gpt-5.6-sol"],
        nova: ["low", "medium", "high", "ultra"],
        novaDefault: "medium",
        gone: [],
        provider: "codex",
        codebuddy: ["hy3"],
        claudeEfforts: ["low", "medium", "high", "xhigh", "max"],
        source: "official-cache",
        info: { displayName: "GPT-7-Nova", defaultEffort: "medium", fast: { name: "Fast", description: "2x" } },
      },
      errors: [],
    });
  });
});
