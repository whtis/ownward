// 飞书事件源，两条腿：
// 1. bot 长连接（event consume）：只覆盖 bot 所在会话，实时
// 2. user 身份轮询（messages-search 时间窗）：覆盖你所有私聊 + 未静音群聊，兜住 bot 看不到的部分
// 两条腿按 message_id 去重；群消息只收未静音会话（拿不到静音列表时降级为只收 p2p）。
import { LarkDailyMsg } from "../lark-digest.ts";
import { parseLarkTs, previewText } from "../lark-state.ts";
import { OwnwardEvent } from "../spool.ts";
import { cfg, DATA, fmt, log, run } from "../util.ts";
import { openAction } from "../actions.ts";
import type { ConnectorContext, ConnectorEvent } from "../kernel/connectors/contracts.ts";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { createHash } from "crypto";
import { basename, dirname, join } from "path";
import { connectorConfig } from "../connector-config.ts";

let unmutedChats: Set<string> | null = null;
const warnedUnsubscribed = new Set<string>();  // 回调未订阅的事件：只提醒一次，之后慢重试

async function refreshUnmuted() {
  const r = await run(
    ["lark-cli", "im", "+chat-list", "--as", "user", "--exclude-muted", "--format", "json"],
    { timeoutMs: 30_000 },
  );
  try {
    const parsed = JSON.parse(r.stdout);
    if (r.code === 0 && parsed.ok !== false) {
      unmutedChats = new Set((parsed.data?.chats || []).map((c: any) => c.chat_id));
      return;
    }
  } catch { /* fall through */ }
  log(`lark: unmuted chat list refresh failed, group messages degraded to drop`);
  unmutedChats = null;
}

/** 事件是否值得进队列 */
function wanted(payload: any, sourceConfig: any = connectorConfig(cfg, "lark")): boolean {
  const policy = sourceConfig?.groupPolicy || "unmuted"; // unmuted | p2p | all
  if (policy === "all") return true;
  const msg = payload?.message || payload || {};
  const chatType = msg.chat_type || payload?.chat_type;
  const chatId = msg.chat_id || payload?.chat_id;
  if (chatType === "p2p") return true;
  if (!chatType && !chatId) return true;          // 结构未知的事件不误杀
  if (policy === "p2p") return false;
  return unmutedChats ? unmutedChats.has(chatId) : false;
}

// message_id 去重：bot 长连接和 user 轮询会看到同一条消息
// ---- 表情回复 = 已处理：我对消息回过表情的，视同处理完，不进事件流、不催办 ----

/** 内嵌 reactions 结构（messages-search / chat-messages-list 返回里自带）是否含我的表情 */
/** 单条消息查表情回复。查询失败按「没回」处理——宁可多推一条，不静默吞消息 */
async function myReactionOn(messageId: string): Promise<boolean> {
  const r = await run(
    ["lark-cli", "im", "reactions", "list", "--message-id", messageId, "--as", "user", "--format", "json"],
    { timeoutMs: 15_000 },
  );
  if (r.code !== 0) return false;
  try {
    const items = JSON.parse(r.stdout).data?.items || [];
    return items.some((it: any) => it.operator?.operator_id === cfg.notify.larkUserId);
  } catch { return false; }
}

/** triage 前置过滤：批里的飞书消息若已被我回表情，出队丢弃（触达前最后一道闸）。
 *  消息从进队到 triage 有最多 intervalMin 的窗口，正好覆盖「看到消息顺手回表情」的习惯。 */
export async function dropReactedLark(events: OwnwardEvent[]): Promise<OwnwardEvent[]> {
  const out: OwnwardEvent[] = [];
  for (const e of events) {
    const msgId = e.source === "lark" && !String(e.key||"").endsWith("card.action.trigger")
      ? (e.payload as any)?.message_id : "";
    if (msgId && await myReactionOn(msgId)) {
      log(`lark: ${msgId} 已回表情，视同已处理，出队`);
      continue;
    }
    out.push(e);
  }
  return out;
}

