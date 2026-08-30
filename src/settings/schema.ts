export const SETTINGS_SCHEMA_VERSION = 2 as const;

export type SettingTier = "public" | "advanced" | "internal";
export type SettingValueType = "object" | "array" | "string" | "number" | "boolean";
export type SettingRisk = "low" | "high" | "critical";

export interface SettingLeafMetadata {
  editable: boolean;
  sensitive: boolean;
  restart: "paired-release";
  risk: SettingRisk;
}

export interface SettingSchemaNode {
  type: SettingValueType;
  tier: SettingTier;
  default: unknown;
  children?: Record<string, SettingSchemaNode>;
  metadata?: SettingLeafMetadata;
}

export interface SettingsSchema {
  version: typeof SETTINGS_SCHEMA_VERSION;
  nodes: Record<string, SettingSchemaNode>;
}

const TIERS: Record<string, SettingTier> = {
  owner: "public", timezone: "public", quietHours: "public", notify: "public",
  vault: "public", heartbeat: "public", digest: "public", chat: "public",
  connectors: "public", strategy: "advanced", dashboard: "advanced",
  triage: "advanced", llm: "advanced", dispatch: "advanced", engine: "advanced",
  architecture: "internal", providers: "internal", release: "internal", verticals: "internal",
};

function valueType(value: unknown): SettingValueType {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  throw new Error(`不支持的设置默认值类型：${typeof value}`);
}

const INTERNAL_PATH = /^(?:\/architecture\/(?:sessionRunnerMode|sessionRunnerTaskIds)|\/release\/|\/verticals\/|\/connectors\/externalPaths$|\/connectors\/lark\/eventKeys$|\/providers\/[^/]+\/version$)/;
const ADVANCED_PATH = /^(?:\/dashboard\/|\/triage\/|\/llm\/|\/dispatch\/|\/engine\/|\/strategy\/|\/providers\/|\/architecture\/)/;
const HIGH_RISK_PATH = /(?:\/dashboard\/(?:port|listen)$|Bin$|\/command$|\/positionsCmd$|\/allowedRoots$|\/allowFullAccess$|\/worktreeRoot$|\/vault\/root$)/;
const SENSITIVE_PATH = /(?:password|secret|token|api[-_]?key|credential)/i;

function leafTier(path: string, inherited: SettingTier): SettingTier {
  if (INTERNAL_PATH.test(path)) return "internal";
  if (ADVANCED_PATH.test(path)) return "advanced";
  return inherited;
}

function node(value: unknown, tier: SettingTier, path = ""): SettingSchemaNode {
  const type = valueType(value);
  const children = type === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      return [key, node(child, tier, childPath)];
    }))
    : undefined;
  const resolvedTier = type === "object" ? tier : leafTier(path, tier);
  const metadata = type === "object" ? undefined : {
    editable: resolvedTier !== "internal",
    sensitive: SENSITIVE_PATH.test(path),
    restart: "paired-release" as const,
    risk: resolvedTier === "internal" ? "critical" as const : HIGH_RISK_PATH.test(path) ? "high" as const : "low" as const,
  };
  return { type, tier: resolvedTier, default: structuredClone(value), ...(children ? { children } : {}), ...(metadata ? { metadata } : {}) };
}

export function buildSettingsSchema(defaults: Record<string, unknown>): SettingsSchema {
  const unknown = Object.keys(defaults).filter((key) => !TIERS[key]);
  if (unknown.length) throw new Error(`未分类的顶层设置：${unknown.join(", ")}`);
  return {
    version: SETTINGS_SCHEMA_VERSION,
    nodes: Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, node(value, TIERS[key]!, `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)])),
  };
}

export function schemaLeafPointers(schema: SettingsSchema): string[] {
  const result: string[] = [];
  const walk = (children: Record<string, SettingSchemaNode>, prefix: string) => {
    for (const [key, child] of Object.entries(children)) {
      const pointer = `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (child.type === "object") walk(child.children ?? {}, pointer);
      else result.push(pointer);
    }
  };
  walk(schema.nodes, "");
  return result.sort();
}
