// 自动收割管线：替代「每个会话手动 session wrap」的老规矩。
// 所有 Claude Code 会话的 transcript 都在 ~/.claude/projects/——daemon 定时扫描，
// 刚沉寂的实质会话自动总结，按 git 远程分流（配了 vault.workRemoteMatch 才分：
// 远程含匹配串 = work，其余 = private；没配则全部平铺不分流）：
//   <scope>/inbox/YYYY-MM-DD.md   当日采集层（按天）
//   <scope>/projects/<slug>/log/YYYY-MM.md   项目知识层（按项目按月）
// 人不用再记得"结束前写日志"——干完活它自己落。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join } from "path";
import { ccSessionPath, listCcSessions } from "./cc-sessions.ts";
import { isWithinDataDir } from "./internal-path.ts";
import { llmJson } from "./llm.ts";
import { inboxDir, projectDir, SCOPES_ON, scopeForRemote, type Scope } from "./paths.ts";
import { cfg, DATA, ensureDir, fmt, log } from "./util.ts";

const STATE_FILE = join(DATA, "capture.json");

interface CaptureState { [sessionId: string]: { size: number; at: string } }

function loadCapState(): CaptureState {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveCapState(s: CaptureState) {
  ensureDir(DATA);
  // 只留 300 条，老会话不需要追踪
  const entries = Object.entries(s).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 300);
  writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
}

/** 工作/私人分流：看 git 远程地址是否含 vault.workRemoteMatch（且不含 workRemoteExclude），不看本地路径。
 *  没有匹配远程（或不是 git 仓库）= 私人。目录已删（worktree 清理后）才退回路径兜底。
 *  没配 workRemoteMatch = 不分流，恒为空 scope。 */
const scopeCache = new Map<string, Scope>();

export function scopeOf(cwd: string): Scope {
  if (!SCOPES_ON) return "";
  const hit = scopeCache.get(cwd);
  if (hit !== undefined) return hit;
  let scope: Scope = "private";
  try {
    if (existsSync(cwd)) scope = scopeForRemote(gitRemoteText(cwd));
    else scope = scopeForRemote(cwd);   // 目录没了只能拿路径兜底（路径里通常带组织名/仓库名）
  } catch { /* 判不出来按私人处理——宁可漏进公司文档，不能错进 */ }
  scopeCache.set(cwd, scope);
  return scope;
}

const remoteCache = new Map<string, string>();
function gitRemoteText(dir: string): string {
  const hit = remoteCache.get(dir);
  if (hit !== undefined) return hit;
  let text = "";
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "remote", "-v"], { timeout: 5000 });
    text = new TextDecoder().decode(r.stdout);
  } catch { /* 不是仓库/git 不在 */ }
  remoteCache.set(dir, text);
  return text;
}

// ---- 会话实际触达了哪些仓库 ----
// 会话 cwd 只是“在哪开的终端”，不是“改了哪个项目”：在私人项目开起的会话可以整场都在改工作项目。
// 所以除了 cwd，再数 transcript 里工具调用碰过的路径（Edit/Write/Read 的 file_path、Bash 命令里的绝对路径），
// 归并到各自 git 仓库根，按触达次数定主导仓库 → 决定 scope 与 slug（见 resolveScope）。

const ABS_PATH_RE = /(?:^|[\s"'`=(\[{,;:])((?:\/Users|\/home|\/opt|\/srv|\/var|\/private|~)\/[^\s"'`)\]}<>,;|&]+)/g;
const PATH_KEYS = ["file_path", "path", "notebook_path", "cwd", "directory", "dir"];

/** 纯函数：从一次 tool_use 的 input 里抽出绝对路径（路径键 + 命令文本里的 /Users/... 字面量） */
export function pathsInToolUse(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  const obj = input as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && (isAbsolute(v) || v.startsWith("~/"))) out.push(v.replace(/^~/, process.env.HOME || "~"));
  }
  for (const k of ["command", "cmd", "script"]) {
    const v = obj[k];
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(ABS_PATH_RE)) out.push(m[1].replace(/^~/, process.env.HOME || "~"));
  }
  return out;
}

/** 向上找仓库根（含 .git 目录或 worktree 的 .git 文件）；找不到返回 null。按目录缓存，整棵树最多爬 12 层。 */
const rootCache = new Map<string, string | null>();
export function repoRootOf(p: string): string | null {
  let dir = p;
  try { if (!statSync(p).isDirectory()) dir = dirname(p); } catch { dir = dirname(p); }
  const start = dir;
  const seen: string[] = [];
  for (let i = 0; i < 12 && dir && dir !== "/"; i++) {
    const hit = rootCache.get(dir);
    if (hit !== undefined) { for (const d of seen) rootCache.set(d, hit); return hit; }
    seen.push(dir);
    if (existsSync(join(dir, ".git"))) { for (const d of seen) rootCache.set(d, dir); return dir; }
    dir = dirname(dir);
  }
  for (const d of seen) rootCache.set(d, null);
  rootCache.set(start, null);
  return null;
}

