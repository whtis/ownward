import { createHash } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { durableRemove, durableWrite } from "../release/durable-write.ts";
import type { ApprovalRecord } from "../control-plane/approval.ts";
import { loadSettings, stable, validateSettingsPatches, type SettingsDiffEntry, type SettingsFiles, type SettingsPatch } from "./service.ts";

export type SettingsOperationPhase = "prepared" | "approved" | "writing-config" | "config-written" | "installing" | "verifying" | "committed" | "restoring" | "restored" | "manual-repair";
export interface SettingsFsIdentity { dev: string; ino: string; type: "directory" | "file" }
export interface SettingsFileImage {
  existed: boolean;
  bytesBase64: string | null;
  mode: number | null;
  digest: string;
  parent: SettingsFsIdentity;
  entry: SettingsFsIdentity | null;
}
export interface SettingsRuntimePin { buildIdentity: string; schemaDigest: string }
export interface SettingsOperation {
  formatVersion: 2;
  id: string;
  phase: SettingsOperationPhase;
  createdAt: string;
  updatedAt: string;
  browserSessionId: string;
  idempotencyKey: string;
  requestDigest: string;
  clientRequestDigest: string;
  expectedSourceDigest: string;
  runtime: SettingsRuntimePin;
  patches: SettingsPatch[];
  redactedDiff: SettingsDiffEntry[];
  risk: { level: "low" | "high" | "critical"; approvalRequired: true; confirmations: string[] };
  origins: { previous: string; candidate: string | null; previousPort: number; candidatePort: number; requiresProxyUpdate: boolean };
  history: { phase: SettingsOperationPhase; at: string }[];
  oldFile: SettingsFileImage;
  proposedFile: SettingsFileImage;
  approval?: Pick<ApprovalRecord, "id" | "createdAt" | "expiresAt" | "consumedAt" | "bindingDigest">;
  deployment?: Record<string, unknown>;
  error?: { code: string; message: string; at: string };
}

export interface SettingsDeploymentExecutor {
  runtime(operation: SettingsOperation): Promise<SettingsRuntimePin>;
  install(operation: SettingsOperation): Promise<Record<string, unknown> | void>;
  verify(operation: SettingsOperation): Promise<void>;
  restore(operation: SettingsOperation): Promise<void>;
}

export class SettingsOperationError extends Error {
  constructor(public code: "SETTINGS_APPLY_BUSY" | "SETTINGS_APPLY_FROZEN" | "SETTINGS_IDEMPOTENCY_CONFLICT" | "SETTINGS_OPERATION_NOT_FOUND" | "SETTINGS_CAS_MISMATCH" | "SETTINGS_RUNTIME_MISMATCH" | "SETTINGS_MANUAL_REPAIR", message: string) { super(message); }
}

const TERMINAL = new Set<SettingsOperationPhase>(["committed", "restored", "manual-repair"]);
const digestBytes = (bytes: Buffer | null) => createHash("sha256").update(bytes ?? Buffer.from("<missing>")) .digest("hex");

function identity(stat: ReturnType<typeof lstatSync>, type: SettingsFsIdentity["type"]): SettingsFsIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), type };
}

function validIdentity(value: unknown, type: SettingsFsIdentity["type"]): value is SettingsFsIdentity {
  const id = value as SettingsFsIdentity | null;
  return !!id && id.type === type && /^\d+$/.test(id.dev) && /^\d+$/.test(id.ino);
}

function validImage(value: unknown): value is SettingsFileImage {
  const image = value as SettingsFileImage | null;
  return !!image && typeof image.existed === "boolean" && /^[a-f0-9]{64}$/.test(image.digest) && validIdentity(image.parent, "directory")
    && (image.existed ? typeof image.bytesBase64 === "string" && typeof image.mode === "number" && validIdentity(image.entry, "file") : image.bytesBase64 === null && image.mode === null && image.entry === null);
}

