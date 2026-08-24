import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { dirname, join } from "path";
import type { DevMsg } from "./types.ts";
import type { SessionProviderId } from "../../sessions/repository.ts";

export type InitialHistorySnapshot = { schemaVersion: 1 | 2; status: "ok" | "unavailable"; sessionId: string; providerId: SessionProviderId; nativeRef: string; messages: DevMsg[]; copiedAt: string; attempts?:number;nextRetryAt?:string };
const pathFor = (root: string, id: string) => join(root, "session-history", `${encodeURIComponent(id)}.json`);
function normalizeMessages(raw: unknown): DevMsg[] { if(!Array.isArray(raw))return[];return raw.flatMap((m:any)=>{if(!m||typeof m.text!=="string")return[];const role=["user","assistant","tool","system"].includes(m.role)?m.role:m.role==="thinking"?"assistant":null;if(!role)return[];return[{role,text:m.text,...(typeof m.name==="string"?{name:m.name}:{}),ts:Number.isFinite(Date.parse(m.ts))?m.ts:new Date().toISOString()} as DevMsg];}); }
function parse(raw: unknown): InitialHistorySnapshot {
  const x: any = raw;
  if (!x || ![1, 2].includes(x.schemaVersion) || typeof x.sessionId !== "string" || !["claude", "codex", "codebuddy"].includes(x.providerId) || typeof x.nativeRef !== "string" || !Array.isArray(x.messages)) throw new Error("initial history schema 非法");x.messages=normalizeMessages(x.messages);
  const markerOnly=x.messages.length>0&&x.messages.every((m:any)=>m.role==="system"&&["history","diagnostic"].includes(String(m.name||"")));
  const status = markerOnly ? "unavailable" : x.schemaVersion === 1 ? "ok" : x.status;
  if(markerOnly)x.messages=[];
  if (!["ok", "unavailable"].includes(status) || (status === "unavailable" && x.messages.length)||(x.attempts!==undefined&&(!Number.isSafeInteger(x.attempts)||x.attempts<1))||(x.nextRetryAt!==undefined&&!Number.isFinite(Date.parse(x.nextRetryAt)))) throw new Error("initial history status 非法");
  return { ...x, status };
}
export function readInitialHistorySnapshot(root: string, sessionId: string): InitialHistorySnapshot | null { const file = pathFor(root, sessionId); if (!existsSync(file)) return null; try{return structuredClone(parse(JSON.parse(readFileSync(file,"utf8"))));}catch{try{renameSync(file,`${file}.invalid.${Date.now()}`);}catch{}return null;} }
export function readInitialHistory(root: string, sessionId: string): DevMsg[] { return readInitialHistorySnapshot(root, sessionId)?.messages ?? []; }
export function clearInitialHistory(root:string,sessionId:string):void{rmSync(pathFor(root,sessionId),{force:true});}
export function writeInitialHistory(root: string, snapshot: { status?: "ok" | "unavailable"; sessionId: string; providerId: SessionProviderId; nativeRef: string; messages: Array<Pick<DevMsg,"role"|"text">&Partial<Omit<DevMsg,"role"|"text">>>;attempts?:number;nextRetryAt?:string }): void {
  const file = pathFor(root, snapshot.sessionId); mkdirSync(dirname(file), { recursive: true });
  const messages=normalizeMessages(snapshot.messages),status = snapshot.status ?? "ok"; if (status === "unavailable" && messages.length) throw new Error("unavailable history 不能包含 marker/messages");
  let replace = false;
  if (existsSync(file)) { const current=readInitialHistorySnapshot(root,snapshot.sessionId);if(current){if(current.providerId!==snapshot.providerId)throw new Error("initial history 身份冲突");if(current.nativeRef===snapshot.nativeRef&&current.status==="ok")return;}replace=existsSync(file); }
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`, body = JSON.stringify({ schemaVersion: 2, ...snapshot, messages,status, copiedAt: new Date().toISOString() }, null, 2) + "\n";
  try {
    writeFileSync(tmp, body, { flag: "wx", mode: 0o600 }); const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    if (replace) renameSync(tmp, file); else try { linkSync(tmp, file); } catch (error: any) { if (error?.code !== "EEXIST") throw error; const current = parse(JSON.parse(readFileSync(file, "utf8"))); if (current.providerId !== snapshot.providerId || current.nativeRef !== snapshot.nativeRef) throw new Error("initial history 身份冲突"); }
    const dir = openSync(dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { rmSync(tmp, { force: true }); }
}
