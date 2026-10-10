// 笔记 tab 的服务端：vault 索引、全文搜索、反向链接、图片、带冲突检测的保存、跨设备的「最近 / 收藏」。
//
// 借鉴 SilverBullet / Obsidian / NoteDiscovery 的几件事：打开就回到上次那篇、边写边存、
// [[双链]] 能点、能看到谁链到了这篇。所有函数都显式传 root，方便拿临时目录测试；
// 越界判断一律走 path-within（带分隔符的前缀判断，AGENTS.md 红线 3）。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, normalize, relative, sep } from "path";
import { isStrictlyWithin } from "./path-within.ts";

export type VaultFile = { path: string; name: string; dir: string; mtime: number };
export type VaultIndex = { files: VaultFile[]; assets: Map<string, string[]> };
export type LineHit = { line: number; text: string };
export type NoteHits = VaultFile & { matches: LineHit[] };

/** /api/vault/list 最多回多少篇（按修改时间倒序）；超出的仍能被全文搜索和反链扫到 */
export const VAULT_LIST_CAP = 2000;
/** 单篇超过这个大小不进全文搜索/反链：读一次就要阻塞事件循环，跳过的篇数会如实回给客户端 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
// svg 不放行：直接打开 /api/vault/asset 时它会在工作台同源里执行脚本
const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
};

const toPosix = (p: string) => p.split(sep).join("/");
/** vault 相对路径（posix 分隔、去掉 .md）——双链和反链都按它比对 */
export const noteRel = (f: Pick<VaultFile, "name" | "dir">) => (f.dir ? `${f.dir}/${f.name}` : f.name);

/** 全 vault 扫一遍：md 进 files（按 mtime 倒序），图片按文件名进 assets（Obsidian 的 ![[x.png]] 只写文件名）。
 *  隐藏目录（.git/.obsidian/.trash）整段跳过。 */
export function scanVault(root: string): VaultIndex {
  const files: VaultFile[] = [], assets = new Map<string, string[]>();
  if (!existsSync(root)) return { files, assets };
  for (const raw of readdirSync(root, { recursive: true }) as string[]) {
    const rel = toPosix(raw);
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
    const full = join(root, raw);
    if (rel.endsWith(".md")) {
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        const slash = rel.lastIndexOf("/");
        files.push({ path: full, name: rel.slice(slash + 1, -3), dir: slash < 0 ? "" : rel.slice(0, slash), mtime: st.mtimeMs });
      } catch { /* 扫描途中被删 */ }
    } else if (ASSET_TYPES[extname(rel).toLowerCase()]) {
      const key = basename(rel).toLowerCase();
      const list = assets.get(key);
      list ? list.push(full) : assets.set(key, [full]);
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const list of assets.values()) list.sort((a, b) => a.length - b.length);  // 同名图片取路径最短的，和 Obsidian 一致
  return { files, assets };
}

// 全文搜索/反链的正文缓存：按 mtime 校验，没变的文件不再读盘（全库 1500 篇 / 10MB，每次重读会把事件循环卡上百毫秒）。
// 总量设上限，超了就不再往里放（照样能搜，只是退回每次读盘）；扫完一整轮顺手清掉已经不在的文件
const TEXT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const textCache = new Map<string, { mtimeMs: number; text: string }>();
let textCacheBytes = 0;

function readForScan(f: VaultFile): string | null {
  try {
    const st = statSync(f.path);
    if (st.size > MAX_SCAN_BYTES) return null;
    const hit = textCache.get(f.path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = readFileSync(f.path, "utf8");
    if (hit) { textCacheBytes -= hit.text.length; textCache.delete(f.path); }
    if (textCacheBytes + text.length <= TEXT_CACHE_MAX_BYTES) {
      textCache.set(f.path, { mtimeMs: st.mtimeMs, text });
      textCacheBytes += text.length;
    }
    return text;
  } catch { return null; }
}

function pruneTextCache(files: VaultFile[]) {
  const live = new Set(files.map((f) => f.path));
  for (const [path, v] of textCache) if (!live.has(path)) { textCacheBytes -= v.text.length; textCache.delete(path); }
}

const clip = (line: string, at: number) => {
  const start = Math.max(0, at - 50);
  const s = line.slice(start, start + 160).trim();
  return (start > 0 ? "…" : "") + s + (start + 160 < line.length ? "…" : "");
};

/** 全文搜索：空白分词、全部命中才算（名字或正文都行），名字命中的排前面，其余保持 mtime 倒序。
 *  每篇回最多 3 行命中片段。total 是命中总篇数，hits 截到 limit，skipped 是超大没扫的篇数。 */
export function searchVault(files: VaultFile[], q: string, limit = 40) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const named: NoteHits[] = [], texted: NoteHits[] = [];
  let total = 0, skipped = 0;
  if (!terms.length) return { hits: [], total, skipped, truncated: false };
  for (const f of files) {
    const rel = noteRel(f).toLowerCase();
    const text = readForScan(f);
    if (text === null) { skipped++; continue; }
    const lower = text.toLowerCase();
    if (!terms.every((t) => rel.includes(t) || lower.includes(t))) continue;
    total++;
    const bucket = terms.every((t) => rel.includes(t)) ? named : texted;  // 名字命中排前面，两桶各留 limit 条再合并截断
    if (bucket.length >= limit) continue;
    const matches: LineHit[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && matches.length < 3; i++) {
      const l = lines[i].toLowerCase();
      const at = Math.min(...terms.map((t) => l.indexOf(t)).filter((n) => n >= 0));
      if (Number.isFinite(at)) matches.push({ line: i, text: clip(lines[i], at) });
    }
    bucket.push({ ...f, matches });
  }
  pruneTextCache(files);
  const hits = [...named, ...texted].slice(0, limit);
  return { hits, total, skipped, truncated: total > hits.length };
}