async function enqueueLark(key: string, payload: any, connector: ConnectorContext) {
  const normalized=normalizeLarkPayload(key,payload);
  const msgId = normalized.message_id || normalized.id;
  const upstreamId=String(msgId||normalized.event_id||normalized.request_id||"");
  if(!upstreamId){connector.log("drop","event missing stable upstream id");return;}
  const event=larkConnectorEvent(key,normalized);
  if(key==="card.action.trigger")await connector.publish([event]);
  else await connector.publish([event],{version:1,cursor:upstreamId,updatedAt:new Date().toISOString()});
}

/** Convert both lark-cli's legacy flat rows and Feishu's native event envelope into
 * the stable payload consumed by projections. Transport-only envelope fields are omitted. */
export function normalizeLarkPayload(key:string,input:any):Record<string,unknown>{
  const root=input&&typeof input==="object"?input:{};
  const header=root.header&&typeof root.header==="object"?root.header:{};
  const event=root.event&&typeof root.event==="object"?root.event:{};
  const message=event.message&&typeof event.message==="object"?event.message:(root.message&&typeof root.message==="object"?root.message:{});
  const eventId=String(header.event_id||event.event_id||root.event_id||"");
  if(key==="card.action.trigger"){
    const operator=event.operator&&typeof event.operator==="object"?event.operator:{};
    const operatorId=operator.operator_id?.open_id||operator.open_id||event.operator_id||root.operator_id;
    const action=event.action&&typeof event.action==="object"?event.action:(root.action&&typeof root.action==="object"?root.action:{});
    const context=event.context&&typeof event.context==="object"?event.context:(root.context&&typeof root.context==="object"?root.context:{});
    const value=action.value??event.action_value??root.action_value;
    return{event_id:eventId||undefined,request_id:root.request_id||event.request_id||eventId||undefined,operator_id:operatorId,action_value:typeof value==="string"?value:JSON.stringify(value??{}),action_tag:action.tag,action_option:action.option,open_message_id:context.open_message_id||event.open_message_id||root.open_message_id,open_chat_id:context.open_chat_id||event.open_chat_id||root.open_chat_id,context:structuredClone(context),token:event.token||root.token||""};
  }
  const sender=event.sender&&typeof event.sender==="object"?event.sender:(root.sender&&typeof root.sender==="object"?root.sender:{});
  return{event_id:eventId||undefined,message_id:message.message_id||root.message_id,id:message.id||root.id,chat_id:message.chat_id||root.chat_id,chat_type:message.chat_type||root.chat_type,message_type:message.message_type||root.message_type,content:message.content??root.content,create_time:message.create_time||event.create_time||root.create_time||header.create_time,timestamp:message.timestamp||event.timestamp||root.timestamp,sender_name:root.sender_name||event.sender_name||sender.sender_name||sender.name||"",sender:{sender_id:sender.sender_id,sender_type:sender.sender_type,name:sender.name},chat_partner:root.chat_partner};
}

export function larkConnectorEvent(key:string,payload:any,now=new Date()):ConnectorEvent{
  const normalized=normalizeLarkPayload(key,payload);
  const upstreamId=String(normalized?.message_id||normalized?.id||normalized?.event_id||normalized?.request_id||"");
  if(!upstreamId)throw Object.assign(new Error("Lark event missing stable upstream id"),{code:"CONNECTOR_EVENT_ID_MISSING"});
  return{id:`${key}:${upstreamId}`,namespace:"lark.inbox",type:key,occurredAt:now.toISOString(),payload:structuredClone(normalized)};
}

