// macOS 后台定时任务采集：launchd（用户/全局 agents + daemons）+ crontab。
// plist 用 plutil 转 JSON 解析，运行态来自 launchctl list（仅 gui 域可见）。
import { existsSync, readdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { log, run } from "./util.ts";

export interface ScheduleItem {
  label: string;
  scope: "user" | "global" | "daemon" | "system" | "cron";
  schedule: string;      // 人话调度规则
  program: string;
  path: string;
  state: "running" | "loaded" | "unloaded" | "unknown";
  pid?: number;
  lastExit?: number;
  disabled?: boolean;    // launchctl disable 的持久停用态（仅 user 域）
  editable?: boolean;    // 用户自己的 LaunchAgent，允许 run/toggle/改调度
}

const SCAN_DIRS: [string, ScheduleItem["scope"]][] = [
  [join(homedir(), "Library", "LaunchAgents"), "user"],
  ["/Library/LaunchAgents", "global"],
  ["/Library/LaunchDaemons", "daemon"],
];

let cache: { at: number; items: ScheduleItem[] } | null = null;

function humanizeCalendar(c: any): string {
  const wd = ["日", "一", "二", "三", "四", "五", "六"];
  const parts: string[] = [];
  if (c.Weekday !== undefined) parts.push(`每周${wd[c.Weekday] ?? c.Weekday}`);
  else if (c.Day !== undefined) parts.push(`每月 ${c.Day} 日`);
  else parts.push("每天");
  const h = c.Hour !== undefined ? String(c.Hour).padStart(2, "0") : "**";
  const m = c.Minute !== undefined ? String(c.Minute).padStart(2, "0") : "00";
  if (c.Hour !== undefined || c.Minute !== undefined) parts.push(`${h}:${m}`);
  return parts.join(" ");
}

function humanizeSchedule(p: any): string {
  const out: string[] = [];
  if (p.StartCalendarInterval) {
    const arr = Array.isArray(p.StartCalendarInterval) ? p.StartCalendarInterval : [p.StartCalendarInterval];
    out.push(arr.map(humanizeCalendar).join("；"));
  }
  if (p.StartInterval) {
    const s = p.StartInterval;
    out.push(s % 3600 === 0 ? `每 ${s / 3600} 小时` : s % 60 === 0 ? `每 ${s / 60} 分钟` : `每 ${s} 秒`);
  }
  if (p.KeepAlive) out.push("常驻");
  if (p.WatchPaths?.length) out.push("监听文件变化");
  if (!out.length && p.RunAtLoad) out.push("登录时");
  return out.join(" · ") || "按需";
}

async function parsePlist(path: string): Promise<any | null> {
  const r = await run(["plutil", "-convert", "json", "-o", "-", path], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export function clearSchedulesCache() { cache = null; }

const UID = process.getuid?.() ?? 501;
const PROTECTED_SCHEDULE_LABELS = new Set(["ai.ownward.runner"]);
export const isProtectedSchedule = (label: string) => PROTECTED_SCHEDULE_LABELS.has(label);
function assertScheduleNotProtected(label: string) { if (PROTECTED_SCHEDULE_LABELS.has(label)) throw new Error(`受保护的系统任务不可从工作台操作: ${label}`); }

export async function listSchedules(includeSystem = false): Promise<ScheduleItem[]> {
  if (cache && Date.now() - cache.at < 60_000 && !includeSystem) return cache.items;

  // 运行态：label → {pid, lastExit}（gui 域，daemons 看不到属预期）
  const rt = new Map<string, { pid?: number; lastExit?: number }>();
  const lc = await run(["launchctl", "list"], { timeoutMs: 15_000 });
  for (const line of lc.stdout.split("\n").slice(1)) {
    const [pid, status, label] = line.split("\t");
    if (!label) continue;
    rt.set(label.trim(), {
      pid: pid !== "-" ? parseInt(pid, 10) : undefined,
      lastExit: status !== "-" ? parseInt(status, 10) : undefined,
    });
  }

  // 持久停用列表（launchctl disable 过的）
  const disabledSet = new Set<string>();
  const pd = await run(["launchctl", "print-disabled", `gui/${UID}`], { timeoutMs: 15_000 });
  for (const m of pd.stdout.matchAll(/"([^"]+)"\s*=>\s*(?:disabled|true)/g)) {
    disabledSet.add(m[1]);
  }

  const items: ScheduleItem[] = [];
  const dirs = includeSystem
    ? [...SCAN_DIRS, ["/System/Library/LaunchAgents", "system"] as [string, ScheduleItem["scope"]]]
    : SCAN_DIRS;

  for (const [dir, scope] of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".plist"));
    const parsed = await Promise.all(files.map(async (f) => ({ f, p: await parsePlist(join(dir, f)) })));
    for (const { f, p } of parsed) {
      if (!p) continue;
      const label = p.Label || f.replace(/\.plist$/, "");
      const r = rt.get(label);
      items.push({
        label,
        scope,
        schedule: humanizeSchedule(p),
        program: (p.ProgramArguments || [p.Program]).filter(Boolean).join(" ").slice(0, 200),
        path: join(dir, f),
        state: r?.pid ? "running" : r ? "loaded" : scope === "daemon" ? "unknown" : "unloaded",
        pid: r?.pid,
        lastExit: r?.lastExit,
        disabled: scope === "user" ? disabledSet.has(label) : undefined,
        editable: scope === "user" && !isProtectedSchedule(label),
      });
    }
  }

  // crontab
  const cron = await run(["crontab", "-l"], { timeoutMs: 10_000 });
  if (cron.code === 0) {
    for (const line of cron.stdout.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (!m) continue;
      items.push({
        label: m[2].split(/\s+/).slice(0, 2).join(" ").slice(0, 40),
        scope: "cron",
        schedule: m[1],
        program: m[2].slice(0, 200),
        path: "crontab",
        state: "loaded",
      });
    }
  }

  items.sort((a, b) => (a.scope === b.scope ? a.label.localeCompare(b.label) : a.scope.localeCompare(b.scope)));
  if (!includeSystem) cache = { at: Date.now(), items };
  log(`schedules: ${items.length} item(s)`);
  return items;
}

