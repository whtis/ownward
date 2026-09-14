import type { DevImage, DevMsg, AgentControl } from "./types.ts";
import type { SessionProviderId } from "../../sessions/repository.ts";

export type SessionCapability = "stream" | "resume" | "interrupt" | "approval" | "images" | "tools" | "add-dir" | "set-access" | "set-options" | "new-session";
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
  model?: string; effort?: string;
  operability: "active" | "read-only"; archiveState?: "orphaned-task-link";
}
/** 会话谱系里的一条：接力链上的每个 Session（含当前）各一条，每条带它自己的原生会话 ID 与可直接粘贴的恢复命令。
 *  接力 / 就地换模型之后，用户要能查到「之前那个 claude 会话 ID 是什么、怎么在终端里接着聊」——历史保留了却找不到入口等于没保留。 */
export interface SessionLineageEntry {
  sessionId: string; providerId: SessionProviderId; model?: string; effort?: string; cwd: string;
  nativeRef: string | null; resume: { id: string; tool: string; cmd: string } | null;
  createdAt: string; handedOffAt?: string; reason?: string; current: boolean;
  /** 同一 Session 里被 /new 换掉的旧原生会话（仍可各自恢复） */
  previousRefs?: { nativeRef: string; resume: { id: string; tool: string; cmd: string } }[];
}
export interface KernelSessionState {
  messages: DevMsg[]; turn: string; alive: boolean; partial: string; pending: unknown[];
  backend: SessionProviderId; providerId: SessionProviderId; control: AgentControl;
  resume: { id: string; tool: string; cmd: string } | null;
  queued?: unknown[]; plan?: unknown[]; tokens?: unknown; model?: string; effort?: string; commands?: string[];
  ctxTokens?: number; ctxWindow?: number; lastActivityAt?: number; fullAccess?: boolean;
  stale?: boolean; errorCode?: string;
  operability?: "active" | "read-only"; archiveState?: "orphaned-task-link";
  handoff?: { predecessorId?: string; at: string; reason?: string; currentProviderId: SessionProviderId };
  lineage?: SessionLineageEntry[];
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
  /** 跨 Provider 接力；同 Provider 只换模型/深度时改道 reconfigure（inPlace=true，sessionId 不变） */
  handoff(id:string,input:{providerId:SessionProviderId;model?:string;effort?:string;reason?:string;confirmUnknownOutcome?:boolean}):Promise<SessionMutationResult & {sessionId:string;providerId:SessionProviderId;inPlace?:true}>;
  /** 同 Provider 就地改模型/思考深度：沿用原生会话（claude --resume / codex exec resume 都认新参数），不接力、不重放历史 */
  reconfigure(id:string,input:{model?:string;effort?:string}):Promise<SessionMutationResult & {sessionId:string;providerId:SessionProviderId;model?:string;effort?:string}>;
}