/** 仓库显示名：优先远程 URL 最后一段（worktree 目录名不稳定），没远程用根目录名 */
export function repoNameOf(root: string, remoteText: string): string {
  const url = (remoteText.split("\n")[0] || "").trim().split(/\s+/)[1] || "";
  const seg = url.replace(/\/+$/, "").split(/[/:]/).pop() || "";
  const name = seg.replace(/\.git$/, "");
  return (name || basename(root)).toLowerCase();
}

export interface RepoTouch { name: string; root: string; scope: Scope; touches: number }

/** 把触达路径归并成仓库触达计数（最多解析 12 个不同仓库，内部目录/临时目录不算） */
export function touchedRepos(paths: string[]): RepoTouch[] {
  const byRoot = new Map<string, RepoTouch>();
  for (const p of paths) {
    if (isWithinDataDir(p, DATA) || p.startsWith("/private/tmp/") || p.startsWith("/tmp/") || p.startsWith("/private/var/")) continue;
    const root = repoRootOf(p);
    if (!root) continue;
    let t = byRoot.get(root);
    if (!t) {
      if (byRoot.size >= 12) continue;
      const remote = gitRemoteText(root);
      t = { name: repoNameOf(root, remote), root, scope: scopeForRemote(remote), touches: 0 };
      byRoot.set(root, t);
    }
    t.touches++;
  }
  return [...byRoot.values()].sort((a, b) => b.touches - a.touches);
}

/** 纯决策：cwd 的 scope/slug + 触达仓库计数 → 最终 scope/slug。
 *  主导仓库要想推翻 cwd 判定，必须触达 ≥3 次且 ≥2× 另一侧的总触达（宁可漏进公司文档，不能错进）；
 *  cwd 不是仓库（~、~/workspace）而主导仓库 ≥3 次时，slug 用主导仓库名而不是 home/workspace。 */
export function resolveScope(cwdScope: Scope, cwdSlug: string, cwdRoot: string | null, repos: RepoTouch[]): { scope: Scope; slug: string; repos: string[] } {
  const names = repos.map((r) => r.name);
  const top = repos[0];
  if (!top) return { scope: cwdScope, slug: cwdSlug, repos: names };
  const sum = (s: Scope) => repos.filter((r) => r.scope === s).reduce((n, r) => n + r.touches, 0);
  if (top.scope !== cwdScope) {   // 不分流时两边都是 ""，自然不会进来
    const mine = Math.max(1, sum(cwdScope));  // cwd 自己至少算 1 次
    if (top.touches >= 3 && top.touches >= 2 * mine) return { scope: top.scope, slug: top.name, repos: names };
    return { scope: cwdScope, slug: cwdSlug, repos: names };
  }
  if (!cwdRoot && top.touches >= 3) return { scope: cwdScope, slug: top.name, repos: names };
  return { scope: cwdScope, slug: cwdSlug, repos: names };
}

/** ownward 内部机器会话不收割（心跳/分流/AI 对话/routine 写入/顾问咨询等） */
function isInternal(cwd: string, title: string): boolean {
  if (isWithinDataDir(cwd, DATA)) return true;
  if (cwd.startsWith("/private/tmp/") || cwd.startsWith("/tmp/")) return true; // scratchpad 咨询
  if (/^执行 (Heartbeat|Triage) 任务/.test(title)) return true;
  if (/工作总结代笔|写进飞书文档/.test(title.slice(0, 60))) return true;
  if (/^你是.{0,20}(顾问|共创者)/.test(title)) return true; // codex-alt 设计咨询
  return false;
}

interface Transcript { text: string; paths: string[] }

/** CC transcript → 对话文本（给模型总结）+ 工具调用触达的路径（给分流判主导仓库）。一趟读完。 */
function extractConversation(path: string, maxChars = 14_000): Transcript {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: string[] = [];
  const paths: string[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.isSidechain || e.isMeta) continue;
      const role = e.type === "user" ? "USER" : e.type === "assistant" ? "AI" : null;
      if (!role) continue;
      const c = e.message?.content;
      if (Array.isArray(c)) {
        for (const x of c) if (x?.type === "tool_use") paths.push(...pathsInToolUse(x.input));
      }
      let text = typeof c === "string" ? c
        : Array.isArray(c) ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : "";
      text = text.trim();
      if (text && !text.startsWith("<")) out.push(`[${role}] ${text.slice(0, 1500)}`);
    } catch { /* skip */ }
  }
  let joined = out.join("\n");
  if (joined.length > maxChars) joined = "…(前文截断)…\n" + joined.slice(-maxChars);
  return { text: joined, paths };
}

