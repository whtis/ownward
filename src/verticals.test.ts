import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { canonicalTaskExtraDirs, devLegacyRoutes, devVerticalManifest, projectExternalVerticalNavigation, scopedTasks } from "./verticals.ts";
import type { VerticalManifest, VerticalStatus } from "./kernel/extensions/contracts.ts";
import { createDevVertical } from "./verticals/dev.ts";
import { createDevDomainAdapter } from "./verticals/dev-domain-adapter.ts";
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true})});
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),"ownward-task-grant-"))),outside=realpathSync(mkdtempSync(join(tmpdir(),"ownward-task-outside-")));roots.push(root,outside);mkdirSync(join(root,"project"));symlinkSync(outside,join(root,"escape"));return{root,outside};}
const navStatus = (id: string, state: VerticalStatus["state"], source: VerticalStatus["source"] = "external"): VerticalStatus => ({ id, name: id, version: "1.0.0", source, state, consecutiveFailures: 0 });
const navManifest = (id: string, navigation: NonNullable<VerticalManifest["navigation"]>): VerticalManifest => ({ id, name: id, version: "1.0.0", kernelApiVersion: 1, entry: "index.ts", capabilities: [], roots: [], routes: [], assets: [], navigation });

describe("external Vertical navigation projection", () => {
  test("only ready/degraded external manifests can project links under their own namespace", () => {
    const statuses = [
      navStatus("ready-ext", "ready"), navStatus("degraded-ext", "degraded"),
      navStatus("disabled-ext", "disabled"), navStatus("failed-ext", "failed"),
      navStatus("builtin-ready", "ready", "builtin"),
    ];
    const manifests = statuses.map((status) => navManifest(status.id, [{ id: `${status.id}-home`, label: status.name, href: `/verticals/${status.id}/index.html` }]));
    expect(projectExternalVerticalNavigation(statuses, manifests)).toEqual([
      { verticalId: "ready-ext", id: "ready-ext-home", label: "ready-ext", href: "/verticals/ready-ext/index.html", state: "ready" },
      { verticalId: "degraded-ext", id: "degraded-ext-home", label: "degraded-ext", href: "/verticals/degraded-ext/index.html", state: "degraded" },
    ]);
  });

  test("rejects cross-namespace, traversal, encoded, URL, query and prefix-sibling hrefs", () => {
    const hrefs = [
      "/verticals/other/index.html", "/verticals/safe-evil/index.html", "/verticals/safe/../secret.html",
      "/verticals/safe/%2e%2e/secret.html", "/verticals/safe/index.html?token=x",
      "/verticals/safe/index.html#x", "https://example.com/verticals/safe/index.html", "//example.com/verticals/safe/index.html",
    ];
    const manifest = navManifest("safe", hrefs.map((href, index) => ({ id: `entry-${index}`, label: `Entry ${index}`, href })));
    expect(projectExternalVerticalNavigation([navStatus("safe", "ready")], [manifest])).toEqual([]);
  });

  test("keeps hostile-looking labels as inert text and deterministically removes duplicate ids/hrefs/statuses", () => {
    const label = '<img src=x onerror="globalThis.pwned=1">';
    const manifest = navManifest("safe", [
      { id: "home", label, href: "/verticals/safe/index.html" },
      { id: "home", label: "duplicate id", href: "/verticals/safe/other.html" },
      { id: "other", label: "duplicate href", href: "/verticals/safe/index.html" },
    ]);
    expect(projectExternalVerticalNavigation([navStatus("safe", "ready"), navStatus("safe", "degraded")], [manifest])).toEqual([
      { verticalId: "safe", id: "home", label, href: "/verticals/safe/index.html", state: "ready" },
    ]);
  });
});
// 接管幂等：bind() 按 nativeRef 去重，若调用方先 mint 了 task 再 adopt，多出来的卡片就永远
// 指向同一个对话（2026-08-24 实撞：一条 Session 挂了三个 taskId，三张卡点进去是同一个会话）。
// 用子进程 + 独立 OWNWARD_DATA_ROOT 跑，因为它真的会建卡落盘——绝不能写进生产 data。
describe("外部会话接管", () => {
  test("同一个原生会话接管两次只留一张卡，且卡片不冒充「成功」", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ownward-adopt-idem-")));
    roots.push(root);
    const cwd = join(root, "repo"); mkdirSync(cwd);
    const q = (v: unknown) => JSON.stringify(v);
    const script = [
      `const {adoptSessionCandidate}=await import(${q(join(process.cwd(), "src/verticals.ts"))});`,
      `const {loadTasks}=await import(${q(join(process.cwd(), "src/dispatch.ts"))});`,
      `const base={provider:"claude",nativeId:"019ffae9-ad07-7ef0-ab0a-761b9a426650",cwd:${q(cwd)},project:"repo"};`,
      `const first=await adoptSessionCandidate({...base,title:"第一次接管"});`,
      `const second=await adoptSessionCandidate({...base,title:"又点了一次接管"});`,
      `console.log(JSON.stringify({first,second,ids:loadTasks().map(t=>t.id)}));`,
    ].join("");
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(r.second.id).toBe(r.first.id);
    expect(r.ids).toEqual([r.first.id]);
    // 接管不是一次运行：没有退出码，也不该显示成「成功」
    expect(r.first.kind).toBe("adopted");
    expect(r.first.status).toBe("done");
    expect(r.first.exitCode).toBeUndefined();
  });
});

