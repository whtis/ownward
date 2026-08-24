import { readFileSync, mkdirSync, existsSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { canonicalConnectorOverlay } from "./connector-config.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
function runtimeSourceRoot(): string {
  if (process.env.OWNWARD_SOURCE_ROOT) return resolve(expandHome(process.env.OWNWARD_SOURCE_ROOT));
  try { const manifest=JSON.parse(readFileSync(join(ROOT,"release.json"),"utf8"));if(typeof manifest.sourceRoot==="string"&&manifest.sourceRoot)return resolve(manifest.sourceRoot); } catch {}
  return ROOT;
}
export const SOURCE_ROOT = runtimeSourceRoot();
export const CONFIG_ROOT = process.env.OWNWARD_CONFIG_ROOT ? expandHome(process.env.OWNWARD_CONFIG_ROOT) : ROOT;
// 测试/故障演练可把整个运行时数据面隔离到临时目录；生产未设置时仍固定为仓库 data/。
export const DATA = process.env.OWNWARD_DATA_ROOT ? expandHome(process.env.OWNWARD_DATA_ROOT) : join(SOURCE_ROOT, "data");

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** 配置分层：config.default.json（进 git，无个人信息）← config.json（本机，gitignored）覆盖。
 *  递归合并，只合对象；数组和标量整个替换（watchlist 这类语义是「换掉」不是「追加」）。 */
export function mergeDeep(base: any, over: any): any {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])
      ? mergeDeep(base[k], v)
      : v;
  }
  return out;
}

export function loadConfigFiles(defaultFile: string, localFile: string): { config: Record<string, any>; local: Record<string, any> } {
  const def = JSON.parse(readFileSync(defaultFile, "utf8"));
  let local: any = {};
  try {
    local = JSON.parse(readFileSync(localFile, "utf8"));
  } catch (e: any) {
    // 文件不存在 = 还没跑 install.sh，用默认值跑（能起来但只有本地功能）；
    // 存在但 JSON 坏了必须炸，否则用户改错一个逗号会静默回落到默认配置
    if (e?.code !== "ENOENT") throw new Error(`config.json 解析失败：${e.message}`);
  }
  return { config: mergeDeep(def, canonicalConnectorOverlay(local)), local };
}

const loadedConfig = loadConfigFiles(join(ROOT, "config.default.json"), join(CONFIG_ROOT, "config.json"));
export const cfg = loadedConfig.config;
/** 未合并的 config.json，仅用于需要判断本机显式覆盖来源的控制面。 */
export const localCfg = loadedConfig.local;
export const TZ: string = cfg.timezone || "Asia/Shanghai";

export function log(...args: unknown[]) {
  console.log(fmt(new Date(), "datetime"), ...args);
}

// Intl.DateTimeFormat 构造很贵（ICU 初始化），模块级单例——每条日志都要走这里
const dtFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

export function fmt(d: Date, kind: "date" | "time" | "datetime"): string {
  const parts = dtFmt.format(d); // sv-SE → "2026-07-16 14:03:05"
  const [date, time] = parts.split(" ");
  if (kind === "date") return date;
  if (kind === "time") return time.slice(0, 5);
  return `${date} ${time}`;
}

export function inQuietHours(d = new Date()): boolean {
  const t = fmt(d, "time");
  const { start, end } = cfg.quietHours || {};
  if (!start || !end) return false;
  return start > end ? t >= start || t < end : t >= start && t < end;
}

const STATE_FILE = join(DATA, "state.json");

// state.json 在热路径（每个事件的 markHealth、每次 SSE snapshot）被频繁读取——
// 内存缓存 + mtime 校验：命中时零 I/O，跨进程写入（CLI）靠 mtime 变化感知
let stateCache: { data: Record<string, any>; mtimeMs: number } | null = null;

export function loadState(): Record<string, any> {
  try {
    const m = statSync(STATE_FILE).mtimeMs;
    if (stateCache && stateCache.mtimeMs === m) return stateCache.data;
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    stateCache = { data, mtimeMs: m };
    return data;
  } catch {
    return stateCache?.data ?? {};
  }
}

export function saveState(state: Record<string, any>) {
  mkdirSync(DATA, { recursive: true });
  // 原子写（tmp + rename）：避免读端读到半截 JSON
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
  try { stateCache = { data: state, mtimeMs: statSync(STATE_FILE).mtimeMs }; } catch { stateCache = null; }
}

/** 读-改-写收口：进程内走同一个缓存对象，消除 RMW 竞态窗口 */
export function updateState(mut: (s: Record<string, any>) => void) {
  const s = loadState();
  mut(s);
  saveState(s);
}

/** 按字节从文件尾读取，最多 maxBytes——日志类 API 禁止全量读 */
export function tailRead(path: string, maxBytes = 128 * 1024): string {
  const { openSync, readSync, closeSync } = require("fs") as typeof import("fs");
  const size = statSync(path).size;
  const chunk = Math.min(size, maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(chunk);
    readSync(fd, buf, 0, chunk, size - chunk);
    let text = buf.toString("utf8");
    if (chunk < size) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}

/** 记录事件源健康时间戳（dashboard 展示用） */
export function markHealth(source: string) {
  const state = loadState();
  state.health = { ...(state.health || {}), [source]: new Date().toISOString() };
  saveState(state);
}

export interface RunResult { code: number; stdout: string; stderr: string; }

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function run(
  cmd: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string>; input?: string } = {},
): Promise<RunResult> {
  // Windows 从任务计划程序或隐藏进程启动时常没有 HOME；Codex CLI 依赖它定位登录态。
  // 显式补齐与 os.homedir() 一致的值，避免后台 Agent 看起来启动了、实际无法调用模型。
  const inheritedEnv = { ...process.env, HOME: process.env.HOME || homedir() };
  // Bun 在 Windows 直接执行位于含空格路径里的 .cmd/.bat 时会丢失首参数引号。
  // 经 PowerShell 逐参数单引号转义，npm 全局安装的 CLI（如 Codex）才能稳定启动。
  const spawnCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd[0])
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `& ${cmd.map(quoteForPowerShell).join(" ")}`]
    : cmd;
  const proc = Bun.spawn(spawnCmd, {
    cwd: opts.cwd ?? ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.input === undefined ? "ignore" : "pipe",
    env: opts.env ? { ...inheritedEnv, ...opts.env } : inheritedEnv,
  });
  if (opts.input !== undefined) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr };
}

export function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
