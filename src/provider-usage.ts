// 各家订阅额度（Claude 5h/周窗口、Codex 主/次窗口）：会话头部按当前引擎显示一枚徽标，系统页两家都列。
// 数据源都是各家 CLI 自己登录态背后的官方 usage 接口：
//   Claude → claude-usage.ts（OMC statusline 缓存优先，否则 Keychain 里的 OAuth token 直调 api.anthropic.com）
//   Codex  → $CODEX_HOME/auth.json 的 ChatGPT OAuth token 调 chatgpt.com/backend-api/wham/usage
//            （codex exec --json 不上报 rate_limits，只有 app-server 协议才有，所以走接口；TUI 的 /status 画的就是它）
// 窗口统一成 {label, seconds, percent, resetsAt}：Codex 不同套餐窗口不同（Pro 只有周窗口，Plus 有 5h+周），
// 前端只按 label 画，不假设哪家一定有 5h。两家都按 60s 内存缓存；拿不到就 null，UI 隐藏徽标，不算错误。
// token 只在本机用，绝不落日志。
import { readFileSync } from "fs";
import { join } from "path";
import { claudeUsage, type ClaudeUsage } from "./claude-usage.ts";
import { codexHomeDir } from "./codex-catalog.ts";

export interface UsageWindow { label: string; seconds: number; percent: number; resetsAt?: string }
export interface ProviderUsage { windows: UsageWindow[]; plan?: string; fetchedAt: string }
export interface ProvidersUsage { claude: ProviderUsage | null; codex: ProviderUsage | null }
export interface CodexAuth { accessToken: string; accountId?: string }

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** 窗口时长 → 短标签：5h / 周 / N天 / Nh，跟 statusline 的 5h:… wk:… 同一套眼熟写法 */
export function windowLabel(seconds: number): string {
  if (seconds === 604_800) return "周";
  if (seconds % 86_400 === 0 && seconds >= 86_400) return `${seconds / 86_400}天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** 上游给的时间戳格式不一（Anthropic 是 6 位小数 + "+00:00"）：统一成标准 ISO，三端客户端只认一种 */
const iso = (s?: string): string | undefined => { const t = Date.parse(s || ""); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

export function fromClaudeUsage(u: ClaudeUsage | null, now = Date.now()): ProviderUsage | null {
  if (!u || typeof u.fiveHourPercent !== "number") return null;
  const fiveHourResetsAt = iso(u.fiveHourResetsAt), weeklyResetsAt = iso(u.weeklyResetsAt);
  const windows: UsageWindow[] = [{ label: "5h", seconds: 18_000, percent: clamp(u.fiveHourPercent), ...(fiveHourResetsAt ? { resetsAt: fiveHourResetsAt } : {}) }];
  if (typeof u.weeklyPercent === "number") windows.push({ label: "周", seconds: 604_800, percent: clamp(u.weeklyPercent), ...(weeklyResetsAt ? { resetsAt: weeklyResetsAt } : {}) });
  return { windows, fetchedAt: new Date(now).toISOString() };
}

/** wham/usage 响应 → 统一窗口表。只认顶层 rate_limit 的主/次窗口（/status 也只画这两个）；
 *  additional_rate_limits 是按模型另计的（如 Spark），不混进来。 */
export function parseCodexUsage(j: any, now = Date.now()): ProviderUsage | null {
  const win = (w: any): UsageWindow | null => {
    if (!w || typeof w.used_percent !== "number" || typeof w.limit_window_seconds !== "number") return null;
    const resetsAt = typeof w.reset_at === "number" ? new Date(w.reset_at * 1000).toISOString()
      : typeof w.reset_after_seconds === "number" ? new Date(now + w.reset_after_seconds * 1000).toISOString() : undefined;
    return { label: windowLabel(w.limit_window_seconds), seconds: w.limit_window_seconds, percent: clamp(w.used_percent), ...(resetsAt ? { resetsAt } : {}) };
  };
  const windows = [j?.rate_limit?.primary_window, j?.rate_limit?.secondary_window].map(win).filter((w): w is UsageWindow => !!w).sort((a, b) => a.seconds - b.seconds);
  if (!windows.length) return null;
  return { windows, ...(typeof j?.plan_type === "string" && j.plan_type ? { plan: j.plan_type } : {}), fetchedAt: new Date(now).toISOString() };
}

/** Codex 登录态：auth.json 的 tokens.access_token（API key 模式没有窗口额度，返回 null） */
export function readCodexAuth(home = codexHomeDir()): CodexAuth | null {
  try {
    const j = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    const t = j?.tokens?.access_token;
    if (typeof t !== "string" || !t) return null;
    return { accessToken: t, ...(typeof j.tokens.account_id === "string" && j.tokens.account_id ? { accountId: j.tokens.account_id } : {}) };
  } catch { return null; }
}

async function fetchCodexUsageJson(auth: CodexAuth): Promise<unknown> {
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${auth.accessToken}`, ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.json();
}

export interface CodexUsageDeps { readAuth?: () => CodexAuth | null; fetchJson?: (auth: CodexAuth) => Promise<unknown>; now?: () => number }
export async function codexUsage(deps: CodexUsageDeps = {}): Promise<ProviderUsage | null> {
  try {
    const auth = (deps.readAuth ?? readCodexAuth)();
    if (!auth) return null;
    const j = await (deps.fetchJson ?? fetchCodexUsageJson)(auth);
    return j ? parseCodexUsage(j, (deps.now ?? Date.now)()) : null;
  } catch { return null; }
}

const TTL_MS = 60_000;
const cache: Partial<Record<keyof ProvidersUsage, { at: number; data: ProviderUsage | null }>> = {};
const inflight: Partial<Record<keyof ProvidersUsage, Promise<ProviderUsage | null>>> = {};
async function cached(key: keyof ProvidersUsage, load: () => Promise<ProviderUsage | null>): Promise<ProviderUsage | null> {
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  // 头部轮询与系统页可能同时问：同一时刻只打一次接口
  if (!inflight[key]) inflight[key] = load().then((data) => { cache[key] = { at: Date.now(), data }; return data; }).finally(() => { delete inflight[key]; });
  return inflight[key]!;
}

export interface ProvidersUsageDeps { claude?: () => Promise<ProviderUsage | null>; codex?: () => Promise<ProviderUsage | null> }
export async function providersUsage(deps: ProvidersUsageDeps = {}): Promise<ProvidersUsage> {
  const [claude, codex] = await Promise.all([
    cached("claude", deps.claude ?? (async () => fromClaudeUsage(await claudeUsage()))),
    cached("codex", deps.codex ?? (() => codexUsage())),
  ]);
  return { claude, codex };
}
