import type { SkillInventory, SkillObservation, SkillRoot } from "./contracts.ts";

/** Never serialize these objects. Public API receives only `inventory`. */
export interface RawSkillObservation extends SkillObservation {
  rawRoot: string;
  rawEntryPath: string;
  rawRealPath: string | null;
  rawLinkTarget: string | null;
}

export interface RawSkillSnapshot {
  inventory: SkillInventory;
  roots: SkillRoot[];
  observations: RawSkillObservation[];
}

export interface PathPrecondition {
  exists: boolean;
  nodeType: SkillObservation["nodeType"];
  identity: SkillObservation["entryIdentity"];
  parentIdentity: SkillObservation["parentIdentity"];
  digest: string | null;
  linkTarget: string | null;
}

export interface InternalSkillEffect {
  index: number;
  kind: import("./contracts.ts").SkillEffectKind;
  path: string;
  source?: string;
  target?: string;
  content?: string;
  mode?: number;
  destructive: boolean;
  summary: string;
  precondition: PathPrecondition;
  sourcePrecondition?: PathPrecondition;
}

export interface InternalSkillPlan {
  public: import("./contracts.ts").SkillPlan;
  /** 建计划那一刻【可写根】的指纹。审批后的复扫比对它：只读根（codex 自带 skill、plugin 缓存）
   *  由外部工具维护、也永远不是写入目标，它们变了不该否决用户已经点过的批准。 */
  mutableRevision: string;
  effects: InternalSkillEffect[];
  registryAfter: import("./registry.ts").SkillRegistry;
}
