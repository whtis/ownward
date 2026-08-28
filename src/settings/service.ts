import { createHash } from "crypto";
import { readFileSync } from "fs";
import { canonicalConnectorOverlay } from "../connector-config.ts";
import { mergeDeep } from "../util.ts";
import { buildSettingsSchema, type SettingRisk, type SettingSchemaNode, type SettingsSchema } from "./schema.ts";

export type SettingsPatch = { op: "set"; path: string; value: unknown } | { op: "remove"; path: string };
export type SettingsIssue = { path: string; code: string; message: string };
export type SettingSource = "default" | "override" | "legacy";

export interface SettingsSnapshot {
  schemaVersion: number;
  sourceDigest: string;
  effective: Record<string, unknown>;
  override: Record<string, unknown>;
  provenance: Record<string, SettingSource>;
}

export interface SettingsFiles { defaultFile: string; overrideFile: string }
export interface SettingsDiffEntry { path: string; before: unknown; after: unknown; risk: SettingRisk }
export interface SettingsValidationResult {
  valid: boolean;
  issues: SettingsIssue[];
  sourceDigest: string;
  normalizedPatches: SettingsPatch[];
  redactedDiff: SettingsDiffEntry[];
  risk: { level: SettingRisk; approvalRequired: true; confirmations: string[] };
  candidateOverride?: Record<string, unknown>;
  /** 只供 helper 准备操作，route 绝不能直接序列化。 */
  candidateOverrideRaw?: Record<string, unknown>;
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function parseSettingsFile(path: string, optional = false): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根节点必须是对象");
    return value;
  } catch (error: any) {
    if (optional && error?.code === "ENOENT") return {};
    throw new Error(`${path} 解析失败：${error?.message ?? error}`);
  }
}

function escapePointer(value: string) { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function walkLeaves(value: unknown, prefix = "", output: string[] = []): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) walkLeaves(child, `${prefix}/${escapePointer(key)}`, output);
  } else output.push(prefix);
  return output;
}

function provenance(defaults: Record<string, any>, local: Record<string, any>): Record<string, SettingSource> {
  const result: Record<string, SettingSource> = {};
  for (const path of walkLeaves(defaults)) result[path] = "default";
  for (const path of walkLeaves(local)) result[path] = "override";
  for (const id of ["lark", "github", "gmail", "stock"] as const) {
    if (local.connectors?.[id] === undefined && local.sources?.[id] !== undefined) {
      for (const path of walkLeaves(local.sources[id], `/connectors/${id}`)) result[path] = "legacy";
    }
  }
  return result;
}

export function loadSettings(files: SettingsFiles): { schema: SettingsSchema; snapshot: SettingsSnapshot } {
  const defaults = parseSettingsFile(files.defaultFile), local = parseSettingsFile(files.overrideFile, true);
  const schema = buildSettingsSchema(defaults);
  const canonical = canonicalConnectorOverlay(local);
  return { schema, snapshot: {
    schemaVersion: schema.version,
    sourceDigest: createHash("sha256").update(stable({ defaults, local })).digest("hex"),
    effective: redact(mergeDeep(defaults, canonical)) as Record<string, unknown>,
    override: redact(local) as Record<string, unknown>,
    provenance: provenance(defaults, local),
  } };
}

function tokens(path: string): string[] | null {
  if (path === "" || !path.startsWith("/")) return null;
  try { return path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); } catch { return null; }
}

function schemaAt(schema: SettingsSchema, parts: string[]): SettingSchemaNode | undefined {
  let current: SettingSchemaNode | undefined;
  let children = schema.nodes;
  for (const part of parts) { current = children[part]; if (!current) return; children = current.children ?? {}; }
  return current;
}