export function captureSettingsFileImage(path: string): SettingsFileImage {
  const parentStat = lstatSync(dirname(path));
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new SettingsOperationError("SETTINGS_CAS_MISMATCH", "config.json 父目录必须是普通目录且不能是符号链接");
  const parent = identity(parentStat, "directory");
  if (!existsSync(path)) return { existed: false, bytesBase64: null, mode: null, digest: digestBytes(null), parent, entry: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new SettingsOperationError("SETTINGS_CAS_MISMATCH", "config.json 必须是普通文件且不能是符号链接");
  const bytes = readFileSync(path);
  return { existed: true, bytesBase64: bytes.toString("base64"), mode: stat.mode & 0o777, digest: digestBytes(bytes), parent, entry: identity(stat, "file") };
}

export function settingsSchemaDigest(files: SettingsFiles): string {
  return createHash("sha256").update(stable(loadSettings(files).schema)).digest("hex");
}

export function assertSettingsOperationRuntime(operation: SettingsOperation, runtime: SettingsRuntimePin) {
  if (operation.runtime.buildIdentity !== runtime.buildIdentity || operation.runtime.schemaDigest !== runtime.schemaDigest) throw new SettingsOperationError("SETTINGS_RUNTIME_MISMATCH", "设置操作与当前 helper build/schema 不匹配，拒绝执行");
}

function publicOperation(op: SettingsOperation) {
  const { oldFile: _old, proposedFile: _proposed, browserSessionId: _session, ...safe } = op;
  return { ...safe, ...(op.phase === "manual-repair" ? { remediation: "不要手工覆盖 operation journal；检查 config.json 与当前 release 后，从备份恢复或重新运行完整 install.sh。" } : {}) };
}

export const clientSettingsRequestDigest = (sourceDigest: unknown, patches: unknown) => createHash("sha256").update(stable({ sourceDigest, patches })).digest("hex");

export class SettingsOperationStore {
  readonly root: string;
  constructor(root: string, private now = () => new Date()) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("settings operation root invalid");
    chmodSync(this.root, 0o700);
  }

  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SettingsOperationError("SETTINGS_OPERATION_NOT_FOUND", "设置操作不存在");
    return join(this.root, `${id}.json`);
  }
  list(): SettingsOperation[] {
    return readdirSync(this.root).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => this.read(name.slice(0, -5))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  read(id: string): SettingsOperation {
    const file = this.file(id);
    if (!existsSync(file)) throw new SettingsOperationError("SETTINGS_OPERATION_NOT_FOUND", "设置操作不存在");
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("settings operation journal permissions invalid");
    const op = JSON.parse(readFileSync(file, "utf8")) as SettingsOperation;
    if (op.formatVersion !== 2 || op.id !== id || !/^[A-Za-z0-9._:-]{1,160}$/.test(op.runtime?.buildIdentity ?? "") || !/^[a-f0-9]{64}$/.test(op.runtime?.schemaDigest ?? "") || !validImage(op.oldFile)
      || !(op.proposedFile?.entry === null ? op.proposedFile.existed && typeof op.proposedFile.bytesBase64 === "string" && typeof op.proposedFile.mode === "number" && /^[a-f0-9]{64}$/.test(op.proposedFile.digest) && validIdentity(op.proposedFile.parent, "directory") : validImage(op.proposedFile))
      || !TERMINAL.has(op.phase) && !["prepared", "approved", "writing-config", "config-written", "installing", "verifying", "restoring"].includes(op.phase)) throw new Error("settings operation journal invalid");
    return op;
  }
  public(id: string) { return publicOperation(this.read(id)); }
  findIdempotent(browserSessionId: string, idempotencyKey: string) {
    return this.list().find((op) => op.browserSessionId === browserSessionId && op.idempotencyKey === idempotencyKey);
  }
  write(op: SettingsOperation): SettingsOperation {
    op.updatedAt = this.now().toISOString();
    durableWrite(this.file(op.id), JSON.stringify(op) + "\n", 0o600);
    return op;
  }
  transition(id: string, phase: SettingsOperationPhase, extra: Partial<SettingsOperation> = {}) {
    const current = this.read(id), at = this.now().toISOString();
    return this.write({ ...current, ...extra, phase, history: [...(current.history ?? []), { phase, at }] });
  }

  prepare(input: { sourceDigest: string; patches: SettingsPatch[]; idempotencyKey: string; browserSessionId: string; runtimeBuildIdentity: string; requestOrigin?: string; proxied?: boolean; clientRequestDigest?: string }, files: SettingsFiles): { operation: SettingsOperation; reused: boolean } {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new SettingsOperationError("SETTINGS_IDEMPOTENCY_CONFLICT", "idempotencyKey 格式无效");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.runtimeBuildIdentity)) throw new SettingsOperationError("SETTINGS_RUNTIME_MISMATCH", "runtime build identity 无效");
    const validated = validateSettingsPatches(input, files);
    if (!validated.valid || !validated.candidateOverrideRaw) throw Object.assign(new Error("设置校验失败"), { code: validated.issues[0]?.code ?? "VALIDATION_FAILED", issues: validated.issues });
    const requestDigest = createHash("sha256").update(stable({ sourceDigest: input.sourceDigest, patches: validated.normalizedPatches })).digest("hex");
    const clientRequestDigest = input.clientRequestDigest ?? clientSettingsRequestDigest(input.sourceDigest, input.patches);
    const previous = this.findIdempotent(input.browserSessionId, input.idempotencyKey);
    if (previous) {
      if (previous.requestDigest !== requestDigest || previous.clientRequestDigest !== clientRequestDigest) throw new SettingsOperationError("SETTINGS_IDEMPOTENCY_CONFLICT", "同一幂等键已绑定其他设置变更");
      return { operation: previous, reused: true };
    }
    if (this.list().some((op) => op.phase === "manual-repair")) throw new SettingsOperationError("SETTINGS_APPLY_FROZEN", "存在需要人工修复的设置操作，已冻结新的应用");
    if (this.list().some((op) => !TERMINAL.has(op.phase))) throw new SettingsOperationError("SETTINGS_APPLY_BUSY", "已有设置应用正在进行");
    const oldFile = captureSettingsFileImage(files.overrideFile), proposedBytes = Buffer.from(JSON.stringify(validated.candidateOverrideRaw, null, 2) + "\n");
    const proposedFile: SettingsFileImage = { existed: true, bytesBase64: proposedBytes.toString("base64"), mode: oldFile.mode ?? 0o600, digest: digestBytes(proposedBytes), parent: oldFile.parent, entry: null };
    const beforePort = Number((loadSettings(files).snapshot.effective as any).dashboard?.port || 4517);
    const candidateTemp = structuredClone(validated.candidateOverrideRaw), defaults = JSON.parse(readFileSync(files.defaultFile, "utf8"));
    const candidatePort = Number((candidateTemp as any).dashboard?.port ?? defaults.dashboard?.port ?? 4517);
    let previousOrigin = `http://127.0.0.1:${beforePort}`, candidateOrigin: string | null = `http://127.0.0.1:${candidatePort}`;
    if (input.requestOrigin) try { const previous = new URL(input.requestOrigin); previousOrigin = previous.origin; if (input.proxied) candidateOrigin = null; else { previous.port = String(candidatePort); candidateOrigin = previous.origin; } } catch {}
    const createdAt = this.now().toISOString(), operation: SettingsOperation = {
      formatVersion: 2, id: crypto.randomUUID(), phase: "prepared", createdAt, updatedAt: createdAt,
      browserSessionId: input.browserSessionId, idempotencyKey: input.idempotencyKey, requestDigest, clientRequestDigest,
      expectedSourceDigest: input.sourceDigest, runtime: { buildIdentity: input.runtimeBuildIdentity, schemaDigest: settingsSchemaDigest(files) },
      patches: validated.normalizedPatches.map((patch) => patch.op === "remove" ? patch : ({ ...patch, value: validated.redactedDiff.find((entry) => entry.path === patch.path)?.after })),
      redactedDiff: validated.redactedDiff, risk: validated.risk, oldFile, proposedFile,
      origins: { previous: previousOrigin, candidate: candidateOrigin, previousPort: beforePort, candidatePort, requiresProxyUpdate: input.proxied === true && beforePort !== candidatePort },
      history: [{ phase: "prepared", at: createdAt }],
    };
    this.write(operation);
    return { operation, reused: false };
  }
}

