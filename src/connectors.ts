// Connector Registry compatibility facade. The runtime is opt-in while first-party sources are
// migrated one-by-one; production defaults remain on the legacy source bootstrap.
import { cfg, DATA, log, updateState } from "./util.ts";
import { openAction } from "./actions.ts";
import { ConnectorRuntime, type BuiltinConnector } from "./kernel/connectors/runtime.ts";
import { createConnectorSecretResolver } from "./kernel/connectors/secrets.ts";
import{existsSync,readFileSync,readdirSync}from"fs";import{join}from"path";
import { connectorDomainDispatcher } from "./connectors/domain-events.ts";

const manifest = (id: string, name: string, secrets=false) => ({ id, name, version: "1.0.0", kernelApiVersion: 1, entry: "builtin", capabilities: ["events", "checkpoint",...(secrets?["secrets" as const]:[])] as ("events"|"checkpoint"|"secrets")[], eventNamespaces: [`${id}.inbox`],...(id==="lark"?{priorityEventTypes:["card.action.trigger"]}:{}),...(id==="github"?{singletonEventTypes:["snapshot"]}:{}) });

// These wrappers preserve current protocols/config during the migration window. They are never
// enabled together with legacy bootstrap; the next thin-slice replaces their legacy start body
// with ConnectorContext.publish without changing Registry/Kernel contracts.
const builtins: BuiltinConnector[] = [
  { manifest: manifest("lark", "Lark"), load: async () => import("./sources/lark.ts").then((m)=>m.createLarkConnector()) },
  { manifest: manifest("github", "GitHub"), load: async () => import("./sources/github.ts").then((m)=>({start:m.startGithubConnector})) },
  { manifest: manifest("gmail", "Gmail",true), load: async () => import("./sources/gmail.ts").then((m)=>({start:m.startGmailConnector})) },
  { manifest: manifest("stock", "Stock Market"), load: async () => import("./sources/stock.ts").then((m)=>({start:m.startStockConnector})) },
];

function gmailSecrets(ref:string):string|undefined{if(ref!=="GMAIL_ACCOUNTS")return undefined;const dir=join(DATA,"secrets");if(!existsSync(dir))return JSON.stringify([]);const accounts=[];for(const file of readdirSync(dir).filter(f=>/^gmail(-.+)?\.json$/.test(f)).sort())try{const creds=JSON.parse(readFileSync(join(dir,file),"utf8"));accounts.push({email:creds.email||file.replace(/^gmail-?/,"").replace(/\.json$/,"")||"default",client_id:creds.client_id,client_secret:creds.client_secret,refresh_token:creds.refresh_token,access_token:creds.access_token,expires_at:creds.expires_at});}catch{}return JSON.stringify(accounts);}
const connectorSecretResolver=createConnectorSecretResolver({gmail:gmailSecrets});

export const connectorRuntime = new ConnectorRuntime({ dataRoot: DATA, config: cfg, builtins, externalPaths: Array.isArray(cfg.connectors?.externalPaths) ? cfg.connectors.externalPaths : [], secretResolver:connectorSecretResolver,onHealthy:(id,at)=>updateState(s=>{s.health={...(s.health||{}),[id]:at};}),onAlert:(id,code)=>openAction({id:`connector:${id}:${code}`,kind:"decide",source:"connector",title:`Connector ${id} 需要处理`,reason:code,ref:{}}),onEvents:(events)=>connectorDomainDispatcher.dispatch(events), log });
let starting:Promise<void>|null=null;let lifecycle=0,probeTimer:ReturnType<typeof setInterval>|undefined;
export async function startConnectorServices(runtime:{start():Promise<void>|void},dispatcher:{recoverStartup?:()=>Promise<void>|void;startRecovery?:()=>void;recover?:()=>Promise<void>|void}){if(dispatcher.recoverStartup)await dispatcher.recoverStartup();else if(dispatcher.startRecovery)dispatcher.startRecovery();else await dispatcher.recover?.();await runtime.start();}
export function startConnectors(){if(starting)return starting;const epoch=++lifecycle,work=startConnectorServices(connectorRuntime,connectorDomainDispatcher).then(()=>{if(epoch!==lifecycle)return;if(!probeTimer){void connectorRuntime.probe();probeTimer=setInterval(()=>void connectorRuntime.probe(),60_000);(probeTimer as any).unref?.();}}).catch((e)=>{log(`connectors start unavailable: ${e instanceof Error?e.name:"unknown"}`);if(starting===work)starting=null;});starting=work;return work;}
export async function stopConnectors(){lifecycle++;const active=starting;starting=null;if(probeTimer)clearInterval(probeTimer);probeTimer=undefined;const stopping=connectorRuntime.stop();connectorDomainDispatcher.stopRecovery();await stopping;let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([connectorDomainDispatcher.drain(),new Promise<void>(resolve=>{timer=setTimeout(()=>{log("connector dispatcher drain timeout; durable spool will recover on restart");resolve();},2_000);})]);if(timer)clearTimeout(timer);void active;}
export function connectorStatuses(){return connectorRuntime.statuses();}
export async function connectorDiagnostics(){const recovery=connectorDomainDispatcher.recoveryStatuses();return(await connectorRuntime.health()).map(status=>({...status,...(recovery[String(status.id)]?{recovery:recovery[String(status.id)]}:{})}));}
export async function restartConnector(id:string){await startConnectors();await connectorRuntime.restartConnector(id);}
