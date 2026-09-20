// Worktree 清理：bg 编码任务默认在 dispatch.worktreeRoot 下开隔离 worktree，任务结束后
// 除非人手动点「清 worktree」，目录就一直留着。实测积到 21 个 / 3.9G——绝大部分的活早就
// 合进去了，占的全是 node_modules 和构建产物。
//
// 这里只做两件事：把「现在有哪些 worktree、删了会不会丢东西」讲清楚，以及按这个判断批量删。
//
// 判断口径（重要）：`git worktree remove` **不删分支**，所以已提交的东西删目录不会丢。
// 真正会丢的只有两类：未提交改动（tracked 改动 + 未跟踪文件），以及被 .gitignore 忽略的
// 本地文件（node_modules、构建产物、dev 用的 config.json）。前者是硬闸，后者在界面上说清楚。
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { join, resolve } from "path";
import { isStrictlyWithin } from "./path-within.ts";
import { ROOT, SOURCE_ROOT, cfg, expandHome, log, run } from "./util.ts";
import { loadTasks } from "./dispatch.ts";

export type WorktreeState =
  | "busy"      // 还有任务在跑，别动
  | "dirty"     // 有未提交改动，删了就丢
  | "unmerged"  // 干净，但分支上有主检出和远端都没有的提交（删目录不丢提交，只是活还没落地）
  | "clean"     // 干净且已落地：删了什么都不丢
  | "orphan";   // 不是任何仓库注册的 worktree（手删过主仓 / 复制出来的目录）