type RawIngress={key:string;payload:Record<string,unknown>;storedAt:string;seq?:number;attempts?:number;nextAttemptAt?:string;lastError?:string};
type LarkIngressDeps={now?:()=>Date;retryBaseMs?:number;ttlMs?:number;cardTtlMs?:number;quarantineTtlMs?:number;onExpiredCard?:(id:string)=>void};
function durableIngressPayload(value:unknown):unknown{if(Array.isArray(value))return value.map(durableIngressPayload);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,/(?:token|secret|password|authorization|cookie|credential)/i.test(key)?"[REDACTED]":durableIngressPayload(item)]));return value;}
export class LarkIngressStore{
  private readonly dir:string;
  private usage?:{files:string[];sizes:Map<string,number>;byHash:Map<string,string>;bytes:number};
  private readonly inflight=new Set<string>();
  private readonly ephemeralTokens=new Map<string,string>();
  constructor(root=DATA,private readonly maxFiles=10_000,private readonly maxBytes=64*1024*1024,private readonly deps:LarkIngressDeps={}){this.dir=join(root,"connectors","lark","raw-ingress");this.scrubLegacyRaw();this.cleanupQuarantine();}
  private ensureDir(path=this.dir){mkdirSync(path,{recursive:true,mode:0o700});try{chmodSync(path,0o700);}catch{}}
  private scrubLegacyRaw(){this.ensureDir();let changed=false;try{for(const file of readdirSync(this.dir).filter(value=>value.endsWith(".json"))){const path=join(this.dir,file);try{const value=JSON.parse(readFileSync(path,"utf8")),safe={...value,payload:durableIngressPayload(value.payload)},raw=JSON.stringify(safe)+"\n";if(raw===readFileSync(path,"utf8"))continue;const temp=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp,raw,{mode:0o600});const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);chmodSync(path,0o600);changed=true;}catch{}}if(changed){const fd=openSync(this.dir,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}}catch{}}
  private inventory(){if(this.usage)return this.usage;this.ensureDir();const files:string[]=[];try{files.push(...readdirSync(this.dir).filter(f=>f.endsWith(".json")));}catch{}files.sort((a,b)=>{const aa=Number(a.match(/^(\d+)-/)?.[1]||0),bb=Number(b.match(/^(\d+)-/)?.[1]||0);return aa-bb||a.localeCompare(b);});const sizes=new Map<string,number>(),byHash=new Map<string,string>();let bytes=0;for(const file of files)try{const size=statSync(join(this.dir,file)).size;sizes.set(file,size);bytes+=size;const hash=file.match(/(?:^|-)([a-f0-9]{64})\.json$/)?.[1];if(hash)byHash.set(hash,file);}catch{}return this.usage={files,sizes,byHash,bytes};}
  private nextSeq(){this.ensureDir();const path=join(this.dir,"next-seq"),usage=this.inventory();let seq=Math.max(1,...usage.files.map(file=>Number(file.match(/^(\d+)-/)?.[1]||0)+1));try{seq=Math.max(seq,Number.parseInt(readFileSync(path,"utf8"),10)||1);}catch{}const temp=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp,String(seq+1)+"\n",{mode:0o600});const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);return seq;}
  stage(key:string,payload:Record<string,unknown>):string{const event=larkConnectorEvent(key,payload),hash=createHash("sha256").update(event.id).digest("hex"),usage=this.inventory(),existing=usage.byHash.get(hash),token=typeof payload.token==="string"&&payload.token!=="[REDACTED]"?payload.token:"";if(existing){const path=join(this.dir,existing);if(token)this.ephemeralTokens.set(path,token);return path;}const storedAt=(this.deps.now?.()??new Date()).toISOString(),durable=durableIngressPayload(payload) as Record<string,unknown>,estimate=JSON.stringify({key,payload:durable,storedAt,seq:Number.MAX_SAFE_INTEGER})+"\n";if(usage.files.length>=this.maxFiles||usage.bytes+Buffer.byteLength(estimate)>this.maxBytes)throw Object.assign(new Error("Lark raw ingress capacity reached"),{code:"LARK_INGRESS_CAPACITY"});const seq=this.nextSeq(),name=`${String(seq).padStart(16,"0")}-${hash}.json`,path=join(this.dir,name),raw=JSON.stringify({key,payload:durable,storedAt,seq})+"\n",temp=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp,raw,{mode:0o600});const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dfd=openSync(dirname(path),"r");try{fsyncSync(dfd);}finally{closeSync(dfd);}if(token)this.ephemeralTokens.set(path,token);const size=Buffer.byteLength(raw);usage.files.push(name);usage.sizes.set(name,size);usage.byHash.set(hash,name);usage.bytes+=size;return path;}
  project(item:{path:string;value:RawIngress}):RawIngress{const token=this.ephemeralTokens.get(item.path);return token?{...item.value,payload:{...item.value.payload,token}}:item.value;}
  pending(limit=Number.POSITIVE_INFINITY):Array<{path:string;value:RawIngress}>{const out:Array<{path:string;value:RawIngress}>=[],usage=this.inventory(),now=(this.deps.now?.()??new Date()).getTime();for(const file of usage.files.slice()){if(out.length>=limit)break;const path=join(this.dir,file);if(this.inflight.has(path))continue;try{const value=JSON.parse(readFileSync(path,"utf8"));if(typeof value?.key!=="string"||!value.payload||typeof value.payload!=="object")throw new Error("invalid raw ingress");if(value.nextAttemptAt&&Date.parse(value.nextAttemptAt)>now)continue;out.push({path,value});}catch{try{renameSync(path,`${path}.corrupt.${Date.now()}`);}catch{}this.removeUsage(file);}}return out;}
  claim(path:string){if(this.inflight.has(path))return false;this.inflight.add(path);return true;}
  release(path:string){this.inflight.delete(path);}
  private removeUsage(file:string){const usage=this.inventory(),size=usage.sizes.get(file)||0;usage.files=usage.files.filter(value=>value!==file);usage.sizes.delete(file);usage.bytes=Math.max(0,usage.bytes-size);for(const[hash,name]of usage.byHash)if(name===file)usage.byHash.delete(hash);}
  private rewrite(path:string,value:RawIngress){const raw=JSON.stringify(value)+"\n",temp=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp,raw,{mode:0o600});const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dfd=openSync(this.dir,"r");try{fsyncSync(dfd);}finally{closeSync(dfd);}const file=basename(path),usage=this.inventory(),before=usage.sizes.get(file)||0,after=Buffer.byteLength(raw);usage.sizes.set(file,after);usage.bytes=Math.max(0,usage.bytes-before+after);}
  quarantine(path:string,reason:string){const dir=join(dirname(this.dir),"raw-ingress-quarantine");this.ensureDir(dir);this.cleanupQuarantine(dir);const target=join(dir,`${basename(path)}.${reason}.${Date.now()}`);try{renameSync(path,target);for(const fsyncDir of[this.dir,dir]){const dfd=openSync(fsyncDir,"r");try{fsyncSync(dfd);}finally{closeSync(dfd);}}}finally{this.ephemeralTokens.delete(path);this.removeUsage(basename(path));this.release(path);}return target;}
  cleanupQuarantine(dir=join(dirname(this.dir),"raw-ingress-quarantine")){const cutoff=(this.deps.now?.()??new Date()).getTime()-(this.deps.quarantineTtlMs??30*24*60*60_000);try{for(const file of readdirSync(dir)){const path=join(dir,file);try{if(statSync(path).mtimeMs<cutoff)unlinkSync(path);}catch{}}}catch{}}
  expired(item:{path:string;value:RawIngress}){const card=item.value.key==="card.action.trigger",ttl=card?(this.deps.cardTtlMs??10*60_000):(this.deps.ttlMs??7*24*60*60_000);if((this.deps.now?.()??new Date()).getTime()-Date.parse(item.value.storedAt)<=ttl)return false;this.quarantine(item.path,card?"expired-card":"expired");if(card){const id=basename(item.path).match(/([a-f0-9]{64})\.json/)?.[1]||createHash("sha256").update(item.path).digest("hex");(this.deps.onExpiredCard??((eventId:string)=>openAction({id:`lark-ingress-expired:${eventId}`,kind:"decide",source:"lark",title:"飞书卡片操作已过期",reason:"卡片回调超过安全重放窗口，已隔离且未自动执行",ref:{}})))(id);}return true;}
  requeue(item:{path:string;value:RawIngress},error:unknown){const attempts=(item.value.attempts??0)+1;if(attempts>=3){this.quarantine(item.path,"poison");return"quarantined" as const;}const delay=(this.deps.retryBaseMs??250)*2**(attempts-1),now=this.deps.now?.()??new Date(),code=error&&typeof error==="object"&&"code"in error?String((error as any).code):error instanceof Error?error.name:"LARK_REPLAY_FAILED";this.rewrite(item.path,{...item.value,attempts,lastError:/^[A-Z0-9_-]{1,80}$/.test(code)?code:"LARK_REPLAY_FAILED",nextAttemptAt:new Date(now.getTime()+delay).toISOString()});this.release(item.path);return"requeued" as const;}
  ack(path:string){try{unlinkSync(path);this.removeUsage(basename(path));}catch(error:any){if(error?.code!=="ENOENT")throw error;this.removeUsage(basename(path));}finally{this.ephemeralTokens.delete(path);this.release(path);}}
}
let defaultLarkIngressStore:LarkIngressStore|undefined;const defaultIngress=()=>defaultLarkIngressStore??=new LarkIngressStore();
export async function replayLarkIngress(connector:ConnectorContext,store=defaultIngress(),batchSize=50):Promise<number>{let count=0,firstError:unknown;for(const item of store.pending(batchSize)){if(connector.signal.aborted)break;if(store.expired(item))continue;if(!store.claim(item.path))continue;try{const projected=store.project(item);await enqueueLark(projected.key,projected.payload,connector);store.ack(item.path);count++;}catch(error){store.requeue(item,error);firstError??=error;}}if(firstError)throw firstError;return count;}
function abortableDelay(ms:number,signal:AbortSignal){return new Promise<void>(resolve=>{if(signal.aborted)return resolve();const timer=setTimeout(done,ms);function done(){clearTimeout(timer);signal.removeEventListener("abort",done);resolve();}signal.addEventListener("abort",done,{once:true});});}
export async function drainLarkIngress(connector:ConnectorContext,store=defaultIngress(),opts:{batchSize?:number;idleMs?:number;maxBackoffMs?:number}={}):Promise<void>{let backoff=100;while(!connector.signal.aborted){try{const count=await replayLarkIngress(connector,store,opts.batchSize??50);backoff=100;if(count){await connector.reportHealth({ok:true,detail:{transport:"durable-replay",count}});continue;}await abortableDelay(opts.idleMs??1_000,connector.signal);}catch(error){const message=error instanceof Error?error.message:String(error);await connector.reportHealth({ok:false,code:"LARK_REPLAY_FAILED",message});connector.log("replay",message);await abortableDelay(backoff,connector.signal);backoff=Math.min(opts.maxBackoffMs??30_000,backoff*2);}}}

