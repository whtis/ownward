// 项目「删除」= 隐藏项目组，不动磁盘会话/transcript：记下每个被隐藏项目的隐藏时刻，
// 客户端据此过滤——该项目再有比隐藏时刻更新的活动（新任务/新会话）就自动重新出现。
// 同 lark hideReadChats「来新消息会自动回来」的模型。
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir } from "./util.ts";

const FILE = join(DATA, "dismissed-projects.json");
let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = {}; }
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

/** 全部隐藏项目 → 隐藏时刻（epoch ms）。客户端拿去过滤：组内最新活动 <= 隐藏时刻则不显示。 */
export function dismissedProjects(): Record<string, number> {
  return { ...load() };
}

/** 隐藏一个项目（记当前时刻）。 */
export function dismissProject(project: string): void {
  if (!project) return;
  const store = load();
  store[project] = Date.now();
  save();
}

/** 取消隐藏（用户主动恢复）。 */
export function restoreProject(project: string): void {
  const store = load();
  if (project in store) { delete store[project]; save(); }
}
