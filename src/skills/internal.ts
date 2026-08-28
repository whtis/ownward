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
  effects: InternalSkillEffect[];
  registryAfter: import("./registry.ts").SkillRegistry;
}
