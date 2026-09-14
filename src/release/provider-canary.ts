import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { RunnerClient } from "../runner/client.ts";
import { RunnerEventJournal } from "../runner/journals.ts";

const terminalTypes=new Set(["completed","failed","interrupted","unknown-outcome"]);
export type CanaryResult={providerId:string;ok:boolean;startCommandId:string;resumeCommandId?:string;nativeRef?:string;errorCode?:string;detail?:string};

async function waitTerminal(client:RunnerClient,id:string,timeoutMs:number){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const reply=await client.queryCommand(id,2_000),events=(reply.body.events??[])as any[],terminal=events.find(e=>terminalTypes.has(e.type));if(terminal)return{events,terminal};await Bun.sleep(100);}throw Object.assign(new Error(`provider canary timed out: ${id}`),{code:"PROVIDER_CANARY_TIMEOUT"});}
async function waitCommandInactive(client:RunnerClient,commandId:string,timeoutMs:number){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const health=await client.request("ping",{},2_000);if(!((health.body.activeRuns??[])as string[]).includes(commandId))return;await Bun.sleep(25);}throw Object.assign(new Error(`provider canary command stayed active: ${commandId}`),{code:"PROVIDER_CANARY_TIMEOUT"});}
function payloads(client:RunnerClient,events:any[]){const journal=new RunnerEventJournal(client.dataRoot);return events.filter(e=>e.payloadRef).map(e=>{try{return JSON.parse(journal.readPayload(e)!);}catch{return null;}}).filter(Boolean);}
function classify(client:RunnerClient,events:any[],fallback="PROVIDER_CANARY_FAILED"){const values=payloads(client,events),raw=JSON.stringify(values),categories=values.map((x:any)=>x.category);if(categories.includes("auth_expired")||/auth|login|credential|token.*expired/i.test(raw))return"PROVIDER_AUTH_EXPIRED";if(categories.includes("rate_limited")||/rate.?limit|429/i.test(raw))return"PROVIDER_RATE_LIMITED";if(categories.includes("resume_not_found")||/resume.*not found|thread.*not found|rollout.*not found/i.test(raw))return"PROVIDER_RESUME_NOT_FOUND";if(/ENOENT|command not found|spawn[^\n]*(?:not found|failed)/i.test(raw))return"PROVIDER_BINARY_MISSING";if(/protocol|invalid.*json/i.test(raw))return"PROVIDER_PROTOCOL_MISMATCH";return fallback;}
function classifyError(error:any){const raw=`${error?.code??""} ${error instanceof Error?error.message:String(error)}`;if(/ENOENT|command not found|spawn[^\n]*(?:not found|failed)/i.test(raw))return"PROVIDER_BINARY_MISSING";if(/auth|login|credential|token.*expired/i.test(raw))return"PROVIDER_AUTH_EXPIRED";if(/rate.?limit|429/i.test(raw))return"PROVIDER_RATE_LIMITED";if(/protocol|invalid.*json/i.test(raw))return"PROVIDER_PROTOCOL_MISMATCH";return error?.code||"PROVIDER_CANARY_FAILED";}
// 只要求助手「以 nonce 开头独占一行」，不要求整条消息逐字相等：claude.ai 侧的连接器
// （Gmail/日历/Drive）在 canary 的隔离 HOME 里授权不到，resume 那轮会在 nonce 后面追加一段
// "…MCP servers need authorization…" 的附言，于是连正在跑的生产版本都过不了 canary。
// 首行精确匹配仍然证明了要证明的东西：provider 忠实回传新 nonce，且 resume 只凭 nativeRef
// 就能接上会话（两轮 nonce 不同）。模型自己多说的话不改变这两点。
function provesNonce(client:RunnerClient,events:any[],expected:string){const messages=payloads(client,events).filter((x:any)=>x.role==="assistant"&&typeof x.text==="string").map((x:any)=>x.text.trim());return messages.some(text=>text.split("\n")[0].trim()===expected);}
export async function canaryProvider(client:RunnerClient,providerId:"claude"|"codex",cwd:string,timeoutMs=90_000):Promise<CanaryResult>{
  const nonce=crypto.randomUUID(),sessionId=`canary-session-${nonce}`,startCommandId=`canary-start-${nonce}`,resumeCommandId=`canary-resume-${nonce}`;
  // Codex contract only exposes workspace-write/full-access. The workspace is a fresh disposable empty dir,
  // so workspace-write cannot touch user or production data.
  const options=providerId==="claude"?{access:"standard",extraDirs:[]}:{access:"workspace-write",extraDirs:[],home:{kind:"default"}};
  try{
    const startRunId=`canary-run-1-${nonce}`;
    await client.request("submit",{commandId:startCommandId,kind:"start-run",runId:startRunId,sessionId,providerId,input:JSON.stringify({text:`Reply exactly OWNWARD_CANARY_${nonce}. Do not use tools or modify files.`,cwd,images:[],options})});
    const first=await waitTerminal(client,startCommandId,timeoutMs),nativeRef=first.events.find(e=>e.type==="session-updated")?.nativeRef;
    if(first.terminal.type!=="completed"||typeof nativeRef!=="string")return{providerId,ok:false,startCommandId,errorCode:classify(client,first.events),detail:`start terminal=${first.terminal.type} reason=${first.terminal.reason??"unknown"}`};
    if(!provesNonce(client,first.events,`OWNWARD_CANARY_${nonce}`))return{providerId,ok:false,startCommandId,nativeRef,errorCode:"PROVIDER_CANARY_OUTPUT_MISMATCH",detail:"start output did not exactly match nonce"};
    await waitCommandInactive(client,startCommandId,timeoutMs);
    await client.request("submit",{commandId:resumeCommandId,kind:"resume-run",runId:`canary-run-2-${nonce}`,sessionId,providerId,input:JSON.stringify({text:`Reply exactly OWNWARD_RESUME_${nonce}. Do not use tools or modify files.`,cwd,images:[],options,nativeRef})});
    const second=await waitTerminal(client,resumeCommandId,timeoutMs);
    if(second.terminal.type!=="completed")return{providerId,ok:false,startCommandId,resumeCommandId,nativeRef,errorCode:classify(client,second.events,"PROVIDER_RESUME_FAILED"),detail:`resume terminal=${second.terminal.type} reason=${second.terminal.reason??"unknown"}`};
    if(!provesNonce(client,second.events,`OWNWARD_RESUME_${nonce}`))return{providerId,ok:false,startCommandId,resumeCommandId,nativeRef,errorCode:"PROVIDER_RESUME_OUTPUT_MISMATCH",detail:"resume output did not exactly match nonce"};
    return{providerId,ok:true,startCommandId,resumeCommandId,nativeRef};
  }catch(error:any){const code=error?.code==="PROVIDER_CANARY_TIMEOUT"?"PROVIDER_CANARY_TIMEOUT":classifyError(error);return{providerId,ok:false,startCommandId,resumeCommandId,errorCode:code,detail:error instanceof Error?error.message:String(error)};}
}

