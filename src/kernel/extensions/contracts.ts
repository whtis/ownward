export const KERNEL_API_VERSION = 1;

/** Kernel 的语义化版本。必须与 package.json 的 version 一致（有测试盯着）。
 *
 *  和 KERNEL_API_VERSION 分工不同，别混：
 *    KERNEL_API_VERSION  代际契约。不等 = 契约不兼容，Vertical 直接拒载。
 *                        只有删/改既有 API 才动它。
 *    KERNEL_VERSION      同一代内的演进。只做加法时递增 minor/patch，
 *                        Vertical 用 manifest 的 minKernelVersion 声明
 *                        「我用到了哪一版才有的东西」。
 *
 *  没有 minKernelVersion 的话，「新 Vertical 装到老 Kernel」会一路放行到
 *  运行时才炸（老 Kernel 的方法分发链走到末尾抛 EXTENSION_KERNEL_METHOD_DENIED），
 *  用户看到的是「页面打得开，一点某个功能就报错」。 */
export const KERNEL_VERSION = "1.1.3";

export type VerticalState = "discovered" | "disabled" | "starting" | "migration_failed" | "ready" | "degraded" | "failed" | "stopping";
export type VerticalCapability = "storage" | "sessions" | "tasks" | "tasks:full-access" | "actions" | "events" | "scheduler" | "notify" | "vault" | "llm" | "sources";

export interface VerticalManifest {
  id: string;
  name: string;
  version: string;
  kernelApiVersion: number;
  /** 可选。Vertical 声明自己最低需要哪一版 Kernel（x.y.z）。
   *  Kernel 比这个旧就拒载，而不是等到调用时才失败。 */
  minKernelVersion?: string;
  entry: string;
  capabilities?: VerticalCapability[];
  roots?: string[];
  vault?: { scopes: string[]; sensitivity: "normal" | "sensitive" };
  routes?: string[];
  navigation?: { id: string; label: string; href: string }[];
  assets?: { path: string; file: string; contentType?: string }[];
  commands?: { id: string; title: string; schema?: Record<string, unknown> }[];
  subscriptions?: { namespace: string; event: string }[];
}

/** builtin 实现是同步的；external Vertical 经 host RPC 拿到的是 Promise 版。调用方一律 await（await 非 Promise 无害）。 */
export interface ScopedStorage {
  readJson<T>(key: string): T | null | Promise<T | null>;
  writeJson(key: string, value: unknown): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}
export interface ScopedScheduler {
  every(id: string, intervalMs: number, job: (signal: AbortSignal) => Promise<void> | void): void;
}
export interface ScopedSessions {
  create(input: { taskId: string; providerId: "claude" | "codex" | "codebuddy"; cwd: string; control?: "ownward" | "observing" | "external" }): Promise<unknown>;
  adopt(input: { taskId: string; providerId: "claude" | "codex" | "codebuddy"; nativeRef: string; cwd: string; control?: "ownward" | "observing" | "external" }): Promise<unknown>;
  send(id: string, input: { text: string; clientMutationId?: string }): Promise<unknown>;
  state(id: string): Promise<unknown>;
  interrupt(id: string): Promise<unknown>;
}
export interface ScopedTasks {
  startWork(input: { dir: string; task: string; bg?: boolean; codex?: boolean; provider?: "claude" | "codex" | "codebuddy"; worktree?: boolean; model?: string; effort?: string; permission?: "safe"|"bypass"; extraDirs?: string[]; images?: { media_type: string; data: string }[] }): Promise<unknown>;
  list(): Promise<unknown[]> | unknown[];
}
export interface ScopedAction {
  readonly id: string;
  readonly source: string;
  readonly kind: "reply" | "review" | "approve" | "follow_up" | "decide";
  readonly title: string;
  readonly reason: string;
  readonly state: "open" | "snoozed" | "processing" | "resolved" | "dismissed";
  readonly createdAt: string;
  readonly ref: Readonly<{ url?: string; task_id?: string; note?: string }>;
}
/** builtin 实现是同步的；external Vertical 经 host RPC 拿到的是 Promise 版。调用方一律 await（await 非 Promise 无害）。 */
/** 决策模型（抽取/判断）：Kernel 统一提供引擎链、沙箱、超时与审计。
 *  Vertical 不该自己 spawn CLI——「收割→提醒」的三条腿里，抽取这条必须是 Kernel 能力，
 *  否则沙箱纪律要在每个 Vertical 里重写一遍，写错一次就是一个越权读文件的口子。 */
