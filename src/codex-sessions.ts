// Codex 会话：旁观 + 接管，对齐 CC 会话的待遇。
// rollout 落盘在 ~/.codex[-alt]/sessions/YYYY/MM/DD/rollout-*.jsonl；
// 接管续聊用 `codex exec resume <id> --json`——每轮一个进程，事件流回灌消息列表。
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { CcMessage, CcSessionMeta } from "./cc-sessions.ts";
import { isWithinDataDir } from "./internal-path.ts";
import { CodexRolloutDecoder, readCodexRolloutWindow } from "./providers/transcript-history.ts";
import { DATA, log } from "./util.ts";

const HOMES: [string, string][] = [
  ["codex", join(homedir(), ".codex", "sessions")],
  ["codex-alt", join(homedir(), ".codex-alt", "sessions")],
];

function readBuffer(path: string, from: number, len: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

function readBytes(path: string, from: number, len: number): string {
  return readBuffer(path, from, len).toString("utf8");
}

export interface CodexMeta extends CcSessionMeta {
  kind: "codex";
  home: string;        // codex | codex-alt（resume 时选对 CODEX_HOME）
  rolloutId: string;
  repoUrl: string;
  originator: string;  // codex-tui / Codex Desktop = 真人；codex_exec = `codex exec`（Ownward codex-bg 引擎、脚本）
}

/** 头部抓 session_meta + 首条真实 user 消息作标题 */
function headMeta(path: string): { id: string; cwd: string; repoUrl: string; title: string; originator: string } {
  const head = readBytes(path, 0, Math.min(96 * 1024, statSync(path).size));
  let id = "", cwd = "", repoUrl = "", title = "", originator = "";
  const decoder = new CodexRolloutDecoder(120);
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload || {};
    if (e.type === "session_meta") {
      id = p.id || p.session_id || "";
      cwd = p.cwd || "";
      repoUrl = p.git?.repository_url || "";
      originator = String(p.originator || "");
    }
    const message = decoder.decode(e);
    if (!title && message?.role === "user") title = message.text.trim().slice(0, 120);
    if (id && title) break;
  }
  return { id, cwd, repoUrl, title, originator };
}

/** Exact rollout inspection for adoption; deliberately bypasses listCache. */
export function inspectCodexSessionFile(path: string, home: string): CodexMeta {
  const st = statSync(path), { id, cwd, repoUrl, title, originator } = headMeta(path);
  if (!id) throw new Error("Codex rollout 缺少 session identity");
  return {
    kind: "codex", id: `cdx:${home}:${id}`, home, rolloutId: id, cwd, repoUrl, originator,
    project: cwd ? cwd.split("/").filter(Boolean).pop() || cwd : "codex",
    title: (title || "(codex 会话)").replace(/\s+/g, " ").trim(), firstUser: title,
    mtime: st.mtimeMs, size: st.size, active: Date.now() - st.mtimeMs < 120_000,
    // @ts-expect-error private exact-file identity, never serialize
    _path: path,
  };
}

let listCache: { at: number; items: CodexMeta[] } | null = null;

export function listCodexSessions(limit = 30, homes: ReadonlyArray<readonly [string, string]> = HOMES): CodexMeta[] {
  const cacheable = homes === HOMES;
  if (cacheable && listCache && Date.now() - listCache.at < 20_000) return listCache.items;
  const files: { home: string; path: string; mtime: number; size: number }[] = [];
  for (const [home, root] of homes) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root, { recursive: true }) as string[]) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const full = join(root, f);
        const st = statSync(full);
        if (st.size < 2000) continue;
        files.push({ home, path: full, mtime: st.mtimeMs, size: st.size });
      } catch { /* race */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const items: CodexMeta[] = [];
  // 边读 cwd 边过滤：对话 tab 的 codex 聊天（cwd=ownward/data/chats）不是开发会话，
  // 必须在取 limit 前剔除，否则它们占满最近窗口、把真正的开发会话挤出去（收割为 0 的根因）。
  // 有成本上限（最多看 limit*4 个文件），避免把 200+ rollout 全读一遍。
  const seen = new Set<string>();   // 同一 thread resume 一次多一个 rollout 文件，id 相同——只留最新
  for (const x of files.slice(0, Math.max(limit * 4, 80))) {
    if (items.length >= limit) break;
    try {
      const { id, cwd, repoUrl, title, originator } = headMeta(x.path);
      if (!id) continue;
      if (seen.has(`${x.home}:${id}`)) continue;  // 重复 id 会把客户端 ForEach 布局打炸（实测大段空白）
      seen.add(`${x.home}:${id}`);
      if (isWithinDataDir(cwd, DATA)) continue;
      items.push({
        kind: "codex",
        id: `cdx:${x.home}:${id}`,
        home: x.home,
        rolloutId: id,
        cwd, repoUrl, originator,
        project: cwd ? cwd.split("/").filter(Boolean).pop() || cwd : "codex",
        title: (title || "(codex 会话)").replace(/\s+/g, " ").trim(),  // title 里可能带换行，压平
        firstUser: title,
        mtime: x.mtime,
        size: x.size,
        active: Date.now() - x.mtime < 120_000,
        // @ts-expect-error 私有字段给 readCodexMessages 用
        _path: x.path,
      });
    } catch { /* 单文件坏不影响 */ }
  }
  if (cacheable) listCache = { at: Date.now(), items };
  return items;
}