// ---- 控制操作（只允许用户自己的 LaunchAgents） ----

export function assertUserAgent(path: string, baseDir = join(homedir(), "Library", "LaunchAgents")) {
  // 必须 realpath 归一化再比前缀：`..`/symlink 能让 startsWith 通过但实际指向目录外的
  // 任意 plist，launchctl bootstrap 它等于以当前用户执行任意命令
  let resolved: string, base: string;
  try { resolved = realpathSync(resolve(path)); } catch { throw new Error("plist 路径不存在或不可访问"); }
  try { base = realpathSync(baseDir); } catch { base = baseDir; }
  if (!resolved.startsWith(base + "/")) throw new Error("只允许操作 ~/Library/LaunchAgents 下的任务");
}

export async function runScheduleNow(label: string): Promise<void> {
  assertScheduleNotProtected(label);
  const r = await run(["launchctl", "kickstart", "-k", `gui/${UID}/${label}`], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`kickstart 失败: ${r.stderr.slice(0, 150)}`);
  clearSchedulesCache();
}

export async function toggleSchedule(label: string, path: string, enable: boolean): Promise<void> {
  assertScheduleNotProtected(label);
  // 只在 enable 分支校验 path：bootstrap 会加载它（任意 plist=任意命令执行）；
  // disable 只按 label 操作不碰文件——plist 已被手动删除的任务也要能停用
  if (enable) {
    assertUserAgent(path);
    await run(["launchctl", "enable", `gui/${UID}/${label}`], { timeoutMs: 15_000 });
    const r = await run(["launchctl", "bootstrap", `gui/${UID}`, path], { timeoutMs: 15_000 });
    // 已加载时 bootstrap 报错可忽略
    if (r.code !== 0 && !/already/i.test(r.stderr)) log(`schedule enable bootstrap: ${r.stderr.slice(0, 120)}`);
  } else {
    await run(["launchctl", "bootout", `gui/${UID}/${label}`], { timeoutMs: 15_000 });
    await run(["launchctl", "disable", `gui/${UID}/${label}`], { timeoutMs: 15_000 });
  }
  clearSchedulesCache();
}

export interface ScheduleSpec {
  mode: "interval" | "daily" | "weekly";
  minutes?: number;   // interval
  hour?: number;      // daily / weekly
  minute?: number;
  weekday?: number;   // 0-6，weekly
}

/** 改调度：PlistBuddy 重写 StartInterval / StartCalendarInterval，然后重载 */
export async function updateSchedule(label: string, path: string, spec: ScheduleSpec): Promise<void> {
  assertScheduleNotProtected(label);
  assertUserAgent(path);
  const pb = "/usr/libexec/PlistBuddy";
  const cmds: string[] = ["Delete :StartInterval", "Delete :StartCalendarInterval"];
  if (spec.mode === "interval") {
    // 值直接插进 PlistBuddy 命令串，先做数值域校验，别让 HTTP body 里的任意内容进 plist
    if (!Number.isFinite(spec.minutes) || spec.minutes! < 1 || spec.minutes! > 527_040) throw new Error("间隔分钟数无效");
    cmds.push(`Add :StartInterval integer ${Math.round(spec.minutes! * 60)}`);
  } else {
    const h = spec.hour ?? 9, m = spec.minute ?? 0;
    if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) throw new Error("时间无效");
    cmds.push("Add :StartCalendarInterval dict");
    cmds.push(`Add :StartCalendarInterval:Hour integer ${h}`);
    cmds.push(`Add :StartCalendarInterval:Minute integer ${m}`);
    if (spec.mode === "weekly") {
      const w = spec.weekday ?? 1;
      if (!Number.isInteger(w) || w < 0 || w > 6) throw new Error("星期无效");
      cmds.push(`Add :StartCalendarInterval:Weekday integer ${w}`);
    }
  }
  for (const c of cmds) {
    const r = await run([pb, "-c", c, path], { timeoutMs: 10_000 });
    // Delete 不存在的键会报错，忽略
    if (r.code !== 0 && !c.startsWith("Delete")) throw new Error(`plist 修改失败 (${c}): ${r.stderr.slice(0, 120)}`);
  }
  // 重载生效
  await run(["launchctl", "bootout", `gui/${UID}/${label}`], { timeoutMs: 15_000 });
  const r = await run(["launchctl", "bootstrap", `gui/${UID}`, path], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`重载失败: ${r.stderr.slice(0, 150)}`);
  clearSchedulesCache();
  log(`schedule updated: ${label} → ${JSON.stringify(spec)}`);
}
