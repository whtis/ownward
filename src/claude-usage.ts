// Claude 订阅额度（5h / 周窗口利用率）：优先读 OMC statusline 的缓存文件（用户开着 TUI 时
// 它每分钟刷新，白捡且不重复打 API）；过期（>15min，比如 TUI 没开）就自己拿 Keychain 里的
// Claude Code OAuth token 调官方 usage 接口兜底。
// 注意：launchd 里的 daemon 首次读 Keychain 可能被 ACL 拦（无人点允许）——失败就静默返回 null，
// UI 隐藏额度徽标即可，不算错误。内存缓存 60s。
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { run } from "./util.ts";

export interface ClaudeUsage {
  fiveHourPercent: number;
  weeklyPercent?: number;
  fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
}

let cache: { at: number; data: ClaudeUsage | null } | null = null;

export async function claudeUsage(): Promise<ClaudeUsage | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  const data = readOmcCache() ?? (await fetchFromApi());
  cache = { at: Date.now(), data };
  return data;
}

/** OMC statusline 的额度缓存（.usage-cache-anthropic.json），15 分钟内算新鲜 */
function readOmcCache(): ClaudeUsage | null {
  try {
    const p = join(homedir(), ".claude", "plugins", "oh-my-claudecode", ".usage-cache-anthropic.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (typeof j?.data?.fiveHourPercent !== "number") return null;
    if (Date.now() - (j.timestamp || 0) > 15 * 60_000) return null;
    return {
      fiveHourPercent: j.data.fiveHourPercent,
      weeklyPercent: j.data.weeklyPercent,
      fiveHourResetsAt: j.data.fiveHourResetsAt,
      weeklyResetsAt: j.data.weeklyResetsAt,
    };
  } catch { return null; }
}

/** 直调 api.anthropic.com/api/oauth/usage（与 OMC 同源做法；token 只在本机使用） */
async function fetchFromApi(): Promise<ClaudeUsage | null> {
  try {
    const r = await run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeoutMs: 10_000 });
    if (r.code !== 0) return null;
    const token = JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken;
    if (!token) return null;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const pct = (x: any) => (typeof x?.utilization === "number" ? Math.round(x.utilization) : undefined);
    const fh = pct(j.five_hour);
    if (fh === undefined) return null;
    return {
      fiveHourPercent: fh,
      weeklyPercent: pct(j.seven_day),
      fiveHourResetsAt: j.five_hour?.resets_at,
      weeklyResetsAt: j.seven_day?.resets_at,
    };
  } catch { return null; }
}