// ---- user 身份「夜间收割」：每晚 24:00 拉过去一天跟我有关的消息，落盘（默认纳入日报，可勾掉排除）----
// 替代原来每几分钟一轮的未读轮询：不再实时轰炸，一天结算一次。
function isoLocal(d: Date): string {
  // +08:00 是飞书域的时区(北京时间)，不是用户的显示时区——飞书 messages-search 的时间窗按北京时间算，
  // 与 lark-state.ts parseLarkTs 的反向解析成对。所以这里固定 +08:00，不跟 cfg.timezone 走。
  // 注意：日期部分仍用 cfg.timezone 的 fmt，若用户把 timezone 改到非 +08 区，这两半会不自洽——
  // 届时应整体改用北京时间的日期，而不是把偏移改成 cfg.timezone。
  return `${fmt(d, "date")}T${new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d)}+08:00`;
}

/** 北京时间某天 00:00 的 epoch ms（飞书域时区，+08:00 固定偏移；同 isoLocal 的理由，不跟 cfg.timezone） */
function midnightMs(d: Date): number {
  return new Date(`${fmt(d, "date")}T00:00:00+08:00`).getTime();
}

/**
 * 拉「从昨晚 24:00 到今晚 24:00」这一天跟我有关的消息（私聊全收，群聊按未静音/policy 过滤），
 * 落盘到 lark-digest（默认纳入，飞书 tab 可取消勾选排除）。opts.today=true 时拉「今天 00:00→此刻」用于即时预览。
 */
