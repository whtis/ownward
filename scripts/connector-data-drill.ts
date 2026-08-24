import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative, resolve } from "path";
import { tmpdir } from "os";
import { LarkIngressStore, larkConnectorEvent, replayLarkIngress } from "../src/sources/lark.ts";
import { collectGithub } from "../src/sources/github.ts";
import { collectGmailAccount } from "../src/sources/gmail.ts";
import type { ConnectorCheckpoint, ConnectorContext, ConnectorEvent } from "../src/kernel/connectors/contracts.ts";

const MARKER=".ownward-connector-drill-copy";
const ALLOW=["queue.jsonl","connectors/lark/raw-ingress","connectors/lark/raw-ingress-quarantine","connectors/lark/checkpoint.json","connectors/github/checkpoint.json","connectors/gmail/checkpoint.json"];

function files(root:string):string[]{const out:string[]=[];function walk(dir:string){if(!existsSync(dir))return;for(const name of readdirSync(dir)){const path=join(dir,name),st=lstatSync(path);if(st.isSymbolicLink())throw new Error("DRILL_SYMLINK_REJECTED");if(st.isDirectory())walk(path);else if(st.isFile())out.push(path);}}walk(root);return out.sort();}
function digest(root:string,list:string[]){const h=createHash("sha256");for(const path of list){h.update(relative(root,path));h.update("\0");h.update(readFileSync(path));h.update("\0");}return h.digest("hex");}
function fixture(id:string){let checkpoint:ConnectorCheckpoint|null=null;const events:ConnectorEvent[]=[];const ctx:ConnectorContext={id,generation:"drill",config:{},signal:new AbortController().signal,checkpoint:async()=>checkpoint,publish:async(rows,next)=>{events.push(...rows);checkpoint=next??checkpoint;return{accepted:rows.length,duplicates:0};},secret:async()=>undefined,reportHealth:async()=>{},log(){}};return{ctx,events};}

export async function runConnectorDataDrill(sourceInput:string,workInput?:string){const source=realpathSync(resolve(sourceInput));if(!existsSync(join(source,MARKER)))throw new Error("DRILL_COPY_MARKER_REQUIRED");if(existsSync(join(source,"secrets")))throw new Error("DRILL_SECRETS_PRESENT");const work=workInput?resolve(workInput):mkdtempSync(join(tmpdir(),"ownward-connector-drill-"));if(existsSync(work)&&readdirSync(work).length)throw new Error("DRILL_WORKDIR_NOT_EMPTY");mkdirSync(work,{recursive:true,mode:0o700});chmodSync(work,0o700);
  for(const rel of ALLOW){const from=join(source,rel),to=join(work,"copied",rel);if(!existsSync(from))continue;mkdirSync(resolve(to,".."),{recursive:true,mode:0o700});cpSync(from,to,{recursive:true,preserveTimestamps:true});}
  const copied=join(work,"copied"),copiedFiles=files(copied),rawDir=join(copied,"connectors","lark","raw-ingress"),rawFiles=existsSync(rawDir)?readdirSync(rawDir).filter(name=>name.endsWith(".json")):[];
  let privateDirs=0,privateFiles=0;for(const path of copiedFiles){if((statSync(path).mode&0o077)===0)privateFiles++;}for(const path of[work,rawDir])if(existsSync(path)&&(statSync(path).mode&0o077)===0)privateDirs++;

  let now=new Date("2026-08-17T00:00:00Z"),expiredActions=0;const fixtureRoot=join(work,"synthetic"),store=new LarkIngressStore(fixtureRoot,20,1024*1024,{now:()=>now,retryBaseMs:1,cardTtlMs:10,onExpiredCard:()=>{expiredActions++;}});store.stage("im.message.receive_v1",{message_id:"poison"});store.stage("im.message.receive_v1",{message_id:"healthy"});const published:string[]=[],base=fixture("lark-drill"),ctx:ConnectorContext={...base.ctx,publish:async(rows)=>{const id=String(rows[0]?.payload?.message_id||"");if(id==="poison")throw new Error("synthetic poison");published.push(id);return{accepted:1,duplicates:0};}};for(let i=0;i<3;i++){try{await replayLarkIngress(ctx,store,20);}catch{}now=new Date(now.getTime()+10);}store.stage("card.action.trigger",{request_id:"expired-card",token:"synthetic-secret"});now=new Date(now.getTime()+11);await replayLarkIngress(ctx,store,20);
  const quarantine=join(fixtureRoot,"connectors","lark","raw-ingress-quarantine"),quarantined=existsSync(quarantine)?readdirSync(quarantine).length:0;

  const gh=fixture("github"),gm=fixture("gmail");await collectGithub(gh.ctx,async()=>({code:0,stdout:JSON.stringify([{id:"fixture",reason:"review_requested",updated_at:"2026-08-17T00:00:00Z",repository:{full_name:"fixture/repo"},subject:{title:"Fixture",type:"PullRequest"}}]),stderr:""}));await collectGmailAccount(gm.ctx,{email:"fixture@example.invalid",file:"[fixture]"},async path=>path.startsWith("/messages?")?{messages:[{id:"fixture"}]}:{threadId:"fixture",snippet:"fixture",payload:{headers:[]}} as any);const fixtureIds=[larkConnectorEvent("im.message.receive_v1",{message_id:"fixture"}).id,...gh.events.map(e=>e.id),...gm.events.map(e=>e.id)].sort();
  return{schemaVersion:1,copy:{files:copiedFiles.length,rawFiles:rawFiles.length,aggregateSha256:digest(copied,copiedFiles),privateFiles,privateDirs},faults:{healthyPublished:published.length,quarantined,expiredCardActions:expiredActions,pending:store.pending().length},sourceFixture:{events:fixtureIds.length,identitySha256:createHash("sha256").update(fixtureIds.join("\n")).digest("hex")}};
}

if(import.meta.main){const args=process.argv.slice(2),source=args[args.indexOf("--source")+1],workIndex=args.indexOf("--workdir");if(!source){console.error("usage: bun scripts/connector-data-drill.ts --source <sanitized-copy> [--workdir <empty-dir>]");process.exit(2);}try{console.log(JSON.stringify(await runConnectorDataDrill(source,workIndex>=0?args[workIndex+1]:undefined),null,2));}catch(error:any){console.error(JSON.stringify({ok:false,code:String(error?.message||"DRILL_FAILED").split(":")[0]}));process.exit(1);}}
