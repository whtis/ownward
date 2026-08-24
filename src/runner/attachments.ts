import { modeBitsClear, ownedByCurrentUser } from "../posix-owner.ts";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { basename, join } from "path";
import { RUNNER_MAX_BLOB_BYTES } from "./protocol.ts";
import { withRunnerFileLock } from "./durable-journal.ts";

export type RunnerAttachmentRef = { ref: string; sha256: string; bytes: number };
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const pattern = /^attachments\/([a-f0-9]{64})\.blob$/;

/** Kernel 在 submit 前预置大附件；IPC 只携带短 ref，不放宽 1MiB frame。 */
export function stageRunnerAttachment(dataRoot: string, base64: string): RunnerAttachmentRef {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Object.assign(new Error("附件不是合法 base64"), { code: "RUNNER_INPUT_INVALID" });
  const bytes = Buffer.byteLength(base64); if (bytes > RUNNER_MAX_BLOB_BYTES) throw Object.assign(new Error("附件超过 blob 上限"), { code: "RUNNER_INPUT_TOO_LARGE" });
  return withRunnerFileLock(join(dataRoot, "runner", ".blob-maintenance"), () => {
  const sha256 = hash(base64), runner = join(dataRoot, "runner"), dir = join(runner, "attachments"), file = join(dir, `${sha256}.blob`);
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(runner, 0o700); chmodSync(dir, 0o700);
  if (!existsSync(file)) {
    const tmp = join(dir, `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`), data = Buffer.from(base64), fd = openSync(tmp, "wx", 0o600);
    try { let offset = 0; while (offset < data.length) { const count = writeSync(fd, data, offset, data.length - offset); if (count <= 0) throw new Error("附件 blob 短写入"); offset += count; } fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(tmp, file); } catch (error: any) { if (error?.code !== "EEXIST") throw error; } finally { unlinkSync(tmp); }
    const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
  }
  chmodSync(file, 0o600); const found = readFileSync(file, "utf8"); if (hash(found) !== sha256 || Buffer.byteLength(found) !== bytes) throw new Error("附件 blob 落盘校验失败");
  return { ref: `attachments/${sha256}.blob`, sha256, bytes };
  });
}

export function readRunnerAttachment(dataRoot: string, descriptor: RunnerAttachmentRef): string {
  const match = typeof descriptor?.ref === "string" ? pattern.exec(descriptor.ref) : null;
  if (!match || match[1] !== descriptor.sha256 || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > RUNNER_MAX_BLOB_BYTES) throw Object.assign(new Error("附件引用非法"), { code: "PROVIDER_INPUT_INVALID" });
  const file = join(dataRoot, "runner", "attachments", `${descriptor.sha256}.blob`), stat = statSync(file);
  if (!stat.isFile() || !ownedByCurrentUser(stat) || !modeBitsClear(stat, 0o077)) throw Object.assign(new Error("附件权限或所有权非法"), { code: "PROVIDER_INPUT_INVALID" });
  const content = readFileSync(file, "utf8"); if (hash(content) !== descriptor.sha256 || Buffer.byteLength(content) !== descriptor.bytes) throw Object.assign(new Error("附件 hash/bytes 校验失败"), { code: "PROVIDER_INPUT_INVALID" });
  return content;
}
