// 工作台 API：客户端六个 tab 的数据与操作。
// 飞书读写走 lark-cli 的 user 身份（你的账号）；vault 只允许读 vault 目录内的 md。
import { isStrictlyWithin, isWithin } from "./path-within.ts";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, normalize, resolve, sep } from "path";
import { lookup } from "dns/promises";
import { listActions, resolveAction, setActionState } from "./actions.ts";
import { chatBinding, deleteChat, getChat, listChats, providers, renameChat, resolveChatBinding, saveChatCandidate, streamChat } from "./chat.ts";
import { withBranches, worktreeBranches } from "./git-branch.ts";
import { loadTasks } from "./dispatch.ts";
import { chatMeta, markRead, touchChat } from "./lark-state.ts";
import { RESEARCH_DIR, VAULT_ROOT } from "./paths.ts";
import { gmailInbox, gmailMessageDetail, gmailReply } from "./sources/gmail.ts";
import { CONFIG_ROOT, DATA, ROOT, SOURCE_ROOT, cfg, expandHome, log, run, tailRead } from "./util.ts";
import { parseSessionMigrationMode, validateSessionRunnerTaskIds } from "./kernel/sessions/contracts.ts";
import { createNewSessionService, createSessionService, effectiveSessionMode } from "./session-service.ts";
import { connectorConfig } from "./connector-config.ts";
import { saveStockConnectorConfig } from "./connector-control.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/**
 * 忙时输入队列：GET 投影；POST {action:"remove",queueId} 撤一条还没发出的。
 * 只认 queueId，不认下标——客户端手里是轮询快照，按下标撤会删掉另一条且无人察觉。
 */
export async function queueRouteResponse(method:string,id:string,state:()=>Promise<{queued?:unknown[]}>,remove:(queueId:string)=>Promise<{removed:boolean;queued:unknown[]}>,body?:{action?:unknown;queueId?:unknown}):Promise<Response>{
  if(!id)return json({ok:false,msg:"缺 id"},400);
  if(method==="GET"){const current=await state();return json({ok:true,queued:current.queued??[]});}
  if(method!=="POST")return json({ok:false,msg:"方法不支持"},405);
  if(body?.action!=="remove")return json({ok:false,msg:"只支持 action=remove"},400);
  const queueId=typeof body?.queueId==="string"?body.queueId:"";
  if(!queueId)return json({ok:false,msg:"缺 queueId"},400);
  const r=await remove(queueId);
  // 撤不到必须说出来：本轮刚结束、这条已经合并发出去了就是这个结果，静默回 ok 会让人以为撤掉了
  if(!r.removed)return json({ok:false,errorCode:"QUEUE_ITEM_GONE",msg:"这条已经发出，或已不在队列里",queued:r.queued},409);
  return json({ok:true,msg:"已撤回",queued:r.queued});
}
function sessionError(error:any):Response{const code=typeof error?.code==="string"?error.code:undefined,unavailable=new Set(["RUNNER_UNAVAILABLE","RUNNER_CONTROL_TIMEOUT","RUNNER_PROVIDER_UNAVAILABLE","RUNNER_PROVIDER_MISSING","RUNNER_PROVIDER_DEGRADED"]),conflict=code==="SESSION_RUNNER_DRAIN_REQUIRED"||!!code?.startsWith("SESSION_HANDOFF_"),status=unavailable.has(code??"")?503:conflict?409:400,known:Record<string,string>={RUNNER_UNAVAILABLE:"Runner 不可用，请使用原 commandId 查询结果",RUNNER_CONTROL_TIMEOUT:"Runner 结果未知，请使用原 commandId 查询结果",SESSION_RUNNER_DRAIN_REQUIRED:"Runner 命令尚未收敛，暂不能切回旧链写入"},raw=String(error instanceof Error?error.message:error),safe=/(?:ENOENT|lstat|\/Users\/|\/var\/|\.sock)/.test(raw)?"Session 操作失败":raw.slice(0,240);return json({ok:false,msg:code?(known[code]??safe):safe,...(code?{errorCode:code}:{}),...(typeof error?.commandId==="string"?{commandId:error.commandId}:{}),...(typeof error?.runId==="string"?{runId:error.runId}:{}),...(error?.outcomeUnknown===true?{outcomeUnknown:true}:{})},status);}

async function sessionService(taskId: string) { const mode=effectiveSessionMode(taskId);return{mode,service:createSessionService(taskId,cfg.architecture?.allowedRoots??[])}; }

async function lark(args: string[]): Promise<any> {
  const r = await run(["lark-cli", ...args, "--format", "json"], { timeoutMs: 30_000 });
  let parsed: any = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not json */ }
  if (parsed?.ok === false || r.code !== 0) {
    const m = parsed?.error?.message || r.stderr.slice(0, 200) || "lark-cli error";
    // 常见场景翻译成人话
    if (/access denied|user_unauthorized/i.test(m)) {
      throw new Error("飞书拒绝了该操作（外部租户会话通常不允许 API 代发；内部会话正常）");
    }
    throw new Error(m.slice(0, 200));
  }
  return parsed?.data ?? parsed;
}

/** lark-cli 已把 content 渲染成可读文本；清洗掉客户端渲染不了的伪标记 */
function larkText(msg: any): string {
  const c = msg.content;
  let text: string;
  if (typeof c === "string") {
    try {
      const parsed = JSON.parse(c);
      text = parsed?.text ? String(parsed.text) : c;
    } catch { text = c; }
  } else {
    return `[${msg.msg_type || "消息"}]`;
  }
  return text
    .replace(/!\[Image\]\([^)]*\)/g, "[图片]")
    .replace(/\(img_key:[^)]*\)/g, "")
    .replace(/<card title="([^"]*)"[^>]*>/g, "【卡片】$1\n")
    .replace(/<\/?(p|div|br)[^>]*>/g, "\n")
    .replace(/<\/?[a-z][^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 2000);
}

// 会话原始列表缓存：每次拉取要派生两个 lark-cli 进程（~1s），60s TTL + 过期先回旧值后台刷新。
// single-flight：冷启动/SWR 共享同一个 refresh Promise，并发请求不重复派进程
let chatsCache: { at: number; p2p: any; groups: any } | null = null;
let chatsPromise: Promise<{ at: number; p2p: any; groups: any }> | null = null;

function fetchChatLists() {
  if (!chatsPromise) {
    chatsPromise = (async () => {
      // 分开拉：p2p 和群各一页，避免第一页被群刷满导致私聊不可见
      const [p2p, groups] = await Promise.all([
        lark(["im", "+chat-list", "--as", "user", "--types", "p2p"]),
        lark(["im", "+chat-list", "--as", "user"]),
      ]);
      chatsCache = { at: Date.now(), p2p, groups };
      return chatsCache;
    })().finally(() => { chatsPromise = null; });
  }
  return chatsPromise;
}

async function rawChatLists(): Promise<{ p2p: any; groups: any }> {
  if (!chatsCache) return fetchChatLists();
  if (Date.now() - chatsCache.at > 60_000) {
    fetchChatLists().catch(() => {}); // stale-while-revalidate
  }
  return chatsCache;
}

// vault 文件索引缓存：递归遍历 + 每文件 statSync 会阻塞事件循环，30s TTL 足够
let vaultCache: { at: number; files: any[] } | null = null;

// 飞书文档解析缓存（进程生命周期内不重拉）
const docCache = new Map<string, any>();

/** 抓取目标是否指向本机/私网/链路本地：SSRF 兜底（安全评审 LOW#5）。个人机风险有限，但拦一层防内网扫描。 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;              // loopback / private / this-host
    if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16-31.x
    if (a === 192 && b === 168) return true;                        // 192.168.x
    if (a === 169 && b === 254) return true;                        // link-local (含云 metadata 169.254.169.254)
  }
  if (h === "::1" || h.startsWith("[::1") || h.startsWith("fd") || h.startsWith("fe80")) return true;  // IPv6 本机/私网
  return false;
}

/** 研究沉淀：抓标题 → AI 摘要 → 追加 vault research/YYYY-MM-DD.md */
async function saveResearch(url: string, note?: string): Promise<string> {
  let title = url, excerpt = "";
  try {
    const researchHost = new URL(url).hostname;
    if (isPrivateHost(researchHost)) throw new Error("拒绝抓取本机/私网地址");
    // DNS rebinding：域名可能解析到私网/云 metadata IP。isPrivateHost 只看字面 host，这里按解析结果再挡一层。
    const resolved = await lookup(researchHost, { all: true }).catch(() => [] as { address: string }[]);
    if (resolved.some((a) => isPrivateHost(a.address))) throw new Error("拒绝抓取解析到私网的地址");
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual" });
    const html = (await res.text()).slice(0, 200_000);
    title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim().slice(0, 100) || url;
    excerpt = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 6000);
  } catch { /* 页面抓不到也要能存 */ }

  let summary = note || "";
  if (excerpt.length > 300) {
    const { llmJson } = await import("./llm.ts");
    const r = await llmJson(`用两三句话总结这个网页的核心内容，输出严格 JSON：{"summary":"..."}\n\n标题：${title}\n正文节选：${excerpt}`);
    if (r?.summary) summary = note ? `${r.summary}（备注：${note}）` : r.summary;
  }

  const { appendFileSync, mkdirSync } = await import("fs");
  const { fmt } = await import("./util.ts");
  const dir = RESEARCH_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${fmt(new Date(), "date")}.md`);
  if (!existsSync(file)) writeFileSync(file, `# ${fmt(new Date(), "date")} 资料\n\n`);
  appendFileSync(file, `- [${title.replace(/[[\]]/g, "")}](${url})${summary ? ` — ${summary}` : ""}\n`);
  log(`research saved: ${title}`);
  return `已存: ${title.slice(0, 40)}`;
}