/** [[目标#标题|别名]] → 小写的目标（去 .md）；[[#标题]] 这种页内链接回空串 */
export function wikiTarget(inner: string): string {
  return inner.split("|")[0].split("#")[0].trim().replace(/\.md$/i, "").toLowerCase();
}

/** 把相对链接拼到笔记所在目录上，回 vault 相对路径（posix、去 .md、小写）；越出 vault 回 null */
export function joinRel(dir: string, href: string): string | null {
  let h = href;
  try { h = decodeURIComponent(href); } catch { /* 保留原样 */ }
  const out: string[] = [];
  for (const seg of [...(h.startsWith("/") ? [] : dir.split("/")), ...h.split("/")]) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); }
    else out.push(seg);
  }
  return out.join("/").replace(/\.md$/i, "").toLowerCase();
}

type LinkRef = { source: string; line: number; text: string };
/** 反链索引：wiki 按链接里写的目标（可能只是文件名或路径后缀），md 链接按解析后的完整相对路径 */
export type LinkIndex = { wiki: Map<string, LinkRef[]>; exact: Map<string, LinkRef[]>; skipped: number };

export function buildLinkIndex(files: VaultFile[]): LinkIndex {
  const wiki = new Map<string, LinkRef[]>(), exact = new Map<string, LinkRef[]>();
  let skipped = 0;
  const add = (map: Map<string, LinkRef[]>, key: string, ref: LinkRef) => {
    const list = map.get(key);
    list ? list.push(ref) : map.set(key, [ref]);
  };
  for (const f of files) {
    const text = readForScan(f);
    if (text === null) { skipped++; continue; }
    if (!text.includes("[[") && !text.includes(".md")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const seen = new Set<string>();   // 同一行链两次同一篇只记一次
      for (const m of l.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
        const key = wikiTarget(m[1]);
        if (key && !seen.has("w:" + key)) { seen.add("w:" + key); add(wiki, key, { source: f.path, line: i, text: clip(l, m.index ?? 0) }); }
      }
      for (const m of l.matchAll(/\[[^\]\n]*\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/gi)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;   // http(s):// 等外链
        const key = joinRel(f.dir, m[1]);
        if (key && !seen.has("e:" + key)) { seen.add("e:" + key); add(exact, key, { source: f.path, line: i, text: clip(l, m.index ?? 0) }); }
      }
    }
  }
  pruneTextCache(files);
  return { wiki, exact, skipped };
}

/** 谁链到了 target：[[README]] 这种只写文件名的、[[projects/x/README]] 这种写路径后缀的、
 *  [文字](../x/README.md) 这种相对链接都算。同名多篇时 Obsidian 按「最近的那篇」解析，
 *  这里不做歧义裁决——宁可多列一条，也不漏掉真链接。 */
export function findBacklinks(index: LinkIndex, files: VaultFile[], target: Pick<VaultFile, "path" | "name" | "dir">): NoteHits[] {
  const rel = noteRel(target).toLowerCase(), parts = rel.split("/");
  const refs: LinkRef[] = [...(index.exact.get(rel) || [])];
  for (let i = 0; i < parts.length; i++) refs.push(...(index.wiki.get(parts.slice(i).join("/")) || []));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const grouped = new Map<string, NoteHits>();
  for (const r of refs) {
    if (r.source === target.path) continue;
    const f = byPath.get(r.source);
    if (!f) continue;
    const g = grouped.get(r.source) ?? grouped.set(r.source, { ...f, matches: [] }).get(r.source)!;
    if (g.matches.length < 3 && !g.matches.some((m) => m.line === r.line)) g.matches.push({ line: r.line, text: r.text });
  }
  return [...grouped.values()].sort((a, b) => b.mtime - a.mtime);
}

