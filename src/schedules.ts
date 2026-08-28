// macOS 后台定时任务采集：launchd（用户/全局 agents + daemons）+ crontab。
// plist 用 plutil 转 JSON 解析，运行态来自 launchctl list（仅 gui 域可见）。
import { existsSync, readdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { log, run, SOURCE_ROOT } from "./util.ts";

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
  // ── 归属与人话呈现（系统状态收敛用）──
  owner?: "ownward";                              // 由 ownward 安装/管理，否则视为外部
  group?: "core" | "connection";                 // core=核心组件；connection=连接与维护
  role?: string;                                  // 人话名称
  purpose?: string;                               // 一句话用途
  health?: ScheduleHealth;                        // 收敛后的健康结论
}

export type HealthLevel = "ok" | "attention" | "down" | "paused" | "unknown";
export interface ScheduleHealth {
  level: HealthLevel;
  label: string;        // 状态词：正常/需要处理/已暂停/不可用/未知
  reason?: string;      // 结论下的原因（人话，已翻译退出码）
  hint?: string;        // 下一步提示
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

// ── 归属登记：ownward 自己安装/管理的 launchd 任务白名单 ──
// 只显示这些 + ai.ownward.* 前缀 + 程序指向 ownward 源码根的任务；其余（第三方/用户别的项目/系统服务）默认隐身。
// 绝不再枚举全机 launchd 服务当健康清单（见 listSchedules 的 ownward 过滤）。
const OWNWARD_REGISTRY: Record<string, { group: "core" | "connection"; role: string; purpose: string }> = {
  "ai.ownward.daemon": { group: "core", role: "主守护", purpose: "事件处理与工作台" },
  "ai.ownward.runner": { group: "core", role: "任务执行器", purpose: "运行 agent 会话" },
  "com.cloudflare.cloudflared.ownward": { group: "connection", role: "外网隧道", purpose: "手机 / 远程访问工作台" },
};

/** 判定并标注归属：返回 ownward 登记信息，非 ownward 返回 null（不进健康清单）。 */
export function classifyOwnwardSchedule(item: Pick<ScheduleItem, "label" | "program">): { group: "core" | "connection"; role: string; purpose: string } | null {
  const reg = OWNWARD_REGISTRY[item.label];
  if (reg) return reg;
  if (item.label.startsWith("ai.ownward.")) {
    const tail = item.label.split(".").slice(2).join(".") || item.label;
    return { group: "core", role: tail, purpose: "ownward 组件" };
  }
  // 兜底：程序/工作目录指向 ownward 源码根（覆盖 label 漂移的情况）
  if (SOURCE_ROOT && SOURCE_ROOT.length > 3 && item.program.includes(SOURCE_ROOT)) {
    return { group: "core", role: item.label.split(".").pop() || item.label, purpose: "ownward 组件" };
  }
  return null;
}

/** 退出码翻译：把 launchd 的裸退出码变成「人话原因 + 下一步」。 */
export function explainExit(code: number): { reason: string; hint: string } {
  const T: Record<number, { reason: string; hint: string }> = {
    127: { reason: "找不到要执行的命令或路径（错误 127）", hint: "常见原因：bun/git 路径变化、脚本被移动或依赖未安装" },
    126: { reason: "命令没有执行权限（错误 126）", hint: "检查脚本的可执行权限（chmod +x）" },
    2: { reason: "命令用法或参数有误（错误 2）", hint: "查看日志确认脚本报错" },
    1: { reason: "命令执行时报错（错误 1）", hint: "查看日志了解具体报错" },
  };
  return T[code] || { reason: `上次异常退出（退出码 ${code}）`, hint: "查看日志了解详情" };
}

/** 收敛健康结论：核心组件要求常驻 running；连接/维护类是一次性任务，非 running 也算就绪。 */
export function scheduleHealth(item: ScheduleItem): ScheduleHealth {
  if (item.disabled) return { level: "paused", label: "已暂停", hint: "已停用，不会自动运行" };
  const failed = item.lastExit !== undefined && item.lastExit !== 0;
  if (item.group === "core") {
    if (item.state === "running") return { level: "ok", label: "正常运行" };
    if (failed) { const e = explainExit(item.lastExit!); return { level: "down", label: "不可用", reason: e.reason, hint: e.hint }; }
    return { level: "down", label: "未运行", reason: "核心组件当前未在运行", hint: "尝试重启该组件" };
  }
  // connection / 维护类（一次性运行后退出属正常）
  if (failed) { const e = explainExit(item.lastExit!); return { level: "attention", label: "需要处理", reason: e.reason, hint: e.hint }; }
  if (item.state === "running") return { level: "ok", label: "运行中" };
  return { level: "ok", label: "已就绪" };
}

/** all=false（默认）只返回 ownward 自己管理的任务（核心/连接），供收敛后的系统状态用；
 *  all=true 返回全机任务，仅供「高级诊断 > 未纳管服务」只读查看。 */
const filterOwn = (items: ScheduleItem[], all: boolean) => (all ? items : items.filter((i) => i.owner === "ownward"));

export async function listSchedules(includeSystem = false, all = false): Promise<ScheduleItem[]> {
  if (cache && Date.now() - cache.at < 60_000 && !includeSystem) return filterOwn(cache.items, all);

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
      const item: ScheduleItem = {
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
      };
      const reg = classifyOwnwardSchedule(item);
      if (reg) { item.owner = "ownward"; item.group = reg.group; item.role = reg.role; item.purpose = reg.purpose; item.health = scheduleHealth(item); }
      items.push(item);
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
  const owned = items.filter((i) => i.owner === "ownward").length;
  log(`schedules: ${items.length} item(s), ${owned} ownward`);
  return filterOwn(items, all);
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
