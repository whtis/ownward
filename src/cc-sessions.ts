// CC 会话旁观：~/.claude/projects 是所有 Claude Code 会话（ownward / clawd / Terminal 手开）
// 的统一落盘点，这里做只读旁观——列表 + 按字节增量读消息，配合客户端轮询实现"边跑边看"。
// JSONL 行级 schema 无官方契约（官方明示当 opaque），过滤规则借鉴 clawos/clawd 的实测逆向：
//   isSidechain / parent_tool_use_id → 子 agent 流，整行丢；isMeta / XML envelope → 系统脚手架；
//   model === '<synthetic>' → 只有 "No response requested."（拒绝工具占位）是噪音，
//     其余（限流/登录过期/API 错）是必须透出的真错误——别一刀切丢；
//   toolUseResult 为 string → 用户拒绝 sentinel。
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, relative, sep } from "path";
import { saveContentImages } from "./runner/agent-images.ts";
import { DATA } from "./util.ts";

const PROJECTS = join(homedir(), ".claude", "projects");

export interface CcSessionMeta {
  id: string;         // "<hashDir>/<uuid>"，API 引用键
  cwd: string;        // 行内 cwd 字段（hashDir 反解有损，不用）
  project: string;    // cwd 尾段
  title: string;
  firstUser: string;  // 首条真实 user 文本（未经摘要）——terminal 任务据此确定性认领自己的会话
  mtime: number;      // 毫秒
  size: number;
  active: boolean;    // 2 分钟内有写入
}

export interface CcMessage {
  role: "user" | "assistant" | "tool" | "system";  // system：限流等错误提示
  text: string;
  name?: string;      // tool 消息：工具名（name="image" = 图片行，内联渲染）；system 消息 name="error" 表错误
  ts?: string;
  images?: string[];  // 图片 URL（agent-images 落盘出的 /api/agent-image/...）
}

/** 读文件头/尾指定字节（大 transcript 禁止全量读） */
function readBytes(path: string, from: number, len: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 从头部 chunk 提取 cwd / 首条真实 user 文本 / entrypoint（sdk-cli=daemon 决策，cli=真人交互）。
 *  只读 24KB：cwd/entrypoint/首条 user 都在开头几行，读小块才能在几千文件的目录里快速跳过 daemon 会话。 */
function headMeta(path: string): { cwd: string; firstUser: string; entrypoint: string } {
  const head = readBytes(path, 0, Math.min(24 * 1024, statSync(path).size));
  let cwd = "";
  let firstUser = "";
  let entrypoint = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (!entrypoint && typeof e.entrypoint === "string") entrypoint = e.entrypoint;
    if (!firstUser && e.type === "user" && !e.isMeta && !e.isSidechain) {
      const t = extractText(e.message?.content);
      if (t && !/^</.test(t.trim())) firstUser = t.trim().slice(0, 120);
    }
    if (cwd && firstUser && entrypoint) break;
  }
  return { cwd, firstUser, entrypoint };
}

/** 尾部找 summary 行（CC 生成的会话摘要，标题最优来源之一） */
function tailSummary(path: string, size: number): string {
  const chunk = Math.min(32 * 1024, size);
  const tail = readBytes(path, size - chunk, chunk);
  const lines = tail.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "summary" && typeof e.summary === "string") return e.summary.slice(0, 120);
    } catch { /* 半截行 */ }
  }
  return "";
}

/** Exact-file inspection for security-sensitive adoption.  Unlike listCcSessions this never
 * consults the short UI cache; callers must still bind/compare the file identity. */
export function inspectCcSessionFile(path: string, id: string): CcSessionMeta {
  const st = statSync(path);
  const { cwd, firstUser, entrypoint } = headMeta(path);
  if (entrypoint === "sdk-cli") throw new Error("不是可接管的交互式 Claude 会话");
  const title = tailSummary(path, st.size) || firstUser || id.split("/").pop() || "Claude 会话";
  return {
    id, cwd,
    project: cwd ? cwd.split("/").filter(Boolean).pop() || cwd : "claude",
    title, firstUser, mtime: st.mtimeMs, size: st.size,
    active: Date.now() - st.mtimeMs < 120_000,
  };
}

