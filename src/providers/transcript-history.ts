import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, relative, sep } from "path";
import type { RunnerHistoryMessage } from "../runner/server.ts";

const MAX_READ_BYTES = 8 * 1024 * 1024, MAX_MESSAGES = 100, MAX_TEXT = 2000;
const marker = (text: string): RunnerHistoryMessage[] => [{ role: "system", name: "history", text }];
const text = (content: any) => typeof content === "string" ? content : Array.isArray(content) ? content.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n") : "";
function chunk(path: string, from: number, length: number): string { const fd = openSync(path, "r"); try { const out = Buffer.alloc(length), read = readSync(fd, out, 0, length, from); return out.subarray(0, read).toString("utf8"); } finally { closeSync(fd); } }
function boundedLines(path: string): string[] { const size = statSync(path).size, from = Math.max(0, size - MAX_READ_BYTES); let value = chunk(path, from, size - from); if (from) value = value.slice(value.indexOf("\n") + 1); return value.split("\n").filter(Boolean); }
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
    const path = oneFile(join(base, "sessions"), (p) => headLines(p).some((line) => { try { const e = JSON.parse(line); return e.type === "session_meta" && (e.payload?.id === nativeRef || e.payload?.session_id === nativeRef); } catch { return false; } })); const out: RunnerHistoryMessage[] = []; let invalid = 0;
    for (const line of boundedLines(path)) { let e: any; try { e = JSON.parse(line); } catch { invalid++; continue; } const p = e.payload || {}; if (e.type === "event_msg" && p.type === "user_message" && p.message) out.push({ role: "user", text: String(p.message).slice(0, MAX_TEXT), ts: e.timestamp }); else if (e.type === "event_msg" && p.type === "agent_message" && p.message) out.push({ role: "assistant", text: String(p.message).slice(0, MAX_TEXT), ts: e.timestamp }); }
    if (!out.length) return marker(invalid ? "⚠️ Codex 历史记录损坏，未能恢复可显示消息" : "Codex 历史记录中没有可显示消息"); return out.slice(-MAX_MESSAGES);
  } catch (error) { return marker(`⚠️ Codex 历史读取失败：${error instanceof Error ? error.message : "未知错误"}`); }
}