/** 笔记里引用的图片（![[x.png]] / ![](img/x.png)）解析成磁盘路径：先笔记所在目录，再 vault 根，
 *  最后按文件名全库找（Obsidian 默认附件落 vault 根，笔记里只写文件名）。
 *  只放行图片扩展名、不进隐藏目录、realpath 之后仍在 vault 内（挡住指向外面的符号链接）。 */
export function resolveVaultAsset(root: string, assets: Map<string, string[]>, ref: string, from?: string): { path: string; type: string } | null {
  let r = ref.split("|")[0].split("#")[0].trim();
  try { r = decodeURIComponent(r); } catch { /* 保留原样 */ }
  if (!r || r.includes("\0")) return null;
  const candidates: string[] = [];
  if (from && isStrictlyWithin(root, normalize(from))) candidates.push(join(dirname(normalize(from)), r));
  candidates.push(join(root, r), ...(assets.get(basename(r).toLowerCase()) || []));
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return null; }
  for (const c of candidates) {
    const full = normalize(c), type = ASSET_TYPES[extname(full).toLowerCase()];
    if (!type || !isStrictlyWithin(root, full)) continue;
    if (toPosix(relative(root, full)).split("/").some((seg) => seg.startsWith("."))) continue;
    try {
      if (!statSync(full).isFile() || !isStrictlyWithin(realRoot, realpathSync(full))) continue;
    } catch { continue; }
    return { path: full, type };
  }
  return null;
}

export type SaveResult =
  | { ok: true; mtime: number }
  | { ok: false; code: "VAULT_CONFLICT"; mtime: number }
  | { ok: false; code: "VAULT_GONE" };

/** 保存一篇笔记。带 baseMtime 时是「我是基于这个版本改的」：磁盘上的文件在这之后被别处改过
 *  （daemon 收割追加、Obsidian、另一台设备的工作台）就拒绝，不静默覆盖别人的改动；
 *  不带 baseMtime 是用户明确选了「用我的覆盖」，照写。 */
export function saveVaultNote(full: string, content: string, baseMtime?: number): SaveResult {
  if (typeof baseMtime === "number") {
    if (!existsSync(full)) return { ok: false, code: "VAULT_GONE" };
    const cur = statSync(full).mtimeMs;
    if (cur !== baseMtime) return { ok: false, code: "VAULT_CONFLICT", mtime: cur };
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return { ok: true, mtime: statSync(full).mtimeMs };
}

/** 「最近打开 / 收藏」：存 vault 相对路径，换 vault 根目录也不失效；落 data/，手机和电脑共用一份 */
export type NotePrefs = { recent: { rel: string; at: string }[]; pinned: string[] };
export const RECENT_CAP = 20, PINNED_CAP = 50;

export function readNotePrefs(file: string): NotePrefs {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const recent = Array.isArray(raw?.recent)
      ? raw.recent.filter((r: any) => typeof r?.rel === "string" && typeof r?.at === "string").slice(0, RECENT_CAP) : [];
    const pinned = Array.isArray(raw?.pinned) ? raw.pinned.filter((p: any) => typeof p === "string").slice(0, PINNED_CAP) : [];
    return { recent, pinned };
  } catch { return { recent: [], pinned: [] }; }
}

export function applyNotePref(prefs: NotePrefs, op: "open" | "pin" | "unpin", rel: string, now = new Date()): NotePrefs {
  if (op === "open") return { ...prefs, recent: [{ rel, at: now.toISOString() }, ...prefs.recent.filter((r) => r.rel !== rel)].slice(0, RECENT_CAP) };
  const rest = prefs.pinned.filter((p) => p !== rel);
  return { ...prefs, pinned: op === "pin" ? [rel, ...rest].slice(0, PINNED_CAP) : rest };
}

export function writeNotePrefs(file: string, prefs: NotePrefs) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...prefs }, null, 2));
  renameSync(tmp, file);
}

/** 给客户端的视图：绝对路径（和其余 vault 接口一致），已经不存在的篇目不回 */
export function notePrefsView(root: string, prefs: NotePrefs, exists: (p: string) => boolean = existsSync) {
  const abs = (rel: string) => join(root, `${rel}.md`);
  return {
    ok: true,
    recent: prefs.recent.map((r) => ({ path: abs(r.rel), at: r.at })).filter((r) => exists(r.path)),
    pinned: prefs.pinned.map(abs).filter((p) => exists(p)),
  };
}