// 项目收藏（启动器数据源）
const PROJECTS_FILE = join(DATA, "projects.json");
function loadProjects(): { name: string; dir: string }[] {
  try { return JSON.parse(readFileSync(PROJECTS_FILE, "utf8")); } catch { return []; }
}
function saveProjects(list: { name: string; dir: string }[]) {
  writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
}

// 项目候选集：收藏 + 近期任务/会话目录并集。收藏是手动维护的（开源化重置后常年一条），
// 派发下拉的真实价值来自「你最近在哪些目录干过活」——从活动数据自动喂；/api/projects 与 /api/branches 共用
async function projectCandidates(): Promise<{ name: string; dir: string }[]> {
  const fav = loadProjects();
  const seen = new Set<string>();
  const out: { name: string; dir: string }[] = [];
  const allowedRoots = (cfg.architecture?.allowedRoots ?? []).flatMap((root) => {
    try { const actual = realpathSync(resolve(expandHome(root))); return statSync(actual).isDirectory() ? [actual] : []; }
    catch { return []; }
  });
  let wtRoot = expandHome(cfg.dispatch?.worktreeRoot || "~/.ownward-worktrees");
  try { wtRoot = realpathSync(wtRoot); } catch { /* 尚未创建时沿用展开路径 */ }
  const push = (dir?: string | null, name?: string) => {
    if (!dir) return;
    let actual: string;
    try { actual = realpathSync(resolve(expandHome(dir))); if (!statSync(actual).isDirectory()) return; }
    catch { return; }
    if (!allowedRoots.some((root) => isWithin(root, actual)) || seen.has(actual)) return;
    if (isStrictlyWithin(wtRoot, actual) || /-\d{8}-[a-z0-9]{4}$/.test(actual)) return;  // 任务临时 worktree 不进候选
    seen.add(actual);
    out.push({ name: name || basename(actual) || actual, dir: actual });
  };
  for (const project of fav) push(project.dir, project.name);
  for (const t of [...loadTasks()].reverse()) {
    push((t as any).projectDir);
    for (const dir of (t as any).extraDirs ?? []) push(dir);
  }
  try {
    const { SessionRepository } = await import("./sessions/repository.ts");
    for (const session of new SessionRepository(DATA).list().reverse()) {
      push(session.cwd);
      for (const dir of session.extraDirs ?? []) push(dir);
    }
  } catch { /* 仓库损坏时仍保留任务与历史会话 fallback */ }
  try {
    const { listCcSessions } = await import("./cc-sessions.ts");
    for (const s of listCcSessions(30)) push((s as any).cwd);
  } catch { /* 会话列表失败不影响收藏部分 */ }
  return out;
}

/** 「按分支」视图的 worktree 补全：对每个项目候选扫 git worktree list，得 分支 → 项目/worktree 平铺行。
 *  同一仓库的多个项目候选（互为 worktree）会扫出同一份集合，按路径重合去重只记一次；任务临时 worktree 不进映射。 */
async function branchWorktrees(): Promise<{ branch: string; project: string; dir: string; path: string; isMain: boolean }[]> {
  let wtRoot = expandHome(cfg.dispatch?.worktreeRoot || "~/.ownward-worktrees");
  try { wtRoot = realpathSync(wtRoot); } catch { /* 尚未创建时沿用展开路径 */ }
  const seenRepo = new Set<string>();
  const out: { branch: string; project: string; dir: string; path: string; isMain: boolean }[] = [];
  const perDir = await Promise.all((await projectCandidates()).slice(0, 30).map(async ({ name, dir }) => ({ name, dir, wts: await worktreeBranches(dir) })));
  for (const { name, dir, wts } of perDir) {
    if (wts.some((w) => seenRepo.has(w.path))) continue;   // 同仓库已由别的项目目录扫出
    for (const w of wts) {
      seenRepo.add(w.path);
      if (isStrictlyWithin(wtRoot, w.path) || /-\d{8}-[a-z0-9]{4}$/.test(w.path)) continue;
      out.push({ branch: w.branch, project: name, dir, path: w.path, isMain: w.isMain });
    }
  }
  return out;
}

// open_id → 姓名缓存：持久化 + 负缓存（外部租户查不到就记空，不再反复重查——这是切会话慢的主因之一）
const NAMES_FILE = join(DATA, "lark-names.json");
let nameCache: Map<string, string> | null = null;

function loadNames(): Map<string, string> {
  if (!nameCache) {
    try { nameCache = new Map(Object.entries(JSON.parse(readFileSync(NAMES_FILE, "utf8")))); }
    catch { nameCache = new Map(); }
  }
  return nameCache;
}

function saveNames() {
  writeFileSync(NAMES_FILE, JSON.stringify(Object.fromEntries(nameCache!), null, 2));
}

async function resolveNames(ids: string[]): Promise<Map<string, string>> {
  const cache = loadNames();
  const missing = [...new Set(ids)].filter((id) => id?.startsWith("ou_") && !cache.has(id));
  if (!missing.length) return cache;
  try {
    // 一次批量解析，替代原先的 N 个并行单查
    const data = await lark(["contact", "+search-user", "--as", "user", "--user-ids", missing.join(",")]);
    const found = new Map((data.users || []).map((u: any) => [u.open_id, u.localized_name || u.name || ""]));
    for (const id of missing) cache.set(id, (found.get(id) as string) || ""); // 查不到的负缓存
    saveNames();
  } catch { /* 本轮解析失败，下次再试 */ }
  return cache;
}

/** HEIC → JPEG：收原始字节，macOS sips 转码后回传 jpeg。皮肤壁纸与对话附件共用一份实现
 *  （Chromium 解不了 HEIC：不先转，前端既画不出预览也编不出 base64）。 */
async function heicToJpeg(req: Request): Promise<Response> {
  const raw = await readLimitedBody(req, 20 * 1024 * 1024);
  if (!raw.ok) return json({ ok: false, msg: "图片太大（>20MB）" }, 413);
  const bin = raw.bin;
  const { convertHeicToJpeg } = await import("./skins.ts");
  const r = await convertHeicToJpeg(bin);
  if (!r.ok || !r.jpeg) return json({ ok: false, msg: r.msg || "转码失败" }, 400);
  return new Response(r.jpeg, { headers: { "Content-Type": "image/jpeg" } });
}

/** 不信任 Content-Length：chunked/缺失/伪造时也必须在读取过程中硬停。 */
async function readLimitedBody(req: Request, max: number): Promise<{ ok: true; bin: Buffer } | { ok: false }> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, bin: Buffer.alloc(0) };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return { ok: false }; }
    chunks.push(value);
  }
  return { ok: true, bin: Buffer.concat(chunks.map((c) => Buffer.from(c)), size) };
}