type DailyPullResult={date:string;count:number;items?:LarkDailyMsg[];p2pLast?:any[];error?:string};
function dailyPullFailure(today:boolean|undefined,date:string,error:unknown):DailyPullResult{if(!today)throw error;const message=error instanceof Error?error.message:String(error);log(`lark daily preview unavailable: ${message}`);return{date,count:0,items:[],p2pLast:[],error:message};}
export async function pullDailyLark(opts: { today?: boolean; project?:boolean; config?:Record<string,unknown>; runCommand?:typeof run;deadlineMs?:number } = {}): Promise<DailyPullResult> {
  const now = new Date();
  const todayMidnight = midnightMs(now);
  const endMs = opts.today ? now.getTime() : todayMidnight;       // 结算刚结束的一天：end = 今天 00:00
  const startMs = opts.today ? todayMidnight : todayMidnight - 86400_000; // start = 昨天 00:00
  const date = fmt(new Date(startMs), "date");                    // 分桶归到被结算的那一天
  if ((opts.config as any)?.groupPolicy !== "p2p" && (opts.config as any)?.groupPolicy !== "all" && unmutedChats === null) await refreshUnmuted(); // 群过滤要用到未静音列表

  const deadlineMs=Math.max(1,Math.min(180_000,opts.deadlineMs??180_000));let deadline:ReturnType<typeof setTimeout>|undefined;const command=(opts.runCommand??run)(
    ["lark-cli", "im", "+messages-search", "--as", "user",
     "--start", isoLocal(new Date(startMs)), "--end", isoLocal(new Date(endMs)),
     "--page-all", "--page-limit", "10",
     "--exclude-sender-type", "bot", "--no-reactions", "--format", "json"],
    { timeoutMs: deadlineMs },
  );let r:any;try{r=await Promise.race([command,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(Object.assign(new Error("lark daily pull deadline exceeded"),{code:"LARK_DAILY_DEADLINE"})),deadlineMs);})]);}catch(error){return dailyPullFailure(opts.today,date,error);}finally{if(deadline)clearTimeout(deadline);}
  if (r.code !== 0) return dailyPullFailure(opts.today,date,Object.assign(new Error(`lark daily pull failed (${r.code}): ${r.stderr.slice(0, 150)}`), { code: "LARK_DAILY_CLI_FAILED" }));
  let parsed: any;
  try { parsed = JSON.parse(r.stdout); } catch (cause) { return dailyPullFailure(opts.today,date,Object.assign(new Error("lark daily pull returned invalid JSON", { cause }), { code: "LARK_DAILY_PARSE_FAILED" })); }
  if (parsed.ok === false) return dailyPullFailure(opts.today,date,Object.assign(new Error(`lark daily pull API failed: ${String(parsed.error?.message || parsed.error || "unknown error").slice(0, 150)}`), { code: "LARK_DAILY_API_FAILED" }));

  const msgs = parsed.data?.messages || parsed.data?.items || [];
  const out: LarkDailyMsg[] = [];
  const p2pLast = new Map<string, any>();  // p2p 会话 → 当天最后一条（含我发的），用于生成/对账回复催办
  const previews: { chat_id: string; text: string; ts: string; sender: string }[] = [];
  for (const m of msgs) {
    if (!wanted({ chat_type: m.chat_type, chat_id: m.chat_id }, opts.config)) continue;
    const mine = m.sender?.id === cfg.notify.larkUserId;
    if (m.chat_type === "p2p") {
      const prev = p2pLast.get(m.chat_id);
      if (!prev || parseLarkTs(m.create_time) >= parseLarkTs(prev.create_time)) p2pLast.set(m.chat_id, {...m,mine});
    }
    // 会话预览素材（不算未读，避免夜里角标炸）——我发的也要进：只喂对方消息
    // 会让 p2p 预览停在旧消息上（自己发送的消息也要刷新），投影层统一 touchChat。
    previews.push({ chat_id: m.chat_id, text: previewText(m.content), ts: m.create_time, sender: mine ? "我" : (m.sender?.name || "") });
    if (mine) continue;  // 自己发的不进清单
    out.push({
      id: m.message_id, chat_id: m.chat_id, chat_type: m.chat_type || "group",
      chat_name: m.chat_partner?.name || m.chat_name || m.sender?.name || "会话",
      sender: m.sender?.name || "", ts: parseLarkTs(m.create_time),
      text: previewText(m.content),
      // 默认纳入日报（AI 自行判相关性），用户在飞书 tab 取消勾选 = 排除。
      // 勾选制上线一周实际勾选数恒为 0——人不会每天做这道手工题，改为自动纳入。
      selected: true,
    });
  }
  const facts={date,items:out,p2pLast:[...p2pLast.entries()],previews};
  if(opts.project!==false)await (await import("../connectors/lark-policy.ts")).projectDailyLarkFacts(facts,myReactionOn);
  log(`lark daily pull: ${date} 收 ${out.length} 条相关消息（待勾选）`);
  return { date, count: out.length,...(opts.project===false?facts:{}) };
}