function valueAt(root: unknown, parts: string[]): { exists: boolean; value?: unknown } {
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { exists: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function validateNode(value: unknown, spec: SettingSchemaNode, path: string, issues: SettingsIssue[], allowUnknown = false) {
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (actual !== spec.type) { issues.push({ path, code: "TYPE", message: `需要 ${spec.type}，实际为 ${actual}` }); return; }
  if (typeof value === "number" && !Number.isFinite(value)) issues.push({ path, code: "VALUE", message: "必须是有限数字" });
  if (path === "/dashboard/port" && (value as number) % 1 !== 0 || path === "/dashboard/port" && ((value as number) < 1 || (value as number) > 65_535)) issues.push({ path, code: "VALUE", message: "端口必须是 1–65535 的整数" });
  if (/\/(?:intervalMin|pollMin|maxBatch|watchSec|observationSec)$/.test(path) && (value as number) < 0) issues.push({ path, code: "VALUE", message: "不能小于 0" });
  if (path === "/engine/compactThreshold" && ((value as number) <= 0 || (value as number) > 1)) issues.push({ path, code: "VALUE", message: "必须大于 0 且不超过 1" });
  if (typeof value === "string" && /\/(?:time|start|end)$/.test(path) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) issues.push({ path, code: "VALUE", message: "时间必须是 HH:mm" });
  if (path === "/timezone" && typeof value === "string") { try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { issues.push({ path, code: "VALUE", message: "无效时区" }); } }
  if (spec.type === "object") for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}/${escapePointer(key)}`, childSpec = spec.children?.[key];
    if (!childSpec) { if (!allowUnknown) issues.push({ path: childPath, code: "UNKNOWN_SETTING", message: "对象包含未知设置" }); }
    else validateNode(child, childSpec, childPath, issues, allowUnknown);
  }
}

/** 对象级 set 替换已知配置，但不能顺带抹掉之前版本或扩展留下的未知 sibling。 */
function preserveUnknown(existing: unknown, replacement: unknown, spec: SettingSchemaNode): unknown {
  if (spec.type !== "object" || !existing || typeof existing !== "object" || Array.isArray(existing) || !replacement || typeof replacement !== "object" || Array.isArray(replacement)) return replacement;
  const result = structuredClone(replacement) as Record<string, unknown>;
  for (const [key, oldValue] of Object.entries(existing as Record<string, unknown>)) {
    const childSpec = spec.children?.[key];
    if (!childSpec) result[key] = structuredClone(oldValue);
    else if (Object.prototype.hasOwnProperty.call(result, key)) result[key] = preserveUnknown(oldValue, result[key], childSpec);
  }
  return result;
}

function parentAt(root: Record<string, unknown>, parts: string[], create: boolean): Record<string, unknown> | null {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const value = current[part];
    if (value === undefined && create) current[part] = {};
    else if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    current = current[part] as Record<string, unknown>;
  }
  return current;
}

export function validateSettingsPatches(input: { sourceDigest?: unknown; patches?: unknown }, files: SettingsFiles): SettingsValidationResult {
  const { schema, snapshot } = loadSettings(files);
  const issues: SettingsIssue[] = [];
  if (input.sourceDigest !== snapshot.sourceDigest) issues.push({ path: "", code: "STALE_DIGEST", message: "配置已变化，请刷新后重试" });
  if (!Array.isArray(input.patches)) issues.push({ path: "/patches", code: "TYPE", message: "patches 必须是数组" });
  const currentOverride = parseSettingsFile(files.overrideFile, true), next = structuredClone(currentOverride);
  const accepted: SettingsPatch[] = [];
  const seen = new Set<string>();
  if (!issues.length) for (const [index, raw] of (input.patches as unknown[]).entries()) {
    const issuePath = `/patches/${index}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { issues.push({ path: issuePath, code: "TYPE", message: "patch 必须是对象" }); continue; }
    const patch = raw as Record<string, unknown>, parts = typeof patch.path === "string" ? tokens(patch.path) : null;
    if (!parts?.length) { issues.push({ path: `${issuePath}/path`, code: "POINTER", message: "需要非空 JSON Pointer" }); continue; }
    if (parts[0] === "sources") { issues.push({ path: patch.path as string, code: "LEGACY_READ_ONLY", message: "旧 sources 路径只读，请使用 connectors" }); continue; }
    const spec = schemaAt(schema, parts);
    if (!spec) { issues.push({ path: patch.path as string, code: "UNKNOWN_SETTING", message: "未知设置路径" }); continue; }
    if (spec.type === "object") { issues.push({ path: patch.path as string, code: "LEAF_REQUIRED", message: "设置只能按叶子字段修改" }); continue; }
    if (!spec.metadata?.editable) { issues.push({ path: patch.path as string, code: "READ_ONLY", message: "内部设置只读" }); continue; }
    if (seen.has(patch.path as string)) { issues.push({ path: patch.path as string, code: "DUPLICATE_PATH", message: "同一路径不能重复修改" }); continue; }
    seen.add(patch.path as string);
    const parent = parentAt(next, parts, patch.op === "set");
    if (!parent) { issues.push({ path: patch.path as string, code: "PARENT_TYPE", message: "父路径不是对象" }); continue; }
    const key = parts.at(-1)!;
    if (patch.op === "set") { const before = issues.length; validateNode(patch.value, spec, patch.path as string, issues); if (issues.length === before) { parent[key] = preserveUnknown(parent[key], patch.value, spec); accepted.push({ op: "set", path: patch.path as string, value: structuredClone(patch.value) }); } }
    else if (patch.op === "remove") { delete parent[key]; accepted.push({ op: "remove", path: patch.path as string }); }
    else issues.push({ path: `${issuePath}/op`, code: "OP", message: "仅支持 set/remove" });
  }
  if (!issues.length) {
    const canonical = canonicalConnectorOverlay(next);
    for (const [key, value] of Object.entries(canonical)) {
      const spec = schema.nodes[key];
      if (spec) validateNode(value, spec, `/${escapePointer(key)}`, issues, true);
    }
  }
  const defaults = parseSettingsFile(files.defaultFile), beforeEffective = mergeDeep(defaults, canonicalConnectorOverlay(currentOverride));
  const afterEffective = mergeDeep(defaults, canonicalConnectorOverlay(next));
  const normalizedPatches = issues.length ? [] : accepted.filter((patch) => {
    const parts = tokens(patch.path)!;
    if (patch.op === "remove") return valueAt(currentOverride, parts).exists;
    const previous = valueAt(currentOverride, parts);
    return !previous.exists || stable(previous.value) !== stable(patch.value);
  }).sort((a, b) => a.path.localeCompare(b.path));
  const redactedDiff: SettingsDiffEntry[] = issues.length ? [] : normalizedPatches.map((patch) => {
    const parts = tokens(patch.path)!, spec = schemaAt(schema, parts)!;
    const before = valueAt(beforeEffective, parts).value, after = valueAt(afterEffective, parts).value;
    return { path: patch.path, before: redact(before, parts.at(-1)), after: redact(after, parts.at(-1)), risk: spec.metadata!.risk };
  });
  const level: SettingRisk = redactedDiff.some((entry) => entry.risk === "critical") ? "critical" : redactedDiff.some((entry) => entry.risk === "high") ? "high" : "low";
  const confirmations = [
    ...(redactedDiff.some((entry) => entry.path === "/dashboard/port") ? ["dashboard-origin-change"] : []),
    ...(redactedDiff.some((entry) => /(?:Bin$|\/command$|\/positionsCmd$)/.test(entry.path)) ? ["command-execution"] : []),
    ...(redactedDiff.some((entry) => entry.path === "/architecture/allowFullAccess") ? ["full-access"] : []),
  ];
  return {
    valid: issues.length === 0, issues, sourceDigest: snapshot.sourceDigest, normalizedPatches,
    redactedDiff, risk: { level, approvalRequired: true, confirmations },
    candidateOverride: issues.length ? undefined : redact(next) as Record<string, unknown>,
    candidateOverrideRaw: issues.length ? undefined : next,
  };
}

const SECRET_KEY = /(?:password|secret|token|api[-_]?key|credential)/i;
export function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  return value;
}
