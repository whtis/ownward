// 决策引擎封装：一次推理 → 严格 JSON。
// engine=claude（默认）：claude -p，吃 Claude 订阅；engine=codex：codex exec，吃 ChatGPT 订阅。
// 规则上下文（prompts/）通过 system prompt 显式注入，不依赖 CLI 的文件发现：
//   prompts/owner.md（gitignored，install.sh 生成的个人画像）+ prompts/decision-rules.md（通用规则）。
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { notify } from "./notify.ts";
import { CONFIG_ROOT, ROOT, cfg, log, run, updateState } from "./util.ts";

type LlmEngine = "claude" | "codex";
interface ProviderResult { value: any | null; error?: string }
const FAILOVER_NOTICE_COOLDOWN_MS = 6 * 3600_000;

export function isFailoverEligible(error: string): boolean {
  return /(quota|usage limit|hit (?:your )?(?:weekly )?limit|reached (?:your )?(?:weekly )?limit|rate.?limit|too many requests|authentication|unauthorized|not logged in|(?:run|use) \/login|login required|overload|unavailable|capacity|timed? out|command not found|\b(?:401|429|529)\b)/i.test(error);
}

export function safeProviderReason(error: string): string {
  if (/(quota|usage limit|hit (?:your )?(?:weekly )?limit|reached (?:your )?(?:weekly )?limit)/i.test(error)) return "额度已耗尽";
  if (/(rate.?limit|too many requests|\b429\b)/i.test(error)) return "请求频率受限";
  if (/(authentication|unauthorized|not logged in|(?:run|use) \/login|login required|\b401\b)/i.test(error)) return "登录认证失效";
  if (/(timed? out)/i.test(error)) return "请求超时";
  if (/(command not found)/i.test(error)) return "命令不可用";
  return "服务暂不可用";
}

export function shouldNotifyFailover(previous: any, now: number, cooldownMs = FAILOVER_NOTICE_COOLDOWN_MS): boolean {
  const last = Date.parse(previous?.lastNotifiedAt || "");
  return !Number.isFinite(last) || now - last >= cooldownMs;
}

export async function reportFailover(state: "fallback" | "failed", primary: LlmEngine, fallback: LlmEngine, rawError: string, deps: {
  update?: typeof updateState; send?: typeof notify; now?: () => number; cooldownMs?: number;
} = {}) {
  const update = deps.update || updateState, send = deps.send || notify, now = deps.now?.() ?? Date.now();
  const detail = safeProviderReason(rawError);
  let shouldNotify = false;
  try {
    update((s) => {
      shouldNotify = shouldNotifyFailover({ lastNotifiedAt: s.llmFailoverLastNotifiedAt }, now, deps.cooldownMs);
      if (shouldNotify) s.llmFailoverLastNotifiedAt = new Date(now).toISOString();
      s.llmFailoverNotice = {
        state, primary, fallback, detail, at: new Date(now).toISOString(),
      };
    });
  } catch (e) { log(`llm failover state unavailable: ${e}`); shouldNotify = true; }
  if (!shouldNotify) return;
  const text = state === "fallback"
    ? `⚠️ 后台 AI 已自动从 ${primary} 切换到 ${fallback}\n原因：${detail}`
    : `🚨 后台 AI 摘要不可用：${primary} 与 ${fallback} 均失败\n待收尾任务会自动退避重试，不会丢失。`;
  try { await send(text, { source: "system" }); } catch (e) { log(`llm failover notification unavailable: ${e}`); }
}

function clearFailoverNotice() {
  try { updateState((s) => { delete s.llmFailoverNotice; }); }
  catch (e) { log(`llm failover recovery state unavailable: ${e}`); }
}

export async function runWithFailover(
  primary: LlmEngine,
  fallback: LlmEngine | null,
  invoke: (engine: LlmEngine) => Promise<ProviderResult>,
  report = reportFailover,
  clear = clearFailoverNotice,
): Promise<any | null> {
  const first = await invoke(primary);
  if (first.value !== null) {
    try { clear(); } catch (e) { log(`llm failover recovery observer failed: ${e}`); }
    return first.value;
  }
  if (!fallback || !isFailoverEligible(first.error || "")) return null;
  const second = await invoke(fallback);
  try { await report(second.value !== null ? "fallback" : "failed", primary, fallback, first.error || "unknown provider failure"); }
  catch (e) { log(`llm failover observer failed: ${e}`); }
  return second.value;
}

const rules = () => {
  let owner = "";
  try { owner = readFileSync(join(CONFIG_ROOT, "prompts", "owner.md"), "utf8").trim(); } catch { /* 没配就纯规则 */ }
  const base = readFileSync(join(ROOT, "prompts", "decision-rules.md"), "utf8");
  return owner ? `${owner}\n\n${base}` : base;
};

export async function llmJson(prompt: string): Promise<any | null> {
  const engine = (cfg.llm?.engine || "claude") as LlmEngine;
  const configured = cfg.llm?.fallbackEngine;
  const fallback = configured === false || configured === "off" ? null
    : (configured || (engine === "claude" ? "codex" : null)) as LlmEngine | null;
  return runWithFailover(engine, fallback, (provider) => provider === "codex" ? viaCodex(prompt) : viaClaude(prompt));
}

async function viaClaude(prompt: string): Promise<ProviderResult> {
  const args = [
    "-p", prompt,
    "--model", cfg.llm?.claudeModel || "haiku",
    "--max-turns", "3",            // 留一点余量；工具已全禁，正常一轮就出结果
    "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit",
    "--output-format", "text",
    "--append-system-prompt",
    rules() + "\n\n不要使用任何工具。最终回复必须是且只能是一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
  ];
  const r = await run([cfg.llm?.claudeBin || "claude", ...args], {
    timeoutMs: 180_000,
    cwd: ROOT,
    env: { DISABLE_OMC: "1" },     // 关掉用户级 OMC hooks，避免注入编排指令
  });
  if (r.code !== 0) {
    const error = (r.stderr || r.stdout).slice(-500);
    log(`claude -p failed (${r.code}): ${error}`);
    return { value: null, error };
  }
  return { value: parseJson(r.stdout) };
}

async function viaCodex(prompt: string): Promise<ProviderResult> {
  const dir = mkdtempSync(join(tmpdir(), "ownward-llm-"));
  const outFile = join(dir, "last.txt");
  const args = [
    "exec", "--sandbox", "read-only", "--skip-git-repo-check",
    "-C", ROOT, "--output-last-message", outFile,
  ];
  if (cfg.llm?.codexModel) args.push("-m", cfg.llm.codexModel);
  args.push(prompt);
  try {
    const r = await run([cfg.llm?.codexBin || "codex", ...args], { timeoutMs: 180_000 });
    if (r.code !== 0) {
      const error = (r.stderr || r.stdout).slice(-500);
      log(`codex exec failed (${r.code}): ${error}`);
      return { value: null, error };
    }
    let text = "";
    try { text = readFileSync(outFile, "utf8"); } catch { text = r.stdout; }
    return { value: parseJson(text) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseJson(text: string): any | null {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    log(`llm output not JSON: ${stripped.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (e) {
    log(`llm JSON parse error: ${e}`);
    return null;
  }
}