/** daemon 每分钟调：跨过本地 00:00 后、当天首次触发一次夜间收割（结算刚结束的一天）。 */
type LarkTransportState={startedAt?:string;active:Set<string>;lastValidLineAt?:string;lastExitAt?:string;lastHealthReportAt?:number};
export function shouldReportLarkHealthy(state:LarkTransportState|undefined,now=Date.now(),intervalMs=30_000):boolean{if(!state)return true;if(state.lastHealthReportAt!==undefined&&now-state.lastHealthReportAt<intervalMs)return false;state.lastHealthReportAt=now;return true;}
export async function startLark(connector: ConnectorContext,transport?:LarkTransportState) {
  const conf = connector.config as any;
  if (!conf?.enabled||connector.signal.aborted) return;
  void drainLarkIngress(connector);
  refreshUnmuted();
  const refreshTimer=setInterval(refreshUnmuted, 10 * 60_000);
  const bindCleanup=(cleanup:()=>void)=>connector.signal.aborted?cleanup():connector.signal.addEventListener("abort",cleanup,{once:true});bindCleanup(()=>clearInterval(refreshTimer));
  // bot 长连接（事件推送，非轮询）：保留这条轻量实时路径，负责实时未读角标。
  for (const ev of (Array.isArray(conf.eventKeys)?conf.eventKeys:[]) as { key: string; as: string }[]) {
    consumeLoop(ev.key, ev.as, 10_000, connector,transport);
  }
  const dailyState={running:false,lastDailyDate:String((await connector.checkpoint())?.metadata?.dailyDate||"")};if(connector.signal.aborted)return;const daily=()=>runLarkDaily(connector,dailyState);void daily();const dailyTimer=setInterval(()=>void daily(),60_000);bindCleanup(()=>clearInterval(dailyTimer));
}

