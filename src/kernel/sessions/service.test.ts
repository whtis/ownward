import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRunJournalStrict, RunRepository } from "../../runs/repository.ts";
import { migrateLegacySessions, SessionRepository } from "../../sessions/repository.ts";
import type { RunnerEventRecord } from "../../runner/journals.ts";
import { RunnerCommandJournal, RunnerEventJournal } from "../../runner/journals.ts";
import { KernelSessionService, readStableRunnerSnapshot, shellQuote } from "./service.ts";
import { effectiveSessionMigrationMode } from "./contracts.ts";
import { cfg } from "../../util.ts";
import { KernelSessionPolicyError, projectRunnerEvent, RunnerAgentStateProjector, RunnerSessionConsumer, validateDirectoryGrant } from "./runner-consumer.ts";
import { RunnerServer, type RunnerProvider } from "../../runner/server.ts";
import { SessionRunnerBridgeStore } from "./bridge-store.ts";
import { createSessionService, SESSION_SERVICE_CACHE_LIMIT } from "../../session-service.ts";
import { readInitialHistorySnapshot, writeInitialHistory } from "./initial-history.ts";

const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "ownward-kernel-session-")); roots.push(root); return root; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function seed(root: string, providerId: "claude" | "codex" = "claude") {
  const cwd = join(root, "repo"); mkdirSync(cwd);
  const session = new SessionRepository(root).reserve({ taskId: "task", providerId, cwd });
  return { cwd, session };
}

