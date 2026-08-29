// 目录 → 当前 git 分支：任务列表（/api/tasks、SSE tasks）与会话列表（/api/cc/sessions）的「按分支」分组视图用。
// 每目录结果带短 TTL 缓存（promise 级 single-flight，2.5s 轮询/多客户端并发只起一次 git 进程）；
// 过期先回旧值后台刷新（SWR，同 workbench chatsCache 的姿势）——冷刷新一轮要秒级（几十个目录各起一次 git），
// 不能拖慢 /api/tasks 与派发应答。非 git 目录/解析失败返回 ""，前端归入「无分支」组。
import { run } from "./util.ts";

export const BRANCH_TTL_MS = 30_000;

const cache = new Map<string, { at: number; branch: Promise<string> }>();

function resolveBranch(dir: string): Promise<string> {
  const branch = (async () => {
    try {
      const r = await run(["git", "-C", dir, "branch", "--show-current"], { timeoutMs: 5_000 });
      return r.code === 0 ? r.stdout.trim() : "";   // detached HEAD 也回 ""，与无分支同组
    } catch { return ""; }
  })();
  cache.set(dir, { at: Date.now(), branch });
  return branch;
}

export function currentBranch(dir: string, ttlMs = BRANCH_TTL_MS): Promise<string> {
  if (!dir) return Promise.resolve("");
  const hit = cache.get(dir);
  if (!hit) return resolveBranch(dir);
  if (Date.now() - hit.at >= ttlMs) resolveBranch(dir);   // 过期：后台重解析，本次先回旧值
  return hit.branch;
}

/** 一条 worktree 记录：path=worktree 目录，branch=checkout 的分支名（detached/bare 无分支名不产出），isMain=主 checkout */
export type WorktreeInfo = { path: string; branch: string; isMain: boolean };

const wtCache = new Map<string, { at: number; wts: Promise<WorktreeInfo[]> }>();

function resolveWorktrees(dir: string): Promise<WorktreeInfo[]> {
  const wts = (async () => {
    try {
      const r = await run(["git", "-C", dir, "worktree", "list", "--porcelain"], { timeoutMs: 5_000 });
      if (r.code !== 0) return [] as WorktreeInfo[];
      const out: WorktreeInfo[] = [];
      let path = "", n = 0;   // n=记录序号，porcelain 首条即主 checkout；空行分隔记录
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice(9);
        else if (line.startsWith("branch refs/heads/")) out.push({ path, branch: line.slice(18), isMain: n === 0 });
        if (line === "") n++;   // detached/bare 记录只推进序号，不进分支映射
      }
      return out;
    } catch { return [] as WorktreeInfo[]; }
  })();
  wtCache.set(dir, { at: Date.now(), wts });
  return wts;
}

/** 目录所在仓库全部 worktree 及各自 checkout 的分支（主 checkout 自己的分支也算一个）；同 currentBranch 的 TTL+SWR 单飞缓存 */
export function worktreeBranches(dir: string, ttlMs = BRANCH_TTL_MS): Promise<WorktreeInfo[]> {
  if (!dir) return Promise.resolve([]);
  const hit = wtCache.get(dir);
  if (!hit) return resolveWorktrees(dir);
  if (Date.now() - hit.at >= ttlMs) resolveWorktrees(dir);   // 过期：后台重解析，本次先回旧值
  return hit.wts;
}

/** 给任务/会话行补 branch：cwd 优先（worktree 任务指向 worktree），projectDir 兜底；解析失败保留行上已有 branch 字段 */
export async function withBranches<T extends { cwd?: string; projectDir?: string; branch?: string }>(rows: T[]): Promise<(T & { branch: string })[]> {
  return Promise.all(rows.map(async (r) => {
    const branch = await currentBranch(r.cwd || "") || await currentBranch(r.projectDir || "") || r.branch || "";
    return { ...r, branch };
  }));
}