export async function handleWorkbench(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;

  // ---- 执行日志（尾读：这两个端点被 2-3s 高频轮询，全量读会随日志增长拖慢整个事件循环） ----
  if (p === "/api/logs") {
    const f = join(DATA, "logs", "daemon.log");
    if (!existsSync(f)) return json({ lines: [] });
    const n = parseInt(url.searchParams.get("lines") || "300", 10);
    const lines = tailRead(f, 256 * 1024).split("\n");
    return json({ lines: lines.slice(-n).filter(Boolean) });
  }

  // ---- 任务日志（bg: 输出文件 / terminal: 提示） ----
  const taskLog = p.match(/^\/api\/tasks\/([\w-]+)\/log$/);
  if (taskLog) {
    const t = loadTasks().find((x) => x.id === taskLog[1]);
    if (!t) return json({ ok: false, msg: "任务不存在" }, 404);
    if (t.logFile && existsSync(t.logFile)) {
      return json({ ok: true, text: tailRead(t.logFile, 60 * 1024) });
    }
    return json({ ok: true, text: "(terminal 模式任务：过程在 Terminal 窗口/Claude transcript 里，结束后运行 ownward done 收割)" });
  }

  // ---- terminal 任务底层 CC 会话 id（app 内直接旁观该 terminal 任务的 Claude 会话）----
  const taskCc = p.match(/^\/api\/tasks\/([\w-]+)\/cc-session$/);
  if (taskCc) {
    const t = loadTasks().find((x) => x.id === taskCc[1]);
    if (!t) return json({ ok: false, msg: "任务不存在" }, 404);
    if (t.mode !== "terminal") return json({ ok: false, msg: "不是 terminal 模式任务" }, 400);
    const { findTerminalCcSession } = await import("./terminal-tasks.ts");
    const cc = await findTerminalCcSession(t);
    return json(cc ? { ok: true, sessionId: cc.id, active: cc.active } : { ok: false, msg: "还没认领到会话" });
  }

  // ---- 按 id 取单个任务（attention 点旧任务时，/api/tasks 只回最近 30 条会漏，这里补全量单查） ----
  const taskById = p.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskById) {
    const t = loadTasks().find((x) => x.id === taskById[1]);
    if (!t) return json({ ok: false, msg: "任务不存在" }, 404);
    return json(t);
  }

  // ---- 皮肤（自定义皮肤库；内置皮肤在 web/skin.js，资产路由在 server.ts /skin-asset/） ----
  if (p === "/api/skins" && req.method === "GET") {
    const { listSkins } = await import("./skins.ts");
    return json(listSkins());
  }
  if (p === "/api/skins" && req.method === "POST") {
    const { createSkin } = await import("./skins.ts");
    const r = createSkin(await req.json());
    return json(r, r.ok ? 200 : 400);
  }
  if (p === "/api/skins/delete" && req.method === "POST") {
    const { deleteSkin } = await import("./skins.ts");
    const b = await req.json() as { id?: string };
    return json(deleteSkin(String(b.id || "")));
  }
  // HEIC 前置转码：Chromium 前端解不了 HEIC，收原始字节 → sips 转 jpeg 回传，前端再走取色+重编码入库
  // （对话附件走 /api/chat/convert-heic，同一个 heicToJpeg——两处路径不同是给客户端看的语义，实现只有一份）
  if (p === "/api/skins/convert-heic" && req.method === "POST") return heicToJpeg(req);

  // ---- 笔记（vault 只读浏览） ----
  if (p === "/api/vault/list") {
    if (vaultCache && Date.now() - vaultCache.at < 30_000) return json(vaultCache.files);
    if (!existsSync(VAULT_ROOT)) return json([]);  // 新装还没建 vault：空列表，别 500
    // 全 vault 扫描（隐藏目录除外），客户端拿相对目录建文件树
    const files: { path: string; name: string; dir: string; mtime: number }[] = [];
    for (const raw of readdirSync(VAULT_ROOT, { recursive: true }) as string[]) {
      if (!raw.endsWith(".md")) continue;
      // readdirSync 给的是 OS 分隔符（Windows 上是 \）。统一转成 "/" 再解析：
      // 否则隐藏目录过滤失效、name 变成整条相对路径、dir 恒为空——客户端的文件树直接塌成一层。
      const f = raw.split(sep).join("/");
      if (f.split("/").some((seg) => seg.startsWith("."))) continue; // .git/.obsidian/.omc 等
      const full = join(VAULT_ROOT, raw);
      try {
        files.push({
          path: full,
          name: f.split("/").pop()!.replace(/\.md$/, ""),
          dir: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "",
          mtime: statSync(full).mtimeMs,
        });
      } catch { /* skip */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    vaultCache = { at: Date.now(), files: files.slice(0, 2000) };
    return json(vaultCache.files);
  }
  if (p === "/api/vault/file") {
    const raw = url.searchParams.get("path") || "";
    const full = normalize(raw);
    if (!isWithin(VAULT_ROOT, full) || !full.endsWith(".md")) return json({ ok: false, msg: "越界" }, 403);
    if (!existsSync(full)) return json({ ok: false, msg: "不存在" }, 404);
    return json({ ok: true, text: readFileSync(full, "utf8") });
  }

  // ---- 飞书（user 身份） ----
  if (p === "/api/lark/chats") {
    try {
      const raw = await rawChatLists();
      const meta = chatMeta();  // meta 每次现合并：未读/预览实时，缓存只缓贵的部分（进程派生）
      const mapChats = (data: any) => (data.chats || data.items || []).map((c: any) => {
        const m = meta[c.chat_id];
        return {
          chat_id: c.chat_id, name: c.name || "(无名会话)", mode: c.chat_mode,
          target_type: c.p2p_target_type || "group",
          last_text: m?.last_text || "", last_ts: m?.last_ts || 0,
          last_sender: m?.last_sender || "", unread: m?.unread || 0,
          deleted: m?.deleted || false,
        };
      });
      let all = [...mapChats(raw.p2p).filter((c: any) => c.target_type !== "bot"), ...mapChats(raw.groups)];
      // 被「清除」的已处理会话默认不出现（来新消息会自动浮回）；?all=1 查看全部
      if (url.searchParams.get("all") !== "1") {
        const { isChatHidden } = await import("./lark-state.ts");
        all = all.filter((c: any) => !isChatHidden(meta[c.chat_id]));
      }
      all.sort((a: any, b: any) => b.last_ts - a.last_ts || (a.mode === "p2p" ? -1 : 1));
      return json(all);
    } catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/lark/hide-read") {
    const { hideReadChats } = await import("./lark-state.ts");
    return json({ ok: true, msg: `已清除 ${hideReadChats()} 个会话（来新消息会自动回来）` });
  }
  if (req.method === "POST" && p === "/api/lark/chat-delete") {
    const body = await req.json() as { chat_id?: string; restore?: string };
    if (!body.chat_id) return json({ ok: false, msg: "缺 chat_id" }, 400);
    const { setChatDeleted } = await import("./lark-state.ts");
    const restore = body.restore === "1";
    setChatDeleted(body.chat_id, !restore);
    return json({ ok: true, msg: restore ? "已恢复" : "已删除（来新消息会浮现，读完自动消失）" });
  }
  if (p === "/api/lark/messages") {
    const chatId = url.searchParams.get("chat_id");
    if (!chatId) return json({ ok: false, msg: "缺 chat_id" }, 400);
    try {
      const data = await lark(["im", "+chat-messages-list", "--as", "user", "--chat-id", chatId]);
      // peek=1 是后台预取：只取数据，不动未读状态
      if (url.searchParams.get("peek") !== "1") markRead(chatId);
      // API 返回 desc（最新在前），反转成时间正序：界面底部=最新，符合 IM 习惯
      const msgs = (data.messages || data.items || []).reverse();
      const names = await resolveNames(msgs.map((m: any) => m.sender?.id));
      const items = msgs.map((m: any) => ({
        id: m.message_id,
        sender: names.get(m.sender?.id) || m.sender?.id || "?",  // 负缓存为空串时回退显示 id
        ts: m.create_time || "",
        text: larkText(m),
        mine: m.sender?.id === cfg.notify.larkUserId,
      }));
      return json(items);
    } catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/lark/send") {
    const body = await req.json() as { chat_id: string; text: string };
    if (!body.chat_id || !body.text) return json({ ok: false, msg: "缺参数" }, 400);
    try {
      await lark(["im", "+messages-send", "--as", "user", "--chat-id", body.chat_id, "--text", body.text]);
      touchChat(body.chat_id, { text: body.text, ts: Date.now(), sender: "我", incrementUnread: false });
      markRead(body.chat_id);
      resolveAction(`lark:${body.chat_id}`, "replied"); // 真的回复了才算完成

      log(`workbench: lark reply sent to ${body.chat_id}`);
      return json({ ok: true, msg: "已发送" });
    } catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }

  // ---- macOS 定时任务 ----
  if (p === "/api/schedules") {
    const { listSchedules } = await import("./schedules.ts");
    // 默认只返回 ownward 自己管理的任务（收敛后的系统状态）；all=1 返回用户/全局/守护域全部任务
    // （高级诊断，只读）；system=1 才另加 /System/Library 的 Apple 系统 agent
    const all = url.searchParams.get("all") === "1";
    return json(await listSchedules(url.searchParams.get("system") === "1", all));
  }
  if (req.method === "POST" && p === "/api/schedules/run") {
    const body = await req.json() as { label: string };
    const { runScheduleNow } = await import("./schedules.ts");
    try { await runScheduleNow(body.label); return json({ ok: true, msg: "已触发运行" }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/schedules/toggle") {
    const body = await req.json() as { label: string; path: string; enable: boolean };
    const { toggleSchedule } = await import("./schedules.ts");
    try { await toggleSchedule(body.label, body.path, body.enable); return json({ ok: true, msg: body.enable ? "已启用" : "已停用" }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/schedules/update") {
    const body = await req.json() as { label: string; path: string; spec: any };
    const { updateSchedule } = await import("./schedules.ts");
    try { await updateSchedule(body.label, body.path, body.spec); return json({ ok: true, msg: "调度已更新并重载" }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }

  // ---- 笔记编辑（vault 写入，路径锁死 vault 内 .md） ----
  if (req.method === "POST" && p === "/api/vault/save") {
    const body = await req.json() as { path: string; content: string };
    const full = normalize(expandHome(body.path));
    if (!isStrictlyWithin(VAULT_ROOT, full) || !full.endsWith(".md")) return json({ ok: false, msg: "只允许写 vault 内的 md" }, 400);
    writeFileSync(full, body.content ?? "");
    return json({ ok: true, msg: "已保存" });
  }
  if (req.method === "POST" && p === "/api/vault/new") {
    const body = await req.json() as { name: string; dir?: string };
    const name = (body.name || "").replace(/[/\\:*?"<>|]/g, "").trim();
    if (!name) return json({ ok: false, msg: "文件名为空" }, 400);
    const dir = normalize(join(VAULT_ROOT, body.dir || "notes"));
    if (!isWithin(VAULT_ROOT, dir)) return json({ ok: false, msg: "目录非法" }, 400);
    const { mkdirSync } = await import("fs");
    mkdirSync(dir, { recursive: true });
    const full = join(dir, `${name}.md`);
    if (!existsSync(full)) writeFileSync(full, `# ${name}\n\n`);
    return json({ ok: true, msg: "已创建", path: full });
  }
  if (req.method === "POST" && p === "/api/vault/append-today") {
    const body = await req.json() as { text: string };
    if (!body.text?.trim()) return json({ ok: false, msg: "内容为空" }, 400);
    const { appendDaily } = await import("./obsidian.ts");
    appendDaily("手记", [{ source: "system", summary: body.text.trim() }]);
    return json({ ok: true, msg: "已追加到今日" });
  }

  // ---- Gmail 动作 ----
  if (req.method === "POST" && p === "/api/gmail/act") {
    const body = await req.json() as { id: string; action: "archive" | "read" | "unread" | "star" | "unstar"; account?: string };
    const { gmailModify } = await import("./sources/gmail.ts");
    const map: Record<string, [string[], string[]]> = {
      archive: [[], ["INBOX"]], read: [[], ["UNREAD"]], unread: [["UNREAD"], []],
      star: [["STARRED"], []], unstar: [[], ["STARRED"]],
    };
    const [add, remove] = map[body.action] || [[], []];
    try { await gmailModify(body.id, add, remove, body.account); return json({ ok: true, msg: { archive: "已归档", read: "已标已读", unread: "已标未读", star: "已加星", unstar: "已去星" }[body.action] }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (p === "/api/gmail/search") {
    const { gmailSearch } = await import("./sources/gmail.ts");
    try { return json(await gmailSearch(url.searchParams.get("q") || "in:inbox", 20, url.searchParams.get("account") || "all")); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/gmail/compose") {
    const body = await req.json() as { to: string; subject: string; text: string; account?: string };
    const { gmailCompose } = await import("./sources/gmail.ts");
    try { await gmailCompose(body.to, body.subject, body.text, body.account); return json({ ok: true, msg: "已发送" }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }

  // ---- 飞书文档解析（消息里的 doc 链接 → 标题+摘要 / 收藏成 Action） ----
  if (p === "/api/lark/doc") {
    const docUrl = url.searchParams.get("url") || "";
    if (!/^https?:\/\/[^/]*(feishu\.cn|larksuite\.com)(\/|$)/.test(docUrl)) return json({ ok: false, msg: "不是飞书文档链接" }, 400);
    const cached = docCache.get(docUrl);
    if (cached) return json(cached);
    try {
      const r = await run(["lark-cli", "docs", "+fetch", "--doc", docUrl], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(r.stderr.slice(0, 150) || "拉取失败");
      const text = r.stdout.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
      const title = r.stdout.match(/<title>([^<]+)<\/title>/)?.[1] || text.slice(0, 40) || "飞书文档";
      const out = { ok: true, title, excerpt: text.slice(0, 400) };
      docCache.set(docUrl, out);
      return json(out);
    } catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/lark/doc/save") {
    const body = await req.json() as { url: string; title: string };
    const { openAction } = await import("./actions.ts");
    openAction({
      id: `larkdoc:${body.url.slice(-24)}`, kind: "follow_up", source: "lark",
      title: `看文档：${(body.title || "飞书文档").slice(0, 50)}`,
      reason: "从飞书消息收藏", ref: { url: body.url },
    });
    return json({ ok: true, msg: "已收藏到收件箱" });
  }

  // ---- 研究沉淀（URL → 标题+AI 摘要 → vault research/） ----
  if (req.method === "POST" && p === "/api/research") {
    const body = await req.json() as { url: string; note?: string };
    if (!/^https?:\/\//.test(body.url || "")) return json({ ok: false, msg: "不是有效 URL" }, 400);
    try { return json({ ok: true, msg: await saveResearch(body.url, body.note) }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }

  // ---- 股票自选 ----
  if (req.method === "GET" && p === "/api/stock/watchlist") {
    const stock = connectorConfig(cfg, "stock");
    return json({ enabled: stock.enabled === true, watchlist: Array.isArray(stock.watchlist) ? stock.watchlist : [] });
  }
  if (req.method === "POST" && p === "/api/stock/watchlist") {
    const body = await req.json() as { enabled?: boolean; watchlist?: string[] };
    // 持久化 canonical config，并热重启 stock Connector。
    const confPath = join(SOURCE_ROOT, "config.json");
    await saveStockConnectorConfig({
      file: confPath,
      liveConfig: cfg,
      patch: body,
      restart: async (id) => (await import("./connectors.ts")).restartConnector(id),
    });
    return json({ ok: true, msg: "已保存并应用" });
  }
  if (req.method === "POST" && p === "/api/stock/analyze") {
    const body = await req.json() as { symbol: string };
    const sym = (body.symbol || "").trim().toUpperCase();
    if (!/^[A-Z0-9.]{1,12}$/.test(sym)) return json({ ok: false, msg: "标的代码不合法" }, 400);
    const r = await run(["python3", expandHome("~/.local/bin/lb-analyze.py"), sym], { timeoutMs: 120_000 });
    if (r.code !== 0) return json({ ok: false, msg: (r.stderr || "分析失败").slice(0, 200) }, 500);
    return json({ ok: true, text: r.stdout.slice(-8000) });
  }

  // ---- 周期性职责（routine：草稿→人审→受控写入飞书文档） ----
  if (p === "/api/routines") {
    const { todayRoutines } = await import("./routines.ts");
    return json(todayRoutines());
  }
  // 设置页可编辑的 routine 规则（日报/周报等周期职责的时间/星期/窗口/启用）
  if (req.method === "GET" && p === "/api/routines/rules") {
    const { listRoutines } = await import("./routines.ts");
    return json(listRoutines());
  }
  if (req.method === "POST" && p === "/api/routines/rules") {
    const body = await req.json() as { id: string; patch: any };
    const { updateRoutineRule } = await import("./routines.ts");
    try { return json({ ok: true, msg: "规则已更新", rules: updateRoutineRule(body.id, body.patch || {}) }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 400); }
  }
  if (req.method === "GET" && p === "/api/routines/draft") {
    // 必须限定 GET：否则会抢先吃掉下面的 POST 保存请求（读空 query→占坑返回「没有草稿」，
    // saveDraft 永远调不到）——这正是「编辑草稿不生效」的真凶。
    const { draftView } = await import("./routines.ts");
    const v = draftView(url.searchParams.get("id") || "", url.searchParams.get("date") || "");
    return v ? json({ ok: true, ...v }) : json({ ok: false, msg: "没有草稿" }, 404);
  }
  if (req.method === "POST" && p === "/api/routines/draft") {
    const body = await req.json() as { id: string; date?: string; content: string };
    const { saveDraft } = await import("./routines.ts");
    const { fmt } = await import("./util.ts");
    const date = body.date || fmt(new Date(), "date");
    try { saveDraft(body.id, date, body.content); return json({ ok: true, msg: "草稿已保存" }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 400); }
  }
  if (req.method === "POST" && p === "/api/routines/generate") {
    const body = await req.json() as { id: string };
    const { generateDraft } = await import("./routines.ts");
    try { await generateDraft(body.id); return json({ ok: true, msg: "草稿已生成" }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/routines/write") {
    const body = await req.json() as { id: string; date?: string };
    const { writeRoutine } = await import("./routines.ts");
    const { fmt } = await import("./util.ts");
    const date = body.date || fmt(new Date(), "date");
    try { return json({ ok: true, msg: "写入任务已派发，任务页可旁观", taskId: await writeRoutine(body.id, date) }); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 400); }
  }
  if (req.method === "POST" && p === "/api/routines/skip") {
    const body = await req.json() as { id: string; date?: string };
    const { skipRoutine } = await import("./routines.ts");
    const { fmt } = await import("./util.ts");
    const date = body.date || fmt(new Date(), "date");
    skipRoutine(body.id, date);
    return json({ ok: true, msg: "已跳过（今天不再提醒）" });
  }

  // ---- 日报（?date=YYYY-MM-DD 补生成指定日） ----
  if (req.method === "POST" && p === "/api/digest/run") {
    const { runDailyDigest } = await import("./daily-digest.ts");
    try {
      const f = await runDailyDigest(true, url.searchParams.get("date") || undefined);
      return json({ ok: !!f, msg: f ? `日报已生成: ${basename(f)}` : "今天没什么可总结的（或生成失败）" });
    } catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }

  // ---- 今日会议 ----
  if (p === "/api/calendar/today") {
    const { todayMeetings } = await import("./calendar.ts");
    try { return json(await todayMeetings(url.searchParams.get("force") === "1")); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }

  // ---- 项目启动器 ----
  if (p === "/api/projects") return json((await projectCandidates()).slice(0, 30));
  // 分支 → 项目/worktree 映射：「按分支」视图把还没任务的 worktree 项目补进对应需求节点
  if (p === "/api/branches") return json({ worktrees: await branchWorktrees() });
  if (req.method === "POST" && p === "/api/projects/add") {
    const body = await req.json() as { name?: string; dir: string };
    const dir = expandHome((body.dir || "").trim());
    if (!existsSync(dir)) return json({ ok: false, msg: "目录不存在" }, 400);
    const list = loadProjects().filter((x) => x.dir !== dir);
    list.unshift({ name: (body.name || basename(dir) || dir).trim(), dir });
    saveProjects(list.slice(0, 30));
    return json({ ok: true, msg: "已收藏" });
  }
  if (req.method === "POST" && p === "/api/projects/remove") {
    const body = await req.json() as { dir: string };
    saveProjects(loadProjects().filter((x) => x.dir !== body.dir));
    return json({ ok: true, msg: "已移除" });
  }
  if (req.method === "POST" && p === "/api/projects/open") {
    const body = await req.json() as { dir: string; app: "code" | "terminal" | "finder" };
    let dir: string;
    try { dir = realpathSync(resolve(expandHome(body.dir))); if (!statSync(dir).isDirectory()) return json({ ok: false, msg: "目录不存在" }, 400); }
    catch { return json({ ok: false, msg: "目录不存在" }, 400); }
    // 只允许打开授权根内的目录（与 /api/fs/dirs、/api/work 同口径）；不给随手用系统 open 打开任意路径
    const openRoots = (cfg.architecture?.allowedRoots ?? []).flatMap((root) => {
      try { const a = realpathSync(resolve(expandHome(root))); return statSync(a).isDirectory() ? [a] : []; } catch { return []; }
    });
    if (!openRoots.some((root) => isWithin(root, dir))) return json({ ok: false, msg: "目录不在授权范围（architecture.allowedRoots）内" }, 403);
    if (body.app === "code") Bun.spawn(["open", "-a", "Visual Studio Code", dir]);
    else if (body.app === "terminal") Bun.spawn(["open", "-a", "Terminal", dir]);
    else Bun.spawn(["open", dir]);
    return json({ ok: true, msg: "已打开" });
  }

  // ---- 最近会话：ownward 原生引擎对话（人派的，排除 routine/evolve 代笔与 terminal/旁观） ----
  if (p === "/api/dev/recent") {
    const { codexSessionPath, readCodexMessages } = await import("./codex-sessions.ts");
    const { SessionRepository } = await import("./sessions/repository.ts");
    const tasks = loadTasks().filter((t) => t.engine && t.kind !== "routine" && t.kind !== "evolve"), taskIds = new Set(tasks.map((t) => t.id));
    const sessionByTask = new Map<string, string>(), runnerSessions = new Map<string, any>();
    try {
      for (const session of new SessionRepository(DATA).list()) {
        for (const taskId of session.taskIds) sessionByTask.set(taskId, session.id);
        if (session.source !== "legacy" && session.taskIds.some((taskId) => taskIds.has(taskId))) runnerSessions.set(session.id, session);
      }
    } catch (e) { log(`recent sessions repository read failed, fallback legacy: ${e}`); }
    let runnerStates = new Map<string, any>();
    try {
      if (runnerSessions.size) {
        runnerStates = await createNewSessionService(cfg.architecture?.allowedRoots ?? []).states([...runnerSessions.keys()]);
      }
    } catch (e) { runnerStates = new Map(); log(`recent sessions runner snapshot failed, fallback legacy: ${e}`); }
    const list = tasks
      .map((t) => {
        let msgs = 0, userMsgs = 0, last = "", pending: any[] = [], runnerTurn = "", lastAt = +new Date(t.endedAt || t.startedAt) || 0;
        const derive = (mm: any[]) => {
          msgs = mm.length;
          for (const m of mm) if (m.role === "user") userMsgs++;
          const real = [...mm].reverse().find((m) => (m.role === "assistant" || m.role === "user") && m.text?.trim());
          last = real ? `${real.role === "user" ? "我：" : ""}${String(real.text).trim().slice(0, 160)}` : "";
        };
        let dk = t.id;   // 去重键：同一 codex rollout 被多次接管会生成多个任务，只留最新
        const sessionId = sessionByTask.get(t.id), runnerState = sessionId ? runnerStates.get(sessionId) : undefined;
        if (runnerState) {
          const messages = runnerState.messages ?? [];
          derive(messages);
          pending = (runnerState.pending ?? []).map((p: any) => ({ toolName: p.toolName, brief: p.brief }));
          runnerTurn = runnerState.turn || "";
          lastAt = Math.max(lastAt, runnerState.lastActivityAt || 0, ...messages.map((m) => Date.parse(m.ts || "") || 0));
          dk = sessionId!;
        } else try {
          const s = JSON.parse(readFileSync(join(DATA, "tasks", `${t.id}.session.json`), "utf8"));
          derive(s.messages || []);
          pending = (s.pending ?? s.pendingPerms ?? []).map((p: any) => ({ toolName: p.toolName, brief: p.brief }));
          runnerTurn = s.turn || "";
          if (s.lastActivityAt) lastAt = s.lastActivityAt;
        } catch {
          // codex 引擎：data/tasks 只有 meta（rolloutId），消息本体在 codex 的 rollout 文件里
          try {
            const meta = JSON.parse(readFileSync(join(DATA, "tasks", `${t.id}.codex.json`), "utf8"));
            const rp = codexSessionPath(`cdx:${meta.home || "codex"}:${meta.rolloutId}`);
            derive(readCodexMessages(rp).messages);
            lastAt = statSync(rp).mtimeMs;
            dk = sessionByTask.get(t.id) ?? `cdx:${meta.rolloutId}`;
          } catch { /* rollout 掉出最近窗口/已清理：按空壳处理 */ }
        }
        // Claude 的 /new 会轮换 native ref，但每个真实 Task 仍须单独展示；仅 Codex 接管副本去重。
        if (t.mode === "codex-bg") dk = sessionByTask.get(t.id) ?? dk;
        return { id: t.id, project: t.project, title: t.title || String(t.task || "").slice(0, 80),
          mode: t.mode, backend: runnerState?.providerId ?? (t.mode === "codex-bg" ? "codex" : "claude"), providerId: runnerState?.providerId ?? (t.mode === "codex-bg" ? "codex" : "claude"), status: t.status, exitCode: t.exitCode, uncertain: !!t.uncertain, runnerState: { pending, turn: runnerTurn }, startedAt: t.startedAt, lastAt, msgs, userMsgs, last, dk };
      })
      .filter((s) => s.msgs > 0)   // 两边都没消息的空壳不算「有过对话」
      .sort((a, b) => b.lastAt - a.lastAt || (+new Date(b.startedAt) || 0) - (+new Date(a.startedAt) || 0) || (a.id < b.id ? 1 : -1));
    const seenDk = new Set<string>();
    const deduped = list.filter((s) => !seenDk.has(s.dk) && seenDk.add(s.dk))
      .map(({ dk, ...s }) => s).slice(0, 100);
    return json(deduped);
  }

  // ---- 开发会话（引擎任务：追问/审批/中断/接管；CC 与 codex 统一走 agent-backend 分发层） ----
  if (p === "/api/dev/messages") {
    const id = url.searchParams.get("id") || "";
    try {
      const service=(await sessionService(id)).service;
      const state = url.searchParams.get("refresh")==="1"?await service.refreshHistory(id):await service.state(id);
      const task = loadTasks().find((t) => t.id === id) as any;
      let cwd = task?.cwd || task?.projectDir || "", extraDirs = task?.extraDirs ?? [];
      try {
        const { SessionRepository } = await import("./sessions/repository.ts");
        const session = new SessionRepository(DATA).getByTaskId(id);
        if (session) { cwd = session.cwd; extraDirs = session.extraDirs ?? []; }
      } catch { /* 旧数据或仓库暂不可读时使用任务快照 */ }
      return json({ ...state, cwd, extraDirs });
    } catch (e) { return sessionError(e); }
  }
  if (p === "/api/system/session-migration-report") {
    const id = url.searchParams.get("id") || "";
    const { migrateLegacySessions, SessionRepository } = await import("./sessions/repository.ts");
    try { const session=new SessionRepository(DATA).getByTaskId(id),migration=migrateLegacySessions(DATA,{dryRun:true});return json({at:new Date().toISOString(),taskId:id,...(session?{providerId:session.providerId}:{}),status:session?(migration.conflicts.length?"drift":"match"):"missing",migration}); } catch(e){return json({at:new Date().toISOString(),taskId:id,status:"error",reason:e instanceof Error?e.name:"UnknownError",migration:null});}
  }
  if (p === "/api/system/session-store-status") {
    try { const { sessionStoreStatus }=await import("./sessions/repository.ts"),schema=JSON.parse(readFileSync(join(DATA,"schema.json"),"utf8"));const status=sessionStoreStatus(DATA);return json({...status,migrationApplied:Array.isArray(schema?.applied)&&schema.applied.includes("stage6-kernel-sessions-v1")}); }
    catch { return json({primary:false,legacyFallback:false,archivedOrphans:0,migrationApplied:false,errorCode:"SESSION_STORE_STATUS_UNAVAILABLE"},503); }
  }
  if (p === "/api/system/session-runner-status") {
    let configuredMode: "off" | "runner", taskIds: string[]; try { configuredMode = parseSessionMigrationMode(cfg.architecture?.sessionRunnerMode); taskIds = validateSessionRunnerTaskIds(cfg.architecture?.sessionRunnerTaskIds); } catch { return json({ configuredMode: "invalid", configError: "SESSION_RUNNER_CONFIG_INVALID", runner: { ok: false, errorCode: "CONFIG_INVALID" } }); }
    let runner: any = { ok: true, required: false };
    if (configuredMode === "runner") { let client: any; try { const { RunnerClient } = await import("./runner/client.ts"); client = new RunnerClient(DATA, 1_000); const reply = await client.request("ping", {}); runner = { ok: true, required: true, draining: reply.body.draining === true, activeRunCount: Array.isArray(reply.body.activeRuns) ? reply.body.activeRuns.length : 0, providers:Array.isArray(reply.body.providers)?reply.body.providers:[] }; } catch { runner = { ok: false, required: true, errorCode: "RUNNER_UNAVAILABLE",providers:[] }; } finally { client?.close(); } }
    const canaryHash = taskIds.length ? new Bun.CryptoHasher("sha256").update([...taskIds].sort().join("\0")).digest("hex").slice(0, 12) : null;
    return json({ configuredMode, canary: { count: taskIds.length, hash: canaryHash }, scope: configuredMode === "runner" && taskIds.length ? "allowlist" : configuredMode === "runner" ? "all" : "legacy", runner });
  }
  if (p === "/api/system/session-command") { const commandId = url.searchParams.get("id") || ""; if (!commandId) return json({ ok: false, msg: "缺 commandId" }, 400); const { RunnerCommandJournal, RunnerEventJournal } = await import("./runner/journals.ts"); let command: any, events: any[]; try { command = new RunnerCommandJournal(DATA).readStrict().find((c) => c.commandId === commandId); events = new RunnerEventJournal(DATA).readStrict().filter((e) => e.commandId === commandId); } catch (e) { return sessionError(Object.assign(new Error("Runner journal 无法验证"), { code: "SESSION_RUNNER_JOURNAL_INVALID" })); } if (!command) return json({ ok: false, msg: "command 不存在" }, 404); let runnerReachable = false, client: any; try { const { RunnerClient } = await import("./runner/client.ts"); client = new RunnerClient(DATA, 1_000); const reply = await client.queryCommand(commandId); if (Array.isArray(reply.body.events)) events = reply.body.events; runnerReachable = true; } catch { /* 本地 durable journal 仍是真相。 */ } finally { client?.close(); } const last = events.at(-1); return json({ ok: true, commandId, terminal: !!last && ["completed", "failed", "interrupted", "unknown-outcome"].includes(last.type), outcome: last?.type ?? "accepted", errorCode: last?.reason, stale: !runnerReachable }); }
  if (req.method === "POST" && p === "/api/system/session-drain") { const body = await req.json() as { sessionId: string; commandId: string; confirm: string }; try { const { KernelSessionService } = await import("./kernel/sessions/service.ts"); return json({ ok: true, ...(await new KernelSessionService(DATA, { mode: "off" }).drainUnknown(body)) }); } catch (e) { return sessionError(e); } }
  if (req.method === "POST" && p === "/api/dev/add-dir") {
    const body = await req.json() as { id: string; dir: string };
    const dir = expandHome(String(body.dir || "").trim());
    if (!isAbsolute(dir)) return json({ ok: false, msg: "要绝对路径（或 ~ 开头）" }, 400);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return json({ ok: false, msg: "目录不存在" }, 400);
    try {
      const receipt = await (await sessionService(body.id)).service.addDirectory(body.id, dir);
      return json({ ok: true, msg: "已加入可写目录，下一轮对话生效", ...(receipt || {}) });
    } catch (e) { return sessionError(e); }
  }
  if (req.method === "POST" && p === "/api/dev/set-access") {
    const body = await req.json() as { id: string; full: boolean };
    try {
      const receipt = await (await sessionService(body.id)).service.setAccess(body.id, body.full ? "full-access" : "workspace");
      return json({ ok: true, msg: body.full ? "已解除沙箱，下一轮对话生效" : "已恢复沙箱，下一轮对话生效", ...(receipt || {}) });
    } catch (e) { return sessionError(e); }
  }
  if (req.method === "POST" && p === "/api/dev/send") {
    const body = await req.json() as { id: string; text: string; images?: { media_type: string; data: string }[]; clientMutationId?: string };
    if (!body.text?.trim() && !body.images?.length) return json({ ok: false, msg: "内容为空" }, 400);
    // 斜杠命令：只拦 ownward 语义的 /new（/clear 同义）= 同任务丢上下文重开（逃生门）。
    // 其余 / 开头全部透传——实测 stream-json 下 CC 自己解释斜杠命令（含用户自定义命令）：
    // 能执行的直接执行（如 /compact，有 status 帧透出过程），不可用的回 synthetic 说明文本（已可见）
    const cmd = body.text?.trim();
    if (cmd === "/new" || cmd === "/clear") {
      try {
        const msg = await (await sessionService(body.id)).service.newSession(body.id);
        return json({ ok: true, queued: false, msg });
      } catch (e) { return sessionError(e); }
    }
    try {
      const r = await (await sessionService(body.id)).service.send(body.id, { text: body.text || "", images: body.images || [], ...(body.clientMutationId ? { clientMutationId: body.clientMutationId } : {}) });
      return json({ ok: true, queued: r?.queued ?? false, msg: r?.queued ? "已加入队列，本轮结束自动发送" : "已发送", ...(r?.commandId ? { commandId: r.commandId, runId: r.runId } : {}) });
    } catch (e) { return sessionError(e); }
  }
  if(req.method==="POST"&&p==="/api/dev/handoff"){
    const body=await req.json().catch(()=>({})) as {id?:string;providerId?:"claude"|"codex"|"codebuddy";model?:string;effort?:string;reason?:string;confirmUnknownOutcome?:boolean};
    if(!body.id||!body.providerId||!["claude","codex","codebuddy"].includes(body.providerId))return json({ok:false,msg:"缺少合法 id/providerId"},400);
    try{const result=await(await sessionService(body.id)).service.handoff(body.id,{providerId:body.providerId,...(body.model?{model:body.model}:{}),...(body.effort?{effort:body.effort}:{}),...(body.reason?{reason:body.reason}:{}),...(body.confirmUnknownOutcome===true?{confirmUnknownOutcome:true}:{})});return json({ok:true,msg:`已接力到 ${body.providerId}`,...result});}catch(e){return sessionError(e);}
  }
  // 忙时输入队列：GET 投影 / POST {action:"remove",queueId} 撤一条还没发出的
  if (p === "/api/dev/queue") {
    try{
      const body=req.method==="POST"?await req.json().catch(()=>({}))as any:undefined;
      const id=(typeof body?.id==="string"&&body.id)||url.searchParams.get("id")||"";
      if(!id)return json({ok:false,msg:"缺 id"},400);
      // legacy / Runner 两条链都有队列，service 内部分流（legacy 走 agent-backend，Runner 走落盘队列）
      const {service}=await sessionService(id);
      return await queueRouteResponse(req.method,id,async()=>await service.state(id),(queueId)=>service.removeQueued(id,queueId),body);
    }
    catch(e){return sessionError(e);}
  }
  if (req.method === "POST" && p === "/api/dev/interrupt") {
    const body = await req.json() as { id: string };
    try {
      const receipt = await (await sessionService(body.id)).service.interrupt(body.id);
      return json({ ok: true, msg: "已请求中断", ...(receipt || {}) });
    } catch (e) { return sessionError(e); }
  }
  if (req.method === "POST" && p === "/api/dev/control") {
    const body = await req.json() as { id: string; action: "take" | "release" };
    try {
      const result = await (await sessionService(body.id)).service.acquireControl(body.id, body.action === "take" ? "ownward" : "observing");
      const control = result.control;
      return json({ ok: true, control, msg: control === "ownward" ? "已接管输入权" : "已释放（回到只旁观）" });
    } catch (e) { return sessionError(e); }
  }
  if (req.method === "POST" && p === "/api/dev/decision") {
    // remember: "session" | "global" | null —— 「总是批准」时记忆成自动批准规则
    const body = await req.json() as { id: string; requestId: string; allow: boolean; message?: string; remember?: "session" | "global" | null };
    try { const receipt = await (await sessionService(body.id)).service.respondApproval(body.id, body.requestId, { allow: body.allow, ...(body.message ? { message: body.message } : {}), remember: body.remember ?? null }); return json({ ok: true, msg: "已提交", ...(receipt || {}) }); }
    catch (e) { return sessionError(e); }
  }

  // ---- 自动批准规则（三态审批的「总是批准」记忆管理） ----
  if (p === "/api/approvals") {
    const { listRules } = await import("./approval.ts");
    return json(listRules());
  }
  if (req.method === "POST" && p === "/api/approvals/revoke") {
    const body = await req.json() as { id: string };
    const { revokeRule } = await import("./approval.ts");
    const ok = revokeRule(body.id);
    return json({ ok, msg: ok ? "已撤销" : "规则不存在或已撤销" }, ok ? 200 : 404);
  }

  // ---- 会话旁观（CC ~/.claude/projects + codex ~/.codex[-alt]/sessions 合并） ----
  if (p === "/api/cc/sessions") {
    const { listCcSessions } = await import("./cc-sessions.ts");
    const { listCodexSessions } = await import("./codex-sessions.ts");
    const { devObservationDto } = await import("./kernel/sessions/dev-observation.ts");
    const all = [...listCcSessions(), ...listCodexSessions()].sort((a, b) => b.mtime - a.mtime);
    // 附带 branch（按 cwd 解析，带缓存）：前端「按分支」视图分组用
    return json(await withBranches(all.map((meta: any) => devObservationDto(meta))));
  }
  if (req.method === "POST" && p === "/api/cc/adopt-capability") {
    try {
      const body = await req.json() as { id?: string };
      const { devAdoptCapabilities } = await import("./kernel/sessions/dev-adopt-capability.ts");
      return json({ ok: true, ...devAdoptCapabilities.issue(body.id || "") });
    } catch (error: any) {
      const code = String(error?.code || "DEV_SESSION_CANDIDATE_INVALID");
      return json({ ok: false, msg: String(error?.message || "无法签发接管凭证"), errorCode: code }, code === "DEV_SESSION_DISCOVERY_ACTIVE" ? 409 : 400);
    }
  }
  if (p === "/api/cc/session") {
    const id = url.searchParams.get("id") || "";
    const after = parseInt(url.searchParams.get("after") || "0", 10);
    try {
      if (id.startsWith("cdx:")) {
        const { codexSessionPath, readCodexMessages } = await import("./codex-sessions.ts");
        return json(readCodexMessages(codexSessionPath(id), after));
      }
      const { ccSessionPath, readCcMessages } = await import("./cc-sessions.ts");
      return json(readCcMessages(ccSessionPath(id), after));
    } catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 404); }
  }
  if (req.method === "POST" && p === "/api/cc/harvest") {
    const body = await req.json() as { id: string };
    const { ccSessionPath, listCcSessions } = await import("./cc-sessions.ts");
    const { harvestTranscript } = await import("./harvest.ts");
    try {
      const path = ccSessionPath(body.id);
      const meta = listCcSessions().find((x) => x.id === body.id);
      const file = await harvestTranscript(path, meta?.project || "misc", meta?.cwd || "");
      return json(file ? { ok: true, msg: `已落盘: ${basename(file)}` } : { ok: false, msg: "会话内容太少或总结失败" });
    } catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }

  // ---- Claude 订阅额度（5h/周利用率，顶栏徽标） ----
  if (p === "/api/claude-usage") {
    const { claudeUsage } = await import("./claude-usage.ts");
    return json({ ok: true, usage: await claudeUsage() });
  }

  // ---- 会话置顶（任务列顶部 pin 长期对话，daemon 重启不丢） ----
  if (p === "/api/sessions/pinned") {
    const { listPinned } = await import("./pinned-sessions.ts");
    return json({ ok: true, pinned: listPinned() });
  }
  if (req.method === "POST" && p === "/api/sessions/pin") {
    const body = await req.json() as { kind: "task" | "cc"; ref: string; project?: string; title?: string; cwd?: string; pin: boolean };
    const { pinSession, unpinSession } = await import("./pinned-sessions.ts");
    if (body.pin) { pinSession({ kind: body.kind, ref: body.ref, project: body.project, title: body.title, cwd: body.cwd }); return json({ ok: true, msg: "已置顶" }); }
    unpinSession(body.kind, body.ref);
    return json({ ok: true, msg: "已取消置顶" });
  }

  // ---- 项目隐藏（任务列「删除项目」：隐藏组，不删会话，有新活动自动回来） ----
  if (p === "/api/projects/dismissed") {
    const { dismissedProjects } = await import("./dismissed-projects.ts");
    return json({ ok: true, dismissed: dismissedProjects() });
  }
  if (req.method === "POST" && p === "/api/projects/dismiss") {
    const body = await req.json() as { project: string; restore?: boolean };
    const { dismissProject, restoreProject } = await import("./dismissed-projects.ts");
    if (body.restore) { restoreProject(body.project); return json({ ok: true, msg: "已恢复项目" }); }
    dismissProject(body.project);
    return json({ ok: true, msg: "已删除项目（会话保留，有新活动会自动回来）" });
  }

  // ---- 注意力收件箱（跨所有 agent 会话：待审批/卡住/待收尾，今日页专区数据源） ----
  if (p === "/api/attention") {
    const { collectAttention } = await import("./attention.ts");
    return json(await collectAttention());
  }

  // ---- 行动队列（今日首页数据源） ----
  // 一键确认本周目标（goals.md：删提示行 + 消 action）
  if (req.method === "POST" && p === "/api/memory/goals/confirm") {
    const { confirmGoals } = await import("./memory.ts");
    try { return json(await confirmGoals()); }
    catch (e) { return json({ ok: false, msg: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (p === "/api/actions") return json(listActions());
  if (req.method === "POST" && p === "/api/actions/state") {
    const body = await req.json() as { id: string; state: "snoozed" | "dismissed" | "resolved"; snoozeMin?: number };
    return json({ ok: setActionState(body.id, body.state, body.snoozeMin || 120), msg: { snoozed: "稍后再说", dismissed: "已忽略", resolved: "已完成" }[body.state] });
  }

  // ---- Role（角色：vault <scope>/roles/ 里的持久化一等对象） ----
  // 整段接管 /api/roles 命名空间：没匹配上的一律显式 404，不许漏到下面变成别的语义。
  // 候选记忆只进 _candidates，promote 是人工门——这里没有任何自动晋升入口，别加。
  // 按 id 寻址的接口全部走 resolveRole：跨 scope 同 id 是歧义，一律 409，不许静默命中第一份。
  if (p === "/api/roles" || p.startsWith("/api/roles/")) {
    const R = await import("./roles.ts");
    // 失败 code → 状态码：not_found=404 / conflict=409 / 其余入参问题=400
    const out = (r: any) => json(r, r.ok ? 200 : r.code === "not_found" ? 404 : r.code === "conflict" ? 409 : 400);
    const body = async () => { try { return await req.json(); } catch { return null; } };

    const PM = await import("./project-memory.ts");
    if (req.method === "GET" && p === "/api/roles") {
      const roles = R.listRoles({ includeArchived: url.searchParams.get("archived") === "1" });
      // types/projectTargets 一并下发：前端的类型枚举与晋升目标不许自己写一份平行常量
      return json({
        ok: true, roles, icons: R.ROLE_ICONS, targets: R.PROMOTE_TARGETS,
        types: R.ROLE_TYPES, projectTargets: PM.PROJECT_PROMOTE_TARGETS,
      });
    }
    if (req.method === "POST" && p === "/api/roles") {
      const b = await body();
      return b ? out(R.createRole(b)) : json({ ok: false, msg: "请求体不是 JSON" }, 400);
    }
    // 必须排在 /api/roles/:id 之前——projects 是固定段，不是角色 id
    if (req.method === "GET" && p === "/api/roles/projects") {
      const { ALL_SCOPES, SCOPES_ON, WORK_SCOPE } = await import("./paths.ts");
      const raw = url.searchParams.get("scope");
      const scope = raw === null || raw === "" ? WORK_SCOPE : raw;
      // 不做兜底回落：scope 传错就报错，否则工作角色会拿到私人项目列表
      if (!ALL_SCOPES.includes(scope as any)) return json({ ok: false, msg: `scope 不合法（可选：${ALL_SCOPES.join("/") || "留空"}）` }, 400);
      return json({ ok: true, scope, scopesOn: SCOPES_ON, projects: R.listProjectSlugs(scope as any) });
    }

    const roleOne = p.match(/^\/api\/roles\/([\w-]+)$/);
    if (req.method === "GET" && roleOne) {
      // resolveRole 而不是 getRole：id 冲突要给 409 + 原话，不能糊成"角色不存在"
      const r = R.resolveRole(roleOne[1]);
      if (!r.ok) return out(r);
      const cands = R.listRoleCandidates(r.role.id);
      const org = R.roleOrg(r.role);
      // 项目候选跟着主项目走（scope/slug 都由角色推导，客户端给不了任意路径）
      const pc = (r.role.type === "project" && r.role.primaryProject
        ? PM.listProjectCandidates(r.role.primaryProject, r.role.scope)
        : null) as { ok: boolean; candidates?: any[]; msg?: string } | null;
      return json({
        ok: true, role: r.role, candidates: cands.ok ? cands.candidates : [], org,
        projectCandidates: pc?.ok ? pc.candidates : [],
        // 项目目录没了（被删/改名）也如实说，不装作"这个项目没有候选"
        projectCandidatesMsg: pc && !pc.ok ? pc.msg : "",
      });
    }
    const roleUpdate = p.match(/^\/api\/roles\/([\w-]+)\/update$/);
    if (req.method === "POST" && roleUpdate) {
      const b = await body();
      return b ? out(R.updateRole(roleUpdate[1], b)) : json({ ok: false, msg: "请求体不是 JSON" }, 400);
    }
    const roleArchive = p.match(/^\/api\/roles\/([\w-]+)\/archive$/);
    if (req.method === "POST" && roleArchive) {
      const b = await body() as { archived?: unknown } | null;
      // 必须显式给布尔 archived：空 body / 坏 JSON / 字符串 "false" 都不许被当成"归档吧"——
      // 归档是改状态的破坏性动作，猜错方向用户是从列表里少了个角色才发现的
      if (!b || typeof b.archived !== "boolean") {
        return json({ ok: false, msg: "archived 必须显式给 true（归档）或 false（恢复）" }, 400);
      }
      const r = R.archiveRole(roleArchive[1], b.archived);
      return r.ok ? json({ ...r, msg: r.role.status === "archived" ? "已归档" : "已恢复" }) : out(r);
    }
    const roleCands = p.match(/^\/api\/roles\/([\w-]+)\/candidates$/);
    if (req.method === "GET" && roleCands) return out(R.listRoleCandidates(roleCands[1]));
    if (req.method === "POST" && roleCands) {
      const b = await body();
      return b ? out(R.createRoleCandidate(roleCands[1], b)) : json({ ok: false, msg: "请求体不是 JSON" }, 400);
    }
    const candAct = p.match(/^\/api\/roles\/([\w-]+)\/candidates\/([\w-]+)\/(promote|dismiss)$/);
    if (req.method === "POST" && candAct) {
      if (candAct[3] === "dismiss") return out(R.dismissRoleCandidate(candAct[1], candAct[2]));
      const b = await body() as { target?: string } | null;
      return out(R.promoteRoleCandidate(candAct[1], candAct[2], String(b?.target ?? "")));
    }

    // 项目候选：挂在项目专家下面，slug 与 scope 一律由角色推导——
    // 客户端能指定项目 slug 的话，work 角色就能往 private 项目里写候选。
    const expertOf = (id: string) => {
      const r = R.resolveRole(id);
      if (!r.ok) return r;
      if (r.role.type !== "project" || !r.role.primaryProject) {
        return { ok: false as const, code: "invalid" as const, msg: `角色 ${r.role.id} 是职能负责人，没有主项目（项目候选只属于项目专家）` };
      }
      return { ok: true as const, role: r.role };
    };
    const projCands = p.match(/^\/api\/roles\/([\w-]+)\/project-candidates$/);
    if (projCands) {
      const e = expertOf(projCands[1]);
      if (!e.ok) return out(e);
      if (req.method === "GET") return out(PM.listProjectCandidates(e.role.primaryProject, e.role.scope));
      if (req.method === "POST") {
        const b = await body() as { text?: string; evidence?: string; sourceChatId?: string } | null;
        if (!b) return json({ ok: false, msg: "请求体不是 JSON" }, 400);
        return out(PM.createProjectCandidate(e.role.primaryProject, e.role.scope, {
          text: b.text, evidence: b.evidence, sourceChatId: b.sourceChatId, sourceRoleId: e.role.id,
        }));
      }
    }
    const projCandAct = p.match(/^\/api\/roles\/([\w-]+)\/project-candidates\/([\w-]+)\/(promote|dismiss)$/);
    if (req.method === "POST" && projCandAct) {
      const e = expertOf(projCandAct[1]);
      if (!e.ok) return out(e);
      if (projCandAct[3] === "dismiss") return out(PM.dismissProjectCandidate(e.role.primaryProject, e.role.scope, projCandAct[2]));
      const b = await body() as { target?: string } | null;
      return out(PM.promoteProjectCandidate(e.role.primaryProject, e.role.scope, projCandAct[2], String(b?.target ?? "")));
    }
    return json({ ok: false, msg: `未知的角色接口：${req.method} ${p}` }, 404);
  }

  // ---- AI 对话 ----
  // 列表里的 roleId/projectIds 直接来自 chat JSON（旧对话没有这两个键=普通对话）
  if (p === "/api/chat/list") return json(listChats());
  if (p === "/api/chat/messages") {
    const c = getChat(url.searchParams.get("id") || "");
    // binding 是派生信息（角色名/颜色/真正会注入的项目），角色没了标 missing
    return c ? json({ ...c, binding: await chatBinding(c) }) : json({ ok: false, msg: "会话不存在" }, 404);
  }
  if (p === "/api/chat/providers") return json(providers());
  // 附件只读接口：id 白名单在 readChatImage 里（必须出现在这个对话的消息中），
  // 鉴权就是外面这层（localhost Host/Origin 或远程 token），不额外开门
  if (p === "/api/chat/image" && (req.method === "GET" || req.method === "HEAD")) {
    const { readChatImage } = await import("./chat-images.ts");
    const c = getChat(url.searchParams.get("chat_id") || "");
    if (!c) return json({ ok: false, msg: "会话不存在" }, 404);
    const a = readChatImage(c, url.searchParams.get("id") || "");
    if (!a) return json({ ok: false, msg: "图片不存在" }, 404);
    // 内容按 id 不可变 → 可长缓存；nosniff + 私有缓存，别让浏览器把它当别的类型执行
    return new Response(a.bin, { headers: {
      "Content-Type": a.mime,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    } });
  }
  // HEIC 前置转码（与皮肤壁纸同一条实现）：Chromium 解不了 HEIC，前端拿不到预览也编不了 base64
  if (p === "/api/chat/convert-heic" && req.method === "POST") return heicToJpeg(req);
  if (req.method === "POST" && p === "/api/chat/send") {
    // 流式：NDJSON 逐行推送 {type:"delta"|"done"|"error", ...}
    const { MAX_SEND_BODY_BYTES, validateChatImages } = await import("./chat-images.ts");
    // 请求体先看 Content-Length：图片 base64 膨胀 4/3，超限的请求不该被 JSON.parse 拉进内存
    const clen = Number(req.headers.get("content-length") || 0);
    if (clen > MAX_SEND_BODY_BYTES) {
      return json({ ok: false, msg: `请求体太大（${(clen / 1048576).toFixed(1)}MB）：少发几张图或先压缩` }, 413);
    }
    const raw = await readLimitedBody(req, MAX_SEND_BODY_BYTES);
    if (!raw.ok) return json({ ok: false, msg: "请求体太大：少发几张图或先压缩" }, 413);
    let body: {
      chat_id?: string; text?: string; provider?: string; model?: string;
      role_id?: string; project_ids?: string[]; images?: { media_type: string; data: string }[];
    };
    try { body = JSON.parse(raw.bin.toString("utf8")); }
    catch { return json({ ok: false, msg: "请求 JSON 不合法" }, 400); }
    // 图片校验在这里判一次拿干净 4xx（streamChat 内部还会再判一次——那里才是真正落盘的入口）
    const iv = validateChatImages(body.images) as any;
    if (!iv.ok) return json(iv, 400);
    if (!body.text?.trim() && !iv.images.length) return json({ ok: false, msg: "内容为空" }, 400);
    // 绑定先在这里判一次，非法请求拿到干净的 4xx，而不是流里一行 error（streamChat 内部还会再判一次）
    const bind = { roleId: body.role_id, projectIds: body.project_ids };
    const chk = await resolveChatBinding(body.chat_id ? getChat(body.chat_id) : null, bind) as any;
    // 与 /api/roles 同一套映射：跨 scope 同 id 是 409，不是"参数写错了"的 400
    if (!chk.ok) return json(chk, chk.code === "not_found" ? 404 : chk.code === "conflict" ? 409 : 400);
    const gen = streamChat((body.text || "").trim(), body.chat_id, body.provider, body.model, bind, body.images);
    const stream = new ReadableStream({
      async start(ctrl) {
        const enc = new TextEncoder();
        try {
          for await (const ev of gen) ctrl.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        } catch (e) {
          ctrl.enqueue(enc.encode(JSON.stringify({ type: "error", msg: String(e).slice(0, 200) }) + "\n"));
        }
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
  }
  if (req.method === "POST" && p === "/api/chat/rename") {
    const body = await req.json() as { id: string; title: string };
    return json({ ok: renameChat(body.id, body.title), msg: "已重命名" });
  }
  if (req.method === "POST" && p === "/api/chat/delete") {
    const body = await req.json() as { id: string };
    return json({ ok: deleteChat(body.id), msg: "已删除" });
  }
  // assistant 消息 → 候选记忆：只写 _candidates，晋升是角色页上另一次人工点击（别在这里加自动晋升）。
  // target=role（缺省，兼容旧客户端）存进角色；target=project 存进绑定项目专家的主项目。
  if (req.method === "POST" && p === "/api/chat/save-candidate") {
    const body = await req.json().catch(() => null) as { chat_id?: string; index?: number; text?: string; target?: string } | null;
    if (!body?.chat_id) return json({ ok: false, msg: "缺 chat_id" }, 400);
    const r = await saveChatCandidate(body.chat_id, body.index, body.text, body.target) as any;
    return json(r, r.ok ? 200 : r.code === "not_found" ? 404 : r.code === "conflict" ? 409 : 400);
  }

  // ---- 邮件 ----
  if (p === "/api/gmail/accounts") {
    const { gmailAccounts } = await import("./sources/gmail.ts");
    return json(gmailAccounts().map((a) => a.email));
  }
  if (p === "/api/gmail/inbox") {
    try { return json(await gmailInbox(20, url.searchParams.get("account") || "all")); }
    catch (e) { return json({ ok: false, msg: `Gmail 未授权或出错：先跑 bun scripts/gmail-auth.ts（${String(e).slice(0, 120)}）` }, 500); }
  }
  if (p === "/api/gmail/message") {
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false, msg: "缺 id" }, 400);
    try { return json({ ok: true, ...(await gmailMessageDetail(id, url.searchParams.get("account") || undefined)) }); }
    catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }
  if (req.method === "POST" && p === "/api/gmail/reply") {
    const body = await req.json() as { id: string; text: string; account?: string };
    if (!body.id || !body.text) return json({ ok: false, msg: "缺参数" }, 400);
    try {
      await gmailReply(body.id, body.text, body.account);
      log(`workbench: gmail reply sent (${body.id})`);
      return json({ ok: true, msg: "已回复" });
    } catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }

  return null;
}
