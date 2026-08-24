import type { DevImage, DevMsg, AgentControl } from "./types.ts";
import type { SessionProviderId } from "../../sessions/repository.ts";

export type SessionCapability = "stream" | "resume" | "interrupt" | "approval" | "images" | "tools" | "add-dir" | "set-access" | "new-session";
export type KernelGrantedAccess = "workspace" | "full-access" | "bypass";
export function parseSessionMigrationMode(value: unknown): "off" | "runner" { if (value === undefined) return "runner"; if (value !== "off" && value !== "runner") throw new Error(`未知 sessionRunnerMode: ${String(value)}（仅支持 off/runner）`); return value; }
/** Runner canary is stable by persisted task identity. Empty allowlist means all tasks when mode=runner. */
export function validateSessionRunnerTaskIds(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new Error("sessionRunnerTaskIds 必须是字符串数组"); return [...new Set(value)]; }
export function effectiveSessionMigrationMode(value: unknown, identities: string | readonly string[], allowlist: unknown): "off" | "runner" { const mode = parseSessionMigrationMode(value), ids = Array.isArray(identities) ? identities : [identities], allowed = validateSessionRunnerTaskIds(allowlist); if (mode !== "runner") return mode; if (!allowed.length) return "runner"; return ids.some((id) => allowed.includes(id)) ? "runner" : "off"; }
export interface SessionInput { text: string; images?: DevImage[]; clientMutationId?: string; }
export interface KernelSessionGrants { roots: string[]; access: KernelGrantedAccess; }
export interface KernelSessionDto {
  id: string; providerId: SessionProviderId; nativeRef: string | null; cwd: string;
  control: AgentControl; recoverable: boolean; taskIds: string[];
  operability: "active" | "read-only"; archiveState?: "orphaned-task-link";
}
export interface KernelSessionState {
  messages: DevMsg[]; turn: string; alive: boolean; partial: string; pending: unknown[];
  backend: SessionProviderId; providerId: SessionProviderId; control: AgentControl;
  resume: { id: string; tool: string; cmd: string } | null;
  queued?: unknown[]; plan?: unknown[]; tokens?: unknown; model?: string; commands?: string[];
  ctxTokens?: number; lastActivityAt?: number; fullAccess?: boolean;
  stale?: boolean; errorCode?: string;
  operability?: "active" | "read-only"; archiveState?: "orphaned-task-link";
}
export interface SessionMutationResult { queued: boolean; commandId?: string; runId?: string; outcomeUnknown?: boolean; }
export interface SessionService {
  create(input: { taskId: string; providerId: SessionProviderId; cwd: string; control?: AgentControl; providerHome?: string; extraDirs?: string[]; model?: string; effort?: string }, grants: KernelSessionGrants): Promise<KernelSessionDto>;
  adopt(input: { taskId: string; providerId: SessionProviderId; nativeRef: string; providerHome?: string; cwd: string; control?: AgentControl }, grants: KernelSessionGrants): Promise<KernelSessionDto>;
  state(id: string): Promise<KernelSessionState>;
  send(id: string, input: SessionInput): Promise<SessionMutationResult>;
  /** 撤回一条还没发出的排队消息（按稳定 id，绝不按下标）。 */
  removeQueued(id: string, queueId: string): Promise<{ removed: boolean; queued: unknown[] }>;
  resume(id: string, input: SessionInput): Promise<SessionMutationResult>;
  interrupt(id: string): Promise<SessionMutationResult | void>;
  respondApproval(id: string, requestId: string, response: { allow: boolean; message?: string; remember?: "session" | "global" | null }): Promise<SessionMutationResult | void>;
  addDirectory(id: string, dir: string): Promise<SessionMutationResult | void>;
  acquireControl(id: string, owner: "ownward" | "observing"): Promise<{ sessionId: string; control: AgentControl }>;
  setAccess(id: string, access: KernelGrantedAccess): Promise<SessionMutationResult | void>;
  newSession(id: string): Promise<string>;
}