export async function runLarkDaily(connector:ConnectorContext,state:{running:boolean;lastDailyDate:string},pull:typeof pullDailyLark=pullDailyLark,now=new Date()):Promise<boolean>{const expectedDate=fmt(new Date(now.getTime()-86_400_000),"date");if(state.running||state.lastDailyDate===expectedDate)return false;state.running=true;try{const facts=await pull({project:false,config:connector.config});await connector.publish([{id:`daily:${facts.date}`,namespace:"lark.inbox",type:"daily",occurredAt:now.toISOString(),payload:{date:facts.date,items:facts.items??[],p2pLast:facts.p2pLast??[]}}],{version:1,cursor:`daily:${facts.date}`,updatedAt:now.toISOString(),metadata:{dailyDate:facts.date}});state.lastDailyDate=facts.date;await connector.reportHealth({ok:true,detail:{dailyDate:facts.date}});return true;}catch(e){const message=e instanceof Error?e.message:String(e);await connector.reportHealth({ok:false,code:"LARK_DAILY_FAILED",message});connector.log("daily",message);return false;}finally{state.running=false;}}

/** Process one real `lark-cli event consume` stdout line through normalization,
 * policy filtering, and durable Connector publication. */
export async function consumeLarkLine(key:string,line:string,connector:ConnectorContext,store=defaultIngress()):Promise<void>{
  const payload=normalizeLarkPayload(key,JSON.parse(line));
  if(key==="card.action.trigger"||wanted(payload,connector.config)){let path:string;try{path=store.stage(key,payload);}catch(error:any){await connector.reportHealth({ok:false,code:String(error?.code||"LARK_INGRESS_PERSIST_FAILED"),message:error instanceof Error?error.message:String(error)});throw error;}if(!store.claim(path))return;try{await enqueueLark(key,payload,connector);store.ack(path);}catch(error){store.release(path);throw error;}}
  else log(`lark ${key}: filtered (muted group / policy)`);
}