function sameIdentity(actual: SettingsFsIdentity | null, expected: SettingsFsIdentity | null) {
  return actual?.dev === expected?.dev && actual?.ino === expected?.ino && actual?.type === expected?.type;
}

function sameImage(actual: SettingsFileImage, expected: SettingsFileImage) {
  return actual.existed === expected.existed && actual.digest === expected.digest && actual.mode === expected.mode
    && sameIdentity(actual.parent, expected.parent) && sameIdentity(actual.entry, expected.entry);
}

function assertImage(path: string, expected: SettingsFileImage, label: string) {
  const actual = captureSettingsFileImage(path);
  if (!sameImage(actual, expected)) throw new SettingsOperationError("SETTINGS_CAS_MISMATCH", `${label}配置或父目录的 inode/type/dev、字节、权限、存在性已变化`);
}

function assertRestoredContent(path: string, expected: SettingsFileImage, label: string) {
  const actual = captureSettingsFileImage(path);
  if (actual.existed !== expected.existed || actual.digest !== expected.digest || actual.mode !== expected.mode || !sameIdentity(actual.parent, expected.parent) || actual.entry?.type !== expected.entry?.type) throw new SettingsOperationError("SETTINGS_CAS_MISMATCH", `${label}配置内容、权限或父目录身份不一致`);
}

