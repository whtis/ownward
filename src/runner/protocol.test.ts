import { describe, expect, test } from "bun:test";
import { decodeRunnerFramePayload, encodeRunnerFrame, encodeRunnerFramePayload, parseRunnerEnvelope, parseRunnerRequestBody, RunnerFrameDecoder, RUNNER_API_VERSION, RUNNER_FRAME_HEADER_BYTES, RUNNER_MAX_BLOB_BYTES, RUNNER_MAX_FRAME_BYTES, RUNNER_MAX_INLINE_INPUT_BYTES } from "./protocol.ts";

const envelope = () => ({ runnerApiVersion: RUNNER_API_VERSION, envelope: "request" as const, requestId: "request-1", capability: "0123456789abcdef0123456789abcdef", kind: "ping" as const, body: {} });
describe("Runner protocol", () => {
  test("versioned strict envelope 可 round trip，并预留 4-byte frame", () => {
    expect(RUNNER_FRAME_HEADER_BYTES).toBe(4); expect(decodeRunnerFramePayload(encodeRunnerFramePayload(envelope()))).toEqual(envelope());
  });
  test("版本、未知字段、kind/capability 均 fail closed", () => {
    expect(() => parseRunnerEnvelope({ ...envelope(), runnerApiVersion: 2 })).toThrow("版本不兼容");
    expect(() => parseRunnerEnvelope({ ...envelope(), extra: 1 })).toThrow("未知字段");
    expect(() => parseRunnerEnvelope({ ...envelope(), kind: "completed" })).toThrow("不匹配");
    expect(() => parseRunnerEnvelope({ ...envelope(), capability: "short" })).toThrow("capability");
  });
  test("frame size 在编码和解码两端限制", () => {
    expect(RUNNER_MAX_BLOB_BYTES).toBeGreaterThan(RUNNER_MAX_FRAME_BYTES);
    expect(() => encodeRunnerFramePayload({ ...envelope(), body: { text: "x".repeat(RUNNER_MAX_FRAME_BYTES) } })).toThrow("大小上限");
    expect(() => decodeRunnerFramePayload(new Uint8Array(RUNNER_MAX_FRAME_BYTES + 1))).toThrow("大小上限");
  });
  test("非法 UTF-8 fatal，不替换成 U+FFFD 后继续解析", () => {
    expect(() => decodeRunnerFramePayload(Uint8Array.from([0xff, 0xfe, 0xfd]))).toThrow("UTF-8");
  });
  test("length decoder 处理半包、粘包与多帧，并在分配 payload 前拒绝 0/frame bomb", () => {
    const frame = encodeRunnerFrame(envelope()), decoder = new RunnerFrameDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]); expect(decoder.push(frame.subarray(2))).toEqual([envelope()]);
    expect(new RunnerFrameDecoder().push(Buffer.concat([frame, frame]))).toEqual([envelope(), envelope()]);
    expect(() => new RunnerFrameDecoder().push(Uint8Array.of(0, 0, 0, 0))).toThrow("不能为 0");
    const bomb = Buffer.alloc(4); bomb.writeUInt32BE(RUNNER_MAX_FRAME_BYTES + 1); expect(() => new RunnerFrameDecoder().push(bomb)).toThrow("超过上限");
  });
  test("每个 request kind 的 body 都按 schema allowlist 严格验证", () => {
    expect(parseRunnerRequestBody({ ...envelope(), kind: "query-command", body: { commandId: "cmd-1" } })).toEqual({ commandId: "cmd-1" });
    expect(parseRunnerRequestBody({ ...envelope(), kind: "quiesce", body: {} })).toEqual({});
    expect(parseRunnerRequestBody({ ...envelope(), kind: "resume", body: {} })).toEqual({});
    expect(() => parseRunnerRequestBody({ ...envelope(), kind: "quiesce", body: { activeRuns: [] } })).toThrow("未知字段");
    expect(() => parseRunnerRequestBody({ ...envelope(), body: { surprise: true } })).toThrow("未知字段");
    expect(() => parseRunnerRequestBody({ ...envelope(), kind: "submit", body: { commandId: "c", kind: "start-run", runId: "r", sessionId: "s", providerId: "fake", input: "x", shell: "rm" } })).toThrow("未知字段");
    expect(() => parseRunnerRequestBody({ ...envelope(), kind: "submit", body: { commandId: "c", kind: "start-run", runId: "r", sessionId: "s", providerId: "fake", input: "x", testPlan: {} } })).toThrow("未知字段");
    expect(() => parseRunnerRequestBody({ ...envelope(), kind: "submit", body: { commandId: "c", kind: "shell", runId: "r", sessionId: "s", providerId: "fake", input: "x" } })).toThrow("kind");
    let oversized: unknown; try { parseRunnerRequestBody({ ...envelope(), kind: "submit", body: { commandId: "c", kind: "start-run", runId: "r", sessionId: "s", providerId: "fake", input: "x".repeat(RUNNER_MAX_INLINE_INPUT_BYTES + 1) } }); } catch (error) { oversized = error; }
    expect(oversized).toMatchObject({ code: "RUNNER_INPUT_TOO_LARGE" });
    for (const kind of ["start-run", "resume-run", "send-input", "add-dir", "set-access", "new-session"] as const) {
      expect(parseRunnerRequestBody({ ...envelope(), kind: "submit", body: { commandId: `c-${kind}`, kind, runId: "r", sessionId: "s", providerId: "claude", input: "{}" } })).toMatchObject({ kind });
    }
  });
});