/** 每 2 小时扫一轮：CC + codex 沉寂 >15min 的实质会话逐个总结落盘（每轮最多 3 个控成本），
 *  同一轮里再收割引擎任务（sweepHarvest）——都走 featureEnabled("capture") 总闸。 */
/* 飞书消息收割已迁至 external vertical corp-lark-harvest（公司 vertical 仓）。 */
export async function sweepCapture() {
  const { featureEnabled } = await import("./features.ts");
  if (!featureEnabled("capture")) return;
  const { listCodexSessions, codexSessionPath, readCodexMessages } = await import("./codex-sessions.ts");
  const { engineSessionIds } = await import("./session-cleanup.ts");
  const state = loadCapState();
  const now = Date.now();
  let budget = 3;
  // 引擎任务（bg 派发/接管）的 transcript 走任务收割（飞行记录素材更全），不再当普通会话双收
  const engineIds = engineSessionIds();

  // 统一候选：CC transcript + codex rollout（codex 的 scope 用 rollout 里的 git remote 判，最准）
  const candidates: { id: string; cwd: string; project: string; title: string; size: number; mtime: number; active: boolean;
    scope?: Scope; read: () => Transcript }[] = [
    ...listCcSessions(50).filter((s) => !engineIds.has(s.id.split("/").pop() || "")).map((s) => ({
      ...s, read: () => extractConversation(ccSessionPath(s.id)),
    })),
    // codex_exec = `codex exec` 跑出来的（Ownward codex-bg 引擎任务、脚本调用），任务路径已有 harvest，不重复收割
    ...listCodexSessions(40).filter((s) => s.originator !== "codex_exec").map((s) => ({
      ...s,
      scope: (SCOPES_ON && s.repoUrl ? scopeForRemote(s.repoUrl) : undefined) as Scope | undefined,
      read: (): Transcript => ({
        text: readCodexMessages(codexSessionPath(s.id), 0).messages
          .map((m) => `[${m.role === "user" ? "USER" : m.role === "assistant" ? "AI" : "TOOL"}] ${m.text.slice(0, 1500)}`)
          .join("\n").slice(-14_000),
        paths: [],
      }),
    })),
  ];

  for (const s of candidates) {
    if (budget <= 0) break;
    if (s.active || now - s.mtime < 15 * 60_000) continue;  // 还在跑/刚停，等下一轮
    if (now - s.mtime > 48 * 3600_000) continue;            // 太老的不追溯
    if (s.size < 4000) continue;                            // 没聊出东西
    if (!s.cwd || isInternal(s.cwd, s.title)) continue;
    const prev = state[s.id];
    if (prev && s.size < prev.size * 1.3) continue;         // 已收割且没大变化

    budget--;
    try {
      await captureOne(s);
      state[s.id] = { size: s.size, at: new Date().toISOString() };
      saveCapState(state);
    } catch (e) {
      log(`capture [${s.project}] failed: ${e}`);
      state[s.id] = { size: s.size, at: new Date().toISOString() }; // 失败也标记，别每轮烧钱重试
      saveCapState(state);
    }
  }
  // 引擎任务收割：原 sweepHarvest 的独立 10min 定时器并入本轮（reap 也不再即时收割），
  // 沉寂 >15min 的任务重收一遍，多轮追问任务的日志不会停在首轮快照上
  const { sweepHarvest } = await import("./harvest.ts");
  await sweepHarvest().catch((e) => log(`harvest sweep: ${e}`));

  // 飞书消息收割已迁至 external vertical corp-lark-harvest（公司 vertical 仓），不在此编排

  // 收割完顺手同步 vault（写了才 commit，没写是 no-op）
  const { syncVault } = await import("./vault-sync.ts");
  syncVault("capture").catch(() => {});
}

/** 幂等覆盖：把含 key 的旧条目整块换成新条目，找不到就追加。
 *  条目块 = 从它的 `## ` 标题起，到下一个行首 `## ` 之前（或文件尾）。
 *  多轮任务反复收割靠这个只留一条最新的，而不是每轮追加一条互相矛盾的。
 *  key 不在任何 `## ` 块里（文件被手改坏了）时按追加处理——宁可多一条，绝不乱剪别人的内容。 */
export function upsertEntry(content: string, key: string, entry: string): string {
  const lines = content.split("\n");
  const hit = lines.findIndex((l) => l.includes(key));
  if (hit < 0) return content + entry;
  let start = hit;
  while (start >= 0 && !lines[start].startsWith("## ")) start--;
  if (start < 0) return content + entry;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  const block = entry.replace(/\n+$/, "").split("\n");
  const rest = lines.slice(end);
  return [...lines.slice(0, start), ...block, "", ...(rest.length ? rest : [""])].join("\n");
}

