// 领域管家在岗状态（Domain Stewards）：把在岗角色摆成今天页的一排头像，一眼看出谁在干活、谁那边要人管。
// 纯派生、不落盘：任务表 + 行动项 + 主目录 git 状态 + 项目工作日志的新鲜度，每次现算。
// 归属只认确定性线索（任务绑的 roleId/项目、行动项 id 段、链接路径段），不让模型猜谁管哪件事。
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { listActions, type Action } from "./actions.ts";
import { loadTasks, type WorkTask } from "./dispatch.ts";
import { projectDir } from "./paths.ts";
import { activeVault, listRoles, type Role } from "./roles.ts";
import { run } from "./util.ts";

export type StewardPresence = "normal" | "attention" | "busy";
export interface StewardInfo {
  id: string;
  name: string;
  icon: string;
  type: "lead" | "project";
  origin?: "auto" | "domain" | "manual";
  primaryProject?: string;
  presence: StewardPresence;
  summary: string;
  runningTaskCount: number;
  openActionCount: number;
  gitDirty?: boolean;
  daysSinceLog?: number;
}

export interface StewardDeps {
  roles?: () => Role[];
  tasks?: () => WorkTask[];
  actions?: () => Action[];
  /** null = 不是仓库/读不到：不算干净也不算脏，摘要里不提 */
  gitStatus?: (dir: string) => Promise<{ changes: number } | null>;
  /** 角色名下项目最近一次工作日志距今几天；没有日志 = undefined */
  daysSinceLog?: (role: Role) => number | undefined;
}

/** 工作日志多久没动算「要人管」——收割每天都在跑，这么久没记录多半是项目被晾着了 */
export const STALE_LOG_DAYS = 5;
const LOG_FILE_RE = /^\d{4}-\d{2}\.md$/;
const DAY_MS = 86_400_000;

async function gitStatus(dir: string): Promise<{ changes: number } | null> {
  const r = await run(["git", "-C", dir, "status", "--porcelain"], { timeoutMs: 5_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  return { changes: r.stdout.split("\n").filter((l) => l.trim()).length };
}

function logAgeDays(role: Role, now = Date.now()): number | undefined {
  const root = activeVault().root;
  let latest = 0;
  for (const slug of new Set([role.primaryProject, ...role.projects].filter(Boolean))) {
    const dir = join(projectDir(slug, role.scope, root), "log");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => LOG_FILE_RE.test(f)); } catch { continue; }
    for (const f of files) {
      try { latest = Math.max(latest, statSync(join(dir, f)).mtimeMs); } catch { /* 刚被挪走 */ }
    }
  }
  return latest ? Math.max(0, Math.floor((now - latest) / DAY_MS)) : undefined;
}

const lower = (s: unknown) => String(s || "").toLowerCase();

/** 角色名下的项目 slug（小写比较：任务的 project 是目录名原样，slug 是小写） */
function projectSet(role: Role): Set<string> {
  return new Set([role.primaryProject, ...role.projects, ...(role.history || [])].filter(Boolean).map(lower));
}

function taskBelongs(t: WorkTask, role: Role, projects: Set<string>): boolean {
  if (t.roleId) return t.roleId === role.id;   // 派发时绑了角色就以它为准，不再按项目二次归属
  return projects.has(lower(t.roleProject || t.project));
}

function actionBelongs(a: Action, role: Role, projects: Set<string>, taskById: Map<string, WorkTask>): boolean {
  const t = a.ref?.task_id ? taskById.get(a.ref.task_id) : undefined;
  if (t) return taskBelongs(t, role, projects);
  const segs = a.id.split(":").map(lower);
  if (segs.includes(role.id) || segs.some((s) => projects.has(s))) return true;
  // GitHub 一类链接：路径段里有仓库名（github.com/<org>/<repo>/pull/1）
  try {
    const path = new URL(a.ref?.url || "").pathname.split("/").map(lower);
    return path.some((s) => projects.has(s));
  } catch { return false; }
}

export function stewardSummary(s: Pick<StewardInfo, "runningTaskCount" | "openActionCount" | "daysSinceLog"> & { changes?: number; gitDirty?: boolean }): string {
  const parts: string[] = [];
  if (s.runningTaskCount) parts.push(`${s.runningTaskCount} 个任务进行中`);
  if (s.openActionCount) parts.push(`${s.openActionCount} 件待办行动`);
  if (s.gitDirty) parts.push(`${s.changes || 1} 个未提交改动`);
  if (s.daysSinceLog !== undefined && s.daysSinceLog > STALE_LOG_DAYS) parts.push(`${s.daysSinceLog} 天没有工作日志`);
  if (parts.length) return parts.join(" · ");
  return s.gitDirty === false ? "代码分支干净 · 暂无阻塞" : "暂无阻塞";
}

const RANK: Record<StewardPresence, number> = { busy: 0, attention: 1, normal: 2 };

export async function listStewards(deps: StewardDeps = {}): Promise<StewardInfo[]> {
  const roles = (deps.roles || listRoles)();
  const tasks = (deps.tasks || loadTasks)();
  const actions = (deps.actions || (() => listActions(false)))();
  const git = deps.gitStatus || gitStatus;
  const logDays = deps.daysSinceLog || ((r: Role) => logAgeDays(r));

  const running = tasks.filter((t) => t.status === "running" && t.kind !== "adopted");
  const open = actions.filter((a) => a.state === "open");
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const out = await Promise.all(roles.filter((r) => r.status === "active").map(async (role): Promise<StewardInfo> => {
    const projects = projectSet(role);
    const runningTaskCount = running.filter((t) => taskBelongs(t, role, projects)).length;
    const openActionCount = open.filter((a) => actionBelongs(a, role, projects, taskById)).length;
    const dir = role.dirs?.[0];
    const g = dir && existsSync(dir) ? await git(dir) : null;
    const gitDirty = g ? g.changes > 0 : undefined;
    const daysSinceLog = logDays(role);
    const presence: StewardPresence = runningTaskCount ? "busy"
      : gitDirty || openActionCount || (daysSinceLog !== undefined && daysSinceLog > STALE_LOG_DAYS) ? "attention" : "normal";
    return {
      id: role.id, name: role.name, icon: role.icon, type: role.type,
      origin: role.origin === "auto" ? "auto" : role.origin === "domain" ? "domain" : "manual",
      ...(role.primaryProject ? { primaryProject: role.primaryProject } : {}),
      presence,
      summary: stewardSummary({ runningTaskCount, openActionCount, daysSinceLog, gitDirty, changes: g?.changes }),
      runningTaskCount, openActionCount,
      ...(gitDirty !== undefined ? { gitDirty } : {}),
      ...(daysSinceLog !== undefined ? { daysSinceLog } : {}),
    };
  }));
  // 稳定排序：同一档内保持 listRoles 的创建顺序，头像不会每分钟乱跳
  return out.map((s, i) => ({ s, i })).sort((a, b) => RANK[a.s.presence] - RANK[b.s.presence] || a.i - b.i).map((x) => x.s);
}