export async function consumeLarkLineWithBackpressure(key:string,line:string,connector:ConnectorContext,store=defaultIngress(),initialDelayMs=100){let delay=initialDelayMs;while(!connector.signal.aborted)try{await consumeLarkLine(key,line,connector,store);return;}catch(error:any){if(!["LARK_INGRESS_CAPACITY","CONNECTOR_PENDING_CAPACITY","CONNECTOR_PRIORITY_CAPACITY","CONNECTOR_BACKPRESSURE"].includes(String(error?.code)))throw error;await abortableDelay(delay,connector.signal);delay=Math.min(5_000,Math.max(1,delay*2));}}
function consumeLoop(key: string, as: string, backoffMs: number, connector: ConnectorContext,transport?:LarkTransportState) {
  if(connector.signal.aborted)return;
  // stdin 必须保持打开：consume 无界运行时把 stdin EOF 当作退出信号（父进程退出保护）
  const proc = Bun.spawn(["lark-cli", "event", "consume", key, "--as", as, "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  });
  log(`lark consumer started: ${key} (pid ${proc.pid})`);
  transport?.active.add(key);if(transport&&!transport.startedAt)transport.startedAt=new Date().toISOString();
  const stop=()=>{try{proc.stdin.end();}catch{}try{proc.kill("SIGTERM");}catch{}};if(connector.signal.aborted)stop();else connector.signal.addEventListener("abort",stop,{once:true});

  const ingress=readLines(proc.stdout, async(line) => {
    try {
      await consumeLarkLineWithBackpressure(key,line,connector);
      if(transport)transport.lastValidLineAt=new Date().toISOString();
      backoffMs = 10_000; // 有正常事件说明连接健康，重置退避
      if(shouldReportLarkHealthy(transport))await connector.reportHealth({ok:true,detail:{transport:"lark-cli-event",key,evidence:"valid-line"}});
    } catch(e) {
      const message=e instanceof Error?`${e.name}: ${e.message}`:`unparseable line ${line.slice(0,120)}`;void connector.reportHealth({ok:false,code:"LARK_INGRESS_FAILED",message});connector.log("ingress",message);
    }
  },connector.signal);

  proc.exited.then(async (code) => {
    await ingress;
    transport?.active.delete(key);if(transport)transport.lastExitAt=new Date().toISOString();
    if(connector.signal.aborted)return;
    const err = await new Response(proc.stderr).text().catch(() => "");
    await connector.reportHealth({ok:false,code:"LARK_CONNECTION_EXITED",message:`${key} exited ${code}: ${err.slice(-200)}`});
    // 回调未在飞书后台订阅（card.action.trigger 常见）：别紧密重试刷屏，提醒一次后慢重试等你启用
    if (/failed_precondition|subscribe these callbacks/.test(err)) {
      if (!warnedUnsubscribed.has(key)) {
        warnedUnsubscribed.add(key);
        log(`lark ${key}: 回调未订阅——去飞书开发者后台「事件与回调 → 回调配置」启用 ${key} 后该通道才生效（在此之前飞书卡片按钮点了没反应）`);
      }
      scheduleReconnect(() => consumeLoop(key, as, 300_000, connector,transport), 300_000, connector);  // 5min 慢重试，等你启用后自动接上
      return;
    }
    log(`lark consumer exited (${key}, code ${code}) ${err.slice(-200)}; restart in ${backoffMs / 1000}s`);
    scheduleReconnect(() => consumeLoop(key, as, Math.min(backoffMs * 2, 300_000), connector,transport), backoffMs, connector);
  });
}
function scheduleReconnect(fn:()=>void,ms:number,connector:ConnectorContext){if(connector.signal.aborted)return;const timer=setTimeout(fn,ms);connector.signal.addEventListener("abort",()=>clearTimeout(timer),{once:true});}

export function createLarkConnector(){const state:LarkTransportState={active:new Set()};return{async start(ctx:ConnectorContext){await startLark(ctx,state);},health(){return state.active.size?{ok:true,transport:"lark-cli-event",active:[...state.active],startedAt:state.startedAt,lastValidLineAt:state.lastValidLineAt}:{ok:false,code:"LARK_NOT_CONNECTED",transport:"lark-cli-event",lastExitAt:state.lastExitAt};}};}

export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void|Promise<void>,signal?:AbortSignal) {
  const reader = stream.getReader();
  const abort=()=>void reader.cancel("connector aborted").catch(()=>{});
  if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});
  const decoder = new TextDecoder();
  let buf = "";
  try{while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) await onLine(line);
    }
  }}finally{signal?.removeEventListener("abort",abort);reader.releaseLock();}
}
