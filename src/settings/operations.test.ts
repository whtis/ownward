import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ApprovalError, ApprovalStore, approvalBinding } from "../control-plane/approval.ts";
import { approveSettingsOperation, applySettingsOperation, captureSettingsFileImage, recoverSettingsOperations, SettingsOperationStore, type SettingsDeploymentExecutor } from "./operations.ts";
import { loadSettings, validateSettingsPatches } from "./service.ts";
import { routeSettings } from "./routes.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(localText = '{"owner":{"name":"old"}}\n') {
  const root = mkdtempSync(join(tmpdir(), "ownward-settings-op-")); roots.push(root);
  const defaultFile = join(root, "default.json"), source = join(root, "source"), overrideFile = join(source, "config.json");
  mkdirSync(source);
  writeFileSync(defaultFile, readFileSync(join(import.meta.dir, "../../config.default.json")));
  writeFileSync(overrideFile, localText, { mode: 0o640 }); chmodSync(overrideFile, 0o640);
  return { root, files: { defaultFile, overrideFile }, store: new SettingsOperationStore(join(root, "operations")) };
}
function request(files: { defaultFile: string; overrideFile: string }, patches = [{ op: "set" as const, path: "/owner/name", value: "new" }]) {
  return { sourceDigest: loadSettings(files).snapshot.sourceDigest, patches };
}
function approval(input: ReturnType<typeof request>, files: { defaultFile: string; overrideFile: string }, sessionId = "browser-1") {
  const store = new ApprovalStore(() => 1_000, 5_000), result = validateSettingsPatches(input, files);
  return { store, record: store.mint("settings-apply", sessionId, approvalBinding({ sourceDigest: result.sourceDigest, patches: result.normalizedPatches, risk: result.risk })) };
}
function executor(overrides: Partial<SettingsDeploymentExecutor> = {}): SettingsDeploymentExecutor {
  return { runtime: async (operation) => operation.runtime, install: async () => ({ release: "new" }), verify: async () => {}, restore: async () => {}, ...overrides };
}
const runtime = { runtimeBuildIdentity: "build-1" };

describe("approval store", () => {
  test("is short-lived, one-use, session-bound and content-bound", () => {
    let now = 1_000; const store = new ApprovalStore(() => now, 100), record = store.mint("settings-apply", "s1", "a".repeat(64));
    expect(() => store.consume(record.id, "settings-apply", "s2", "a".repeat(64))).toThrow(ApprovalError);
    expect(() => store.consume(record.id, "settings-apply", "s1", "b".repeat(64))).toThrow(ApprovalError);
    expect(store.consume(record.id, "settings-apply", "s1", "a".repeat(64)).consumedAt).toBeDefined();
    expect(() => store.consume(record.id, "settings-apply", "s1", "a".repeat(64))).toThrow("不能重放");
    const expired = store.mint("settings-apply", "s1", "c".repeat(64)); now = 2_000;
    expect(() => store.consume(expired.id, "settings-apply", "s1", "c".repeat(64))).toThrow("已过期");
  });
});