export async function terminateCanaryProcess(runner:Bun.Subprocess){
  const pid=runner.pid;
  try{process.kill(-pid,"SIGKILL");}catch{try{runner.kill("SIGKILL");}catch{}}
  await runner.exited.catch(()=>-1);
  try{process.kill(-pid,"SIGKILL");}catch{}
}

async function keychainClaudeCredential(timeoutMs=5_000):Promise<string|undefined>{
  const proc=Bun.spawn(["security","find-generic-password","-s","Claude Code-credentials","-a",process.env.USER||"","-w"],{stdout:"pipe",stderr:"ignore"});
  const result=await Promise.race([Promise.all([new Response(proc.stdout).text(),proc.exited]).then(([raw,code])=>code===0?raw:undefined),Bun.sleep(timeoutMs).then(()=>undefined)]);
  if(result===undefined){try{proc.kill("SIGKILL");}catch{}await proc.exited.catch(()=>-1);}return result;
}

/** 隔离 home 里给 codex 的最小 config.toml：只搬顶层 `model`（[section] 之前的行），返回 TOML 文本；用户没配就 null。
 *  没有它 CLI 会落到自己的默认型号（2026-09-08 实测 gpt-6-astra，"Selected model is at capacity"），一个与本次构建
 *  无关的服务端满载就把整个发布打回滚；canary 要证明的是「用户实际在跑的模型能通」。notify 钩子、沙箱、MCP 一概不带。 */
