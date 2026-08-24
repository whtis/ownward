import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { dirname, join } from "path";
import type { ConnectorCheckpoint, ConnectorEvent } from "./contracts.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
export class ConnectorDataError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp, path);
  const dirFd=openSync(dirname(path),"r");try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
}
function atomicText(path:string,value:string):void{mkdirSync(dirname(path),{recursive:true});const temp=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp,value);const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dirFd=openSync(dirname(path),"r");try{fsyncSync(dirFd);}finally{closeSync(dirFd);}}
function mergeCheckpoint(previous:ConnectorCheckpoint|undefined|null,next:ConnectorCheckpoint,preserveMetadata=true):ConnectorCheckpoint{if(!previous)return structuredClone(next);const nextIsNewer=Date.parse(next.updatedAt)>=Date.parse(previous.updatedAt),newer=nextIsNewer?next:previous,older=nextIsNewer?previous:next;return{...structuredClone(newer),metadata:preserveMetadata?{...(older.metadata??{}),...(newer.metadata??{})}:structuredClone(newer.metadata)};}
function pendingOrder(a:string,b:string):number{const ar=a.startsWith("priority.")?0:1,br=b.startsWith("priority.")?0:1;if(ar!==br)return ar-br;try{const av=BigInt(a.match(/\d+/)?.[0]||"0"),bv=BigInt(b.match(/\d+/)?.[0]||"0");return av<bv?-1:av>bv?1:a.localeCompare(b);}catch{return a.localeCompare(b);}}
function missing(error:unknown):boolean{return typeof error==="object"&&error!==null&&(error as any).code==="ENOENT";}