let listCache: { at: number; items: CcSessionMeta[] } | null = null;

export function listCcSessions(limit = 40): CcSessionMeta[] {
  if (listCache && Date.now() - listCache.at < 15_000) return listCache.items;
  if (!existsSync(PROJECTS)) return [];

  // 先按 mtime 收集全部 jsonl，再只对前 limit 个做内容解析（stat 便宜，读内容贵）
  const files: { dir: string; f: string; path: string; mtime: number; size: number }[] = [];
  for (const dir of readdirSync(PROJECTS)) {
    const dp = join(PROJECTS, dir);
    let entries: string[];
    try { entries = readdirSync(dp); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = statSync(join(dp, f));
        if (st.size < 200) continue; // 空壳会话
        files.push({ dir, f, path: join(dp, f), mtime: st.mtimeMs, size: st.size });
      } catch { /* race */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  // daemon 自己的 claude -p（心跳/triage/起标题/收割）transcript 也落在 ownward 项目目录，
  // 数量能到几千，会把真人会话彻底淹没。它们 entrypoint=sdk-cli，真人交互是 cli——边扫边跳过 sdk-cli，
  // 凑够 limit 个真会话为止（扫描上限 limit*12 防在纯 daemon 目录里空转）。
  const items: CcSessionMeta[] = [];
  const scanCap = Math.min(files.length, Math.max(limit * 24, 600));
  for (let i = 0; i < scanCap && items.length < limit; i++) {
    const x = files[i];
    try {
      const { cwd, firstUser, entrypoint } = headMeta(x.path);
      if (entrypoint === "sdk-cli") continue;   // daemon 内部决策/派发引擎任务原始流，不进旁观列表
      const title = tailSummary(x.path, x.size) || firstUser || x.f.replace(/\.jsonl$/, "");
      items.push({
        id: `${x.dir}/${x.f.replace(/\.jsonl$/, "")}`,
        cwd,
        project: cwd ? cwd.split("/").filter(Boolean).pop() || cwd : x.dir,
        title,
        firstUser,
        mtime: x.mtime,
        size: x.size,
        active: Date.now() - x.mtime < 120_000,
      });
    } catch { /* 单文件坏不影响列表 */ }
  }
  listCache = { at: Date.now(), items };
  return items;
}

/** id → 物理路径，防目录逃逸 */
export function ccSessionPath(id: string): string {
  const p = normalize(join(PROJECTS, `${id}.jsonl`));
  const rel = relative(PROJECTS, p);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("非法会话 id");
  if (!existsSync(p)) throw new Error("会话文件不存在");
  return p;
}

/** transcript 绝对路径 → 会话 id（"<hashDir>/<uuid>"）。
 *  给 SessionStart 钩子用：claude 自报的 transcript_path 直接反解，不用扫目录猜。
 *  路径必须落在 ~/.claude/projects 内且是 .jsonl（外来输入，按越界处理返回 null）。 */
export function ccIdFromTranscript(path: string): string | null {
  if (!path || typeof path !== "string") return null;
  const p = normalize(path);
  if (!p.endsWith(".jsonl")) return null;
  const rel = relative(PROJECTS, p);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const segments = rel.replace(/\.jsonl$/, "").split(sep);
  return segments.length === 2 && segments.every(Boolean) ? segments.join("/") : null;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
}

/** 系统脚手架识别：XML envelope 或 isMeta。返回 true = 不是真实用户输入 */
function isScaffold(e: any, text: string): boolean {
  if (e.isMeta || e.isSynthetic) return true;
  const t = text.trimStart();
  return /^<(system-reminder|command-name|command-message|local-command|task-notification|session-notes|user-memories)/.test(t);
}

/** 工具输入摘要：一行说清 agent 在干什么 */
function toolBrief(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.url
    || input.prompt || input.description || input.query || "";
  return String(v).replace(/\s+/g, " ").slice(0, 160);
}

/**
 * 按字节偏移增量读消息。after=0 且文件很大时只从尾部 256KB 起读（旁观不需要考古全程）。
 * 返回新偏移供下次轮询；文件变小（截断重建）时从 0 重读。
 */
export function readCcMessages(path: string, after = 0): { messages: CcMessage[]; offset: number; truncated: boolean } {
  const size = statSync(path).size;
  if (size < after) after = 0; // 截断重建
  let from = after;
  let truncated = false;
  const CAP = 256 * 1024;
  if (from === 0 && size > CAP) { from = size - CAP; truncated = true; }
  if (from >= size) return { messages: [], offset: size, truncated: false };

  let text = readBytes(path, from, size - from);
  if (truncated) text = text.slice(text.indexOf("\n") + 1); // 掐掉半截首行
  // 尾部可能是写了一半的行：留到下一轮
  const lastNl = text.lastIndexOf("\n");
  const consumed = lastNl === -1 ? 0 : lastNl + 1;
  const offset = from + (truncated ? text.indexOf("\n") + 1 : 0) + consumed;

  const messages: CcMessage[] = [];
  // 图片仓的 key：transcript 文件名（session uuid）——meta.id 带 "<hashDir>/" 前缀不能进 URL 段
  const imgKey = path.split(sep).pop()!.replace(/\.jsonl$/, "");
  let prevReject = false;
  for (const line of text.slice(0, consumed).split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    // 子 agent 流整行丢（污染主对话）
    if (e.isSidechain === true || e.parent_tool_use_id || e.parentToolUseId) continue;

    if (e.type === "assistant") {
      const msg = e.message;
      if (msg?.model === "<synthetic>") {
        // 限流/登录过期/API 错都长成 synthetic 帧——必须透出（曾被一刀切丢掉，
        // 用户对着毫无反应的会话发消息，完全不知道撞了限流）
        const st = extractText(msg?.content).trim();
        if (st && st !== "No response requested.") {
          messages.push({ role: "system", name: "error", text: `⚠️ ${st.slice(0, 300)}`, ts: e.timestamp });
        }
        continue;
      }
      const t = extractText(msg?.content).trim();
      if (t) messages.push({ role: "assistant", text: t.slice(0, 4000), ts: e.timestamp });
      for (const c of Array.isArray(msg?.content) ? msg.content : []) {
        if (c?.type !== "tool_use") continue;
        // TodoWrite：还原成 TUI 那样的任务清单（✓ 完成 / ▶ 进行中 / ○ 待办），别当普通工具行丢显示
        if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) {
          const lines = c.input.todos.map((td: any) => {
            const icon = td?.status === "completed" ? "✓" : td?.status === "in_progress" ? "▶" : "○";
            return `${icon} ${String(td?.content ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
          }).filter((l: string) => l.length > 2);
          if (lines.length) messages.push({ role: "tool", name: "📋 任务清单", text: lines.join("\n"), ts: e.timestamp });
          continue;
        }
        messages.push({ role: "tool", name: c.name, text: toolBrief(c.name, c.input), ts: e.timestamp });
      }
    } else if (e.type === "user") {
      // reject sentinel：toolUseResult 为 string = 用户拒绝了工具；下一行的 interrupted 提示跳过
      if (typeof e.toolUseResult === "string") {
        messages.push({ role: "tool", name: "⛔ 已拒绝", text: e.toolUseResult.slice(0, 120), ts: e.timestamp });
        prevReject = true;
        continue;
      }
      // 图片块（截图/Read 图片的 tool_result、用户粘贴的图）先捞——它们通常不带文本，
      // 走下面的空文本 continue 就永远看不见了
      try {
        const imgs = saveContentImages(DATA, imgKey, e.message?.content);
        if (imgs.length) messages.push({ role: "tool", name: "image", text: `🖼 图片 ×${imgs.length}`, ts: e.timestamp, images: imgs });
      } catch { /* 图片落盘失败不阻塞旁观 */ }
      const t = extractText(e.message?.content).trim();
      if (prevReject && /^\[Request interrupted/.test(t)) { prevReject = false; continue; }
      prevReject = false;
      if (!t || isScaffold(e, t)) continue;
      messages.push({ role: "user", text: t.slice(0, 4000), ts: e.timestamp });
    }
  }
  return { messages, offset, truncated };
}