function writeImage(path: string, image: SettingsFileImage, expectedCurrent: SettingsFileImage) {
  // effect 前最后一道 TOCTOU 护栏；durableWrite 自身再拒绝 target/parent symlink。
  assertImage(path, expectedCurrent, "写入瞬间");
  if (!image.existed) durableRemove(path);
  else durableWrite(path, Buffer.from(image.bytesBase64!, "base64").toString("utf8"), image.mode ?? 0o600);
}

function operationError(error: unknown) {
  const any = error as any;
  return { code: String(any?.code || "SETTINGS_APPLY_FAILED"), message: String(any?.message || error).slice(0, 500), at: new Date().toISOString() };
}

async function restore(store: SettingsOperationStore, id: string, files: SettingsFiles, executor: SettingsDeploymentExecutor, cause: unknown) {
  const interruptedPhase = store.read(id).phase;
  let op = store.transition(id, "restoring", { error: operationError(cause) });
  try {
    const current = captureSettingsFileImage(files.overrideFile);
    const isOld = sameImage(current, op.oldFile);
    const unrecordedWrite = interruptedPhase === "writing-config" && current.existed && current.digest === op.proposedFile.digest && current.mode === op.proposedFile.mode && sameIdentity(current.parent, op.proposedFile.parent) && current.entry?.type === "file";
    const isProposed = sameImage(current, op.proposedFile) || unrecordedWrite;
    if (!isOld && !isProposed) throw new SettingsOperationError("SETTINGS_MANUAL_REPAIR", "config.json 或父目录在应用期间被其他进程替换，拒绝覆盖");
    if (!isOld) {
      if (unrecordedWrite) op = store.write({ ...op, proposedFile: current });
      writeImage(files.overrideFile, op.oldFile, op.proposedFile);
    }
    await executor.restore(op);
    // rename 恢复必然产生新 inode；这里验证内容/权限/父目录/type，不能伪称恢复原 inode。
    assertRestoredContent(files.overrideFile, op.oldFile, "恢复后");
    return store.transition(id, "restored");
  } catch (error) {
    return store.transition(id, "manual-repair", { error: operationError(error) });
  }
}