export interface WorktreeEntry {
  name: string;
  path: string;
  projectDir: string;      // 主检出（从 .git 指针解析），orphan 时为空
  branch: string;
  dirty: number;
  unmergedCommits: number;
  sizeKb: number;
  lastActiveAt: number;    // epoch ms
  tasks: { id: string; title: string; status: string }[];
  state: WorktreeState;
  removable: boolean;      // 不 force 也能删
  reason: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 任务表里的 cwd 与这里算出来的路径可能一个走符号链接、一个已 realpath（macOS 的
 *  /var → /private/var 就是），逐字比会漏掉「还在跑」这条硬闸。两边都归一化再比。 */
const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
function tasksIn(path: string) {
  const target = canonical(path);
  return loadTasks().filter((t) => t.cwd && canonical(t.cwd) === target);
}

export function worktreeRoot(): string {
  return resolve(expandHome(String(cfg.dispatch?.worktreeRoot || "~/.ownward-worktrees")));
}

/** 解析 worktree 里的 `.git` 指针文件 → 主检出目录。不是 worktree 返回空串。 */
function projectDirOf(path: string): string {
  const pointer = join(path, ".git");
  try {
    if (statSync(pointer).isDirectory()) return path;   // 独立仓库，不是 worktree
    const gitdir = readFileSync(pointer, "utf8").trim().replace(/^gitdir:\s*/, "");
    const at = gitdir.indexOf("/.git/worktrees/");
    return at > 0 ? gitdir.slice(0, at) : "";
  } catch { return ""; }
}

async function dirSizeKb(path: string): Promise<number> {
  // du 比递归 readdir 快一个量级；超时就报 0（大小只是展示，不参与安全判断）
  const r = await run(["du", "-sk", path], { timeoutMs: 20_000 });
  return r.code === 0 ? parseInt(r.stdout.trim().split(/\s+/)[0] || "0", 10) || 0 : 0;
}

/** 目录最近动过的时间：取自身 mtime 与一层子项 mtime 的最大值（顶层 mtime 只反映增删文件） */
function lastActive(path: string): number {
  let newest = 0;
  try { newest = statSync(path).mtimeMs; } catch { return 0; }
  try {
    for (const entry of readdirSync(path)) {
      try { newest = Math.max(newest, statSync(join(path, entry)).mtimeMs); } catch { /* 符号链接/权限：跳过 */ }
    }
  } catch { /* 读不了就用顶层 mtime */ }
  return newest;
}

/** 清单：worktreeRoot 下每个目录一行，带状态判断。withSize=false 时跳过 du（快路径）。 */
export async function listWorktrees(opts: { withSize?: boolean } = {}): Promise<{ root: string; entries: WorktreeEntry[]; totalKb: number }> {
  const root = worktreeRoot();
  let names: string[] = [];
  try { names = readdirSync(root).filter((n) => !n.startsWith(".")); } catch { return { root, entries: [], totalKb: 0 }; }
  const entries = await Promise.all(names.map(async (name): Promise<WorktreeEntry | null> => {
    const path = join(root, name);
    try { if (!statSync(path).isDirectory()) return null; } catch { return null; }
    const projectDir = projectDirOf(path);
    const linked = tasksIn(path).map((t) => ({ id: t.id, title: t.title || String(t.task || "").split("\n")[0].slice(0, 60), status: t.status }));
    const g = (args: string[]) => run(["git", "-C", path, ...args], { timeoutMs: 15_000 });
    const [statusR, branchR, headR] = projectDir
      ? await Promise.all([g(["status", "--porcelain"]), g(["branch", "--show-current"]), g(["rev-parse", "HEAD"])])
      : [null, null, null];
    const dirty = statusR?.code === 0 ? statusR.stdout.split("\n").filter(Boolean).length : 0;
    const branch = branchR?.stdout.trim() || "";
    let unmergedCommits = 0;
    if (projectDir && headR?.code === 0) {
      // 主检出 HEAD 和所有远端引用都够不着的提交 = 「这个分支的活还没落地」。
      // 删目录不会丢它们（分支还在），但值得提醒一句，默认也不进批量清理。
      const r = await run(["git", "-C", projectDir, "rev-list", "--count", headR.stdout.trim(), "--not", "HEAD", "--remotes"], { timeoutMs: 20_000 });
      if (r.code === 0) unmergedCommits = parseInt(r.stdout.trim(), 10) || 0;
    }
    const busy = linked.some((t) => t.status === "running");
    const state: WorktreeState = busy ? "busy" : !projectDir ? "orphan" : dirty ? "dirty" : unmergedCommits ? "unmerged" : "clean";
    const reason = busy ? "有任务在跑"
      : state === "dirty" ? `${dirty} 个未提交改动`
      : state === "orphan" ? "不是注册的 worktree（只能整目录删）"
      : state === "unmerged" ? `${unmergedCommits} 个提交还没合进主检出或远端（分支保留，目录可删）`
      : "已落地，删了不丢东西";
    return {
      name, path, projectDir, branch, dirty, unmergedCommits,
      sizeKb: opts.withSize === false ? 0 : await dirSizeKb(path),
      lastActiveAt: lastActive(path), tasks: linked, state,
      // orphan 没有 git 给它兜底（没法判断里面有没有没落地的东西），跟 dirty 一样要明确强制
      removable: state === "clean" || state === "unmerged", reason,
    };
  }));
  const list = entries.filter((e): e is WorktreeEntry => !!e)
    .sort((a, b) => b.sizeKb - a.sizeKb || b.lastActiveAt - a.lastActiveAt);
  return { root, entries: list, totalKb: list.reduce((sum, e) => sum + e.sizeKb, 0) };
}

/** 删除前的硬闸：名字必须是 worktreeRoot 正下方的一层目录，且 realpath 后仍严格在根内。 */
function resolveTarget(name: string): { root: string; path: string } {
  if (!NAME_RE.test(name)) throw new Error("worktree 名非法");
  const root = realpathSync(worktreeRoot()), path = join(root, name);
  if (!existsSync(path)) throw new Error("目录不存在");
  const actual = realpathSync(path);
  if (!isStrictlyWithin(root, actual)) throw new Error("目标不在 worktreeRoot 内，拒绝删除");
  // 理论上前一条就挡住了；daemon 万一自己跑在 worktreeRoot 里时这条是最后一道保险
  const selves = [ROOT, SOURCE_ROOT].map((p) => { try { return realpathSync(p); } catch { return ""; } });
  if (selves.includes(actual)) throw new Error("这是当前运行中的 Ownward 目录，拒绝删除");
  return { root, path: actual };
}

export interface RemoveResult { name: string; ok: boolean; msg: string; freedKb: number; branchDeleted?: string }

/** dispatch 自建的分支名（dispatch.ts 里 `ownward/<日期>-<id>`）。落地后它没有第二个用途，
 *  跟目录一起收掉；其它名字的分支是人起的，留给人处理——删目录本来就不删分支。 */
const AUTO_BRANCH_RE = /^ownward\//;

/** 删一个 worktree。force 才允许删有未提交改动的；有任务在跑永远拒绝。
 *  自建分支且已落地（主检出或远端都够得着它的每个提交）时顺手删分支，keepBranch 可关。 */
export async function removeWorktree(name: string, opts: { force?: boolean; keepBranch?: boolean } = {}): Promise<RemoveResult> {
  const { path } = resolveTarget(name);
  const linkedTasks = tasksIn(path);
  const running = linkedTasks.filter((t) => t.status === "running");
  if (running.length) return { name, ok: false, msg: `还有任务在跑（${running.map((t) => t.id).join(", ")}）`, freedKb: 0 };
  const projectDir = projectDirOf(path);
  let branch = "";
  if (projectDir) {
    const b = await run(["git", "-C", path, "branch", "--show-current"], { timeoutMs: 15_000 });
    branch = b.code === 0 ? b.stdout.trim() : "";
    if (!opts.force) {
      const dirty = await run(["git", "-C", path, "status", "--porcelain"], { timeoutMs: 15_000 });
      if (dirty.stdout.trim()) return { name, ok: false, msg: "有未提交改动，先 commit 或明确强制清理", freedKb: 0 };
    }
  }
  const freedKb = await dirSizeKb(path);
  let branchDeleted = "";
  if (projectDir) {
    const r = await run(["git", "-C", projectDir, "worktree", "remove", ...(opts.force ? ["--force"] : []), path], { timeoutMs: 60_000 });
    if (r.code !== 0) return { name, ok: false, msg: r.stderr.trim().slice(0, 200) || "git worktree remove 失败", freedKb: 0 };
    await run(["git", "-C", projectDir, "worktree", "prune"], { timeoutMs: 30_000 });
    if (branch && AUTO_BRANCH_RE.test(branch) && !opts.keepBranch) {
      // 目录已经没了，分支还有没有别处没有的提交？一个都没有才删——删了也丢不了东西
      const pending = await run(["git", "-C", projectDir, "rev-list", "--count", branch, "--not", "HEAD", "--remotes"], { timeoutMs: 20_000 });
      if (pending.code === 0 && parseInt(pending.stdout.trim(), 10) === 0) {
        const d = await run(["git", "-C", projectDir, "branch", "-D", branch], { timeoutMs: 15_000 });
        if (d.code === 0) branchDeleted = branch;
      }
    }
  } else {
    // 没有主检出可依赖（orphan）：git 判断不了里面有没有没落地的东西，只有明确强制才整目录删。
    // resolveTarget 已经保证它在 worktreeRoot 之内。
    if (!opts.force) return { name, ok: false, msg: "不是注册的 worktree，看清内容后明确强制清理", freedKb: 0 };
    rmSync(path, { recursive: true, force: true });
  }
  // 目录没了，工作台里以它为组的会话不可能再有新活动：把这个组收起来、把里面跑过的任务归档。
  // 两者都只是从列表隐藏，会话记录与 transcript 一字不动（见 dismissed-projects.ts / archived-sessions.ts）。
  try {
    const { dismissProject } = await import("./dismissed-projects.ts");
    dismissProject(name);
    const { archiveSession } = await import("./archived-sessions.ts");
    for (const t of linkedTasks) archiveSession(t.id);
  } catch (e) { log(`worktree removed but hide-from-list failed: ${e instanceof Error ? e.message : e}`); }
  log(`worktree removed: ${name} (${Math.round(freedKb / 1024)}MB)${branchDeleted ? ` + branch ${branchDeleted}` : ""}`);
  return { name, ok: true, msg: branchDeleted ? `已清理（分支 ${branchDeleted} 已落地，一并删除）` : "已清理", freedKb, ...(branchDeleted ? { branchDeleted } : {}) };
}

export interface CleanupOptions {
  names?: string[];          // 指定要删的；不给就按 states 筛
  states?: WorktreeState[];  // 默认只删 clean
  olderThanDays?: number;    // 只删这么久没动过的
  force?: boolean;
  keepBranch?: boolean;      // 自建分支落地后默认一并删，这里可关
  now?: number;
}

export interface CleanupResult {
  results: RemoveResult[];
  freedKb: number;
  /** 这轮没碰的目录按状态计数——定时清理时写进日志，让「还有几个活没落地」有人看见 */
  skipped: Partial<Record<WorktreeState, number>>;
}

/** 批量清理。默认口径最保守：只删 clean 的。 */
export async function cleanupWorktrees(opts: CleanupOptions = {}): Promise<CleanupResult> {
  const { entries } = await listWorktrees({ withSize: false });
  const states = new Set<WorktreeState>(opts.states ?? ["clean"]);
  const cutoff = opts.olderThanDays ? (opts.now ?? Date.now()) - opts.olderThanDays * 86_400_000 : Infinity;
  // 点名删时不看年龄，但显式给了 states 就照样过滤——两个条件都给的调用方要的是交集，不是 names 悄悄赢
  const targets = opts.names?.length
    ? entries.filter((e) => opts.names!.includes(e.name) && (!opts.states || states.has(e.state)))
    : entries.filter((e) => states.has(e.state) && e.lastActiveAt < cutoff);
  const results: RemoveResult[] = [];
  for (const entry of targets) {
    try { results.push(await removeWorktree(entry.name, { force: opts.force, keepBranch: opts.keepBranch })); }
    catch (e) { results.push({ name: entry.name, ok: false, msg: e instanceof Error ? e.message : String(e), freedKb: 0 }); }
  }
  const picked = new Set(targets.map((e) => e.name));
  const skipped: CleanupResult["skipped"] = {};
  for (const e of entries) if (!picked.has(e.name)) skipped[e.state] = (skipped[e.state] ?? 0) + 1;
  return { results, freedKb: results.filter((r) => r.ok).reduce((sum, r) => sum + r.freedKb, 0), skipped };
}

export function worktreeRetentionDays(): number {
  const raw = Number(cfg.dispatch?.worktreeRetentionDays ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** 定时清理（config `dispatch.worktreeRetentionDays` > 0 才开）：只删 clean 且超期的。
 *  dirty / unmerged / busy 一律不动，只在返回值里计数——它们是「活还没落地」，不是垃圾。 */
export async function sweepWorktrees(now = Date.now()): Promise<CleanupResult> {
  const days = worktreeRetentionDays();
  if (!days) return { results: [], freedKb: 0, skipped: {} };
  return cleanupWorktrees({ states: ["clean"], olderThanDays: days, now });
}
