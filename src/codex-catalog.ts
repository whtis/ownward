// Codex 模型目录：唯一真相是 Codex CLI 自己从后端拉下来、缓存在 $CODEX_HOME/models_cache.json 的官方模型表
// （TUI 里 /model 菜单画的就是它：slug、支持的思考深度、默认深度、「Fast」档）。Ownward 不再手写
// 「codex 有哪些模型 / 各支持哪些深度」——手写表在 2026-09-05 已经悄悄落后（gpt-6-astra 上线、gpt-5.4 下线）
// 而 UI 还照旧画着旧型号。内置表只做兜底：缓存文件不存在（这台机器从没跑过 codex）或坏掉时用，
// 内容是 2026-09-05 的目录快照，别再往里手工加型号，跑一次 codex 让它自己刷新缓存。
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = typeof CODEX_EFFORTS[number];
export function isCodexEffort(value: unknown): value is CodexEffort {
  return CODEX_EFFORTS.includes(value as CodexEffort);
}

/** 官方 service_tiers 里 id=priority 的那档就是 TUI 的「Fast mode」：更快、额度消耗更高（config.toml: service_tier） */
export interface CodexFastTier { id: string; name: string; description: string }
export interface CodexCatalogModel {
  slug: string;
  displayName: string;
  description: string;
  efforts: readonly CodexEffort[];
  defaultEffort: CodexEffort | undefined;
  fast: CodexFastTier | null;
  contextWindow: number | null;
}
export interface CodexCatalog {
  /** official-cache = 读到了 CLI 的缓存；builtin = 兜底快照（缓存缺失/损坏，reason 说明为什么） */
  source: "official-cache" | "builtin";
  file: string;
  fetchedAt: string | null;
  reason?: string;
  models: readonly CodexCatalogModel[];
}

const builtin = (slug: string, displayName: string, description: string, efforts: readonly CodexEffort[], defaultEffort: CodexEffort, fast: CodexFastTier | null, contextWindow: number): CodexCatalogModel =>
  Object.freeze({ slug, displayName, description, efforts: Object.freeze([...efforts]), defaultEffort, fast: fast ? Object.freeze({ ...fast }) : null, contextWindow });
