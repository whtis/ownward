import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { dirname, isAbsolute, join } from "path";

export type BridgeCommandKind = "start-run" | "resume-run" | "send-input" | "interrupt" | "approval-response" | "add-dir" | "set-access" | "set-options" | "new-session";
export interface BridgeCommand { commandId: string; runId: string; taskId: string; sessionId: string; providerId: string; kind: BridgeCommandKind; inputHash: string; clientMutationId?: string; cursor: number; terminal: boolean; createdAt: string; errorCode?: string; authorizedRoots?: string[]; authorizedAccess?: "workspace" | "full-access" | "bypass"; }
interface SessionWatermark { sessionId: string; at: string; eventId: string; }
interface BridgeFile { schemaVersion: 1; commands: BridgeCommand[]; sessionWatermarks?: SessionWatermark[]; }
const pathFor = (root: string) => join(root, "session-runner-bridge.json");
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
function read(root: string): BridgeFile { const file = pathFor(root); if (!existsSync(file)) return { schemaVersion: 1, commands: [] }; const raw = JSON.parse(readFileSync(file, "utf8")); if (raw?.schemaVersion !== 1 || !Array.isArray(raw.commands) || Object.keys(raw).some((k) => !["schemaVersion", "commands", "sessionWatermarks"].includes(k))) throw new Error("session runner bridge journal 非法"); for (const c of raw.commands) { if (!c || typeof c !== "object" || !["start-run", "resume-run", "send-input", "interrupt", "approval-response", "add-dir", "set-access", "set-options", "new-session"].includes(c.kind) || Object.keys(c).some((k) => !["commandId", "runId", "taskId", "sessionId", "providerId", "kind", "inputHash", "clientMutationId", "cursor", "terminal", "createdAt", "errorCode", "authorizedRoots", "authorizedAccess"].includes(k)) || ["commandId", "runId", "taskId", "sessionId", "providerId", "inputHash", "createdAt"].some((k) => typeof c[k] !== "string" || !c[k]) || (c.clientMutationId !== undefined && (typeof c.clientMutationId !== "string" || !c.clientMutationId || c.clientMutationId.length > 128)) || !Number.isSafeInteger(c.cursor) || c.cursor < 0 || typeof c.terminal !== "boolean" || (c.errorCode !== undefined && typeof c.errorCode !== "string") || (c.authorizedRoots !== undefined && (!Array.isArray(c.authorizedRoots) || c.authorizedRoots.some((r: unknown) => typeof r !== "string" || !isAbsolute(r)))) || (c.authorizedAccess !== undefined && !["workspace", "full-access", "bypass"].includes(c.authorizedAccess))) throw new Error("session runner bridge command 非法"); } if (raw.sessionWatermarks !== undefined && (!Array.isArray(raw.sessionWatermarks) || raw.sessionWatermarks.some((w: any) => !w || typeof w.sessionId !== "string" || typeof w.at !== "string" || typeof w.eventId !== "string"))) throw new Error("session runner bridge watermark 非法"); return raw; }
function write(root: string, value: BridgeFile): void { mkdirSync(root, { recursive: true }); const file = pathFor(root), tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, file); const dfd = openSync(dirname(file), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } }
/**
 * bridge 是控制面台账（每条命令的 cursor/terminal），不是历史记录，但此前从不清理：
 * 2026-09-09 实测生产上 791 条里 786 条早已终结，最早追到 24 天前，文件 393KB。
 * 代价在热路径上——advance() 每收到一批事件就要把整份文件 parse + stringify + fsync 重写，
 * 只为改一条记录的一个字段（实测 788 条时 0.94ms/次，只剩活跃记录时 0.21ms）。文件多大，
 * 每次推进就多贵，而且只会一路涨。
 *
 * 四条保留口径，后三条都有明确调用方依赖，别当冗余删掉：
 *  ① 未终结：还在跑，动不得
 *  ② clientMutationId 以 `handoff:` 开头：会话历史靠这批 commandId 把接力产生的内部消息
 *     藏起来（service.ts 里的 internalIds）。剪掉老的接力命令 = 那些内部消息突然在历史里显形
 *  ③ 每个会话最新的一条：send() 用 `list(sessionId).length` 判断「这会话有没有过命令」，
 *     剪到空会让老会话重新去走 rejectLiveLegacyOwner
 *  ④ 窗口内：留给排查
 * ①②③ 构成不随时间增长的地板（实测 94 个会话 + 16 条接力），④ 才是随用量走的部分。
 */
export const BRIDGE_COMMAND_RETENTION_DAYS = 7;
export interface BridgePruneResult { pruned: number; kept: number }