describe("durable settings operation", () => {
  test("applies with exact CAS, verifies and commits", async () => {
    const f = fixture(), input = request(f.files);
    const prepared = f.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-1", browserSessionId: "browser-1" }, f.files).operation;
    const a = approval(input, f.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(f.store, prepared.id, a);
    const result = await applySettingsOperation(f.store, prepared.id, f.files, executor());
    expect(result.phase).toBe("committed"); expect(JSON.parse(readFileSync(f.files.overrideFile, "utf8")).owner.name).toBe("new");
    expect(statSync(f.files.overrideFile).mode & 0o777).toBe(0o640);
    expect(JSON.stringify(f.store.public(prepared.id))).not.toContain("bytesBase64");
    expect(result.history.map((entry) => entry.phase)).toContain("writing-config");
    expect(result.history.map((entry) => entry.phase)).toContain("config-written");
  });

  test("failed install restores exact old bytes and mode", async () => {
    const old = '{  "owner": { "name": "old" } }\n', f = fixture(old), input = request(f.files);
    const prepared = f.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-2", browserSessionId: "browser-1" }, f.files).operation;
    const a = approval(input, f.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(f.store, prepared.id, a);
    let restored = false;
    const result = await applySettingsOperation(f.store, prepared.id, f.files, executor({ install: async () => { throw Object.assign(new Error("deploy failed"), { code: "DEPLOY_FAILED" }); }, restore: async () => { restored = true; } }));
    expect(result.phase).toBe("restored"); expect(restored).toBeTrue(); expect(readFileSync(f.files.overrideFile, "utf8")).toBe(old); expect(statSync(f.files.overrideFile).mode & 0o777).toBe(0o640);
  });

  test("failed first-time apply restores an absent override file", async () => {
    const f = fixture(); rmSync(f.files.overrideFile); const input = request(f.files);
    const prepared = f.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-absent", browserSessionId: "browser-1" }, f.files).operation;
    const a = approval(input, f.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(f.store, prepared.id, a);
    const result = await applySettingsOperation(f.store, prepared.id, f.files, executor({ install: async () => { throw new Error("failed"); } }));
    expect(result.phase).toBe("restored"); expect(existsSync(f.files.overrideFile)).toBeFalse();
  });

  test("external drift fails closed into manual repair and freezes new apply", async () => {
    const f = fixture(), input = request(f.files);
    const prepared = f.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-3", browserSessionId: "browser-1" }, f.files).operation;
    const a = approval(input, f.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(f.store, prepared.id, a);
    writeFileSync(f.files.overrideFile, '{"external":true}\n'); chmodSync(f.files.overrideFile, 0o640);
    expect((await applySettingsOperation(f.store, prepared.id, f.files, executor())).phase).toBe("manual-repair");
    expect(() => f.store.prepare({ ...request(f.files), ...runtime, idempotencyKey: "apply-key-4", browserSessionId: "browser-1" }, f.files)).toThrow("已冻结");
  });

  test("startup recovery restores an operation interrupted after config write", async () => {
    const f = fixture(), input = request(f.files);
    const op = f.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-5", browserSessionId: "browser-1" }, f.files).operation;
    writeFileSync(f.files.overrideFile, Buffer.from(op.proposedFile.bytesBase64!, "base64")); chmodSync(f.files.overrideFile, op.proposedFile.mode!); f.store.transition(op.id, "config-written", { proposedFile: captureSettingsFileImage(f.files.overrideFile) });
    const recovered = await recoverSettingsOperations(f.store, f.files, executor());
    expect(recovered[0]?.phase).toBe("restored"); expect(JSON.parse(readFileSync(f.files.overrideFile, "utf8")).owner.name).toBe("old");
  });

  test("rejects helper build/schema mismatch before any filesystem effect", async () => {
    const f = fixture(), input = request(f.files), op = f.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-runtime", browserSessionId: "browser-1" }, f.files).operation;
    const a = approval(input, f.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(f.store, op.id, a);
    await expect(applySettingsOperation(f.store, op.id, f.files, executor({ runtime: async (operation) => ({ ...operation.runtime, buildIdentity: "other-build" }) }))).rejects.toThrow("build/schema 不匹配");
    expect(f.store.read(op.id).phase).toBe("approved"); expect(JSON.parse(readFileSync(f.files.overrideFile, "utf8")).owner.name).toBe("old");
  });

  test("runtime mismatch recovery always converges to a safe terminal phase", async () => {
    const before = fixture(), input = request(before.files), approved = before.store.prepare({ ...input, ...runtime, idempotencyKey: "runtime-before", browserSessionId: "browser-1" }, before.files).operation;
    const a = approval(input, before.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(before.store, approved.id, a);
    expect((await recoverSettingsOperations(before.store, before.files, executor({ runtime: async (operation) => ({ ...operation.runtime, buildIdentity: "changed" }) })))[0].phase).toBe("restored");
    const after = fixture(), input2 = request(after.files), writing = after.store.prepare({ ...input2, ...runtime, idempotencyKey: "runtime-after", browserSessionId: "browser-1" }, after.files).operation;
    after.store.transition(writing.id, "writing-config");
    expect((await recoverSettingsOperations(after.store, after.files, executor({ runtime: async (operation) => ({ ...operation.runtime, buildIdentity: "changed" }) })))[0].phase).toBe("manual-repair");
  });

  test("operation origins preserve the requesting host and never invent localhost for a proxy", () => {
    const direct = fixture(), directInput = request(direct.files), directOp = direct.store.prepare({ ...directInput, ...runtime, idempotencyKey: "origin-direct", browserSessionId: "browser-1", requestOrigin: "http://my-mac.local:4517" }, direct.files).operation;
    expect(directOp.origins).toMatchObject({ previous: "http://my-mac.local:4517", candidate: "http://my-mac.local:4517", requiresProxyUpdate: false });
    const proxy = fixture(), proxyInput = request(proxy.files), proxyOp = proxy.store.prepare({ ...proxyInput, ...runtime, idempotencyKey: "origin-proxy", browserSessionId: "browser-1", requestOrigin: "https://ownward.example", proxied: true }, proxy.files).operation;
    expect(proxyOp.origins).toMatchObject({ previous: "https://ownward.example", candidate: null });
  });

  test("detects same-content entry inode replacement and parent directory replacement", async () => {
    const first = fixture(), input = request(first.files), op = first.store.prepare({ ...input, ...runtime, idempotencyKey: "apply-key-inode", browserSessionId: "browser-1" }, first.files).operation;
    const a = approval(input, first.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(first.store, op.id, a);
    const replacement = join(first.root, "replacement.json"); writeFileSync(replacement, readFileSync(first.files.overrideFile), { mode: 0o640 }); renameSync(replacement, first.files.overrideFile);
    expect((await applySettingsOperation(first.store, op.id, first.files, executor())).phase).toBe("manual-repair");

    const second = fixture(), input2 = request(second.files), op2 = second.store.prepare({ ...input2, ...runtime, idempotencyKey: "apply-key-parent", browserSessionId: "browser-1" }, second.files).operation;
    const a2 = approval(input2, second.files).record; a2.consumedAt = new Date().toISOString(); approveSettingsOperation(second.store, op2.id, a2);
    const oldParent = join(second.root, "source-old"); renameSync(join(second.root, "source"), oldParent); mkdirSync(join(second.root, "source")); writeFileSync(second.files.overrideFile, readFileSync(join(oldParent, "config.json")), { mode: 0o640 });
    expect((await applySettingsOperation(second.store, op2.id, second.files, executor())).phase).toBe("manual-repair");
  });
});

describe("settings mutation routes", () => {
  test("interactive approval then apply dispatches once and idempotent retry reuses operation", async () => {
    const f = fixture(), approvals = new ApprovalStore(), dispatched: string[] = [], context = { browserSession: { id: "browser-1", interactive: true }, approvals, operations: f.store, runtimeBuildIdentity: "build-1", confirmUserPresence: async () => true, dispatchApply: async (id: string) => { dispatched.push(id); } };
    const input = request(f.files), approveUrl = new URL("http://x/api/settings/approve");
    const approve = await routeSettings(new Request(approveUrl.toString(), { method: "POST", body: JSON.stringify(input) }), approveUrl, f.files, context);
    const approvalId = (await approve!.json() as any).approvalId; expect(approvalId).toBeString();
    const applyUrl = new URL("http://x/api/settings/apply"), body = { ...input, approvalId, idempotencyKey: "route-key-1" };
    const first = await routeSettings(new Request(applyUrl.toString(), { method: "POST", body: JSON.stringify(body) }), applyUrl, f.files, context);
    expect(first?.status).toBe(202); expect(dispatched).toHaveLength(1);
    const retry = await routeSettings(new Request(applyUrl.toString(), { method: "POST", body: JSON.stringify(body) }), applyUrl, f.files, context);
    expect(retry?.status).toBe(202); expect((await retry!.json() as any).reused).toBeTrue(); expect(dispatched).toHaveLength(1);
  });

  test("refuses approval without positive user-presence confirmation", async () => {
    const f = fixture(), approvals = new ApprovalStore(), url = new URL("http://x/api/settings/approve"), input = request(f.files);
    const response = await routeSettings(new Request(url.toString(), { method: "POST", body: JSON.stringify(input) }), url, f.files, { browserSession: { id: "browser-1", interactive: true }, approvals, confirmUserPresence: async () => false });
    expect(response?.status).toBe(403); expect((await response!.json() as any).error.code).toBe("APPROVAL_REQUIRED");
  });

  test("operation polling dispatches recovery only through injected throttle", async () => {
    const f = fixture(), input = request(f.files), op = f.store.prepare({ ...input, ...runtime, idempotencyKey: "recover-key-1", browserSessionId: "browser-1" }, f.files).operation;
    const a = approval(input, f.files).record; a.consumedAt = new Date().toISOString(); approveSettingsOperation(f.store, op.id, a);
    let allowed = true; const dispatched: string[] = [], context = { operations: f.store, allowRecoveryDispatch: async () => { const value = allowed; allowed = false; return value; }, dispatchRecovery: async (id: string) => { dispatched.push(id); } };
    const url = new URL("http://x/api/settings/operations/current");
    const first = await routeSettings(new Request(url.toString()), url, f.files, context); expect((await first!.json() as any).recoveryDispatch.state).toBe("dispatched");
    const second = await routeSettings(new Request(url.toString()), url, f.files, context); expect((await second!.json() as any).recoveryDispatch.state).toBe("throttled");
    expect(dispatched).toEqual([op.id]);
  });
});
