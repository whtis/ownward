export type SkillEngine = "claude" | "codex" | "codebuddy";
export type SkillScope = "user" | "project" | "system" | "plugin";

export interface SkillRoot {
  id: string;
  engine: SkillEngine;
  path: string;
  scope: SkillScope;
  protected: boolean;
  precedence: number | null;
  precedenceStatus: "declared" | "unknown";
  mutationCapability: "read-write" | "explicit-only" | "read-only";
  capabilityReason: string | null;
}

export type SkillAdapterCapability = "read-write" | "read-only" | "unavailable" | "unknown";
export interface SkillAdapterStatus {
  engine: SkillEngine;
  matrixVersion: 1;
  platform: string;
  detectedVersion: string | null;
  capability: SkillAdapterCapability;
  verification: "disk-only" | "loadable" | "unavailable";
  reason: string | null;
  supportedVersionRange: string;
  versionStatus: "supported" | "unsupported" | "unknown";
}

export interface FileIdentity { dev: number; ino: number; mode: number }

export interface SkillObservation {
  id: string;
  engine: SkillEngine;
  scope: SkillScope;
  root: string;
  entryPath: string;
  displayPath: string;
  realPath: string | null;
  linkTarget: string | null;
  nodeType: "directory" | "symlink" | "file" | "other" | "missing";
  parentIdentity: FileIdentity | null;
  entryIdentity: FileIdentity | null;
  physicalIdentity: FileIdentity | null;
  treeDigest: string | null;
  targetTreeDigest: string | null;
  bytes: number;
  files: number;
  name: string;
  description: string | null;
  ownership: "discovered" | "managed" | "protected" | "missing";
  state: "healthy" | "broken" | "unreadable" | "malformed" | "bounded" | "external";
  readError: string | null;
  findings: Array<"duplicate" | "conflict" | "protected" | "broken">;
}

export interface SkillInventory {
  revision: string;
  scannedAt: string;
  roots: SkillRoot[];
  observations: SkillObservation[];
  summary: { total: number; duplicates: number; conflicts: number; protected: number; broken: number };
  warnings: string[];
  completeness: "complete" | "partial";
  budget: { entries: number; files: number; bytes: number; elapsedMs: number };
  adapters: SkillAdapterStatus[];
  catalog: SkillCatalogEntry[];
}

export interface SkillCatalogEntry {
  logicalId: string;
  name: string;
  description: string | null;
  digest: string | null;
  ownership: "discovered" | "managed" | "protected" | "missing";
  observationIds: string[];
  engines: SkillEngine[];
  scopes: SkillScope[];
  findings: SkillObservation["findings"];
}

export type SkillProposalAction =
  | { kind: "adopt"; observationIds: string[]; expose?: Array<{ engine: SkillEngine; scope: "user" | "project"; projectRoot?: string; targetRootId?: string }> }
  | { kind: "repair"; skillId: string; engine: SkillEngine; scope: "user" | "project"; projectRoot?: string; targetRootId?: string }
  | { kind: "migrate"; skillId: string; fromObservationId?: string; engine: SkillEngine; scope: "user" | "project"; projectRoot?: string; targetRootId?: string; removeSource?: boolean }
  | { kind: "delete"; observationId: string };

export interface SkillAnalysisProposal {
  proposalVersion: 1;
  inventoryRevision: string;
  generatedAt: string;
  source: "agent-metadata" | "deterministic-fallback";
  actions: SkillProposalAction[];
  notes: Array<{ severity: "info" | "warning"; code: string; message: string; observationIds: string[] }>;
}

export type SkillEffectKind = "mkdir" | "copy-tree" | "create-link" | "replace-with-link" | "delete-entry" | "write-registry";
export interface PublicSkillEffect {
  index: number;
  kind: SkillEffectKind;
  path: string;
  source?: string;
  target?: string;
  destructive: boolean;
  summary: string;
}
export interface SkillPlan {
  id: string;
  transactionId: string;
  version: 1;
  inventoryRevision: string;
  createdAt: string;
  expiresAt: string;
  digest: string;
  requiresApproval: boolean;
  effects: PublicSkillEffect[];
  registryRevision: string;
}

export type SkillTransactionPhase = "prepared" | "approved" | "applying" | "verifying" | "committed" | "rolling-back" | "rolled-back" | "manual-repair";
export interface PublicSkillTransaction {
  id: string;
  planId: string;
  phase: SkillTransactionPhase;
  createdAt: string;
  updatedAt: string;
  currentEffect: number | null;
  errorCode: string | null;
  rollbackStatus: "not-needed" | "pending" | "complete" | "failed";
  verification: Array<{ engine: SkillEngine; status: "disk-only" | "loadable" | "failed"; message: string }>;
}

export interface SkillScanOptions {
  home: string;
  codexHome?: string;
  projectRoots?: string[];
  limits?: Partial<{ maxEntries: number; maxFiles: number; maxBytes: number; maxFilesPerSkill: number; maxBytesPerSkill: number; maxDepth: number; deadlineMs: number }>;
  storeRoot?: string;
  platform?: string;
  adapterStatus?: Partial<Record<SkillEngine, SkillAdapterStatus>>;
}
