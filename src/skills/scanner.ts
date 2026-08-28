import { createHash } from "crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { probeSkillAdapters, skillRoots } from "./adapters.ts";
import type { FileIdentity, SkillCatalogEntry, SkillInventory, SkillObservation, SkillRoot, SkillScanOptions } from "./contracts.ts";
import type { RawSkillObservation, RawSkillSnapshot } from "./internal.ts";

const DEFAULT_LIMITS = { maxEntries: 20_000, maxFiles: 250_000, maxBytes: 4 * 1024 * 1024 * 1024, maxFilesPerSkill: 100_000, maxBytesPerSkill: 2 * 1024 * 1024 * 1024, maxDepth: 48, deadlineMs: 30_000 };
type Limits = typeof DEFAULT_LIMITS;
type TreeDigestResult = { digest: string | null; files: number; bytes: number; bounded: boolean };
type Budget = { entries: number; files: number; bytes: number; startedAt: number; partial: boolean; reasons: Set<string>; digestCache: Map<string, TreeDigestResult> };
const identity = (s: { dev: number; ino: number; mode: number }): FileIdentity => ({ dev: s.dev, ino: s.ino, mode: s.mode });

export function redactHome(path: string, home: string): string {
  const homes = new Set([resolve(home)]); try { homes.add(realpathSync(home)); } catch {}
  const paths = new Set([resolve(path)]); try { paths.add(realpathSync(path)); } catch {}
  for (const normalized of paths) for (const normalizedHome of homes) {
    if (normalized === normalizedHome) return "~";
    if (normalized.startsWith(normalizedHome + sep)) return `~/${relative(normalizedHome, normalized)}`;
  }
  return resolve(path);
}
function redactText(text: string, home: string): string { let value = text; const homes = new Set([home, resolve(home)]); try { homes.add(realpathSync(home)); } catch {} for (const candidate of homes) value = value.split(candidate).join("~"); return value; }
function errorText(error: unknown, home: string) { return redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), home); }
function exhausted(b: Budget, limits: Limits) {
  const reason = Date.now() - b.startedAt >= limits.deadlineMs ? "deadline" : b.entries >= limits.maxEntries ? "entries" : b.files >= limits.maxFiles ? "files" : b.bytes >= limits.maxBytes ? "bytes" : null;
  if (reason) { b.partial = true; b.reasons.add(reason); return true; }
  return false;
}
function parseFrontmatter(text: string): { name?: string; description?: string; malformed: boolean } {
  if (!text.startsWith("---\n")) return { malformed: false };
  const end = text.indexOf("\n---", 4); if (end < 0) return { malformed: true };
  const result: { name?: string; description?: string; malformed: boolean } = { malformed: false };
  for (const line of text.slice(4, end).split("\n")) { const match = /^(name|description):\s*(.*)$/.exec(line); if (match) result[match[1] as "name" | "description"] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2"); }
  return result;
}

/** Link nodes are hashed as links. A resolved target is hashed as a separate observation. */
function digestTree(entry: string, limits: Limits, budget: Budget) {
  let cacheKey = ""; try { const top = lstatSync(entry); if (!top.isSymbolicLink()) cacheKey = `${top.dev}:${top.ino}:${top.mode}`; } catch {}
  if (cacheKey) { const cached = budget.digestCache.get(cacheKey); if (cached) return { ...cached }; }
  const hash = createHash("sha256"); let files = 0, bytes = 0, bounded = false;
  const walk = (path: string, rel: string, depth: number) => {
    if (exhausted(budget, limits) || depth > limits.maxDepth || files >= limits.maxFilesPerSkill || bytes >= limits.maxBytesPerSkill) { bounded = true; budget.partial = true; budget.reasons.add("skill-tree"); return; }
    const st = lstatSync(path);
    if (st.isSymbolicLink()) { hash.update(`L\0${rel}\0${readlinkSync(path)}\0`); files++; budget.files++; return; }
    if (st.isFile()) {
      const remaining = Math.min(limits.maxBytesPerSkill - bytes, limits.maxBytes - budget.bytes);
      if (st.size > remaining) { hash.update(`F!\0${rel}\0${st.size}\0`); bounded = true; budget.partial = true; budget.reasons.add("bytes"); return; }
      const content = readFileSync(path); hash.update(`F\0${rel}\0${content.length}\0`).update(content); files++; bytes += content.length; budget.files++; budget.bytes += content.length; return;
    }
    if (st.isDirectory()) { hash.update(`D\0${rel}\0`); for (const name of readdirSync(path).sort()) walk(join(path, name), rel ? `${rel}/${name}` : name, depth + 1); return; }
    hash.update(`O\0${rel}\0${st.mode}\0`); files++; budget.files++;
  };
  walk(entry, "", 0); const result = { digest: bounded ? null : hash.digest("hex"), files, bytes, bounded }; if (cacheKey && !bounded) budget.digestCache.set(cacheKey, result); return result;
}

function publicLinkTarget(entryPath: string, target: string, home: string) { return redactHome(resolve(dirname(entryPath), target), home); }
function observe(root: SkillRoot, rawEntryPath: string, options: SkillScanOptions, limits: Limits, budget: Budget): RawSkillObservation {
  const home = options.home;
  budget.entries++;
  const entryPath = redactHome(rawEntryPath, home);
  const base = {
    id: createHash("sha256").update(`${root.engine}\0${rawEntryPath}`).digest("hex").slice(0, 24), engine: root.engine, scope: root.scope,
    root: redactHome(root.path, home), entryPath, displayPath: entryPath, name: basename(rawEntryPath), description: null,
    rawRoot: root.path, rawEntryPath, rawRealPath: null, rawLinkTarget: null,
    parentIdentity: null, entryIdentity: null, physicalIdentity: null, realPath: null, linkTarget: null, treeDigest: null, targetTreeDigest: null,
    bytes: 0, files: 0, ownership: (root.protected ? "protected" : "discovered") as SkillObservation["ownership"], findings: (root.protected ? ["protected"] : []) as SkillObservation["findings"],
  };
  try { base.parentIdentity = identity(statSync(dirname(rawEntryPath))); } catch {}
  try {
    const ls = lstatSync(rawEntryPath); base.entryIdentity = identity(ls);
    const nodeType = ls.isSymbolicLink() ? "symlink" : ls.isDirectory() ? "directory" : ls.isFile() ? "file" : "other";
    if (ls.isSymbolicLink()) { base.rawLinkTarget = resolve(dirname(rawEntryPath), readlinkSync(rawEntryPath)); base.linkTarget = publicLinkTarget(rawEntryPath, readlinkSync(rawEntryPath), home); }
    let rawRealPath: string;
    try { rawRealPath = realpathSync(rawEntryPath); } catch (error) { return { ...base, nodeType, ownership: root.protected ? "protected" : "missing", state: "broken", readError: errorText(error, home), findings: [...base.findings, "broken"] }; }
    base.rawRealPath = rawRealPath; base.realPath = redactHome(rawRealPath, home); base.physicalIdentity = identity(statSync(rawRealPath));
    // system/plugin roots 只作受保护目录展示，永不参与采纳或冲突合并。对它们读取 manifest
    // 足以确认可见性，避免为了一个不可变更的 plugin bundle 哈希数百 MB assets/vendor。
    if (root.protected) {
      try { const manifest = readFileSync(join(rawRealPath, "SKILL.md")); if (manifest.length > 1024 * 1024) return { ...base, nodeType, state: "bounded", readError: null }; const fm = parseFrontmatter(manifest.toString("utf8")); base.name = fm.name || base.name; base.description = fm.description || null; base.treeDigest = createHash("sha256").update("protected-manifest-v1\0").update(manifest).digest("hex"); base.files = 1; base.bytes = manifest.length; return { ...base, nodeType, state: fm.malformed ? "malformed" : "healthy", readError: null }; }
      catch { return { ...base, nodeType, state: "malformed", readError: null }; }
    }
    const linkTree = digestTree(rawEntryPath, limits, budget); base.treeDigest = linkTree.digest; base.files += linkTree.files; base.bytes += linkTree.bytes;
    let bounded = linkTree.bounded;
    if (nodeType === "symlink" && !exhausted(budget, limits)) { const target = digestTree(rawRealPath, limits, budget); base.targetTreeDigest = target.digest; base.files += target.files; base.bytes += target.bytes; bounded ||= target.bounded; }
    let malformed = false, hasManifest = true;
    try { const fm = parseFrontmatter(readFileSync(join(rawRealPath, "SKILL.md"), "utf8")); base.name = fm.name || base.name; base.description = fm.description || null; malformed = fm.malformed; } catch { hasManifest = false; }
    const external = nodeType === "symlink" && !(rawRealPath === root.path || rawRealPath.startsWith(root.path + sep));
    const managedRoot = resolve(options.storeRoot || join(home, ".ownward", "skills"), "managed");
    const ownership = root.protected ? "protected" : rawRealPath.startsWith(managedRoot + sep) ? "managed" : base.ownership;
    return { ...base, ownership, nodeType, state: bounded ? "bounded" : malformed || !hasManifest ? "malformed" : external ? "external" : "healthy", readError: null };
  } catch (error) { return { ...base, nodeType: "missing", ownership: root.protected ? "protected" : "missing", state: "unreadable", readError: errorText(error, home), findings: [...base.findings, "broken"] }; }
}

function pluginEntries(root: SkillRoot, limits: Limits, budget: Budget, warnings: string[], home: string): string[] {
  const found: string[] = [];
  const walk = (path: string, depth: number) => {
    if (exhausted(budget, limits)) return;
    if (depth > limits.maxDepth) { budget.partial = true; budget.reasons.add("plugin-depth"); return; }
    let names: string[]; try { names = readdirSync(path).sort(); } catch (error: any) { if (error?.code !== "ENOENT") { warnings.push(`无法读取 plugin 目录 ${redactHome(path, home)}：${errorText(error, home)}`); budget.partial = true; } return; }
    if (names.includes("SKILL.md")) { found.push(path); return; }
    for (const name of names) { if (exhausted(budget, limits)) return; budget.entries++; const child = join(path, name); let st; try { st = lstatSync(child); } catch { continue; } if (st.isDirectory()) walk(child, depth + 1); }
  };
  walk(root.path, 0); return found;
}

function catalogFor(observations: SkillObservation[]): SkillCatalogEntry[] {
  const groups = new Map<string, SkillObservation[]>();
  for (const item of observations) {
    const physical = item.physicalIdentity ? `${item.physicalIdentity.dev}:${item.physicalIdentity.ino}` : null;
    const key = physical || `${item.name}\0${item.targetTreeDigest || item.treeDigest || item.id}`;
    const group = groups.get(key) || []; group.push(item); groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const findings = [...new Set(group.flatMap((item) => item.findings))].sort() as SkillObservation["findings"];
    const ownership: SkillCatalogEntry["ownership"] = group.some((x) => x.ownership === "protected") ? "protected" : group.some((x) => x.ownership === "managed") ? "managed" : group.every((x) => x.ownership === "missing") ? "missing" : "discovered";
    return { logicalId: createHash("sha256").update(key).digest("hex").slice(0, 24), name: group[0].name, description: group.find((x) => x.description)?.description || null, digest: group[0].targetTreeDigest || group[0].treeDigest, ownership, observationIds: group.map((x) => x.id).sort(), engines: [...new Set(group.map((x) => x.engine))].sort(), scopes: [...new Set(group.map((x) => x.scope))].sort(), findings };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.logicalId.localeCompare(b.logicalId));
}

export function scanSkillsRaw(options: SkillScanOptions): RawSkillSnapshot {
  const roots = skillRoots(options), limits = { ...DEFAULT_LIMITS, ...options.limits }, startedAt = Date.now();
  const budget: Budget = { entries: 0, files: 0, bytes: 0, startedAt, partial: false, reasons: new Set(), digestCache: new Map() };
  const observations: RawSkillObservation[] = [], warnings = ["Codex 对 ~/.agents/skills 与 CODEX_HOME/skills 的优先级尚未确认；当前仅报告，不推断覆盖顺序。"];
  for (const root of roots) {
    if (exhausted(budget, limits)) break;
    let entries: string[];
    if (root.scope === "plugin") entries = pluginEntries(root, limits, budget, warnings, options.home);
    else {
      let children: string[];
      try { children = readdirSync(root.path).sort(); }
      catch (error: any) { if (error?.code !== "ENOENT") { warnings.push(`无法读取 skill 根 ${redactHome(root.path, options.home)}：${errorText(error, options.home)}`); budget.partial = true; } continue; }
      entries = children.map((name) => join(root.path, name));
    }
    for (const rawEntryPath of entries) {
      if (exhausted(budget, limits)) break;
      if (roots.some((candidate) => candidate !== root && candidate.protected && resolve(candidate.path) === resolve(rawEntryPath))) continue;
      observations.push(observe(root, rawEntryPath, options, limits, budget));
    }
  }
  const groups = new Map<string, SkillObservation[]>();
  for (const item of observations) { if (item.state !== "healthy" && item.state !== "external") continue; if (!(item.targetTreeDigest || item.treeDigest)) continue; const group = groups.get(item.name) || []; group.push(item); groups.set(item.name, group); }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const digests = new Set(group.map((x) => x.targetTreeDigest || x.treeDigest)); const finding = digests.size === 1 ? "duplicate" : "conflict";
    for (const item of group) item.findings.push(finding);
  }
  if (budget.partial) warnings.push(`扫描不完整：已触发 ${[...budget.reasons].sort().join(", ")} 预算。`);
  observations.sort((a, b) => a.engine.localeCompare(b.engine) || a.displayPath.localeCompare(b.displayPath));
  const revision = createHash("sha256").update(JSON.stringify(observations.map(({ id, nodeType, parentIdentity, entryIdentity, physicalIdentity, treeDigest, targetTreeDigest, linkTarget, state, findings }) => ({ id, nodeType, parentIdentity, entryIdentity, physicalIdentity, treeDigest, targetTreeDigest, linkTarget, state, findings })))).digest("hex");
  const publicObservations: SkillObservation[] = observations.map(({ rawRoot: _rawRoot, rawEntryPath: _rawEntryPath, rawRealPath: _rawRealPath, rawLinkTarget: _rawLinkTarget, ...item }) => item);
  const inventory: SkillInventory = {
    revision, scannedAt: new Date().toISOString(), roots: roots.map((r) => ({ ...r, path: redactHome(r.path, options.home) })), observations,
    summary: { total: observations.length, duplicates: observations.filter((x) => x.findings.includes("duplicate")).length, conflicts: observations.filter((x) => x.findings.includes("conflict")).length, protected: observations.filter((x) => x.findings.includes("protected")).length, broken: observations.filter((x) => x.findings.includes("broken")).length },
    warnings, completeness: budget.partial ? "partial" : "complete", budget: { entries: budget.entries, files: budget.files, bytes: budget.bytes, elapsedMs: Date.now() - startedAt }, adapters: probeSkillAdapters(options), catalog: catalogFor(publicObservations),
  };
  inventory.observations = publicObservations;
  return { inventory, roots, observations };
}

export function scanSkills(options: SkillScanOptions): SkillInventory { return scanSkillsRaw(options).inventory; }