/** 带 key 就整块覆盖，否则追加（文件不存在时 appendFileSync 会建） */
function writeEntry(file: string, entry: string, key?: string) {
  if (!key || !existsSync(file)) { appendFileSync(file, entry); return; }
  const cur = readFileSync(file, "utf8");
  if (!cur.includes(key)) { appendFileSync(file, entry); return; }
  writeFileSync(file, upsertEntry(cur, key, entry));
}

/** 统一写入口：inbox（按天）+ 项目 log（按月）+ README 骨架。harvest 手动落盘也走这里。
 *  opts.key：同一来源多次收割的幂等键（条目里必须含这个串），给了就覆盖不追加。
 *  opts.date：条目归属日期，默认今天。多轮任务传任务开始那天——否则跨天续跑的任务
 *  会在新一天的文件里另起一条，旧文件里那条过期的永远留在原地。 */
export function appendKnowledge(
  cwd: string, slug: string, entry: string, scopeOverride?: Scope,
  opts?: { key?: string; date?: string },
) {
  const scope = scopeOverride ?? scopeOf(cwd);
  const date = opts?.date || fmt(new Date(), "date");
  const inbox = inboxDir(scope);
  mkdirSync(inbox, { recursive: true });
  const inboxFile = join(inbox, `${date}.md`);
  if (!existsSync(inboxFile)) {
    const scopeLine = scope ? `scope: ${scope}\n` : "";
    writeFileSync(inboxFile, `---\ndate: ${date}\n${scopeLine}type: inbox\n---\n\n# ${date}\n\n`);
  }
  writeEntry(inboxFile, entry, opts?.key);

  const projDir = projectDir(slug, scope);
  mkdirSync(join(projDir, "log"), { recursive: true });
  const readme = join(projDir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      "---", `type: project_memory`, `project: ${slug}`, ...(scope ? [`scope: ${scope}`] : []), `updated_at: ${date}`, "---", "",
      `# ${slug}`, "",
      "## 现状", "(项目当前状态、入口、未决问题——人和 AI 共同维护，这是项目唯一真相)", "",
      "## 已知陷阱", "", "## 决策", "",
    ].join("\n"));
  }
  writeEntry(join(projDir, "log", `${date.slice(0, 7)}.md`), entry, opts?.key);
}

async function captureOne(s: { id: string; cwd: string; project: string; title: string; scope?: Scope; read: () => Transcript }) {
  const { text: conversation, paths } = s.read();
  if (conversation.length < 500) { log(`capture [${s.project}]: 对话文本不足 500 字，跳过`); return; }

  const res = await llmJson([
    "把这次开发会话总结成工作日志条目。输出严格 JSON（不要代码块）：",
    `{"title": "<有辨识度的标题，<=20字>",`,
    ` "problem": "<要解决什么/做什么>",`,
    ` "failed": "<失败的尝试和原因，没有则空字符串>",`,
    ` "solution": "<最终方案和关键实现>",`,
    ` "files": "<涉及的文件/提交，没有则空字符串>"}`,
    "只写事实；会话没实质工作就把 title 设为空字符串。",
    "",
    conversation,
  ].join("\n"));
  if (!res?.title) { log(`capture [${s.project}]: 无实质内容，跳过`); return; }

  // 分流/slug：cwd 判定 + 会话实际触达的仓库（在私人终端整场改工作项目 → 归工作项目/work）
  const cwdSlug = (s.cwd.split("/").filter(Boolean).pop() || "misc").toLowerCase();
  const cwdScope = s.scope ?? scopeOf(s.cwd);
  const repos = paths.length ? touchedRepos(paths) : [];
  const { scope, slug, repos: repoNames } = resolveScope(cwdScope, cwdSlug, existsSync(s.cwd) ? repoRootOf(s.cwd) : null, repos);
  const time = fmt(new Date(), "time");
  const entry = [
    `## ${time} | ${slug} | ${String(res.title).slice(0, 60)}`,
    `- **Problem**: ${res.problem || "(见会话)"}`,
    ...(res.failed ? [`- **Failed attempt**: ${res.failed}`] : []),
    `- **Solution**: ${res.solution || "(见会话)"}`,
    ...(res.files ? [`- **Files**: ${res.files}`] : []),
    ...(repoNames.length > 1 ? [`- **Repos**: ${repoNames.join(", ")}`] : []),
    "", "",
  ].join("\n");
  appendKnowledge(s.cwd, slug, entry, scope);
  log(`capture [${scope ? `${scope}/` : ""}${slug}] ${res.title}${slug !== cwdSlug ? `（cwd=${cwdSlug}，按触达仓库归到 ${slug}）` : ""}`);
}