export function minimalCodexConfig(path:string):string|null{
  let text:string;try{text=readFileSync(path,"utf8");}catch{return null;}
  for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(line.startsWith("["))break;const m=/^model\s*=\s*("(?:[^"\\]|\\.)+")\s*(?:#.*)?$/.exec(line);if(m)return `model = ${m[1]}\n`;}
  return null;
}

export async function runIsolatedProviderCanaries(releaseRoot:string,providers:("claude"|"codex")[],timeoutMs=90_000){
  const root=mkdtempSync(join(tmpdir(),"ownward-provider-canary-")),data=join(root,"data"),cwd=join(root,"cwd"),home=join(root,"home"),claude=join(home,".claude"),codex=join(home,".codex");let runner:Bun.Subprocess|undefined;
  try{for(const dir of[data,cwd,home,claude,codex])mkdirSync(dir,{mode:0o700});
    const copyAuth=(from:string,to:string)=>{if(existsSync(from)){copyFileSync(from,to);chmodSync(to,0o400);}};
    copyAuth(join(homedir(),".claude",".credentials.json"),join(claude,".credentials.json"));copyAuth(join(homedir(),".codex","auth.json"),join(codex,"auth.json"));
    const codexConfig=minimalCodexConfig(join(homedir(),".codex","config.toml"));if(codexConfig)writeFileSync(join(codex,"config.toml"),codexConfig,{mode:0o400});
    if(!existsSync(join(claude,".credentials.json"))&&process.platform==="darwin"){const raw=await keychainClaudeCredential();if(raw)try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed==="object"&&parsed.claudeAiOauth)writeFileSync(join(claude,".credentials.json"),raw,{mode:0o400});}catch{}}
    const claudeState=join(homedir(),".claude.json");if(existsSync(claudeState))try{const source=JSON.parse(readFileSync(claudeState,"utf8")),minimal=Object.fromEntries(["oauthAccount","userID","hasCompletedOnboarding","installMethod"].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));writeFileSync(join(home,".claude.json"),JSON.stringify(minimal),{mode:0o400});}catch{}
    const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:claude,CODEX_HOME:codex,OWNWARD_DATA_ROOT:data,OWNWARD_RUNNER_BUILD_IDENTITY:process.env.OWNWARD_BUILD_IDENTITY||"canary"};
    runner=Bun.spawn([process.execPath,join(releaseRoot,"src/runner/entry.ts")],{cwd:releaseRoot,env,stdout:"ignore",stderr:"pipe",detached:true});
    let client:RunnerClient|undefined;for(let i=0;i<100;i++){try{client=new RunnerClient(data,2_000);await client.request("ping",{});break;}catch{client?.close();client=undefined;await Bun.sleep(50);}}if(!client)throw new Error("isolated Runner failed to start");try{const results=[];for(const provider of providers)results.push(await canaryProvider(client,provider,cwd,timeoutMs));return results;}finally{client.close();}
  }finally{if(runner)await terminateCanaryProcess(runner);rmSync(root,{recursive:true,force:true});}
}
if(import.meta.main){const root=process.argv[2]||process.cwd(),providers=(process.argv.slice(3).length?process.argv.slice(3):["claude","codex"])as("claude"|"codex")[];const result=await runIsolatedProviderCanaries(root,providers);console.log(JSON.stringify(result));if(result.some(x=>!x.ok))process.exitCode=1;}
