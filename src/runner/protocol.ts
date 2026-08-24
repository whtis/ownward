import { isAbsolute } from "path";
export const RUNNER_API_VERSION = 1 as const;
export const RUNNER_SUPPORTED_API_VERSIONS = [RUNNER_API_VERSION] as const;
export const RUNNER_FRAME_HEADER_BYTES = 4;
export const RUNNER_MAX_FRAME_BYTES = 1024 * 1024;
export const RUNNER_MAX_BLOB_BYTES = 8 * 1024 * 1024;
// envelope/IDs/JSON escaping 必须留预算；最终编码仍由 RUNNER_MAX_FRAME_BYTES 做精确硬闸。
export const RUNNER_MAX_INLINE_INPUT_BYTES = RUNNER_MAX_FRAME_BYTES - 64 * 1024;

export const RUNNER_REQUEST_KINDS = ["submit", "query-command", "read-history", "interrupt", "approval-response", "ping", "quiesce", "resume"] as const;
export const RUNNER_RESPONSE_KINDS = ["accepted", "command-status", "ok", "error", "pong"] as const;
export const RUNNER_PUSH_KINDS = ["run-event"] as const;
export type RunnerRequestKind = typeof RUNNER_REQUEST_KINDS[number];
export type RunnerResponseKind = typeof RUNNER_RESPONSE_KINDS[number];
export type RunnerPushKind = typeof RUNNER_PUSH_KINDS[number];

export interface RunnerEnvelope {
  runnerApiVersion: 1;
  envelope: "request" | "response" | "push";
  requestId: string;
  capability: string;
  kind: RunnerRequestKind | RunnerResponseKind | RunnerPushKind;
  body: Record<string, unknown>;
}

export type RunnerSubmitBody = {
  commandId: string; kind: "start-run" | "resume-run" | "send-input" | "add-dir" | "set-access" | "new-session"; runId: string; sessionId: string; providerId: string; input: string;
};
export type RunnerInterruptBody = { commandId: string; runId: string; sessionId: string; providerId: string };
export type RunnerApprovalBody = RunnerInterruptBody & { approvalRequestId: string; input: string };
export type RunnerHistoryBody = { providerId: string; nativeRef: string; providerHome?: string; cwd?: string };
export type RunnerRequestBody = RunnerSubmitBody | RunnerInterruptBody | RunnerApprovalBody | RunnerHistoryBody | { commandId: string } | Record<string, never>;

const bodyKeys: Record<RunnerRequestKind, ReadonlySet<string>> = {
  submit: new Set(["commandId", "kind", "runId", "sessionId", "providerId", "input"]),
  "query-command": new Set(["commandId", "afterSequence", "limit"]),
  "read-history": new Set(["providerId", "nativeRef", "providerHome", "cwd"]),
  interrupt: new Set(["commandId", "runId", "sessionId", "providerId"]),
  "approval-response": new Set(["commandId", "runId", "sessionId", "providerId", "approvalRequestId", "input"]),
  ping: new Set(),
  quiesce: new Set(),
  resume: new Set(),
};
const requiredId = (body: Record<string, unknown>, key: string) => { if (typeof body[key] !== "string" || !ids.test(body[key] as string)) throw new Error(`Runner body ${key} 非法`); };
const requiredText = (body: Record<string, unknown>, key: string) => {
  if (typeof body[key] !== "string") throw Object.assign(new Error(`Runner body ${key} 非法`), { code: "RUNNER_INPUT_INVALID" });
  if (Buffer.byteLength(body[key] as string) > RUNNER_MAX_INLINE_INPUT_BYTES) throw Object.assign(new Error(`Runner body ${key} 超过 inline 上限；大附件必须先写 blob ref`), { code: "RUNNER_INPUT_TOO_LARGE" });
};

