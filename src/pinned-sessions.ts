// 会话置顶：长期要用的对话 pin 在任务列顶部，daemon 重启不丢。
// 存的是引用（kind+ref）+ 一份元信息快照（项目/标题/目录），这样即使被 pin 的旁观会话
// 已滑出最近窗口、或任务被清，置顶行仍能显示、导航、取消。
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { fsyncSync } from "./fs-durable.ts";
import { join } from "path";
import { DATA, ensureDir } from "./util.ts";

export interface PinnedSession {
  kind: "task" | "cc";   // task=ownward 引擎/terminal 任务；cc=旁观的 CC/codex 会话
  ref: string;           // task id 或 cc session id
  project?: string;
  title?: string;
  cwd?: string;
  pinnedAt: number;      // epoch ms，置顶区按此倒序
}

const FILE = join(DATA, "pinned-sessions.json");
let cache: PinnedSession[] | null = null;
const canonicalRef=(kind:string,ref:string)=>kind==="cc"?(ref.split("/").filter(Boolean).at(-1)??ref):ref;

function load(): PinnedSession[] {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = []; }
    if (!Array.isArray(cache)) cache = [];
    cache=cache.filter((raw:any)=>raw&&typeof raw.ref==="string"&&raw.ref);
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  const tmp=`${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;try{writeFileSync(tmp,JSON.stringify(cache,null,2),{mode:0o600});const fd=openSync(tmp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,FILE);}finally{rmSync(tmp,{force:true});}
}

export function listPinned(): PinnedSession[] {
  const deduped=new Map<string,PinnedSession>();for(const raw of load()){const key=`${raw.kind}:${canonicalRef(raw.kind,raw.ref)}`,prior=deduped.get(key);if(!prior||raw.pinnedAt>prior.pinnedAt)deduped.set(key,{...raw});}return [...deduped.values()].sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/** 置顶（按 kind:ref 去重 upsert，刷新元信息快照与时间） */
export function pinSession(p: Omit<PinnedSession, "pinnedAt">): void {
  if (!p.ref) return;
  const canonical=canonicalRef(p.kind,p.ref);
  const store = load();
  const i = store.findIndex((x) => x.kind === p.kind && canonicalRef(x.kind,x.ref) === canonical);
  const entry: PinnedSession = { ...p, ref:i>=0?store[i].ref:p.ref, pinnedAt: i >= 0 ? store[i].pinnedAt : Date.now() };
  if (i >= 0) store[i] = entry; else store.push(entry);
  cache = store;
  save();
}

export function unpinSession(kind: string, ref: string): void {
  ref=canonicalRef(kind,ref);
  const store = load();
  const next = store.filter((x) => !(x.kind === kind && canonicalRef(x.kind,x.ref) === ref));
  if (next.length !== store.length) { cache = next; save(); }
}
