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
  /** 条目内部除自身外还嵌了多少个 SKILL.md。>0 表示这是个技能包，删它会连带删掉里面全部技能。 */
  nestedSkills: number;
  name: string;
  description: string | null;
  ownership: "discovered" | "managed" | "protected" | "missing";
  /** empty：目录里什么都没有（0 文件、非链接、无嵌套）。它不是 malformed——没有任何东西解析失败，
   *  而是看清了里面是空的。包管理器装残的壳就是这种；它是 delete 唯一正当的对象。 */
  state: "healthy" | "broken" | "unreadable" | "malformed" | "bounded" | "external" | "empty";
  readError: string | null;
  findings: Array<"duplicate" | "conflict" | "protected" | "broken">;
}

export interface SkillInventory {
  revision: string;
  /** 只覆盖可写根的指纹。审批门比对它而不是 revision：只读根由外部工具维护、也永远不是写入目标，
   *  拿它当门会让「codex 重刷自带 skill」这类无关动作否决用户已经点过的批准。 */
  mutableRevision: string;
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
  /** 只覆盖可写根的指纹。判断建议是否过期要用它而不是 revision：codex 每次运行都重写
   *  ~/.codex/skills/.system/** 这类只读根，revision 会无谓地抖，拿它判定会让建议秒秒钟"过期"。 */
  inventoryMutableRevision: string;
  generatedAt: string;
  source: "agent-metadata" | "deterministic-fallback";
  actions: SkillProposalAction[];
  notes: Array<{ severity: "info" | "warning"; code: string; message: string; observationIds: string[] }>;
  /** 这次分析实际发生了什么：给用户看的，不用翻 daemon.log。fallback 时也带，outcome 说清原因。 */
  diagnostics?: SkillAnalysisDiagnostics;
}

export interface SkillAnalysisDiagnostics {
  model: string;
  observationsSent: number;
  observationsActionable: number;
  promptBytes: number;
  receivedBytes: number;
  elapsedMs: number;
  timeoutMs: number;
  dropped: number;
  outcome: "agent" | "agent-empty-scope" | "timeout" | "exit" | "malformed" | "invalid-shape" | "error";
}

/** 分析进行中的实时状态，供 UI 轮询：没有它用户只能盯着一个灰掉的按钮猜是不是卡死了。 */
export interface SkillAnalysisProgress {
  phase: "preparing" | "waiting-model" | "receiving" | "validating";
  startedAt: string;
  model: string;
  observationsSent: number;
  promptBytes: number;
  receivedBytes: number;
  timeoutMs: number;
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