export interface DecisionEngineOption {
  engine: string;
  models: string[];
  defaultModel?: string;
  /** 兼容字段只追加不改语义：旧 Vertical 仍可只读 engine/models。 */
  installState?: "not-installed" | "installed";
  /** unknown 表示底座没有可靠、无副作用的认证探针，绝不能解释为已连接。 */
  authState?: "connected" | "needs-login" | "unknown";
  setup?: Readonly<{ command: string; loginCommand: string; loginHint?: string }>;
}
export interface ScopedLlm {
  /** 返回 null = 引擎链全部不可用、输出不可解析、或指定的引擎/模型不在白名单（绝不编造，也绝不悄悄换一个跑）。
   *  engine/model 省略时按底座配置的引擎链依次降级；指定了就只用那一个（顾问在界面上选了什么就是什么）。 */
  complete(input: { prompt: string; json?: boolean; schema?: Record<string, unknown>; filePath?: string; timeoutMs?: number; engine?: string; model?: string }): Promise<unknown | null>;
  /** 可选项由底座下发——Vertical 不该自己猜有哪些引擎可用，界面上也就不会出现选了却跑不通的选项。 */
  engines(): Promise<DecisionEngineOption[]>;
}
export type SourceProvider = "lark";
export type SourceDocumentType = "doc" | "docx";
export interface SourceProviderStatus {
  provider: SourceProvider;
  available: boolean;
  authenticated: boolean;
  identity: "user";
  message?: string;
}
export interface SourceDocumentDescriptor {
  provider: SourceProvider;
  identity: "user";
  canonicalId: string;
  type: SourceDocumentType;
  title: string;
  url: string;
}
export interface SourceDocumentSnapshot extends SourceDocumentDescriptor {
  revision: string;
  contentHash: string;
  contentType: "text/markdown";
  content: string;
  fetchedAt: string;
}
/** 外部资料读取由 Kernel 统一适配认证、CLI、超时和权限；Vertical 只声明业务归属。 */
export interface ScopedSources {
  status(provider: SourceProvider): Promise<SourceProviderStatus>;
  inspect(input: { provider: SourceProvider; url: string }): Promise<SourceDocumentDescriptor>;
  fetch(input: { provider: SourceProvider; url: string }): Promise<SourceDocumentSnapshot>;
}
export interface ScopedActions {
  list(): readonly ScopedAction[] | Promise<readonly ScopedAction[]>;
  /** id 必须带 `<verticalId>:` 前缀；source 由实现强制为本 Vertical id，不接受伪造。幂等：同 id open 只更新内容。 */
  open(input: { id: string; kind: ScopedAction["kind"]; title: string; reason: string; ref?: { url?: string; task_id?: string; note?: string } }): boolean | Promise<boolean>;
  /** 只允许精确 id，且实现必须再次校验 action 属于本 Vertical 的 source scope。 */
  resolve(id: string, resolution: string): boolean | Promise<boolean>;
  dismiss(id: string): boolean | Promise<boolean>;
}
export interface VerticalContext {
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly storage?: ScopedStorage;
  readonly sessions?: ScopedSessions;
  readonly tasks?: ScopedTasks;
  readonly actions?: ScopedActions;
  readonly events?: Readonly<Record<string, never>>;
  readonly scheduler?: ScopedScheduler;
  readonly llm?: ScopedLlm;
  readonly sources?: ScopedSources;
  readonly notify?: Readonly<Record<string, never>>;
  readonly vault?: { readonly scopes: readonly string[]; readonly sensitivity: "normal" | "sensitive" };
  readonly log: (operation: string, message: string) => void;
}
export interface VerticalMigrationContext {readonly migrationId:string;readonly config:Readonly<Record<string,unknown>>;readonly storage?:ScopedStorage;readonly log:(operation:string,message:string)=>void;}
export interface VerticalRouteContext { request: Request; url: URL; signal: AbortSignal; }
export interface OwnwardVertical {
  manifest?: VerticalManifest;
  /** Runs before activate. Missing migrate is an explicit idempotent no-op. */
  migrate?(ctx: VerticalMigrationContext): Promise<void> | void;
  activate(ctx: VerticalContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
  route?(ctx: VerticalRouteContext): Promise<Response | null> | Response | null;
  health?(): Promise<Record<string, unknown>> | Record<string, unknown>;
}
export interface VerticalStatus {
  id: string; name: string; version: string; source: "builtin" | "external"; state: VerticalState;
  lastSuccessAt?: string; lastFailureAt?: string; errorCode?: string; consecutiveFailures: number;
}