describe("Kernel SessionService migration modes", () => {
  test("state, states, refreshHistory and restart share the same public handoff projection",async()=>{const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);const first=repo.reserve({taskId:"task",providerId:"claude",cwd});writeInitialHistory(root,{sessionId:first.id,providerId:"claude",nativeRef:"old",messages:[{role:"user",text:"visible old",ts:"2026-08-01T00:00:00.000Z"}]});const current=repo.handoff({taskId:"task",providerId:"codex",reason:"switch"}).current,bridge=new SessionRunnerBridgeStore(root),identity={commandId:"internal-command",runId:"internal-run"},input=JSON.stringify({text:"SECRET",images:[]});bridge.reserve({taskId:"task",sessionId:current.id,providerId:"codex",kind:"start-run",serializedInput:input,clientMutationId:"handoff:old:codex",identity});new RunnerCommandJournal(root).accept({...identity,kind:"start-run",sessionId:current.id,providerId:"codex",input});bridge.advance(identity.commandId,0,true);const service=new KernelSessionService(root),states=[await service.state("task"),(await service.states(["task"])).get("task")!,await service.refreshHistory("task"),await new KernelSessionService(root).state("task")];for(const state of states){expect(state.messages.map(m=>m.text)).toEqual(["visible old","已从 claude 接力到 codex：switch"]);expect(JSON.stringify(state)).not.toContain("SECRET");expect(JSON.stringify(state)).not.toContain("command:");}});
  test("internal bootstrap filtering uses command identity and preserves a real user input with the same acceptedAt",async()=>{const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);repo.reserve({taskId:"task",providerId:"claude",cwd});const current=repo.handoff({taskId:"task",providerId:"codex"}).current,at="2026-08-25T00:00:00.000Z",journal=new RunnerCommandJournal(root),bridge=new SessionRunnerBridgeStore(root);for(const [commandId,text,internal] of [["bootstrap-command","SECRET",true],["real-command","REAL USER",false]] as const){journal.accept({commandId,runId:`${commandId}-run`,kind:"start-run",sessionId:current.id,providerId:"codex",input:JSON.stringify({text,images:[]})},at);if(internal){bridge.reserve({taskId:"task",sessionId:current.id,providerId:"codex",kind:"start-run",serializedInput:JSON.stringify({text,images:[]}),clientMutationId:"handoff:old:codex",identity:{commandId,runId:`${commandId}-run`}});bridge.advance(commandId,0,true);}}const state=await new KernelSessionService(root).state("task");expect(state.messages.filter(m=>m.role==="user").map(m=>m.text)).toEqual(["REAL USER"]);expect(JSON.stringify(state)).not.toContain("SECRET");});
  test("three-provider handoff chain projects identically for state, states and restart without exposing bootstrap input",async()=>{const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);const first=repo.reserve({taskId:"task",providerId:"claude",cwd});writeInitialHistory(root,{sessionId:first.id,providerId:"claude",nativeRef:"bootstrap",messages:[{role:"user",text:"goal",ts:"2026-08-01T00:00:00.000Z"}]});const second=repo.handoff({taskId:"task",providerId:"codex",reason:"quota"}).current;writeInitialHistory(root,{sessionId:second.id,providerId:"codex",nativeRef:"bootstrap",messages:[{role:"assistant",text:"middle",ts:"2026-08-01T00:01:00.000Z"}]});const third=repo.handoff({taskId:"task",providerId:"codebuddy",reason:"fallback"}).current;writeInitialHistory(root,{sessionId:third.id,providerId:"codebuddy",nativeRef:"bootstrap",messages:[{role:"assistant",text:"current",ts:"2026-08-01T00:02:00.000Z"}]});const bridge=new SessionRunnerBridgeStore(root),identity={commandId:"handoff-bootstrap",runId:"handoff-run"};bridge.reserve({taskId:"task",sessionId:third.id,providerId:"codebuddy",kind:"start-run",serializedInput:JSON.stringify({text:"SECRET TRANSCRIPT",images:[]}),clientMutationId:`handoff:${second.id}:codebuddy`,identity});new RunnerCommandJournal(root).accept({...identity,kind:"start-run",sessionId:third.id,providerId:"codebuddy",input:JSON.stringify({text:"SECRET TRANSCRIPT",images:[]})});bridge.advance("handoff-bootstrap",0,true);const service=new KernelSessionService(root),single=await service.state("task"),batch=(await service.states(["task"])).get("task")!,restarted=await new KernelSessionService(root).state("task");for(const state of[single,batch,restarted]){expect(state.messages.map(m=>m.text)).toEqual(["goal","已从 claude 接力到 codex：quota","middle","已从 codex 接力到 codebuddy：fallback","current"]);expect(JSON.stringify(state)).not.toContain("SECRET TRANSCRIPT");expect(state.providerId).toBe("codebuddy");}});
  test("initial history normalizes legacy roles, quarantines malformed snapshots, and permits nativeRef rotation",()=>{const root=fresh();writeInitialHistory(root,{sessionId:"history",providerId:"claude",nativeRef:"old",messages:[{role:"thinking",text:"reason",ts:"2026-08-01T00:00:00Z"}]});expect(readInitialHistorySnapshot(root,"history")?.messages).toMatchObject([{role:"assistant",text:"reason"}]);writeInitialHistory(root,{sessionId:"history",providerId:"claude",nativeRef:"new",messages:[{role:"assistant",text:"answer",ts:"2026-08-01T00:00:01Z"}]});expect(readInitialHistorySnapshot(root,"history")?.nativeRef).toBe("new");writeFileSync(join(root,"session-history/broken.json"),"{");expect(readInitialHistorySnapshot(root,"broken")).toBeNull();expect(existsSync(join(root,"session-history/broken.json"))).toBeFalse();});
  test("composition root caches native identities independently of the legacy allowlist",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).bind({taskId:"cache",providerId:"claude",nativeRef:"native",cwd});const previous=cfg.architecture.sessionRunnerTaskIds;try{cfg.architecture.sessionRunnerTaskIds=[];const a=createSessionService("cache",[root],root),b=createSessionService("cache",[root],root);expect(a).toBe(b);cfg.architecture.sessionRunnerTaskIds=["other"];expect(createSessionService("cache",[root],root)).toBe(a);}finally{cfg.architecture.sessionRunnerTaskIds=previous;}});
  test("native identities bypass the legacy canary for state, send and control",async()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).bind({taskId:"native",providerId:"claude",nativeRef:"native-ref",cwd});const previousMode=cfg.architecture.sessionRunnerMode,previousIds=cfg.architecture.sessionRunnerTaskIds;try{cfg.architecture.sessionRunnerMode="runner";cfg.architecture.sessionRunnerTaskIds=["other"];const service=createSessionService("native",[root],root);expect((await service.state("native")).providerId).toBe("claude");for(const call of[()=>service.send("native",{text:"hello"}),()=>service.acquireControl("native","observing")]){try{await call();}catch(error:any){expect(error?.code).not.toBe("SESSION_CANARY_NOT_GRANTED");}}}finally{cfg.architecture.sessionRunnerMode=previousMode;cfg.architecture.sessionRunnerTaskIds=previousIds;}});
  test("composition root cache is bounded and evicts the least recently used service",()=>{const firstRoot=fresh(),cwd=join(firstRoot,"repo");mkdirSync(cwd);new SessionRepository(firstRoot).bind({taskId:"cache-lru",providerId:"claude",nativeRef:"native",cwd});const first=createSessionService("cache-lru",[firstRoot],firstRoot);for(let i=0;i<SESSION_SERVICE_CACHE_LIMIT;i++){const root=fresh(),dir=join(root,"repo");mkdirSync(dir);new SessionRepository(root).bind({taskId:`cache-${i}`,providerId:"claude",nativeRef:`native-${i}`,cwd:dir});createSessionService(`cache-${i}`,[root],root);}expect(createSessionService("cache-lru",[firstRoot],firstRoot)).not.toBe(first);});
  test("per-service state cache is bounded and disposable",async()=>{const root=fresh(),repo=new SessionRepository(root),service=new KernelSessionService(root);for(let i=0;i<40;i++){const cwd=join(root,`repo-${i}`);mkdirSync(cwd);repo.reserve({taskId:`state-${i}`,providerId:"claude",cwd});await service.state(`state-${i}`);}expect(service.cacheSizeForTest()).toBeLessThanOrEqual(32);service.dispose();expect(service.cacheSizeForTest()).toBe(0);});
  test("batch state snapshot retries when Runner appends between read and signature",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).reserve({taskId:"snapshot",providerId:"claude",cwd});const commands=new RunnerCommandJournal(root),events=new RunnerEventJournal(root),command=commands.accept({commandId:"snapshot-command",kind:"start-run",runId:"snapshot-run",sessionId:"snapshot",providerId:"claude",input:"{}"}).record;events.append({eventId:"snapshot-started",type:"started",at:"2026-08-17T00:00:00.000Z",commandId:command.commandId,runId:command.runId,sessionId:"snapshot",providerId:"claude"});let appended=false;const snapshot=readStableRunnerSnapshot(root,()=>{if(appended)return;appended=true;events.append({eventId:"snapshot-message",type:"message-completed",at:"2026-08-17T00:00:00.001Z",commandId:command.commandId,runId:command.runId,sessionId:"snapshot",providerId:"claude",payload:JSON.stringify({text:"fresh"})});});expect(snapshot.events.map(event=>event.eventId)).toContain("snapshot-message");expect(snapshot.signature).toContain("events:2");});
  test("resume shell arguments use single-quote escaping", () => { expect(shellQuote("a'b$`c")).toBe("'a'\"'\"'b$`c'"); });
  test("runner state uses the shared interactive Codex resume command",async()=>{const root=fresh(),cwd=join(root,"repo"),a="00000000-0000-4000-8000-000000000011",b="00000000-0000-4000-8000-000000000012";mkdirSync(cwd);new SessionRepository(root).bind({taskId:"default",providerId:"codex",nativeRef:a,providerHome:"codex",cwd});new SessionRepository(root).bind({taskId:"alternate",providerId:"codex",nativeRef:b,providerHome:"codex-alt",cwd});const service=new KernelSessionService(root);expect((await service.state("default")).resume?.cmd).toBe(`cd '${cwd}' && codex resume '${a}'`);expect((await service.state("alternate")).resume?.cmd).toBe(`cd '${cwd}' && CODEX_HOME="$HOME/.codex-alt" codex resume '${b}'`);});
  test("runner canary selection is stable and empty allowlist explicitly means all", () => {
    expect(effectiveSessionMigrationMode("off", "a", ["a"])).toBe("off");
    expect(effectiveSessionMigrationMode("runner", "a", [])).toBe("runner");
    expect(effectiveSessionMigrationMode("runner", "a", ["a"])).toBe("runner");
    expect(effectiveSessionMigrationMode("runner", "b", ["a"])).toBe("off");
    expect(() => effectiveSessionMigrationMode("runner", "a", [""])).toThrow("sessionRunnerTaskIds");
    expect(effectiveSessionMigrationMode("off", "a", undefined)).toBe("off");
    expect(() => effectiveSessionMigrationMode("off", "a", {})).toThrow("sessionRunnerTaskIds");
  });

  test("canonical Session allowlist gives every shared task alias one effective mode", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "older", mode: "claude-bg", cwd }, { id: "newer", mode: "claude-bg", cwd }])); mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks/older.session.json"), JSON.stringify({ toolSessionId: "shared" })); writeFileSync(join(root, "tasks/newer.session.json"), JSON.stringify({ toolSessionId: "shared" })); new SessionRepository(root).reconcile();
    const service = new KernelSessionService(root, { mode: "runner", taskIds: ["older"] });
    expect((await service.state("newer")).providerId).toBe("claude");
    await expect(new KernelSessionService(root, { mode: "runner", taskIds: ["other"] }).state("older")).rejects.toMatchObject({ code: "SESSION_CANARY_NOT_GRANTED" });
  });

  test("workbench off only restores existing legacy identity access", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "task", mode: "claude-bg", cwd }])); mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks/task.session.json"), JSON.stringify({ toolSessionId: "legacy-native", messages: [{ role: "assistant", text: "legacy" }] }));
    const script = `
      import {cfg} from ${JSON.stringify(join(process.cwd(), "src/util.ts"))};
      import {handleWorkbench} from ${JSON.stringify(join(process.cwd(), "src/workbench.ts"))};
      const call=async()=>{const u=new URL("http://localhost/api/dev/messages?id=task");return await (await handleWorkbench(new Request(u),u)).json()};
      const send=async()=>{const u=new URL("http://localhost/api/dev/send");const r=await handleWorkbench(new Request(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"task",text:"hello"})}),u);return {status:r.status,body:await r.json()}};
      const status=async()=>{const u=new URL("http://localhost/api/system/session-runner-status");return await (await handleWorkbench(new Request(u),u)).json()};
      cfg.architecture.sessionRunnerTaskIds=[]; cfg.architecture.sessionRunnerMode="off"; const off=await call();
      cfg.architecture.sessionRunnerMode="runner"; const unavailable=await send();
      cfg.architecture.sessionRunnerTaskIds=["other"]; const runnerStatus=await status(); const canaryOff=await call(); const canaryWrite=await send();
      cfg.architecture.sessionRunnerMode="off"; const rollback=await call(); const rollbackWrite=await send();
      console.log(JSON.stringify({off,unavailable,runnerStatus,canaryOff,canaryWrite,rollback,rollbackWrite}));`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); expect(code, err).toBe(0); const result = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(result.off.messages[0].text).toBe("legacy"); expect(result.unavailable.status).toBe(503); expect(result.unavailable.body).toMatchObject({ ok: false, errorCode: "RUNNER_UNAVAILABLE" }); expect(result.unavailable.body.commandId).toBeString(); expect(result.unavailable.body.msg).toContain("Runner"); expect(result.runnerStatus).toMatchObject({ canary: { count: 1 }, runner: { ok: false, errorCode: "RUNNER_UNAVAILABLE" } }); expect(JSON.stringify(result.runnerStatus)).not.toContain("other"); expect(result.canaryOff.messages[0].text).toBe("legacy"); expect(result.canaryWrite).toMatchObject({ status: 409, body: { errorCode: "SESSION_RUNNER_DRAIN_REQUIRED" } }); expect(result.rollback.messages[0].text).toBe("legacy"); expect(result.rollbackWrite.status).toBe(409);
  });
  test("off fails closed instead of reopening legacy mutations when SessionRepository is corrupt", async () => {
    const root = fresh(), cwd = join(root, "repo"), extra = join(root, "extra"); mkdirSync(cwd); mkdirSync(extra); writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "task", mode: "codex-bg", cwd }])); mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks/task.codex.json"), JSON.stringify({ rolloutId: "rollout", home: "codex", cwd })); writeFileSync(join(root, "sessions.json"), "{");
    const script = `import {cfg} from ${JSON.stringify(join(process.cwd(), "src/util.ts"))};import {adoptCodexSession} from ${JSON.stringify(join(process.cwd(), "src/codex-session.ts"))};import {handleWorkbench} from ${JSON.stringify(join(process.cwd(), "src/workbench.ts"))};cfg.architecture.sessionRunnerMode="off";cfg.architecture.sessionRunnerTaskIds=[];adoptCodexSession("task",${JSON.stringify(cwd)},"codex","rollout",[]);const post=async(path,body)=>{const u=new URL("http://localhost"+path),r=await handleWorkbench(new Request(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),u);return {status:r.status,body:await r.json()}};console.log(JSON.stringify({dir:await post("/api/dev/add-dir",{id:"task",dir:${JSON.stringify(extra)}}),access:await post("/api/dev/set-access",{id:"task",full:true}),control:await post("/api/dev/control",{id:"task",action:"release"}),interrupt:await post("/api/dev/interrupt",{id:"task"}),decision:await post("/api/dev/decision",{id:"task",requestId:"missing",allow:true})}))`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); expect(code, err).toBe(0); const result = JSON.parse(out.trim().split("\n").at(-1)!);
    expect([result.dir,result.access,result.control,result.interrupt,result.decision].every((x:any)=>x.status===400)).toBeTrue();expect(JSON.stringify(result)).toContain("sessions.json");
  });

  test("corrupt Runner journal fails closed even when SessionRepository identity is unavailable", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "task", mode: "codex-bg", cwd }])); mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks/task.codex.json"), JSON.stringify({ rolloutId: "rollout", home: "codex", cwd })); writeFileSync(join(root, "sessions.json"), "{"); mkdirSync(join(root, "runner")); writeFileSync(join(root, "runner/commands.jsonl"), "{broken}\n");
    const script = `import {cfg} from ${JSON.stringify(join(process.cwd(), "src/util.ts"))};import {handleWorkbench} from ${JSON.stringify(join(process.cwd(), "src/workbench.ts"))};cfg.architecture.sessionRunnerMode="off";cfg.architecture.sessionRunnerTaskIds=[];const u=new URL("http://localhost/api/dev/interrupt"),r=await handleWorkbench(new Request(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"task"})}),u);console.log(JSON.stringify({status:r.status,body:await r.json()}))`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); expect(code, err).toBe(0); const result=JSON.parse(out.trim().split("\n").at(-1)!);expect(result.status).toBe(400);expect(result.body.ok).toBeFalse();
  });

  test("invalid migration mode fails at construction", () => { const root = fresh(); expect(() => new KernelSessionService(root, { mode: "invalid" as any })).toThrow("未知 sessionRunnerMode"); });

  test("shared nativeRef keeps the caller task alias instead of forwarding taskIds[0]", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "older", mode: "claude-bg", cwd }, { id: "newer", mode: "claude-bg", cwd }])); mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks/older.session.json"), JSON.stringify({ toolSessionId: "shared", messages: [{ role: "assistant", text: "older" }] })); writeFileSync(join(root, "tasks/newer.session.json"), JSON.stringify({ toolSessionId: "shared", messages: [{ role: "assistant", text: "newer" }] })); new SessionRepository(root).reconcile();
    const script = `import {KernelSessionService} from ${JSON.stringify(join(process.cwd(), "src/kernel/sessions/service.ts"))};console.log(JSON.stringify(await new KernelSessionService(${JSON.stringify(root)},{mode:"off"}).state("newer")))`; const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); expect(code, err).toBe(0); expect(JSON.parse(out.trim().split("\n").at(-1)!).messages).toEqual([{ role: "assistant", text: "newer" }]);
  });

  test("create/adopt return stable DTO and enforce Kernel cwd grants", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); const consumer: any = { readHistory: async () => [{ role: "system", text: "history" }] }; const service = new KernelSessionService(root, {}, consumer);
    const created = await service.create({ taskId: "task", providerId: "claude", cwd }, { roots: [root], access: "workspace" });
    expect(created).toEqual({ id: "task", providerId: "claude", nativeRef: null, cwd: realpathSync(cwd), control: "ownward", recoverable: false, taskIds: ["task"], operability: "active" });
    const adopted = await service.adopt({ taskId: "task", providerId: "claude", nativeRef: "native-1", cwd }, { roots: [root], access: "workspace" });
    expect(adopted).toMatchObject({ id: "task", nativeRef: "native-1", recoverable: true });
    await expect(service.create({ taskId: "bad", providerId: "claude", cwd: fresh() }, { roots: [root], access: "workspace" })).rejects.toMatchObject({ code: "SESSION_CWD_NOT_GRANTED" });
  });

  test("archived orphan is explicitly read-only while native ref and copied history remain visible",async()=>{
    const root=fresh(),cwd=join(root,"gone"),stamp="2026-08-17T00:00:00.000Z";mkdirSync(cwd,{recursive:true});mkdirSync(join(root,"kernel"));
    writeFileSync(join(root,"kernel/sessions.json"),JSON.stringify({schemaVersion:1,sessions:[{id:"archived",providerId:"claude",nativeRef:"native-kept",previousRefs:[],cwd,control:"external",taskIds:[],recoverable:true,source:"legacy",createdAt:stamp,updatedAt:stamp,archive:{state:"orphaned-task-link",originalTaskRefs:["missing-task"],migrationId:"stage6-kernel-sessions-v1",reason:"task-record-missing",sourceAggregateSha256:"a".repeat(64)}}]}));
    writeInitialHistory(root,{status:"ok",sessionId:"archived",providerId:"claude",nativeRef:"native-kept",messages:[{role:"assistant",text:"history kept",ts:stamp}]});
    let historyReads=0;const runner:any={readHistory:async()=>{historyReads++;throw new Error("must not read provider")},submit:async()=>{throw new Error("must not mutate")}},service=new KernelSessionService(root,{roots:[root]},runner);
    expect(await service.state("archived")).toMatchObject({messages:[{text:"history kept"}],resume:null,alive:false,operability:"read-only",archiveState:"orphaned-task-link"});
    expect((await service.states(["archived"])).get("archived")).toMatchObject({messages:[{text:"history kept"}],operability:"read-only"});expect(historyReads).toBe(0);
    await expect(service.refreshHistory("archived")).rejects.toMatchObject({code:"SESSION_ARCHIVED_READ_ONLY"});expect(historyReads).toBe(0);
    const mutations=[()=>service.send("archived",{text:"x"}),()=>service.resume("archived",{text:"x"}),()=>service.interrupt("archived"),()=>service.respondApproval("archived","request",{allow:true}),()=>service.addDirectory("archived",root),()=>service.acquireControl("archived","ownward"),()=>service.setAccess("archived","workspace"),()=>service.newSession("archived")];
    for(const mutation of mutations)await expect(mutation()).rejects.toMatchObject({code:"SESSION_ARCHIVED_READ_ONLY"});
  });

  test("archived state without a local initial-history snapshot is unavailable without Provider fallback or disk writes",async()=>{const root=fresh(),cwd=join(root,"gone"),stamp="2026-08-17T00:00:00.000Z";mkdirSync(cwd,{recursive:true});mkdirSync(join(root,"kernel"));writeFileSync(join(root,"kernel/sessions.json"),JSON.stringify({schemaVersion:1,sessions:[{id:"archived",providerId:"claude",nativeRef:"native",previousRefs:[],cwd,control:"external",taskIds:[],recoverable:true,source:"legacy",createdAt:stamp,updatedAt:stamp,archive:{state:"orphaned-task-link",originalTaskRefs:["missing"],migrationId:"stage6-kernel-sessions-v1",reason:"task-record-missing",sourceAggregateSha256:"a".repeat(64)}}]}));let reads=0;const service=new KernelSessionService(root,{}, {readHistory:async()=>{reads++;return[]}} as any),state=await service.state("archived");expect(state).toMatchObject({stale:true,errorCode:"SESSION_ARCHIVED_HISTORY_UNAVAILABLE",operability:"read-only"});expect(reads).toBe(0);expect(existsSync(join(root,"session-history"))).toBe(false);});

  test("Kernel validates model/effort and expands only granted Codex homes", async()=>{
    const root=fresh(),cwd=join(root,"repo"),home=join(root,".codex");mkdirSync(cwd);mkdirSync(home);const service=new KernelSessionService(root,{roots:[root]},{readHistory:async()=>[{role:"assistant",text:"history"}]} as any);
    await expect(service.create({taskId:"bad-model",providerId:"claude",cwd,model:"--inject"},{roots:[root],access:"workspace"})).rejects.toMatchObject({code:"PROVIDER_INPUT_INVALID"});
    await expect(service.create({taskId:"bad-effort",providerId:"codex",cwd,effort:"extreme"},{roots:[root],access:"workspace"})).rejects.toMatchObject({code:"PROVIDER_INPUT_INVALID"});
    const adopted=await service.adopt({taskId:"codex-home",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000001",providerHome:home,cwd},{roots:[root],access:"workspace"});expect(new SessionRepository(root).getById(adopted.id)?.providerHome).toBe(realpathSync(home));
    await expect(service.adopt({taskId:"outside",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000002",providerHome:tmpdir(),cwd},{roots:[root],access:"workspace"})).rejects.toMatchObject({code:"SESSION_CWD_NOT_GRANTED"});
  });
  test("legacy non-UUID Codex row stays visible/read-only and survives legal copy-forward",async()=>{const root=fresh(),cwd=join(root,"repo"),stamp=new Date().toISOString(),alias="bad-alias",oldValid="00000000-0000-4000-8000-000000000077",bad={id:"bad",providerId:"codex",nativeRef:"not-a-uuid",previousRefs:[oldValid],cwd,control:"ownward",taskIds:["bad",alias],recoverable:true,source:"legacy",createdAt:stamp,updatedAt:stamp};mkdirSync(cwd);writeFileSync(join(root,"sessions.json"),JSON.stringify({schemaVersion:1,sessions:[bad,{id:"healthy",providerId:"claude",nativeRef:"healthy-ref",previousRefs:[],cwd,control:"ownward",taskIds:["healthy"],recoverable:true,source:"legacy",createdAt:stamp,updatedAt:stamp}]}));writeInitialHistory(root,{sessionId:"bad",providerId:"codex",nativeRef:"not-a-uuid",messages:[{role:"assistant",text:"local history",ts:stamp}]});const repo=new SessionRepository(root);expect(repo.list().map(s=>s.id).sort()).toEqual(["bad","healthy"]);expect(repo.getByTaskId(alias)).toMatchObject({id:"bad",nativeRef:null,isolated:"invalid-codex-native-ref"});expect((await new KernelSessionService(root,{mode:"runner"}).state(alias))).toMatchObject({messages:[{text:"local history"}],operability:"read-only",errorCode:"SESSION_RECORD_UNOPERABLE"});repo.setControl("healthy","observing");repo.bind({taskId:"healthy",providerId:"claude",nativeRef:"healthy-new",cwd});repo.reserve({taskId:"new",providerId:"claude",cwd});for(const call of[()=>repo.reserve({taskId:alias,providerId:"codex" as const,cwd}),()=>repo.bind({taskId:"other",providerId:"codex" as const,nativeRef:oldValid,cwd}),()=>repo.clearNativeRef("bad")])expect(call).toThrow("SESSION_RECORD_UNOPERABLE");const report=repo.reconcile();expect(report.conflicts).toContainEqual({key:"bad",reason:"legacy-codex-native-ref-invalid-read-only-skipped"});const rows=JSON.parse(readFileSync(join(root,"kernel/sessions.json"),"utf8")).sessions;expect(rows.find((row:any)=>row.id==="bad")).toEqual(bad);expect(new SessionRepository(root).getByTaskId("healthy")).toMatchObject({control:"observing",nativeRef:"healthy-new"});expect(new SessionRepository(root).getDiagnostics()).toEqual([{key:"bad",reason:"legacy-codex-native-ref-invalid-read-only-skipped"}]);});

  test("adopt durably binds identity then copy-forwards initial history idempotently", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); let reads = 0;
    const consumer: any = { readHistory: async () => { reads++; return [{ role: "user", text: "old question", ts: "2026-08-01T00:00:00Z" }, { role: "assistant", text: "old answer", ts: "2026-08-01T00:00:01Z" }]; } };
    const service = new KernelSessionService(root, {}, consumer);
    await service.adopt({ taskId: "task", providerId: "claude", nativeRef: "native-history", cwd }, { roots: [root], access: "workspace" });
    await service.adopt({ taskId: "task", providerId: "claude", nativeRef: "native-history", cwd }, { roots: [root], access: "workspace" });
    expect(reads).toBe(1); expect((await service.state("task")).messages).toEqual([{ role: "user", text: "old question", ts: "2026-08-01T00:00:00Z" }, { role: "assistant", text: "old answer", ts: "2026-08-01T00:00:01Z" }]);
    expect(JSON.parse(readFileSync(join(root, "session-history/task.json"), "utf8"))).toMatchObject({ schemaVersion: 2, status: "ok", sessionId: "task", nativeRef: "native-history" });
  });

  test("adopt history failure keeps durable identity and an explicit retry marker", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd); mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "legacy", mode: "claude-bg", cwd }])); writeFileSync(join(root, "tasks/legacy.session.json"), JSON.stringify({ toolSessionId: "old-ref", messages: [{ role: "assistant", text: "legacy visible" }] }));
    const consumer: any = { readHistory: async () => { throw Object.assign(new Error("bad transcript"), { code: "RUNNER_HISTORY_UNAVAILABLE" }); } };
    await new KernelSessionService(root, {}, consumer).adopt({ taskId: "new-task", providerId: "claude", nativeRef: "new-ref", cwd }, { roots: [root], access: "workspace" });
    expect(JSON.parse(readFileSync(join(root, "session-history/new-task.json"),"utf8"))).toMatchObject({status:"unavailable",nativeRef:"new-ref"}); expect(new SessionRepository(root).getByTaskId("new-task")?.nativeRef).toBe("new-ref"); expect(new SessionRepository(root).getByTaskId("legacy")).toBeNull();
  });

  test("opening an existing adopted session lazily copies history with bounded retry", async()=>{
    const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).bind({taskId:"legacy",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000099",cwd});const store=JSON.parse(readFileSync(join(root,"kernel/sessions.json"),"utf8"));store.sessions[0].source="adopted";writeFileSync(join(root,"kernel/sessions.json"),JSON.stringify(store));let reads=0;
    const consumer:any={readHistory:async()=>{reads++;return[{role:"assistant",text:"restored",ts:"2026-08-01T00:00:00Z"}]}};const service=new KernelSessionService(root,{},consumer);
    expect((await service.state("legacy")).messages[0]?.text).toBe("restored");expect((await service.state("legacy")).messages[0]?.text).toBe("restored");expect(reads).toBe(1);
    const brokenRoot=fresh(),brokenCwd=join(brokenRoot,"repo");mkdirSync(brokenCwd);new SessionRepository(brokenRoot).bind({taskId:"broken",providerId:"claude",nativeRef:"native-bad",cwd:brokenCwd});const brokenStore=JSON.parse(readFileSync(join(brokenRoot,"kernel/sessions.json"),"utf8"));brokenStore.sessions[0].source="adopted";writeFileSync(join(brokenRoot,"kernel/sessions.json"),JSON.stringify(brokenStore));let readsAfterEmpty=0;const broken:any={readHistory:async()=>++readsAfterEmpty===1?[]:[{role:"assistant",text:"arrived later"}]};const brokenService=new KernelSessionService(brokenRoot,{},broken);const first=await brokenService.state("broken"),deferred=await brokenService.state("broken"),second=await brokenService.refreshHistory("broken");expect(first.messages[0]).toMatchObject({role:"system"});expect(deferred.messages[0]).toMatchObject({role:"system"});expect(second.messages[0]?.text).toBe("arrived later");expect(readsAfterEmpty).toBe(2);expect(JSON.parse(readFileSync(join(brokenRoot,"session-history/broken.json"),"utf8"))).toMatchObject({status:"ok",messages:[{text:"arrived later"}]});
  });

  test("legacy durable Provider marker is unavailable and later real history replaces it",async()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).bind({taskId:"marked",providerId:"claude",nativeRef:"native-marker",cwd});const store=JSON.parse(readFileSync(join(root,"kernel/sessions.json"),"utf8"));store.sessions[0].source="adopted";writeFileSync(join(root,"kernel/sessions.json"),JSON.stringify(store));mkdirSync(join(root,"session-history"));writeFileSync(join(root,"session-history/marked.json"),JSON.stringify({schemaVersion:1,sessionId:"marked",providerId:"claude",nativeRef:"native-marker",messages:[{role:"system",name:"history",text:"failed"}],copiedAt:"2026-08-01T00:00:00Z"}));const service=new KernelSessionService(root,{}, {readHistory:async()=>[{role:"assistant",text:"real"}]} as any);expect((await service.state("marked")).messages[0]?.text).toBe("real");expect(JSON.parse(readFileSync(join(root,"session-history/marked.json"),"utf8"))).toMatchObject({status:"ok",messages:[{text:"real"}]});});
  test("nativeRef rotation refreshes copied history and preserves the previous ref",async()=>{const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);repo.bind({taskId:"rotated",providerId:"claude",nativeRef:"native-A",cwd,source:"adopted"});writeInitialHistory(root,{sessionId:"rotated",providerId:"claude",nativeRef:"native-A",messages:[{role:"assistant",text:"history A"}]});repo.bind({taskId:"rotated",providerId:"claude",nativeRef:"native-B",cwd,source:"adopted"});const runner:any={readHistory:async(input:any)=>[{role:"assistant",text:`history ${input.nativeRef.at(-1)}`}]};const state=await new KernelSessionService(root,{mode:"runner"},runner).state("rotated");expect(state.messages.map(message=>message.text)).toEqual(["history B"]);expect(readInitialHistorySnapshot(root,"rotated")?.nativeRef).toBe("native-B");expect(new SessionRepository(root).getByTaskId("rotated")?.previousRefs).toContain("native-A");});

  test("native first turn never copy-forwards transcript over Runner events",async()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);const repo=new SessionRepository(root),session=repo.reserve({taskId:"native",providerId:"claude",cwd});let reads=0;const service=new KernelSessionService(root,{}, {readHistory:async()=>{reads++;return[{role:"assistant",text:"duplicate"}]}} as any);expect((await service.state(session.id)).messages).toEqual([]);expect(reads).toBe(0);});
  test("forced refresh cannot bypass the native initial-history guard",async()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);const session=new SessionRepository(root).reserve({taskId:"native-refresh",providerId:"claude",cwd});let reads=0;const service=new KernelSessionService(root,{}, {readHistory:async()=>{reads++;return[{role:"assistant",text:"duplicate"}]}} as any);expect((await service.refreshHistory(session.id)).messages).toEqual([]);expect(reads).toBe(0);expect(existsSync(join(root,"session-history/native-refresh.json"))).toBeFalse();});

  test("successful new-session persists reset cursor and clears old history for Claude and Codex; failure preserves it",async()=>{for(const providerId of["claude","codex"] as const){const root=fresh(),cwd=join(root,"repo"),ref=providerId==="codex"?"00000000-0000-4000-8000-000000000088":"claude-old";mkdirSync(cwd);new SessionRepository(root).bind({taskId:"task",providerId,nativeRef:ref,cwd});writeInitialHistory(root,{sessionId:"task",providerId,nativeRef:ref,messages:[{role:"assistant",text:"old history"}]});const provider:RunnerProvider={async *execute(command){yield{eventId:`${command.commandId}:started`,type:"started",at:new Date().toISOString(),commandId:command.commandId,runId:command.runId,sessionId:command.sessionId,providerId:command.providerId};yield{eventId:`${command.commandId}:done`,type:"completed",at:new Date().toISOString(),commandId:command.commandId,runId:command.runId,sessionId:command.sessionId,providerId:command.providerId};}};const server=new RunnerServer(root,()=>provider);server.start();try{const service=new KernelSessionService(root,{mode:"runner",roots:[root]});await service.newSession("task");const reset=new SessionRepository(root).getByTaskId("task")!;expect(reset).toMatchObject({nativeRef:null,recoverable:false});expect(reset.historyResetCommandId).toBeString();expect((await service.state("task")).messages).toEqual([]);expect((await new KernelSessionService(root,{mode:"runner"}).state("task")).messages).toEqual([]);await service.send("task",{text:"fresh"});expect(new SessionRunnerBridgeStore(root).list("task").at(-1)?.kind).toBe("start-run");}finally{server.stop();}}
    const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).bind({taskId:"task",providerId:"claude",nativeRef:"keep-me",cwd});const failed:RunnerProvider={async *execute(command){yield{eventId:`${command.commandId}:failed`,type:"failed",reason:"provider_unavailable",at:new Date().toISOString(),commandId:command.commandId,runId:command.runId,sessionId:command.sessionId,providerId:command.providerId};}};const server=new RunnerServer(root,()=>failed);server.start();try{await expect(new KernelSessionService(root,{mode:"runner"}).newSession("task")).rejects.toMatchObject({code:"RUNNER_CONTROL_FAILED"});expect(new SessionRepository(root).getByTaskId("task")?.nativeRef).toBe("keep-me");}finally{server.stop();}
  });
  test("reset command cursor hides older same-timestamp events and keeps later messages after restart",async()=>{
    const root=fresh(),cwd=join(root,"repo"),stamp="2026-08-17T00:00:00.000Z";
    mkdirSync(cwd);
    new SessionRepository(root).bind({taskId:"task",providerId:"claude",nativeRef:"old",cwd});
    const commands=new RunnerCommandJournal(root),events=new RunnerEventJournal(root);
    const add=(commandId:string,kind:any)=>commands.accept({commandId,kind,runId:`run-${commandId}`,sessionId:"task",providerId:"claude",input:kind==="new-session"?"{}":JSON.stringify({text:commandId})},stamp);
    const started=(commandId:string)=>events.append({eventId:`${commandId}-started`,type:"started",at:stamp,commandId,runId:`run-${commandId}`,sessionId:"task",providerId:"claude"});
    add("old","start-run");
    started("old");
    events.append({eventId:"old-message",type:"message-completed",at:stamp,commandId:"old",runId:"run-old",sessionId:"task",providerId:"claude",payload:JSON.stringify({text:"old"})});
    add("reset","new-session");
    started("reset");
    events.append({eventId:"reset-done",type:"completed",at:stamp,commandId:"reset",runId:"run-reset",sessionId:"task",providerId:"claude"});
    new SessionRepository(root).resetHistory("task","reset");
    add("fresh","start-run");
    started("fresh");
    events.append({eventId:"fresh-message",type:"message-completed",at:stamp,commandId:"fresh",runId:"run-fresh",sessionId:"task",providerId:"claude",payload:JSON.stringify({text:"fresh"})});
    expect((await new KernelSessionService(root,{mode:"runner"}).state("task")).messages.map(message=>message.text)).toEqual(["fresh","fresh"]);
  });
  test("pending history reset fails writes closed and restart settles durable terminal exactly once",async()=>{for(const terminal of["completed","failed"] as const){const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);repo.bind({taskId:"task",providerId:"claude",nativeRef:"old-ref",cwd});const commands=new RunnerCommandJournal(root),events=new RunnerEventJournal(root),command=commands.accept({commandId:`reset-${terminal}`,kind:"new-session",runId:`run-${terminal}`,sessionId:"task",providerId:"claude",input:"{}"}).record;repo.beginHistoryReset("task",command.commandId);const service=new KernelSessionService(root,{mode:"runner"});await expect(service.send("task",{text:"must not resume old"})).rejects.toMatchObject({code:"SESSION_HISTORY_RESET_PENDING"});events.append({eventId:`started-${terminal}`,type:"started",at:"2026-08-17T00:00:00.000Z",commandId:command.commandId,runId:command.runId,sessionId:"task",providerId:"claude"});events.append({eventId:`terminal-${terminal}`,type:terminal,at:"2026-08-17T00:00:00.001Z",commandId:command.commandId,runId:command.runId,sessionId:"task",providerId:"claude",...(terminal==="failed"?{reason:"provider_unavailable" as const}:{})});await new KernelSessionService(root,{mode:"runner"}).state("task");const settled=new SessionRepository(root).getByTaskId("task")!;expect(settled.pendingHistoryReset).toBeUndefined();expect(settled.nativeRef).toBe(terminal==="completed"?null:"old-ref");expect(settled.historyResetCommandId).toBe(terminal==="completed"?command.commandId:undefined);await new KernelSessionService(root,{mode:"runner"}).state("task");}});

  test("off mode rejects new create/adopt and full access is granted at creation boundary", async () => {
    const root = fresh(), cwd = join(root, "repo"); mkdirSync(cwd);
    const off = new KernelSessionService(root, { mode: "off" });
    await expect(off.create({ taskId: "new", providerId: "claude", cwd }, { roots: [root], access: "workspace" })).rejects.toMatchObject({ code: "SESSION_RUNNER_DISABLED" });
    await expect(off.adopt({ taskId: "new", providerId: "codex", nativeRef: "native", cwd }, { roots: [root], access: "workspace" })).rejects.toMatchObject({ code: "SESSION_RUNNER_DISABLED" });
    const previous = cfg.architecture.allowFullAccess; cfg.architecture.allowFullAccess = false;
    try { await expect(new KernelSessionService(root).create({ taskId: "full", providerId: "claude", cwd }, { roots: [root], access: "full-access" })).rejects.toMatchObject({ code: "SESSION_ACCESS_NOT_GRANTED" }); }
    finally { cfg.architecture.allowFullAccess = previous; }
  });

  test("Runner submit produces one stable accepted Run and never guesses provider from task mode", async () => {
    const root = fresh(), { session } = seed(root, "codex"), calls: any[] = [];
    const fake: any = { request: async (_kind: string, body: any) => { calls.push(body); return { kind: "accepted" }; }, close() {} };
    const ids = ["command-1", "run-1"]; const consumer = new RunnerSessionConsumer(root, () => fake, () => ids.shift()!);
    expect(await consumer.submit("task", session, "start-run", { text: "x" })).toEqual({ commandId: "command-1", runId: "run-1" });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ providerId: "codex", sessionId: session.id });
    expect(readRunJournalStrict(root).map((event) => event.type)).toEqual(["command-accepted"]);
  });

  test("Kernel accepted journal failure is a hard gate before Runner socket write", async () => {
    const root = fresh(), { session } = seed(root); appendFileSync(join(root, "runs.jsonl"), "not-json\n"); let calls = 0;
    const fake: any = { request: async () => { calls++; }, close() {} };
    await expect(new RunnerSessionConsumer(root, () => fake).submit("task", session, "start-run", { text: "x" })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("daemon restart resumes strictly from persisted nativeRef/providerId", async () => {
    const root = fresh(), { cwd } = seed(root, "codex"); new SessionRepository(root).bind({ taskId: "task", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000001", cwd }); const calls: any[] = [];
    const fake: any = { request: async (_kind: string, body: any) => { calls.push(body); return { kind: "accepted" }; }, close() {} };
    const restarted = new KernelSessionService(root, { mode: "runner" }, new RunnerSessionConsumer(root, () => fake));
    await restarted.resume("task", { text: "continue" });
    expect(calls[0]).toMatchObject({ kind: "resume-run", providerId: "codex", sessionId: "task" });
    expect(JSON.parse(calls[0].input).nativeRef).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("same pending turn reuses durable identity and consumer cursor reaches terminal across Service restart", async () => {
    const root = fresh(), { session } = seed(root), provider: RunnerProvider = { async *execute(command) { yield { eventId: `${command.commandId}:start`, type: "started", at: "2026-08-16T00:00:01.000Z", commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; yield { eventId: `${command.commandId}:native`, type: "session-updated", at: "2026-08-16T00:00:02.000Z", commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, nativeRef: "native-during-turn", payload: JSON.stringify({ nativeRef: "native-during-turn" }) }; await Bun.sleep(40); yield { eventId: `${command.commandId}:done`, type: "completed", at: "2026-08-16T00:00:03.000Z", commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; } };
    const server = new RunnerServer(root, () => provider); server.start();
    try { const firstService = new KernelSessionService(root, { mode: "runner", roots: [session.cwd] }), first = await firstService.send("task", { text: "same", clientMutationId: "retry-1" }); await Bun.sleep(20); expect(new SessionRepository(root).getByTaskId("task")?.nativeRef).toBe("native-during-turn"); const retry = await new KernelSessionService(root, { mode: "runner", roots: [session.cwd] }).send("task", { text: "same", clientMutationId: "retry-1" }); expect(retry).toEqual(first); await Bun.sleep(100); await new KernelSessionService(root, { mode: "runner", roots: [session.cwd] }).resumePending(); const bridge = new SessionRunnerBridgeStore(root).list("task"); expect(bridge).toHaveLength(1); expect(bridge[0]).toMatchObject({ commandId: first.commandId, runId: first.runId, terminal: true, cursor: 4, clientMutationId: "retry-1" }); expect(readRunJournalStrict(root).filter((e) => e.type === "command-accepted")).toHaveLength(1); }
    finally { server.stop(); }
  });

  test("deterministic unknown outcome closes retry identity so the same text starts a new Run", async () => {
    const root = fresh(); seed(root); let executions = 0;
    const provider: RunnerProvider = { async *execute(command) { executions++; yield { eventId: `${command.commandId}:start`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; yield { eventId: `${command.commandId}:unknown`, type: "unknown-outcome", reason: "runner_lost_ownership", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; } };
    const server = new RunnerServer(root, () => provider); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" }), first = await service.send("task", { text: "retry me" });
      for (let i = 0; i < 50 && !new SessionRunnerBridgeStore(root).list("task")[0]?.terminal; i++) await Bun.sleep(10);
      expect(new SessionRunnerBridgeStore(root).list("task")[0]?.terminal).toBe(true);
      const second = await service.send("task", { text: "retry me" });
      expect(second.commandId).not.toBe(first.commandId); expect(second.runId).not.toBe(first.runId);
      for (let i = 0; i < 50 && new SessionRunnerBridgeStore(root).list("task").filter((c) => c.terminal).length < 2; i++) await Bun.sleep(10);
      expect(executions).toBe(2); expect(readRunJournalStrict(root).filter((e) => e.type === "command-accepted")).toHaveLength(2);
    } finally { server.stop(); }
  });

  test("Runner read falls back to durable local state when the socket is unavailable", async () => {
    const root = fresh(); seed(root); const commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root); commands.accept({ commandId: "local", kind: "start-run", runId: "local-run", sessionId: "task", providerId: "claude", input: JSON.stringify({ text: "x" }) }); new RunRepository(root).append({ schemaVersion: 1, eventId: "local-accepted", type: "command-accepted", at: "2026-08-16T00:00:00.000Z", commandId: "local", runId: "local-run", taskId: "task", sessionId: "task", providerId: "claude" }); events.append({ eventId: "local-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "local", runId: "local-run", sessionId: "task", providerId: "claude" }); events.append({ eventId: "local-message", type: "message-completed", at: "2026-08-16T00:00:02.000Z", commandId: "local", runId: "local-run", sessionId: "task", providerId: "claude", payload: JSON.stringify({ text: "durable" }) });
    const bridge = new SessionRunnerBridgeStore(root); bridge.reserve({ taskId: "task", sessionId: "task", providerId: "claude", kind: "start-run", serializedInput: JSON.stringify({ text: "x" }), identity: { commandId: "local", runId: "local-run" } });
    const state = await new KernelSessionService(root, { mode: "runner" }).state("task"); expect(state).toMatchObject({ stale: true, errorCode: "RUNNER_UNAVAILABLE", messages: [{ role: "assistant", text: "durable" }, { role: "user", text: "x" }], turn: "running" });
  });

  test("cwd grants and full access are Kernel policy, not provider input", async () => {
    const root = fresh(), { cwd } = seed(root); const outside = fresh(); let clients = 0;
    expect(validateDirectoryGrant(cwd, [cwd])).toBe(realpathSync(cwd));
    expect(() => validateDirectoryGrant(outside, [cwd])).toThrow(KernelSessionPolicyError);
    // 这条断言的前提是「没开 allowFullAccess」，必须自己钉死，不能吃运行环境里的 config.json：
    // 主检出的生产 config 开着 allowFullAccess=true，策略门放行后往下真去连 Runner，
    // 拿到的是 RUNNER_UNAVAILABLE 而不是 SESSION_ACCESS_NOT_GRANTED（2026-08-22 实测假失败）。
    const previousFullAccess = cfg.architecture.allowFullAccess;
    cfg.architecture.allowFullAccess = false;
    try {
      const service = new KernelSessionService(root, { mode: "runner", roots: [cwd] });
      await expect(service.setAccess("task", "bypass")).rejects.toMatchObject({ code: "SESSION_ACCESS_NOT_GRANTED" });
    } finally { cfg.architecture.allowFullAccess = previousFullAccess; }
    const noRoots = new KernelSessionService(root, { mode: "runner" }, new RunnerSessionConsumer(root, () => { clients++; throw new Error("must not connect"); }));
    await expect(noRoots.addDirectory("task", cwd)).rejects.toMatchObject({ code: "SESSION_CWD_NOT_GRANTED" });
    expect(clients).toBe(0);
  });
  test("successful add-dir/set-access persist grants while definite failure leaves them unchanged",async()=>{const root=fresh(),cwd=join(root,"repo"),extra=join(root,"extra");mkdirSync(cwd);mkdirSync(extra);const repo=new SessionRepository(root);repo.reserve({taskId:"grants",providerId:"claude",cwd,access:"workspace"});const success:any={require(){},submit:async(_task:any,_session:any,_kind:any,_input:any,identity:any)=>identity,waitTerminal:async()=>[]};const previous=cfg.architecture.allowFullAccess;cfg.architecture.allowFullAccess=true;try{const service=new KernelSessionService(root,{mode:"runner",roots:[root]},success);await service.addDirectory("grants",extra);await service.setAccess("grants","full-access");expect(new SessionRepository(root).getByTaskId("grants")).toMatchObject({access:"full-access",extraDirs:[realpathSync(extra)]});const failed:any={...success,waitTerminal:async()=>{throw Object.assign(new Error("definite"),{code:"RUNNER_CONTROL_FAILED",outcomeUnknown:false});}};await expect(new KernelSessionService(root,{mode:"runner",roots:[root]},failed).setAccess("grants","workspace")).rejects.toThrow("definite");expect(new SessionRepository(root).getByTaskId("grants")?.access).toBe("full-access");}finally{cfg.architecture.allowFullAccess=previous;}});

  test("Codex approval fails capability gate before any Runner connection", async () => {
    const root = fresh(); seed(root, "codex"); let clients = 0;
    const runner = new RunnerSessionConsumer(root, () => { clients++; throw new Error("unexpected"); });
    const service = new KernelSessionService(root, { mode: "runner" }, runner);
    await expect(service.respondApproval("task", "request", { allow: true })).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNSUPPORTED" });
    expect(clients).toBe(0);
  });

  test("control uncertainty preserves receipt, does not drift grants, and approval forwards remember", async () => {
    const root = fresh(), { cwd, session } = seed(root); const extra = join(root, "extra"); mkdirSync(extra); const bodies: any[] = [];
    const unavailable: any = { request: async () => { throw Object.assign(new Error("lost"), { code: "RUNNER_REQUEST_OUTCOME_UNKNOWN" }); }, close() {} };
    const service = new KernelSessionService(root, { mode: "runner", roots: [root] }, new RunnerSessionConsumer(root, () => unavailable, (() => { let n = 0; return () => `id-${++n}`; })()));
    const uncertain = service.addDirectory("task", extra); await expect(uncertain).rejects.toMatchObject({ outcomeUnknown: true }); try { await uncertain; } catch (error: any) { expect(error.commandId).toBeString(); expect(new SessionRunnerBridgeStore(root).list("task").some((c) => c.commandId === error.commandId && c.kind === "add-dir" && !c.terminal)).toBe(true); }
    expect(new SessionRepository(root).getByTaskId("task")?.extraDirs ?? []).not.toContain(realpathSync(extra));
    const fake: any = { request: async (_kind: string, body: any) => { bodies.push(body); return { kind: "accepted" }; }, close() {} };
    await new RunnerSessionConsumer(root, () => fake, () => "approval-command").approval(session, "active-run", "request", { allow: true, remember: "global" });
    expect(JSON.parse(bodies[0].input).remember).toBe("global");
    const rejected: any = { request: async () => { throw Object.assign(new Error("conflict"), { code: "RUNNER_COMMAND_CONFLICT" }); }, close() {} };
    await expect(new RunnerSessionConsumer(root, () => rejected, () => "known-command").submit("task", session, "add-dir", { dir: cwd })).rejects.toMatchObject({ code: "RUNNER_COMMAND_CONFLICT", outcomeUnknown: false });
  });

  test("explicit aged drain records unknown outcome without deleting evidence", async () => {
    const root = fresh(); seed(root); const bridge = new SessionRunnerBridgeStore(root), reserved = bridge.reserve({ taskId: "task", sessionId: "task", providerId: "claude", kind: "start-run", serializedInput: "prompt", identity: { commandId: "stuck-command", runId: "stuck-run" } }).command, file = join(root, "session-runner-bridge.json"); const raw = JSON.parse(readFileSync(file, "utf8")); raw.commands[0].createdAt = "2026-01-01T00:00:00.000Z"; writeFileSync(file, JSON.stringify(raw)); const service = new KernelSessionService(root, { mode: "off" });
    await expect(service.drainUnknown({ sessionId: "task", commandId: reserved.commandId, confirm: "wrong" })).rejects.toMatchObject({ code: "SESSION_DRAIN_CONFIRM_REQUIRED" });
    expect(await service.drainUnknown({ sessionId: "task", commandId: reserved.commandId, confirm: "MARK_UNKNOWN_OUTCOME" })).toMatchObject({ commandId: "stuck-command", runId: "stuck-run", outcome: "unknown-outcome" });
    expect(bridge.list("task")[0].terminal).toBe(true); expect(readFileSync(join(root, "session-drain-audit.jsonl"), "utf8")).toContain("stuck-command"); expect(existsSync(file)).toBe(true);
  });

  test("drain reconciles a real terminal event and audits its actual outcome", async () => {
    const root = fresh(); seed(root); const bridge = new SessionRunnerBridgeStore(root), command = bridge.reserve({ taskId: "task", sessionId: "task", providerId: "claude", kind: "new-session", serializedInput: "{}", identity: { commandId: "finished-command", runId: "finished-run" } }).command, commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root);
    commands.accept({ commandId: command.commandId, kind: "new-session", runId: command.runId, sessionId: "task", providerId: "claude", input: "{}" }); events.append({ eventId: "finished-start", type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: "task", providerId: "claude" }); events.append({ eventId: "finished-done", type: "completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: "task", providerId: "claude" });
    expect(await new KernelSessionService(root, { mode: "off" }).drainUnknown({ sessionId: "task", commandId: command.commandId, confirm: "MARK_UNKNOWN_OUTCOME" })).toMatchObject({ outcome: "completed" });
    expect(JSON.parse(readFileSync(join(root, "session-drain-audit.jsonl"), "utf8").trim()).outcome).toBe("completed");
  });

  test("explicit drain refuses a command still owned by a live Runner", async () => {
    const root = fresh(); seed(root); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const provider: RunnerProvider = { async *execute(command) { yield { eventId: `${command.commandId}:start`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; await held; yield { eventId: `${command.commandId}:done`, type: "completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; } };
    const server = new RunnerServer(root, () => provider); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" }), receipt = await service.send("task", { text: "hold" });
      for (let i = 0; i < 50 && !new RunnerEventJournal(root).readStrict().some((e) => e.commandId === receipt.commandId && e.type === "started"); i++) await Bun.sleep(10);
      const file = join(root, "session-runner-bridge.json"), raw = JSON.parse(readFileSync(file, "utf8")); raw.commands[0].createdAt = "2026-01-01T00:00:00.000Z"; writeFileSync(file, JSON.stringify(raw));
      await expect(service.drainUnknown({ sessionId: "task", commandId: receipt.commandId, confirm: "MARK_UNKNOWN_OUTCOME" })).rejects.toMatchObject({ code: "SESSION_DRAIN_ACTIVE" });
      expect(new SessionRunnerBridgeStore(root).list("task")[0].terminal).toBe(false);
    } finally { release(); await Bun.sleep(20); server.stop(); }
  });

  test("Runner control lease is durable while active Run prevents ownership races", async () => {
    const root = fresh(); seed(root); const service = new KernelSessionService(root, { mode: "runner" });
    expect(await service.acquireControl("task", "observing")).toMatchObject({ sessionId: "task", control: "observing" }); expect(new SessionRepository(root).getByTaskId("task")?.control).toBe("observing");
    const runs = new RunRepository(root); runs.append({ schemaVersion: 1, eventId: "lease-a", type: "command-accepted", at: "2026-08-16T00:00:00.000Z", commandId: "lease-command", runId: "lease-run", taskId: "task", sessionId: "task", providerId: "claude" }); runs.append({ schemaVersion: 1, eventId: "lease-d", type: "run-dispatching", at: "2026-08-16T00:00:01.000Z", commandId: "lease-command", runId: "lease-run", taskId: "task", sessionId: "task", providerId: "claude" }); runs.append({ schemaVersion: 1, eventId: "lease-s", type: "run-started", at: "2026-08-16T00:00:02.000Z", commandId: "lease-command", runId: "lease-run", taskId: "task", sessionId: "task", providerId: "claude" });
    expect(await service.acquireControl("task", "observing")).toMatchObject({ control: "observing" });
    await expect(service.acquireControl("task", "ownward")).rejects.toMatchObject({ code: "SESSION_CONTROL_BUSY" });
  });

  test("follow-up durable accept reopens an exited Task before any later sync",async()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);writeFileSync(join(root,"tasks.json"),JSON.stringify([{id:"task",project:"p",projectDir:cwd,cwd,task:"x",mode:"claude-bg",engine:true,startedAt:"2026-08-17T00:00:00.000Z",endedAt:"2026-08-17T00:01:00.000Z",status:"exited",exitCode:0,commandId:"old",runId:"old-run"}]));new SessionRepository(root).bind({taskId:"task",providerId:"claude",nativeRef:"native",cwd});const fake:any={require(){},submit:async(_task:any,_session:any,_kind:any,_input:any,identity:any)=>identity};const receipt=await new KernelSessionService(root,{mode:"runner"},fake).send("task",{text:"follow up"});const task=JSON.parse(readFileSync(join(root,"tasks.json"),"utf8"))[0];expect(task).toMatchObject({status:"running",launchState:"accepted",commandId:receipt.commandId,runId:receipt.runId,uncertain:false});expect(task.endedAt).toBeUndefined();expect(task.exitCode).toBeUndefined();});
  test("Task projection lock/corruption cannot turn durable accepted send into client failure",async()=>{for(const mode of["busy","corrupt"] as const){const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).bind({taskId:"task",providerId:"claude",nativeRef:"native",cwd});if(mode==="corrupt")writeFileSync(join(root,"tasks.json"),"{");else{writeFileSync(join(root,"tasks.json"),JSON.stringify([{id:"task",project:"p",projectDir:cwd,cwd,task:"x",mode:"claude-bg",engine:true,startedAt:"now",status:"exited"}]));const lock=join(root,".tasks.write.lock");mkdirSync(lock);writeFileSync(join(lock,"owner.json"),JSON.stringify({pid:process.pid,createdAt:Date.now(),token:"held"}));}let syncs=0,submits=0;const fake:any={require(){},submit:async(_task:any,_session:any,_kind:any,_input:any,identity:any)=>{submits++;return identity;},syncCommand:async()=>{syncs++;return[{sequence:1,type:"completed"}]}};const receipt=await new KernelSessionService(root,{mode:"runner"},fake).send("task",{text:"accepted"});expect(receipt).toMatchObject({commandId:expect.any(String),runId:expect.any(String)});await Bun.sleep(10);expect(submits).toBe(1);expect(syncs).toBeGreaterThan(0);expect(new SessionRunnerBridgeStore(root).list("task")).toHaveLength(1);}});
  test("turn idempotency only reuses an explicit client mutation id", () => {
    const root = fresh(), bridge = new SessionRunnerBridgeStore(root), base = { taskId: "task", sessionId: "task", providerId: "claude", kind: "start-run" as const, serializedInput: "same" };
    const a = bridge.reserve(base), b = bridge.reserve(base); expect(b.reused).toBe(false); expect(b.command.commandId).not.toBe(a.command.commandId);
    const c = bridge.reserve({ ...base, clientMutationId: "retry-key" }), d = bridge.reserve({ ...base, clientMutationId: "retry-key" }); expect(d.reused).toBe(true); expect(d.command.commandId).toBe(c.command.commandId);
  });
});

describe("normalized Runner event projection", () => {
  const event = (type: RunnerEventRecord["type"], sequence: number): RunnerEventRecord => ({ schemaVersion: 1, eventId: `event-${sequence}`, sequence, type, at: `2026-08-16T00:00:0${sequence}.000Z`, commandId: "command", runId: "run", sessionId: "task", providerId: "claude" });
  test("started/terminal dual-write one Run and duplicate event is idempotent", () => {
    const root = fresh(); seed(root); new RunRepository(root).append({ schemaVersion: 1, eventId: "accepted", type: "command-accepted", at: "2026-08-16T00:00:00.000Z", commandId: "command", runId: "run", taskId: "task", sessionId: "task", providerId: "claude" });
    projectRunnerEvent(root, "task", event("dispatching", 1)); projectRunnerEvent(root, "task", event("started", 2)); projectRunnerEvent(root, "task", event("completed", 3)); projectRunnerEvent(root, "task", event("completed", 3));
    expect(readRunJournalStrict(root).map((e) => e.type)).toEqual(["command-accepted", "run-dispatching", "run-started", "run-completed"]);
  });
  test("provider/ref drift fails closed", () => { const root = fresh(); seed(root, "codex"); expect(() => projectRunnerEvent(root, "task", event("started", 1))).toThrow(KernelSessionPolicyError); });
  test("turn event without Kernel accepted fails closed while control event remains non-Run", () => {
    const root = fresh(); seed(root); const commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root);
    commands.accept({ commandId: "missing", kind: "start-run", runId: "missing-run", sessionId: "task", providerId: "claude", input: "{}" }); const started = events.append({ eventId: "missing-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "missing", runId: "missing-run", sessionId: "task", providerId: "claude" }).record; expect(() => projectRunnerEvent(root, "task", started)).toThrow("Kernel accepted");
    commands.accept({ commandId: "control", kind: "add-dir", runId: "control-run", sessionId: "task", providerId: "claude", input: "{}" }); const control = events.append({ eventId: "control-start", type: "started", at: "2026-08-16T00:00:02.000Z", commandId: "control", runId: "control-run", sessionId: "task", providerId: "claude" }).record; expect(() => projectRunnerEvent(root, "task", control)).not.toThrow();
  });
  test("completed control event durably projects grants for crash recovery", () => {
    const root = fresh(); seed(root); const commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root);
    new SessionRunnerBridgeStore(root).reserve({ taskId: "task", sessionId: "task", providerId: "claude", kind: "set-access", serializedInput: JSON.stringify({ access: "bypass" }), authorizedAccess: "bypass", identity: { commandId: "grant", runId: "control-run" } });
    commands.accept({ commandId: "grant", kind: "set-access", runId: "control-run", sessionId: "task", providerId: "claude", input: JSON.stringify({ access: "bypass" }) });
    events.append({ eventId: "grant-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "grant", runId: "control-run", sessionId: "task", providerId: "claude" });
    const completed = events.append({ eventId: "grant-done", type: "completed", at: "2026-08-16T00:00:02.000Z", commandId: "grant", runId: "control-run", sessionId: "task", providerId: "claude" }).record;
    projectRunnerEvent(root, "task", completed); expect(new SessionRepository(root).getByTaskId("task")?.access).toBe("bypass"); expect(readRunJournalStrict(root)).toHaveLength(0);
  });
  test("control completion without Kernel acceptance cannot mutate grants", () => { const root = fresh(); seed(root); const commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root); commands.accept({ commandId: "unaccepted-grant", kind: "set-access", runId: "control-run", sessionId: "task", providerId: "claude", input: JSON.stringify({ access: "bypass" }) }); events.append({ eventId: "unaccepted-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "unaccepted-grant", runId: "control-run", sessionId: "task", providerId: "claude" }); const done = events.append({ eventId: "unaccepted-done", type: "completed", at: "2026-08-16T00:00:02.000Z", commandId: "unaccepted-grant", runId: "control-run", sessionId: "task", providerId: "claude" }).record; expect(() => projectRunnerEvent(root, "task", done)).toThrow("Kernel acceptance"); expect(new SessionRepository(root).getByTaskId("task")?.access).toBeUndefined(); });
  test("completed add-dir revalidates the exact roots captured by Kernel acceptance", () => {
    const root = fresh(), { cwd } = seed(root), outside = fresh(), commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root);
    new SessionRunnerBridgeStore(root).reserve({ taskId: "task", sessionId: "task", providerId: "claude", kind: "add-dir", serializedInput: JSON.stringify({ dir: outside }), authorizedRoots: [cwd], identity: { commandId: "bad-dir", runId: "control-run" } });
    commands.accept({ commandId: "bad-dir", kind: "add-dir", runId: "control-run", sessionId: "task", providerId: "claude", input: JSON.stringify({ dir: outside }) });
    events.append({ eventId: "bad-dir-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "bad-dir", runId: "control-run", sessionId: "task", providerId: "claude" });
    const completed = events.append({ eventId: "bad-dir-done", type: "completed", at: "2026-08-16T00:00:02.000Z", commandId: "bad-dir", runId: "control-run", sessionId: "task", providerId: "claude" }).record;
    expect(() => projectRunnerEvent(root, "task", completed)).toThrow(KernelSessionPolicyError);
    expect(new SessionRepository(root).getByTaskId("task")?.extraDirs ?? []).not.toContain(realpathSync(outside));
  });
  test("session-updated payload copy-forwards Provider nativeRef into SessionRepository", () => {
    const root = fresh(); seed(root); const commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root);
    commands.accept({ commandId: "native-command", kind: "start-run", runId: "native-run", sessionId: "task", providerId: "claude", input: "{}" });
    new RunRepository(root).append({ schemaVersion: 1, eventId: "native-accepted", type: "command-accepted", at: "2026-08-16T00:00:00.000Z", commandId: "native-command", runId: "native-run", taskId: "task", sessionId: "task", providerId: "claude" });
    events.append({ eventId: "native-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "native-command", runId: "native-run", sessionId: "task", providerId: "claude" });
    const updated = events.append({ eventId: "native-update", type: "session-updated", at: "2026-08-16T00:00:02.000Z", commandId: "native-command", runId: "native-run", sessionId: "task", providerId: "claude", payload: JSON.stringify({ nativeRef: "claude-native" }) }).record;
    projectRunnerEvent(root, "task", updated); expect(new SessionRepository(root).getByTaskId("task")).toMatchObject({ nativeRef: "claude-native", recoverable: true });
    const cleared = events.append({ eventId: "native-clear", type: "session-updated", at: "2026-08-16T00:00:03.000Z", commandId: "native-command", runId: "native-run", sessionId: "task", providerId: "claude", payload: JSON.stringify({ nativeRef: null }) }).record;
    projectRunnerEvent(root, "task", cleared); expect(new SessionRepository(root).getByTaskId("task")).toMatchObject({ nativeRef: null, previousRefs: ["claude-native"], recoverable: false });
  });
  test("replaying an older new-session null cannot erase a newer Provider ref", () => {
    const root = fresh(); seed(root); const commands = new RunnerCommandJournal(root), events = new RunnerEventJournal(root);
    commands.accept({ commandId: "clear-command", kind: "new-session", runId: "clear-run", sessionId: "task", providerId: "claude", input: "{}" }); events.append({ eventId: "clear-start", type: "started", at: "2026-08-16T00:00:01.000Z", commandId: "clear-command", runId: "clear-run", sessionId: "task", providerId: "claude" }); const oldClear = events.append({ eventId: "old-clear", type: "session-updated", at: "2026-08-16T00:00:02.000Z", commandId: "clear-command", runId: "clear-run", sessionId: "task", providerId: "claude", payload: JSON.stringify({ nativeRef: null }) }).record; projectRunnerEvent(root, "task", oldClear);
    commands.accept({ commandId: "new-command", kind: "start-run", runId: "new-run", sessionId: "task", providerId: "claude", input: "{}" }); new RunRepository(root).append({ schemaVersion: 1, eventId: "new-accepted", type: "command-accepted", at: "2026-08-16T00:00:02.500Z", commandId: "new-command", runId: "new-run", taskId: "task", sessionId: "task", providerId: "claude" }); events.append({ eventId: "new-start", type: "started", at: "2026-08-16T00:00:03.000Z", commandId: "new-command", runId: "new-run", sessionId: "task", providerId: "claude" }); const newRef = events.append({ eventId: "new-ref", type: "session-updated", at: "2026-08-16T00:00:04.000Z", commandId: "new-command", runId: "new-run", sessionId: "task", providerId: "claude", payload: JSON.stringify({ nativeRef: "latest" }) }).record; projectRunnerEvent(root, "task", newRef); projectRunnerEvent(root, "task", oldClear); expect(new SessionRepository(root).getByTaskId("task")?.nativeRef).toBe("latest");
  });
  test("AgentState fixture keeps backend+providerId and normalized message lifecycle", () => {
    const root = fresh(), { session } = seed(root); const projector = new RunnerAgentStateProjector(session, (e) => e.type === "delta" ? "hel" : { text: "hello" });
    projector.apply(event("started", 1)); projector.apply({ ...event("delta", 2), payloadRef: "payloads/" + "a".repeat(64) + ".blob", payloadSha256: "a".repeat(64), payloadBytes: 3 }); projector.apply({ ...event("message-completed", 3), payloadRef: "payloads/" + "b".repeat(64) + ".blob", payloadSha256: "b".repeat(64), payloadBytes: 5 }); projector.apply(event("completed", 4));
    expect(projector.state()).toMatchObject({ messages: [{ role: "assistant", text: "hello" }], turn: "idle", alive: false, partial: "", pending: [], backend: "claude", providerId: "claude", control: "ownward" });
  });

  test("first/follow-up/failure/interruption each remain exactly one Run", async () => {
    const root = fresh(), { session } = seed(root), calls: any[] = [], ids = ["c1", "r1", "c2", "r2", "c3", "r3"];
    const fake: any = { request: async (_kind: string, body: any) => { calls.push(body); return { kind: "accepted" }; }, close() {} };
    const consumer = new RunnerSessionConsumer(root, () => fake, () => ids.shift()!);
    for (const [kind, terminal] of [["start-run", "completed"], ["send-input", "failed"], ["send-input", "interrupted"]] as const) {
      const receipt = await consumer.submit("task", session, kind, { text: kind });
      projectRunnerEvent(root, "task", { ...event("dispatching", 1), eventId: `${receipt.commandId}-d`, commandId: receipt.commandId, runId: receipt.runId });
      projectRunnerEvent(root, "task", { ...event("started", 2), eventId: `${receipt.commandId}-s`, commandId: receipt.commandId, runId: receipt.runId });
      projectRunnerEvent(root, "task", { ...event(terminal, 3), eventId: `${receipt.commandId}-t`, commandId: receipt.commandId, runId: receipt.runId, ...(terminal === "failed" ? { reason: "provider_exit" as const } : {}) });
    }
    const events = readRunJournalStrict(root); expect(events.filter((e) => e.type === "command-accepted")).toHaveLength(3);
    expect(events.filter((e) => e.type.startsWith("run-") && ["run-completed", "run-failed", "run-interrupted"].includes(e.type))).toHaveLength(3);
  });

  test("Kernel facade import boundary does not reach Provider implementations or workbench", () => {
    const source = ["contracts.ts", "service.ts", "runner-consumer.ts"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    expect(source).not.toMatch(/providers\/(claude-code|codex)|workbench\.ts|dispatch\.ts/);
  });
});