/** 由独立 deploy helper 调用；每个 effect 之前先持久化 phase，崩溃后可确定恢复方向。 */
export async function applySettingsOperation(store: SettingsOperationStore, id: string, files: SettingsFiles, executor: SettingsDeploymentExecutor): Promise<SettingsOperation> {
  let op = store.read(id);
  if (op.phase !== "approved") throw new Error(`设置操作 ${id} phase=${op.phase} 不能应用`);
  assertSettingsOperationRuntime(op, await executor.runtime(op));
  try {
    assertImage(files.overrideFile, op.oldFile, "应用前");
    op = store.transition(id, "writing-config");
    writeImage(files.overrideFile, op.proposedFile, op.oldFile);
    const written = captureSettingsFileImage(files.overrideFile);
    if (written.digest !== op.proposedFile.digest || written.mode !== op.proposedFile.mode || !sameIdentity(written.parent, op.proposedFile.parent) || written.entry?.type !== "file") throw new SettingsOperationError("SETTINGS_CAS_MISMATCH", "写入后的配置不符合候选 postcondition");
    op = store.transition(id, "config-written", { proposedFile: written });
    if (loadSettings(files).snapshot.sourceDigest === op.expectedSourceDigest) throw new SettingsOperationError("SETTINGS_CAS_MISMATCH", "候选配置没有产生新的来源摘要");
    op = store.transition(id, "installing");
    const deployment = await executor.install(op);
    op = store.transition(id, "verifying", deployment ? { deployment } : {});
    await executor.verify(op);
    assertImage(files.overrideFile, op.proposedFile, "验证时");
    return store.transition(id, "committed");
  } catch (error) {
    return restore(store, id, files, executor, error);
  }
}

export async function recoverSettingsOperations(store: SettingsOperationStore, files: SettingsFiles, executor: SettingsDeploymentExecutor): Promise<SettingsOperation[]> {
  const recovered: SettingsOperation[] = [];
  for (const op of store.list().filter((item) => !TERMINAL.has(item.phase))) {
    try { assertSettingsOperationRuntime(op, await executor.runtime(op)); }
    catch (error) {
      const failure = operationError(error);
      if (op.phase === "prepared" || op.phase === "approved") recovered.push(store.transition(op.id, "restored", { error: failure }));
      else recovered.push(store.transition(op.id, "manual-repair", { error: { ...failure, message: `${failure.message}；配置 effect 可能已经开始，拒绝用不同 build/schema 自动恢复` } }));
      continue;
    }
    if (op.phase === "prepared") recovered.push(store.transition(op.id, "restored", { error: { code: "APPROVAL_NOT_COMMITTED", message: "未批准的准备操作已关闭", at: new Date().toISOString() } }));
    else if (op.phase === "approved") recovered.push(await applySettingsOperation(store, op.id, files, executor));
    else recovered.push(await restore(store, op.id, files, executor, new Error(`从 ${op.phase} 恢复`)));
  }
  return recovered;
}

export function approveSettingsOperation(store: SettingsOperationStore, id: string, approval: ApprovalRecord) {
  const op = store.read(id);
  if (op.phase !== "prepared") return op;
  return store.transition(id, "approved", { approval: { id: approval.id, createdAt: approval.createdAt, expiresAt: approval.expiresAt, consumedAt: approval.consumedAt, bindingDigest: approval.bindingDigest } });
}

export function abandonSettingsOperation(store: SettingsOperationStore, id: string, error: unknown) {
  const op = store.read(id);
  if (op.phase === "prepared" || op.phase === "approved") return store.transition(id, "restored", { error: operationError(error) });
  return op;
}
