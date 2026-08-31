import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, relative, sep } from "path";
import type { RunnerHistoryMessage } from "../runner/server.ts";
import { AGENT_IMAGE_PROVIDER_LINE_MAX_BYTES } from "../runner/agent-images.ts";

const MAX_READ_BYTES = 8 * 1024 * 1024, CODEX_SEMANTIC_BYTES = 8 * 1024 * 1024, CODEX_SEMANTIC_LINES = 4_000, MAX_MESSAGES = 100, MAX_TEXT = 2000;
const marker = (text: string): RunnerHistoryMessage[] => [{ role: "system", name: "history", text }];
const text = (content: any) => typeof content === "string" ? content : Array.isArray(content) ? content.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n") : "";
type CodexMessageVariant = "event_msg" | "response_item";
type DecodedCodexMessage = RunnerHistoryMessage & { role: "user" | "assistant"; variant: CodexMessageVariant };

function codexContentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => ["input_text", "output_text", "text"].includes(item?.type) && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

/** Stateful because Codex 0.148 writes the same semantic message in both legacy and
 * response_item envelopes. Keeping variant dedup here makes observation and copy-forward agree. */
export class CodexRolloutDecoder {
  private previous: DecodedCodexMessage | null = null;

  constructor(private readonly maxText = MAX_TEXT) {}

  decode(entry: any): RunnerHistoryMessage | null {
    const payload = entry?.payload || {};
    let decoded: DecodedCodexMessage | null = null;
    if (entry?.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message") && typeof payload.message === "string") {
      decoded = {
        role: payload.type === "user_message" ? "user" : "assistant",
        text: payload.message.slice(0, this.maxText),
        ...(typeof entry.timestamp === "string" ? { ts: entry.timestamp } : {}),
        variant: "event_msg",
      };
    } else if (entry?.type === "response_item" && payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const value = codexContentText(payload.content);
      if (value) decoded = {
        role: payload.role,
        text: value.slice(0, this.maxText),
        ...(typeof entry.timestamp === "string" ? { ts: entry.timestamp } : {}),
        variant: "response_item",
      };
    }
    if (!decoded || !decoded.text.trim()) return null;
    const duplicateVariant = this.previous?.role === decoded.role
      && this.previous.text === decoded.text
      && this.previous.variant !== decoded.variant;
    this.previous = decoded;
    if (duplicateVariant) return null;
    const { variant: _, ...message } = decoded;
    return message;
  }
}