export function codexSessionPath(id: string): string {
  const meta = listCodexSessions(60).find((x) => x.id === id) as any;
  if (!meta?._path) throw new Error("codex 会话不存在（刷新后再试）");
  return meta._path;
}

/** Stable observation id -> exact fresh rollout.  Security-sensitive capability issuance must
 * not consult listCache or the recent-window limit. */
export function findCodexSessionFresh(stableId: string): { meta: CodexMeta; path: string } | null {
  const match = /^cdx:([^:]+):(.+)$/.exec(stableId);
  if (!match) return null;
  const root = HOMES.find(([home]) => home === match[1]);
  if (!root || !existsSync(root[1])) return null;
  for (const relative of readdirSync(root[1], { recursive: true }) as string[]) {
    if (!relative.endsWith(".jsonl")) continue;
    const path = join(root[1], relative);
    try {
      const meta = inspectCodexSessionFile(path, root[0]);
      if (meta.rolloutId === match[2] && meta.id === stableId) return { meta, path };
    } catch { /* one corrupt/racing rollout cannot hide the rest */ }
  }
  return null;
}

/** rollout → 消息列表（增量字节读，同 CC 旁观语义）。
 *  顺带抽出最新执行计划（update_plan）+ token 用量（token_count），给进度视图用 */
export function readCodexMessages(path: string, after = 0): { messages: CcMessage[]; offset: number; truncated: boolean; plan?: { text: string; status: string }[]; tokens?: { input?: number; output?: number; total?: number } } {
  const window=readCodexRolloutWindow(path,after),offset=window.offset,truncated=window.truncated;
  if(!window.lines.length)return{messages:[],offset,truncated};

  const messages: CcMessage[] = [];
  const decoder = new CodexRolloutDecoder(4000);
  let plan: { text: string; status: string }[] | undefined;
  let tokens: { input?: number; output?: number; total?: number } | undefined;
  for (const line of window.lines) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload || {};
    const ts = e.timestamp;
    const message = decoder.decode(e);
    if (message) messages.push(message as CcMessage);
    if (e.type === "event_msg") {
      if (p.type === "mcp_tool_call_end") {
        messages.push({ role: "tool", name: `${p.invocation?.server || "mcp"}.${p.invocation?.tool || ""}`, text: JSON.stringify(p.invocation?.arguments || {}).slice(0, 140), ts });
      } else if (p.type === "token_count") {
        // total_token_usage 是本会话累计——直接取最后一份即可
        const u = p.info?.total_token_usage;
        if (u) tokens = { input: u.input_tokens, output: u.output_tokens, total: u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0)) };
      }
    } else if (e.type === "response_item" && p.type === "function_call") {
      if (p.name === "update_plan") {
        // 最新一份 update_plan 覆盖计划（{plan:[{step,status}]}）
        try {
          const a = JSON.parse(p.arguments || "{}");
          const arr = Array.isArray(a.plan) ? a.plan : [];
          const steps = arr.map((it: any) => ({ text: String(it?.step ?? it?.text ?? "").slice(0, 200), status: ["in_progress", "completed"].includes(it?.status) ? it.status : "pending" })).filter((x: any) => x.text);
          if (steps.length) plan = steps;
        } catch { /* 参数坏就跳过 */ }
        continue; // update_plan 不当普通工具行展示
      }
      let brief = "";
      try { const a = JSON.parse(p.arguments || "{}"); brief = String(a.cmd || a.command || p.arguments).slice(0, 140); } catch { brief = String(p.arguments || "").slice(0, 140); }
      messages.push({ role: "tool", name: p.name || "tool", text: brief, ts });
    }
  }
  return { messages, offset, truncated, plan, tokens };
}

export function clearCodexListCache() { listCache = null; }
