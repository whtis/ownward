import { modeBitsClear, ownedByCurrentUser } from "../posix-owner.ts";
import { capabilityMatches, readRunnerCapability, runnerPaths } from "./capability.ts";
import { encodeRunnerFrame, RunnerFrameDecoder, RUNNER_API_VERSION, type RunnerEnvelope, type RunnerRequestKind } from "./protocol.ts";
import { lstatSync } from "fs";

export class RunnerRequestUncertainError extends Error { readonly code = "RUNNER_REQUEST_OUTCOME_UNKNOWN"; constructor(message: string) { super(`${message}；这不代表命令已取消，请重连后 query-command`); } }
type Pending = { resolve: (value: RunnerEnvelope) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RunnerClient {
  private socket?: Bun.Socket<RunnerClient>;
  private connecting?: Promise<void>;
  private decoder = new RunnerFrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly outgoing: Uint8Array[] = [];
  private outgoingOffset = 0;
  private readonly capability: string;
  onPush?: (message: RunnerEnvelope) => void;
  constructor(readonly dataRoot: string, private readonly defaultTimeoutMs = 5_000) { this.capability = readRunnerCapability(dataRoot); }
  async connect(): Promise<void> {
    if (this.socket) return; if (this.connecting) return this.connecting;
    this.preflightSocket();
    this.connecting = new Promise<void>(async (resolve, reject) => {
      try {
        const client = this;
        await Bun.connect<RunnerClient>({ unix: runnerPaths(this.dataRoot).socket, data: this, socket: {
          binaryType: "buffer", open(socket) { client.socket = socket; client.decoder = new RunnerFrameDecoder(); resolve(); },
          data(_socket, bytes) { let frames: RunnerEnvelope[]; try { frames = client.decoder.push(bytes); } catch (error) { client.failPending(new RunnerRequestUncertainError(error instanceof Error ? error.message : "Runner frame 非法")); client.socket?.close(); return; } for (const frame of frames) client.receive(frame); },
          drain() { client.flush(); }, close() { client.disconnected(); }, end() { client.disconnected(); }, error(_socket, error) { client.failPending(new RunnerRequestUncertainError(error.message)); }, connectError(_socket, error) { reject(error); },
        }});
      } catch (error) { reject(error); }
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async request(kind: RunnerRequestKind, body: Record<string, unknown>, timeoutMs = this.defaultTimeoutMs): Promise<RunnerEnvelope> {
    await this.connect(); const requestId = `req-${crypto.randomUUID()}`;
    const envelope: RunnerEnvelope = { runnerApiVersion: RUNNER_API_VERSION, envelope: "request", requestId, capability: this.capability, kind, body };
    return new Promise<RunnerEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => { const error = new RunnerRequestUncertainError(`Runner 请求 ${requestId} 超时`); this.pending.delete(requestId); reject(error); this.disconnectWith(error); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.outgoing.push(encodeRunnerFrame(envelope)); this.flush(); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(new RunnerRequestUncertainError(error instanceof Error ? error.message : "Runner 写入失败")); }
    });
  }
  queryCommand(commandId: string, timeoutMs = this.defaultTimeoutMs, page: { afterSequence?: number; limit?: number } = {}) { return this.request("query-command", { commandId, ...page }, timeoutMs); }
  readHistory(input: { providerId: string; nativeRef: string; providerHome?: string; cwd?: string }, timeoutMs = this.defaultTimeoutMs) { return this.request("read-history", input, timeoutMs); }
  close(): void { this.socket?.close(); this.disconnected(); }
  private receive(frame: RunnerEnvelope): void {
    if (!capabilityMatches(this.capability, frame.capability)) { this.failPending(new RunnerRequestUncertainError("Runner 响应 capability 不匹配")); this.socket?.close(); return; }
    if (frame.envelope === "push") { this.onPush?.(frame); return; }
    const pending = this.pending.get(frame.requestId); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(frame.requestId);
    if (frame.kind === "error") pending.reject(Object.assign(new Error(String(frame.body.message || "Runner error")), { code: frame.body.code })); else pending.resolve(frame);
  }
  private flush(): void {
    if (!this.socket) return;
    while (this.outgoing.length) { const frame = this.outgoing[0]!, written = this.socket.write(frame, this.outgoingOffset, frame.byteLength - this.outgoingOffset); if (written < 0) { this.socket.close(); return; } if (written === 0) return; this.outgoingOffset += written; if (this.outgoingOffset < frame.byteLength) return; this.outgoing.shift(); this.outgoingOffset = 0; }
  }
  private preflightSocket(): void {
    const paths = runnerPaths(this.dataRoot);
    // Windows：Bun 把 unix socket 映射成命名管道，paths.socket 上不存在任何文件实体，
    // lstat 会 ENOENT，isSocket/uid/mode 三项都无从校验。归属由管道名（Runner 私有
    // data 目录）+ 连接后的 capability 握手保证，这里只确认目录在。
    if (process.platform === "win32") {
      if (!lstatSync(paths.dir).isDirectory()) throw new Error("Runner socket 目录非法");
      return;
    }
    const directory = lstatSync(paths.dir), socket = lstatSync(paths.socket);
    if (!directory.isDirectory() || !ownedByCurrentUser(directory) || !modeBitsClear(directory, 0o077)) throw new Error("Runner socket 目录权限或所有权非法");
    if (!socket.isSocket() || !ownedByCurrentUser(socket) || !modeBitsClear(socket, 0o077)) throw new Error("Runner socket 类型、权限或所有权非法");
  }
  private disconnectWith(error: Error): void { const socket = this.socket; this.socket = undefined; this.outgoing.length = 0; this.outgoingOffset = 0; socket?.close(); this.failPending(error); }
  private disconnected(): void { this.socket = undefined; this.outgoing.length = 0; this.outgoingOffset = 0; this.failPending(new RunnerRequestUncertainError("Runner 连接断开")); }
  private failPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
}