export class ConnectorStore {
  private readonly root: string;
  private seen = new Set<string>();
  private pendingCorruptions=0;
  constructor(dataRoot: string, readonly connectorId: string) {
    this.root = join(dataRoot, "connectors", connectorId);
    mkdirSync(this.root, { recursive: true });
    if(!existsSync(join(this.root,"generation.txt")))atomicText(join(this.root,"generation.txt"),crypto.randomUUID()+"\n");
    try { const snapshot=JSON.parse(readFileSync(join(this.root,"accepted-ids.snapshot.json"),"utf8")); if(Array.isArray(snapshot))for(const id of snapshot)if(typeof id==="string"&&ID.test(id))this.seen.add(id); } catch {}
    try { for (const line of readFileSync(join(this.root, "accepted-ids.jsonl"), "utf8").split("\n").filter(Boolean).slice(-50_000)) this.seen.add(line); } catch {}
    // appendEvent(queue) 与 accepted-id/checkpoint 不能跨文件原子提交。若进程恰在两者之间崩溃，
    // 从 durable spool/archive 重建已接收集合，重启重拉不会再次入队。
    const evidence = [join(dataRoot, "queue.jsonl")];
    try { evidence.push(...readdirSync(dataRoot).filter((f) => f.startsWith("queue.processing.") && f.endsWith(".jsonl")).map((f) => join(dataRoot, f))); } catch {}
    try { evidence.push(...readdirSync(join(dataRoot, "events")).filter((f) => f.endsWith(".jsonl")).sort().slice(-2).map((f) => join(dataRoot, "events", f))); } catch {}
    for (const file of evidence) try {
      for (const line of readFileSync(file, "utf8").split("\n")) try {
        const id = JSON.parse(line)?.id;
        if (typeof id === "string" && id.startsWith(`${connectorId}:`)) this.seen.add(id.slice(connectorId.length + 1));
      } catch {}
    } catch {}
  }
  checkpoint(): ConnectorCheckpoint | null {
    const path = join(this.root, "checkpoint.json");
    if (!existsSync(path)) return null;
    let value: any;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new ConnectorDataError("CONNECTOR_CHECKPOINT_CORRUPT", "checkpoint JSON 损坏"); }
    if (value?.version !== 1 || typeof value.cursor !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new ConnectorDataError("CONNECTOR_CHECKPOINT_CORRUPT", "checkpoint schema 非法");
    return value;
  }
  generation():string{return readFileSync(join(this.root,"generation.txt"),"utf8").trim();}
  has(id: string): boolean { return this.seen.has(id); }
  accept(event: ConnectorEvent): void {
    if (!ID.test(event.id)) throw new ConnectorDataError("CONNECTOR_EVENT_INVALID", "event id 非法");
    const path=join(this.root,"accepted-ids.jsonl");appendFileSync(path,event.id+"\n");const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}
    this.seen.add(event.id);
    if(this.seen.size>50_000){this.seen=new Set([...this.seen].slice(-40_000));atomicJson(join(this.root,"accepted-ids.snapshot.json"),[...this.seen]);atomicText(join(this.root,"accepted-ids.jsonl"),[...this.seen].join("\n")+"\n");}
  }
  saveCheckpoint(value: ConnectorCheckpoint): void {
    ConnectorStore.validateCheckpoint(value);
    let previous:ConnectorCheckpoint|null=null;try{previous=this.checkpoint();}catch{}
    atomicJson(join(this.root, "checkpoint.json"),mergeCheckpoint(previous,value));
  }
  static validateCheckpoint(value:unknown):asserts value is ConnectorCheckpoint{const v=value as any;if(v?.version!==1||typeof v.cursor!=="string"||!Number.isFinite(Date.parse(v.updatedAt)))throw new ConnectorDataError("CONNECTOR_CHECKPOINT_INVALID","checkpoint 非法");}
  quarantineCheckpoint():string|null{const path=join(this.root,"checkpoint.json");if(!existsSync(path))return null;const target=join(this.root,`checkpoint.corrupt.${Date.now()}.json`);renameSync(path,target);atomicText(join(this.root,"generation.txt"),crypto.randomUUID()+"\n");return target;}
  diagnostics(): { checkpointBytes: number; acceptedIds: number; pendingDepth:number } {
    let checkpointBytes = 0; try { checkpointBytes = statSync(join(this.root, "checkpoint.json")).size; } catch {}
    let pendingDepth=0;try{pendingDepth=readdirSync(join(this.root,"pending")).filter(f=>f.endsWith(".json")).length;}catch{}return { checkpointBytes, acceptedIds: this.seen.size,pendingDepth };
  }
  hasPending():boolean{try{return readdirSync(join(this.root,"pending")).some(f=>f.endsWith(".json"));}catch(error){if(missing(error))return false;throw error;}}
  hasPriorityPending():boolean{try{return readdirSync(join(this.root,"pending")).some(f=>f.startsWith("priority.")&&f.endsWith(".json"));}catch(error){if(missing(error))return false;throw error;}}
  deferBatch(events:readonly ConnectorEvent[],checkpoint?:ConnectorCheckpoint,priority=false,singletonTypes=new Set<string>()):{accepted:number;duplicates:number}{const dir=join(this.root,"pending");mkdirSync(dir,{recursive:true});let files=readdirSync(dir).filter(f=>f.endsWith(".json")).sort(pendingOrder),carried:ConnectorCheckpoint|undefined;const replacing=new Set(events.filter(event=>singletonTypes.has(event.type)).map(event=>`${event.namespace}\0${event.type}`));if(replacing.size)for(const file of files)try{const path=join(dir,file),value=JSON.parse(readFileSync(path,"utf8")),kept=(value.events??[]).filter((event:ConnectorEvent)=>!replacing.has(`${event.namespace}\0${event.type}`));if(kept.length)atomicJson(path,{...value,events:kept});else{if(value.checkpoint)carried=mergeCheckpoint(carried,value.checkpoint,false);unlinkSync(path);}}catch{}files=readdirSync(dir).filter(f=>f.endsWith(".json")).sort(pendingOrder);const pending=new Set<string>();let last:{path:string;value:any}|undefined,bytes=0;for(const file of files)try{const path=join(dir,file),value=JSON.parse(readFileSync(path,"utf8"));bytes+=statSync(path).size;last={path,value};for(const event of value.events??[])if(typeof event?.id==="string")pending.add(event.id);}catch{}const fresh=events.filter(e=>!pending.has(e.id)),merged=checkpoint?mergeCheckpoint(carried,checkpoint,false):carried;if(fresh.length){let max=0n;for(const file of files){try{const value=BigInt(file.match(/\d+/)?.[0]||"0");if(value>max)max=value;}catch{}}const seq=(max+1n).toString().padStart(20,"0"),value={events:fresh,...(merged?{checkpoint:merged}:{})},encoded=JSON.stringify(value);if(bytes+Buffer.byteLength(encoded)>64*1024*1024+(priority?4*1024*1024:0))throw new ConnectorDataError("CONNECTOR_PENDING_CAPACITY","durable pending byte capacity reached");atomicJson(join(dir,`${priority?"priority.":""}${seq}.json`),value);}else if(merged){if(last)atomicJson(last.path,{...last.value,checkpoint:mergeCheckpoint(last.value.checkpoint,merged,false)});else atomicJson(join(dir,`${priority?"priority.":""}00000000000000000001.json`),{events:[],checkpoint:merged});}return{accepted:fresh.length,duplicates:events.length-fresh.length};}
  pendingBatch():{path:string;events:ConnectorEvent[];checkpoint?:ConnectorCheckpoint}|null{const dir=join(this.root,"pending");let names:string[]=[];try{names=readdirSync(dir).filter(f=>f.endsWith(".json")).sort(pendingOrder);}catch(error){if(missing(error))return null;throw error;}for(const name of names){const path=join(dir,name);let raw:string;try{raw=readFileSync(path,"utf8");}catch(error){throw error;}try{const value=JSON.parse(raw);if(!Array.isArray(value.events))throw new Error("events invalid");return{path,events:value.events,checkpoint:value.checkpoint};}catch{renameSync(path,path+`.corrupt.${Date.now()}`);this.pendingCorruptions++;continue;}}return null;}
  takePendingCorruptions():number{const count=this.pendingCorruptions;this.pendingCorruptions=0;return count;}
  quarantinePending(path:string):string|null{try{const target=path+`.invalid.${Date.now()}`;renameSync(path,target);return target;}catch(error){if(missing(error))return null;throw error;}}
  requeuePending(path:string):string|null{if(!/\.invalid\.\d+$/.test(path)||!existsSync(path))return null;const target=path.replace(/\.invalid\.\d+$/,"");if(existsSync(target))return null;renameSync(path,target);return target;}
  ackPending(path:string):void{try{unlinkSync(path);}catch(error){if(!missing(error))throw error;}}
}