function chunk(path: string, from: number, length: number): string { const fd = openSync(path, "r"); try { const out = Buffer.alloc(length), read = readSync(fd, out, 0, length, from); return out.subarray(0, read).toString("utf8"); } finally { closeSync(fd); } }
function boundedLines(path: string, maxBytes = MAX_READ_BYTES): string[] { const size = statSync(path).size, from = Math.max(0, size - maxBytes); let value = chunk(path, from, size - from); if (from) value = value.slice(value.indexOf("\n") + 1); return value.split("\n").filter(Boolean); }
function previousNewline(fd: number, before: number): number {
  const block = 64 * 1024;
  for (let end = before; end > 0;) {
    const start = Math.max(0, end - block), out = Buffer.allocUnsafe(end - start), read = readSync(fd, out, 0, out.length, start);
    const found = out.subarray(0, read).lastIndexOf(10);
    if (found >= 0) return start + found;
    end = start;
  }
  return -1;
}
function codexRelevant(entry: any): boolean {
  const payload = entry?.payload || {};
  return entry?.type === "event_msg" && ["user_message", "agent_message", "mcp_tool_call_end", "token_count"].includes(payload.type)
    || entry?.type === "response_item" && (payload.type === "message" || payload.type === "function_call");
}
/** Reverse JSONL scan: oversized complete rows are boundary-scanned but never buffered. */
export function readCodexRolloutWindow(path: string, after = 0): { lines: string[]; offset: number; truncated: boolean } {
  const size = statSync(path).size;if(size<after)after=0;const fd=openSync(path,"r");
  try {
    const last=previousNewline(fd,size),completeEnd=last<0?0:last+1;if(completeEnd<=after)return{lines:[],offset:completeEnd,truncated:false};
    const reversed:string[]=[],maxLine=AGENT_IMAGE_PROVIDER_LINE_MAX_BYTES;let cursor=completeEnd,bytes=0,truncated=completeEnd<size;
    while(cursor>after&&reversed.length<CODEX_SEMANTIC_LINES&&bytes<CODEX_SEMANTIC_BYTES){const lineEnd=cursor-1,prior=previousNewline(fd,lineEnd),lineStart=prior+1;if(lineStart<after){truncated=true;break;}const length=lineEnd-lineStart;if(length>maxLine){truncated=true;cursor=lineStart;continue;}const out=Buffer.allocUnsafe(length),read=readSync(fd,out,0,length,lineStart),line=out.subarray(0,read).toString("utf8");let relevant=false;try{relevant=codexRelevant(JSON.parse(line));}catch{}if(relevant){if(bytes+read>CODEX_SEMANTIC_BYTES){truncated=true;break;}reversed.push(line);bytes+=read;}cursor=lineStart;}
    if(cursor>after)truncated=true;return{lines:reversed.reverse(),offset:completeEnd,truncated};
  } finally { closeSync(fd); }
}
function headLines(path: string): string[] { const size = statSync(path).size; return chunk(path, 0, Math.min(size, 96 * 1024)).split("\n").filter(Boolean); }
function oneFile(root: string, accept: (path: string) => boolean): string {
  if (!existsSync(root)) throw new Error("历史目录不存在"); const hits: string[] = [];
  for (const item of readdirSync(root, { recursive: true }) as string[]) { const path = normalize(join(root, item)), rel = relative(root, path); if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !path.endsWith(".jsonl")) continue; try { if (accept(path)) hits.push(path); } catch {} }
  if (!hits.length) throw new Error("原生 transcript 不存在"); hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); return hits[0]!;
}
export function readClaudeTranscript(nativeRef: string, home = homedir()): RunnerHistoryMessage[] {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nativeRef)) throw new Error("Claude nativeRef 非法");
  try { const path = oneFile(join(home, ".claude", "projects"), (p) => p.endsWith(`/${nativeRef}.jsonl`)); const out: RunnerHistoryMessage[] = []; let invalid = 0;
    for (const line of boundedLines(path)) { let e: any; try { e = JSON.parse(line); } catch { invalid++; continue; } if (e.isSidechain || e.parent_tool_use_id || e.isMeta) continue; const value = text(e.message?.content).trim(); if ((e.type === "user" || e.type === "assistant") && value) out.push({ role: e.type, text: value.slice(0, MAX_TEXT), ...(typeof e.timestamp === "string" ? { ts: e.timestamp } : {}) }); }
    if (!out.length) return marker(invalid ? "⚠️ Claude 历史记录损坏，未能恢复可显示消息" : "Claude 历史记录中没有可显示消息"); return out.slice(-MAX_MESSAGES);
  } catch (error) { return marker(`⚠️ Claude 历史读取失败：${error instanceof Error ? error.message : "未知错误"}`); }
}
export function readCodexTranscript(nativeRef: string, providerHome?: string, home = homedir()): RunnerHistoryMessage[] {
  if (!/^[0-9a-f-]{36}$/i.test(nativeRef)) throw new Error("Codex nativeRef 非法");
  try { const base = !providerHome || providerHome === "codex" ? join(home, ".codex") : providerHome === "codex-alt" ? join(home, ".codex-alt") : isAbsolute(providerHome) ? providerHome : (() => { throw new Error("Codex providerHome 非法"); })();
    const path = oneFile(join(base, "sessions"), (p) => headLines(p).some((line) => { try { const e = JSON.parse(line); return e.type === "session_meta" && (e.payload?.id === nativeRef || e.payload?.session_id === nativeRef); } catch { return false; } })); const out: RunnerHistoryMessage[] = []; const decoder = new CodexRolloutDecoder(MAX_TEXT); let invalid = 0;
    for (const line of readCodexRolloutWindow(path).lines) { let e: any; try { e = JSON.parse(line); } catch { invalid++; continue; } const message = decoder.decode(e); if (message) out.push(message); }
    if (!out.length) return marker(invalid ? "⚠️ Codex 历史记录损坏，未能恢复可显示消息" : "Codex 历史记录中没有可显示消息"); return out.slice(-MAX_MESSAGES);
  } catch (error) { return marker(`⚠️ Codex 历史读取失败：${error instanceof Error ? error.message : "未知错误"}`); }
}
