import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerServer, type RunnerProvider } from "../runner/server.ts";
import { RunnerClient } from "../runner/client.ts";
import { canaryProvider, terminateCanaryProcess } from "./provider-canary.ts";

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));

test("provider canary proves start terminal nativeRef and resume terminal",async()=>{
  const data=mkdtempSync(join(tmpdir(),"canary-test-"));roots.push(data);
  const provider:RunnerProvider={id:"codex",version:"1",capabilities:new Set(["resume"]),async*execute(c:any,input?:string){
    const at=new Date().toISOString(),base={at,commandId:c.commandId,runId:c.runId,sessionId:c.sessionId,providerId:c.providerId};
    const prompt=JSON.parse(input||"{}").text as string,expected=/OWNWARD_(?:CANARY|RESUME)_[0-9a-f-]+/.exec(prompt)?.[0];
    yield{...base,eventId:`${c.commandId}-started`,type:"started"};
    yield{...base,eventId:`${c.commandId}-session`,type:"session-updated",nativeRef:"019ffae9-ad07-7ef0-ab0a-761b9a426650",payload:"{}"};
    yield{...base,eventId:`${c.commandId}-message`,type:"message-completed",payload:JSON.stringify({role:"assistant",text:expected})};
    yield{...base,eventId:`${c.commandId}-done`,type:"completed"};
    await Bun.sleep(75); // terminal journal can become visible before Runner releases the active session
  }};
  const server=new RunnerServer(data,()=>provider);server.registerProvider(provider);server.start();const client=new RunnerClient(data);
  try{const result=await canaryProvider(client,"codex",tmpdir(),2_000);expect(result).toMatchObject({ok:true,providerId:"codex",nativeRef:"019ffae9-ad07-7ef0-ab0a-761b9a426650"});expect(result.resumeCommandId).toBeString();}
  finally{client.close();server.stop();}
});

async function scenario(mode:"success"|"binary"|"auth"|"resume-auth"|"nonce"|"resume-nonce"|"timeout"){
  const data=mkdtempSync(join(tmpdir(),"canary-matrix-"));roots.push(data);
  const provider:RunnerProvider={id:"claude",version:"1",capabilities:new Set(["resume"]),async*execute(c:any,input?:string){
    const parsed=JSON.parse(input||"{}"),resume=parsed.text.includes("OWNWARD_RESUME_"),at=new Date().toISOString(),base={at,commandId:c.commandId,runId:c.runId,sessionId:c.sessionId,providerId:c.providerId};
    yield{...base,eventId:`${c.commandId}-started`,type:"started"};
    if(mode==="timeout")await new Promise(()=>{});
    if(mode==="binary"||mode==="auth"||mode==="resume-auth"&&resume){const message=mode==="binary"?"spawn claude ENOENT":"authentication token expired; login required";yield{...base,eventId:`${c.commandId}-notice`,type:"provider-notice",payload:JSON.stringify({category:mode==="binary"?"unavailable":"auth_expired",message})};yield{...base,eventId:`${c.commandId}-failed`,type:"failed",reason:"provider_exit"};return;}
    yield{...base,eventId:`${c.commandId}-session`,type:"session-updated",nativeRef:"claude-native-ref",payload:"{}"};
    const expected=/OWNWARD_(?:CANARY|RESUME)_[0-9a-f-]+/.exec(parsed.text)?.[0];
    yield{...base,eventId:`${c.commandId}-message`,type:"message-completed",payload:JSON.stringify({role:"assistant",text:mode==="nonce"||mode==="resume-nonce"&&resume?"wrong-nonce":expected})};
    yield{...base,eventId:`${c.commandId}-done`,type:"completed"};
  }};
  const server=new RunnerServer(data,()=>provider);server.registerProvider(provider);server.start();const client=new RunnerClient(data);
  try{return await canaryProvider(client,"claude",tmpdir(),30);}finally{client.close();server.stop();}
}

test("provider canary fault matrix is diagnostic",async()=>{
  expect(await scenario("success")).toMatchObject({ok:true,providerId:"claude",nativeRef:"claude-native-ref"});
  expect(await scenario("binary")).toMatchObject({ok:false,errorCode:"PROVIDER_BINARY_MISSING"});
  expect(await scenario("auth")).toMatchObject({ok:false,errorCode:"PROVIDER_AUTH_EXPIRED"});
  const resume=await scenario("resume-auth");expect(resume).toMatchObject({ok:false,errorCode:"PROVIDER_AUTH_EXPIRED"});expect(resume.resumeCommandId).toBeString();
  expect(await scenario("nonce")).toMatchObject({ok:false,errorCode:"PROVIDER_CANARY_OUTPUT_MISMATCH"});
  expect(await scenario("resume-nonce")).toMatchObject({ok:false,errorCode:"PROVIDER_RESUME_OUTPUT_MISMATCH"});
  expect(await scenario("timeout")).toMatchObject({ok:false,errorCode:"PROVIDER_CANARY_TIMEOUT"});
});

test("canary cleanup kills the isolated process group including provider children",async()=>{
  const proc=Bun.spawn(["bash","-c","sleep 30 & child=$!; echo $child; wait"],{stdout:"pipe",stderr:"ignore",detached:true});
  const reader=(proc.stdout as ReadableStream<Uint8Array>).getReader();const first=await reader.read();const child=Number(new TextDecoder().decode(first.value).trim());expect(child).toBeGreaterThan(0);
  await terminateCanaryProcess(proc);await Bun.sleep(10);expect(()=>process.kill(child,0)).toThrow();
});

test("isolated canary redirects every provider home and copies only minimal auth material",()=>{
  const source=readFileSync(join(import.meta.dir,"provider-canary.ts"),"utf8");
  for(const key of["HOME:home","CLAUDE_CONFIG_DIR:claude","CODEX_HOME:codex"])expect(source).toContain(key);
  expect(source).toContain('".credentials.json"');expect(source).toContain('"auth.json"');expect(source).toContain('".claude.json"');expect(source).toContain('"oauthAccount","userID","hasCompletedOnboarding","installMethod"');expect(source).toContain('"Claude Code-credentials"');expect(source).toContain("parsed.claudeAiOauth");expect(source).not.toContain("Bun.spawnSync");expect(source).not.toContain("copyFileSync(homedir()");expect(source).toContain("if(runner)await terminateCanaryProcess(runner);rmSync(root,{recursive:true,force:true})");
});

test("canary waits on the command identifier used by Runner activeRuns",()=>{const canary=readFileSync(join(import.meta.dir,"provider-canary.ts"),"utf8"),server=readFileSync(join(import.meta.dir,"../runner/server.ts"),"utf8");expect(canary).toContain("waitCommandInactive(client,startCommandId");expect(server).toContain("this.active.set(accepted.record.commandId");expect(server).toContain("activeRuns: [...this.active.keys()]")});