export function parseRunnerRequestBody(envelope: RunnerEnvelope): RunnerRequestBody {
  if (envelope.envelope !== "request") throw new Error("只接受 Runner request");
  const kind = envelope.kind as RunnerRequestKind, body = envelope.body;
  if (Object.keys(body).some((key) => !bodyKeys[kind].has(key))) throw new Error(`Runner ${kind} body 含未知字段`);
  if (kind === "ping" || kind === "quiesce" || kind === "resume") { if (Object.keys(body).length) throw new Error(`Runner ${kind} body 必须为空`); return {}; }
  if (kind === "read-history") {
    for (const key of ["providerId", "nativeRef"]) requiredId(body, key);
    if (body.providerHome !== undefined && (typeof body.providerHome !== "string" || !body.providerHome)) throw new Error("Runner providerHome 非法");
    if (body.cwd !== undefined && (typeof body.cwd !== "string" || !isAbsolute(body.cwd))) throw new Error("Runner cwd 非法");
    return structuredClone(body) as RunnerHistoryBody;
  }
  requiredId(body, "commandId");
  if (kind === "query-command") {
    if (body.afterSequence !== undefined && (!Number.isSafeInteger(body.afterSequence) || (body.afterSequence as number) < 0)) throw new Error("Runner afterSequence 非法");
    if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 500)) throw new Error("Runner limit 非法");
    return structuredClone(body) as { commandId: string; afterSequence?: number; limit?: number };
  }
  for (const key of ["runId", "sessionId", "providerId"]) requiredId(body, key);
  if (kind === "interrupt") return structuredClone(body) as RunnerInterruptBody;
  if (kind === "approval-response") { requiredId(body, "approvalRequestId"); requiredText(body, "input"); return structuredClone(body) as RunnerApprovalBody; }
  if (!["start-run", "resume-run", "send-input", "add-dir", "set-access", "new-session"].includes(String(body.kind))) throw new Error("Runner submit command kind 非法");
  requiredText(body, "input");
  return structuredClone(body) as RunnerSubmitBody;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ids = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function parseRunnerEnvelope(raw: unknown): RunnerEnvelope {
  if (!plain(raw)) throw new Error("Runner envelope 不是对象");
  const allowed = new Set(["runnerApiVersion", "envelope", "requestId", "capability", "kind", "body"]);
  if (Object.keys(raw).some((k) => !allowed.has(k))) throw new Error("Runner envelope 含未知字段");
  if (typeof raw.runnerApiVersion !== "number" || !(RUNNER_SUPPORTED_API_VERSIONS as readonly number[]).includes(raw.runnerApiVersion)) throw Object.assign(new Error(`Runner API 版本不兼容: ${String(raw.runnerApiVersion)}`), { code: "RUNNER_API_VERSION_UNSUPPORTED" });
  if (raw.envelope !== "request" && raw.envelope !== "response" && raw.envelope !== "push") throw new Error("Runner envelope 类型非法");
  if (typeof raw.requestId !== "string" || !ids.test(raw.requestId)) throw new Error("Runner requestId 非法");
  // 这里只定义 capability 槽位；真正 token 的生成、0600 文件和恒定时间比较由 socket 阶段实现。
  if (typeof raw.capability !== "string" || raw.capability.length < 32 || raw.capability.length > 512) throw new Error("Runner capability 非法");
  if (typeof raw.kind !== "string") throw new Error("Runner kind 非法");
  const kinds: readonly string[] = raw.envelope === "request" ? RUNNER_REQUEST_KINDS : raw.envelope === "response" ? RUNNER_RESPONSE_KINDS : RUNNER_PUSH_KINDS;
  if (!kinds.includes(raw.kind)) throw new Error("Runner kind 与 envelope 不匹配");
  if (!plain(raw.body)) throw new Error("Runner body 必须是对象");
  return structuredClone(raw) as unknown as RunnerEnvelope;
}

export function encodeRunnerFramePayload(envelope: RunnerEnvelope): Uint8Array {
  const verified = parseRunnerEnvelope(envelope), bytes = Buffer.from(JSON.stringify(verified));
  if (bytes.byteLength > RUNNER_MAX_FRAME_BYTES) throw Object.assign(new Error("Runner frame 超过大小上限"), { code: "RUNNER_FRAME_TOO_LARGE" });
  return bytes;
}

export function decodeRunnerFramePayload(bytes: Uint8Array): RunnerEnvelope {
  if (bytes.byteLength > RUNNER_MAX_FRAME_BYTES) throw Object.assign(new Error("Runner frame 超过大小上限"), { code: "RUNNER_FRAME_TOO_LARGE" });
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("Runner frame 不是合法 UTF-8 JSON"); }
  return parseRunnerEnvelope(raw);
}

export function encodeRunnerFrame(envelope: RunnerEnvelope): Uint8Array {
  const payload = encodeRunnerFramePayload(envelope), frame = Buffer.allocUnsafe(RUNNER_FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0); frame.set(payload, RUNNER_FRAME_HEADER_BYTES); return frame;
}

export class RunnerFrameDecoder {
  private buffered = Buffer.alloc(0);
  push(chunk: Uint8Array): RunnerEnvelope[] {
    if (chunk.byteLength) this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: RunnerEnvelope[] = [];
    while (this.buffered.byteLength >= RUNNER_FRAME_HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(0);
      if (length === 0) throw Object.assign(new Error("Runner frame 长度不能为 0"), { code: "RUNNER_FRAME_EMPTY" });
      if (length > RUNNER_MAX_FRAME_BYTES) throw Object.assign(new Error("Runner frame 声明长度超过上限"), { code: "RUNNER_FRAME_TOO_LARGE" });
      if (this.buffered.byteLength < RUNNER_FRAME_HEADER_BYTES + length) break;
      const payload = this.buffered.subarray(RUNNER_FRAME_HEADER_BYTES, RUNNER_FRAME_HEADER_BYTES + length);
      this.buffered = this.buffered.subarray(RUNNER_FRAME_HEADER_BYTES + length); frames.push(decodeRunnerFramePayload(payload));
    }
    return frames;
  }
}