const FAST_15 = { id: "priority", name: "Fast", description: "1.5x speed, increased usage" } as const;
/** 2026-09-05 官方目录快照（visibility=list、未退役的型号），只在缓存不可用时兜底 */
export const BUILTIN_CODEX_CATALOG: readonly CodexCatalogModel[] = Object.freeze([
  builtin("gpt-6-astra", "GPT-6-Astra", "Our most capable model for complex, demanding work.", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium", { id: "priority", name: "Fast", description: "2x speed, increased usage" }, 272_000),
  builtin("gpt-5.6-sol", "GPT-5.6-Sol", "Reliable agentic workhorse for everyday tasks.", ["low", "medium", "high", "xhigh", "max", "ultra"], "low", FAST_15, 272_000),
  builtin("gpt-5.6-terra", "GPT-5.6-Terra", "Balanced agentic coding model for everyday work.", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium", FAST_15, 272_000),
  builtin("gpt-5.6-luna", "GPT-5.6-Luna", "Fast and affordable agentic coding model.", ["low", "medium", "high", "xhigh", "max"], "medium", FAST_15, 272_000),
  builtin("gpt-5.5", "GPT-5.5", "Proven previous-generation model for coding and general work.", ["low", "medium", "high", "xhigh"], "medium", FAST_15, 272_000),
  builtin("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", "Ultra-fast coding model.", ["low", "medium", "high", "xhigh"], "high", null, 128_000),
]);

export function codexHomeDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return home || join(env.HOME || homedir(), ".codex");
}
export function codexCatalogFile(home = codexHomeDir()): string { return join(home, "models_cache.json"); }

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 把官方缓存里的一条记录规整成 Ownward 认识的形状；不合法的整条丢弃（返回 null）而不是猜 */
function normalizeModel(raw: unknown, now: number): CodexCatalogModel | null {
  if (!plain(raw) || typeof raw.slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(raw.slug)) return null;
  if (raw.visibility !== "list") return null;                       // hide = 内部/实验型号，TUI 也不列
  const upgrade = plain(raw.upgrade) ? raw.upgrade : null;
  const retirement = typeof upgrade?.retirement_at === "string" ? Date.parse(upgrade.retirement_at) : NaN;
  if (Number.isFinite(retirement) && retirement <= now) return null; // 已过退役日：官方已把它换成 upgrade.model
  const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
  const efforts = levels.map((l: unknown) => (plain(l) ? l.effort : undefined)).filter(isCodexEffort);
  const defaultEffort = isCodexEffort(raw.default_reasoning_level) && efforts.includes(raw.default_reasoning_level) ? raw.default_reasoning_level : efforts[0];
  const tiers = Array.isArray(raw.service_tiers) ? raw.service_tiers : [];
  const priority = tiers.find((t: unknown) => plain(t) && t.id === "priority");
  const fast: CodexFastTier | null = plain(priority)
    ? { id: "priority", name: typeof priority.name === "string" ? priority.name : "Fast", description: typeof priority.description === "string" ? priority.description : "" }
    : null;
  return {
    slug: raw.slug,
    displayName: typeof raw.display_name === "string" && raw.display_name ? raw.display_name : raw.slug,
    description: typeof raw.description === "string" ? raw.description : "",
    efforts, defaultEffort, fast,
    contextWindow: Number.isSafeInteger(raw.context_window) ? (raw.context_window as number) : null,
  };
}

export function parseCodexCatalog(text: string, file: string, now = Date.now()): CodexCatalog {
  const raw = JSON.parse(text) as unknown;
  if (!plain(raw) || !Array.isArray(raw.models)) throw new Error("models_cache.json 缺 models 数组");
  const rows = raw.models.map((m: unknown) => ({ model: normalizeModel(m, now), priority: plain(m) && Number.isFinite(m.priority) ? (m.priority as number) : Number.MAX_SAFE_INTEGER }));
  const models = rows.filter((r) => r.model).sort((a, b) => a.priority - b.priority).map((r) => r.model!);
  if (!models.length) throw new Error("models_cache.json 里没有可列出的型号");
  return { source: "official-cache", file, fetchedAt: typeof raw.fetched_at === "string" ? raw.fetched_at : null, models };
}

interface CacheEntry { file: string; mtimeMs: number; size: number; checkedAt: number; catalog: CodexCatalog }
const cache = new Map<string, CacheEntry>();
const STAT_THROTTLE_MS = 2_000;
let lastWarning = "";
/** 读官方缓存；按 mtime/size 复用解析结果，最多每 2s stat 一次。永不抛：读不到就回内置快照并注明原因 */
export function readCodexCatalog(options: { home?: string; now?: number } = {}): CodexCatalog {
  const file = codexCatalogFile(options.home), now = options.now ?? Date.now(), hit = cache.get(file);
  if (hit && now - hit.checkedAt < STAT_THROTTLE_MS) return hit.catalog;
  let catalog: CodexCatalog;
  try {
    if (!existsSync(file)) throw new Error("文件不存在（这台机器还没跑过 codex）");
    const st = statSync(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { hit.checkedAt = now; return hit.catalog; }
    catalog = parseCodexCatalog(readFileSync(file, "utf8"), file, now);
    cache.set(file, { file, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now, catalog });
    return catalog;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const warning = `${file}: ${reason}`;
    if (warning !== lastWarning) { lastWarning = warning; console.error(`codex-catalog: 官方模型缓存不可用，回退内置快照 — ${warning}`); }
    catalog = { source: "builtin", file, fetchedAt: null, reason, models: BUILTIN_CODEX_CATALOG };
    cache.set(file, { file, mtimeMs: -1, size: -1, checkedAt: now, catalog });
    return catalog;
  }
}

/** Codex CLI 自己的默认型号 / 思考深度（用户在终端里 `codex` 不带参数时用的那组）。 */
export interface CodexCliDefaults { file: string; model?: string; effort?: CodexEffort }

/** 只读 config.toml 里决定默认型号的那几个键：顶层 model / model_reasoning_effort；顶层写了 profile = "x" 时
 *  [profiles.x] 里的同名键优先（CLI 自己就是这么叠的）。别的段（[sandbox_workspace_write] 之类）里同名的键不算。
 *  不是通用 TOML 解析器：只认单行字符串值，其余一律跳过。 */
export function parseCodexConfigDefaults(text: string): { model?: string; effort?: string } {
  const top: Record<string, string> = {}, profiles: Record<string, Record<string, string>> = {};
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) { section = header[1].replace(/\s*\.\s*/g, ".").replace(/"([^"]*)"/g, "$1"); continue; }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (!kv) continue;
    const value = kv[2] !== undefined ? kv[2].replace(/\\(["\\])/g, "$1") : kv[3];
    if (section === null) top[kv[1]] = value;
    else if (section.startsWith("profiles.")) (profiles[section.slice("profiles.".length)] ??= {})[kv[1]] = value;
  }
  const profile = top.profile ? profiles[top.profile] ?? {} : {};
  const model = profile.model ?? top.model, effort = profile.model_reasoning_effort ?? top.model_reasoning_effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

interface DefaultsEntry { mtimeMs: number; size: number; checkedAt: number; value: CodexCliDefaults }
const defaultsCache = new Map<string, DefaultsEntry>();
/** 读 $CODEX_HOME/config.toml 的默认型号与档位。只认目录里查得到的型号、且是该型号支持的档位——
 *  CLI 不认识的值下发出去就是 400，宁可回空让调用方落内置默认。按 mtime/size 复用，最多每 2s stat 一次；永不抛 */
export function readCodexCliDefaults(options: { home?: string; now?: number } = {}): CodexCliDefaults {
  const home = options.home ?? codexHomeDir(), file = join(home, "config.toml"), now = options.now ?? Date.now(), hit = defaultsCache.get(file);
  if (hit && now - hit.checkedAt < STAT_THROTTLE_MS) return hit.value;
  let value: CodexCliDefaults = { file };
  try {
    const st = statSync(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { hit.checkedAt = now; return hit.value; }
    const raw = parseCodexConfigDefaults(readFileSync(file, "utf8"));
    const model = raw.model && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(raw.model) ? codexCatalogModel(raw.model, home) : undefined;
    if (model) value = { file, model: model.slug, ...(isCodexEffort(raw.effort) && model.efforts.includes(raw.effort) ? { effort: raw.effort } : {}) };
    defaultsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, checkedAt: now, value });
  } catch {
    defaultsCache.set(file, { mtimeMs: -1, size: -1, checkedAt: now, value });   // 没有 config.toml 是常态，不刷日志
  }
  return value;
}

/** 按 slug 查一条：先官方缓存，再内置快照（缓存里没有但内置有的老型号仍认，避免历史会话突然变非法） */
export function codexCatalogModel(slug: string | undefined, home?: string): CodexCatalogModel | undefined {
  if (!slug) return undefined;
  return readCodexCatalog({ home }).models.find((m) => m.slug === slug) ?? BUILTIN_CODEX_CATALOG.find((m) => m.slug === slug);
}