describe("first-party dev scoped Task Service",()=>{
  test("no roots only disables work dispatch; read/review/approval routes remain owned",()=>{const manifest=devVerticalManifest([]),legacy=devLegacyRoutes([]);expect(manifest.roots).toEqual([]);expect(manifest.commands).toEqual([]);expect(manifest.capabilities).toEqual(["actions"]);expect(legacy).not.toContain("/api/work");expect(legacy).toContain("/api/gh/prs");expect(legacy).toContain("/api/evolve/apply");});
  test("one stale root is skipped without disabling valid task grants",async()=>{const f=fixture(),tasks=scopedTasks([join(f.root,"missing"),f.root]);expect(tasks.list()).toEqual([]);const unavailable=scopedTasks([join(f.root,"missing")]);expect(unavailable.list()).toEqual([]);await expect(unavailable.startWork({dir:f.root,task:"must not run"})).rejects.toMatchObject({code:"VERTICAL_ROOT_UNAVAILABLE"});});
  test("legacy and namespaced work responses preserve the exact legacy msg",async()=>{const task={id:"task-1",mode:"claude-bg"},vertical=createDevVertical({domain:createDevDomainAdapter(()=>({route:async()=>new Response("domain")}))});vertical.activate!({tasks:{startWork:async()=>task,list:()=>[]},log:()=>{}} as any);for(const path of["/api/work","/api/verticals/dev/work"]){const response=await vertical.route!({request:new Request(`http://x${path}`,{method:"POST",body:"{}",headers:{"content-type":"application/json"}}),url:new URL(`http://x${path}`),signal:new AbortController().signal});expect(await response!.json()).toEqual({ok:true,msg:"已派发 [task-1] claude-bg",task});}});
  test("legacy and namespaced work routes expose denied cwd as an actionable 403",async()=>{const denied=Object.assign(new Error("项目目录未授权。请在 config.json 的 architecture.allowedRoots 中加入该目录，然后运行 bash install.sh"),{code:"VERTICAL_CWD_NOT_GRANTED"}),vertical=createDevVertical({domain:createDevDomainAdapter(()=>({route:async()=>new Response("domain")}))});vertical.activate!({tasks:{startWork:async()=>{throw denied},list:()=>[]},log:()=>{}} as any);for(const path of["/api/work","/api/verticals/dev/work"]){const response=await vertical.route!({request:new Request(`http://x${path}`,{method:"POST",body:"{}",headers:{"content-type":"application/json"}}),url:new URL(`http://x${path}`),signal:new AbortController().signal});expect(response!.status).toBe(403);expect(await response!.json()).toEqual({ok:false,msg:denied.message,errorCode:"VERTICAL_CWD_NOT_GRANTED"});}});
  test("missing task capability does not disable cc-hook and other dev routes",async()=>{const vertical=createDevVertical({domain:createDevDomainAdapter(()=>({route:async(_request:Request,url:URL)=>new Response(`handled:${url.pathname}`)}))});vertical.activate!({log:()=>{}} as any);const route=async(path:string)=>vertical.route!({request:new Request(`http://x${path}`,{method:"POST"}),url:new URL(`http://x${path}`),signal:new AbortController().signal});expect(await (await route("/api/cc-hook"))!.text()).toBe("handled:/api/cc-hook");expect((await route("/api/verticals/dev/work"))!.status).toBe(503);});
  test("realpath grants reject symlink escape before dispatch with an actionable policy error",async()=>{const f=fixture(),tasks=scopedTasks([f.root]);try { await tasks.startWork({dir:join(f.root,"escape"),task:"must not run"}); throw new Error("expected rejection"); } catch (error:any) { expect(error.code).toBe("VERTICAL_CWD_NOT_GRANTED"); expect(error.message).toContain("architecture.allowedRoots"); }});
  test("Vertical bypass requires explicit capability and global allowFullAccess",async()=>{const f=fixture(),tasks=scopedTasks([f.root]);await expect(tasks.startWork({dir:join(f.root,"project"),task:"must not run",permission:"bypass"} as any)).rejects.toThrow("SESSION_ACCESS_NOT_GRANTED");await expect(tasks.startWork({dir:join(f.root,"project"),task:"must not run",shell:"rm"} as any)).rejects.toThrow("VERTICAL_TASK_INPUT_INVALID");});
  test("every scoped Task input field is whitelisted and malformed values fail before dispatch",async()=>{const f=fixture(),tasks=scopedTasks([f.root]),base={dir:join(f.root,"project"),task:"must not run"},invalid=[{bg:"yes"},{codex:1},{worktree:null},{model:1},{effort:false},{permission:"root"},{extraDirs:[1]},{images:"x"},{images:[null]},{images:[{media_type:"image/png",data:"x",path:"/tmp/x"}]},{images:[{media_type:1,data:"x"}]},{images:[{media_type:"image/png",data:1}]}];for(const value of invalid)await expect(tasks.startWork({...base,...value} as any)).rejects.toThrow("VERTICAL_TASK_INPUT_INVALID");});
  test("terminal dispatch rejects extra directories at the API boundary",async()=>{const f=fixture(),tasks=scopedTasks([f.root]);await expect(tasks.startWork({dir:join(f.root,"project"),task:"x",bg:false,extraDirs:[f.root]})).rejects.toThrow("terminal 模式不支持附加目录");});
  test("extra directories are canonical, deduplicated and capped before dispatch",()=>{const f=fixture(),primary=realpathSync(join(f.root,"project")),grant=(dir:string)=>realpathSync(dir);expect(canonicalTaskExtraDirs([f.root,join(f.root,"."),primary],primary,grant)).toEqual([f.root]);const dirs=Array.from({length:33},(_,i)=>{const dir=join(f.root,`extra-${i}`);mkdirSync(dir);return dir});expect(()=>canonicalTaskExtraDirs(dirs,primary,grant)).toThrow("最多 32 个");});
  test("task grants expand home and blank provider options normalize before dispatch",async()=>{const home=process.env.HOME!,project=mkdtempSync(join(home,"ownward-vertical-home-"));try{const tasks=scopedTasks([home]);await expect(tasks.startWork({dir:`~/${project.split("/").at(-1)}`,task:"must not run",permission:"bypass",model:"",effort:""} as any)).rejects.toThrow("SESSION_ACCESS_NOT_GRANTED");const f=fixture();try{await tasks.startWork({dir:f.root,task:"x",permission:"",model:" ",effort:""} as any);}catch(error:any){expect(String(error.message)).not.toContain("VERTICAL_TASK_INPUT_INVALID");expect(String(error.message)).not.toContain("effort 非法");}}finally{rmSync(project,{recursive:true,force:true});}});
  test("the complete Dev Vertical boundary cannot import Workbench, domain implementations, or Kernel private storage",()=>{const dir=join(import.meta.dir,"verticals"),files=readdirSync(dir).filter((name)=>/^dev(?:-domain-(?:adapter|service))?\.ts$/.test(name));expect(files.sort()).toEqual(["dev-domain-adapter.ts","dev-domain-service.ts","dev.ts"]);for(const file of files){const source=readFileSync(join(dir,file),"utf8");for(const forbidden of ["workbench.ts","dispatch.ts","terminal-tasks.ts","repo-panel.ts","github-pr.ts","flight-record.ts","sessions/repository.ts","kernel/sessions/service.ts","DATA"])expect(source,`${file} imports or reads ${forbidden}`).not.toContain(forbidden);}});
  test("Dev domain handler uses explicit Kernel gateways instead of private repositories",()=>{const source=readFileSync(join(import.meta.dir,"dev/domain-handler.ts"),"utf8");for(const forbidden of ["workbench.ts","sessions/repository.ts","kernel/sessions/service.ts","kernel/sessions/terminal-adopt.ts","session-service.ts","DATA"])expect(source).not.toContain(forbidden);});
  test("every production module under src/dev has an exact import allowlist and cannot discover Provider sessions or private storage",()=>{const dir=join(import.meta.dir,"dev"),files=readdirSync(dir).filter((name)=>name.endsWith(".ts")&&!name.endsWith(".test.ts"));expect(files).toEqual(["domain-handler.ts"]);const allowed=["../flight-record.ts","../github-pr.ts","../kernel/extensions/contracts.ts","../repo-panel.ts","../terminal-tasks.ts","../verticals/dev-domain-service.ts"];for(const file of files){const source=readFileSync(join(dir,file),"utf8"),imports=[...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map((match)=>match[1]).sort();expect(imports,`${file} import surface changed`).toEqual(allowed);for(const forbidden of ["actions.ts","dispatch.ts","util.ts","cc-sessions.ts","codex-sessions.ts","providers/","workbench.ts","sessions/repository.ts","kernel/sessions/","session-service.ts","DATA","process.env.HOME"])expect(source,`${file} crosses ${forbidden}`).not.toContain(forbidden);}});
});