export function pruneBridgeCommands(dataRoot: string, opts: { retentionDays?: number; now?: Date } = {}): BridgePruneResult {
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.retentionDays ?? BRIDGE_COMMAND_RETENTION_DAYS) * 86_400_000;
  const store = read(dataRoot), newestPerSession = new Map<string, { at: number; commandId: string }>();
  for (const c of store.commands) {
    const at = Date.parse(c.createdAt) || 0, prior = newestPerSession.get(c.sessionId);
    if (!prior || at > prior.at) newestPerSession.set(c.sessionId, { at, commandId: c.commandId });
  }
  const pinned = new Set([...newestPerSession.values()].map((v) => v.commandId));
  const keep = store.commands.filter((c) => !c.terminal || c.clientMutationId?.startsWith("handoff:") || pinned.has(c.commandId) || (Date.parse(c.createdAt) || 0) >= cutoff);
  const pruned = store.commands.length - keep.length;
  if (!pruned) return { pruned: 0, kept: keep.length };
  write(dataRoot, { ...store, commands: keep });
  return { pruned, kept: keep.length };
}

type ReserveInput = Omit<BridgeCommand, "commandId" | "runId" | "cursor" | "terminal" | "createdAt" | "inputHash"> & { serializedInput: string; targetRunId?: string; identity?: { commandId: string; runId: string } };
export class SessionRunnerBridgeStore {
  constructor(readonly dataRoot: string) {}
  private match(store: BridgeFile, input: ReserveInput): BridgeCommand | undefined {
    const inputHash = hash(input.serializedInput), turns = new Set<BridgeCommandKind>(["start-run", "resume-run", "send-input"]), isTurn = turns.has(input.kind);
    return store.commands.find((c) => !c.terminal && c.sessionId === input.sessionId && c.taskId === input.taskId && c.providerId === input.providerId && c.inputHash === inputHash && (!isTurn || (!!input.clientMutationId && c.clientMutationId === input.clientMutationId)) && (c.kind === input.kind || (turns.has(c.kind) && turns.has(input.kind))) && (!input.targetRunId || c.runId === input.targetRunId) && JSON.stringify(c.authorizedRoots ?? []) === JSON.stringify(input.authorizedRoots ?? []) && c.authorizedAccess === input.authorizedAccess);
  }
  /** 同 reserve 的匹配口径，但只看不写：调用方需要先判断「这是不是一次重试」再决定走哪条路。 */
  find(input: ReserveInput): BridgeCommand | undefined { const existing = this.match(read(this.dataRoot), input); return existing ? structuredClone(existing) : undefined; }
  reserve(input: ReserveInput): { command: BridgeCommand; reused: boolean } {
    const store = read(this.dataRoot), inputHash = hash(input.serializedInput), existing = this.match(store, input);
    if (existing) return { command: structuredClone(existing), reused: true };
    const command: BridgeCommand = { commandId: input.identity?.commandId ?? crypto.randomUUID(), runId: input.identity?.runId ?? input.targetRunId ?? crypto.randomUUID(), taskId: input.taskId, sessionId: input.sessionId, providerId: input.providerId, kind: input.kind, inputHash, cursor: 0, terminal: false, createdAt: new Date().toISOString(), ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}), ...(input.authorizedRoots ? { authorizedRoots: [...input.authorizedRoots] } : {}), ...(input.authorizedAccess ? { authorizedAccess: input.authorizedAccess } : {}) };
    store.commands.push(command); write(this.dataRoot, store); return { command: structuredClone(command), reused: false };
  }
  list(sessionId?: string): BridgeCommand[] { return read(this.dataRoot).commands.filter((c) => !sessionId || c.sessionId === sessionId).map((c) => structuredClone(c)); }
  advance(commandId: string, cursor: number, terminal: boolean): void { const store = read(this.dataRoot), c = store.commands.find((x) => x.commandId === commandId); if (!c) throw new Error("bridge command 不存在"); if (cursor < c.cursor) return; if (cursor === c.cursor && (!terminal || c.terminal)) return; c.cursor = cursor; c.terminal ||= terminal; write(this.dataRoot, store); }
  abandon(commandId: string, errorCode: string): void { const store = read(this.dataRoot), c = store.commands.find((x) => x.commandId === commandId); if (!c) throw new Error("bridge command 不存在"); if (c.terminal) return; c.terminal = true; c.errorCode = errorCode || "RUNNER_SUBMIT_REJECTED"; write(this.dataRoot, store); }
  markError(commandId: string, errorCode?: string): void { const store = read(this.dataRoot), c = store.commands.find((x) => x.commandId === commandId); if (!c || c.errorCode === errorCode) return; if (errorCode) c.errorCode = errorCode; else delete c.errorCode; write(this.dataRoot, store); }
  isNewSessionEvent(sessionId: string, at: string, eventId: string): boolean { const old = (read(this.dataRoot).sessionWatermarks ?? []).find((x) => x.sessionId === sessionId); return !old || at > old.at || (at === old.at && eventId > old.eventId); }
  markSessionEvent(sessionId: string, at: string, eventId: string): void { const store = read(this.dataRoot), list = store.sessionWatermarks ?? (store.sessionWatermarks = []), old = list.find((x) => x.sessionId === sessionId); if (old && (old.at > at || (old.at === at && old.eventId >= eventId))) return; if (old) Object.assign(old, { at, eventId }); else list.push({ sessionId, at, eventId }); write(this.dataRoot, store); }
}
