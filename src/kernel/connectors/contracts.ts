export const CONNECTOR_KERNEL_API_VERSION = 1;

export type ConnectorCapability = "events" | "checkpoint" | "secrets";
export type ConnectorState = "discovered" | "disabled" | "starting" | "migration_failed" | "ready" | "degraded" | "failed" | "stopping";

export interface ConnectorManifest {
  id: string;
  name: string;
  version: string;
  kernelApiVersion: number;
  entry: string;
  capabilities: ConnectorCapability[];
  eventNamespaces: string[];
  /** Explicit event types allowed to bypass normal pending order. Empty by default. */
  priorityEventTypes?: string[];
  /** Latest observation replaces older deferred events of the same namespace/type. */
  singletonEventTypes?: string[];
}

export interface ConnectorEvent {
  /** Stable upstream identity. The same upstream fact MUST keep the same id across retries. */
  id: string;
  namespace: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ConnectorCheckpoint {
  version: 1;
  cursor: string;
  updatedAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ConnectorContext {
  readonly id: string;
  readonly generation: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  checkpoint(): Promise<ConnectorCheckpoint | null>;
  publish(events: readonly ConnectorEvent[], nextCheckpoint?: ConnectorCheckpoint): Promise<{ accepted: number; duplicates: number }>;
  secret(ref: string): Promise<string | undefined>;
  reportHealth(report:{ok:boolean;code?:string;message?:string;detail?:Record<string,unknown>}):Promise<void>;
  log(operation: string, message: string): void;
}
export interface ConnectorMigrationContext {readonly migrationId:string;readonly config:Readonly<Record<string,unknown>>;readonly storage:import("../extensions/contracts.ts").ScopedStorage;readonly log:(operation:string,message:string)=>void;}

export interface Connector {
  readonly manifest?: ConnectorManifest;
  /** Runs before start. Missing migrate is an explicit idempotent no-op. */
  migrate?(ctx: ConnectorMigrationContext): Promise<void> | void;
  start(ctx: ConnectorContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?(): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ConnectorStatus {
  id: string; name: string; version: string; source: "builtin" | "external"; state: ConnectorState;
  lastSuccessAt?: string; lastFailureAt?: string; errorCode?: string;
  errorMessage?: string;
  consecutiveFailures: number; accepted: number; duplicates: number; queueDepth: number;
}
