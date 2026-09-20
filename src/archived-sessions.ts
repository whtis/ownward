// 会话「归档」= 从最近会话列表隐藏，不动磁盘上的任何东西（任务记录、transcript、派生索引全留）：
// 只记下每个被归档任务的归档时刻，列表据此过滤——该会话再有比归档时刻更新的活动就自动重新出现。
// 与 dismissed-projects 的「删除项目」同一个模型：失败/结束的会话是终态，不会自己跑回来；
// 归档后又在里面追问的，下一轮 lastAt 就超过归档时刻，列表自动把它捞回来，不会让人以为会话丢了。
import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir } from "./util.ts";

const FILE = join(DATA, "archived-sessions.json");
// 缓存按文件 mtime 失效（同 dismissed-projects.ts）：worktree 清理会从 CLI 进程写这份文件
let cache: Record<string, number> | null = null, cacheMtime = -1;

function load(): Record<string, number> {
  let mtime = 0;
  try { mtime = statSync(FILE).mtimeMs; } catch { /* 还没有文件 */ }
  if (!cache || mtime !== cacheMtime) {
    try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = {}; }
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
    cacheMtime = mtime;
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  writeFileSync(FILE, JSON.stringify(cache, null, 2));
  try { cacheMtime = statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
}

/** 全部已归档任务 id → 归档时刻（epoch ms）。 */
export function archivedSessions(): Record<string, number> {
  return { ...load() };
}

/** 归档一个任务（记当前时刻）。已归档的重复调用会刷新时刻——等于「再压一次」。 */
export function archiveSession(taskId: string, at = Date.now()): void {
  if (!taskId) return;
  load()[taskId] = at;
  save();
}

/** 取消归档（用户主动恢复）。 */
export function restoreSession(taskId: string): void {
  const store = load();
  if (taskId in store) { delete store[taskId]; save(); }
}

/** 列表过滤判据：归档之后没有更新活动的才算「仍被归档」。 */
export function isArchived(taskId: string, lastAt: number): boolean {
  const at = load()[taskId];
  return at !== undefined && lastAt <= at;
}
