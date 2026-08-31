import { isAbsolute } from "path";
import type { RunnerAttachmentRef } from "../../runner/attachments.ts";
import { CLAUDE_EFFORTS, type ClaudeEffort } from "../../session-options.ts";

export { CLAUDE_EFFORTS } from "../../session-options.ts";
export type { ClaudeEffort } from "../../session-options.ts";

export const CLAUDE_PROVIDER_ID = "claude" as const;
export const CLAUDE_PROVIDER_CAPABILITIES = new Set([
  "stream", "resume", "interrupt", "approval", "images", "tools", "add-dir", "set-access", "new-session", "model", "effort",
] as const);

export type ClaudeAccess = "standard" | "bypass";
export type ClaudeImage = { mediaType: string; blob: RunnerAttachmentRef };
export type ClaudeMaterializedImage = { mediaType: string; data: string };
export type ClaudeSessionOptions = { model?: string; effort?: ClaudeEffort; access: ClaudeAccess; extraDirs: string[] };
export type ClaudeStartInput = { text: string; cwd: string; images: ClaudeImage[]; options: ClaudeSessionOptions };
export type ClaudeSendInput = { text: string; images: ClaudeImage[]; cwd?: string; options?: ClaudeSessionOptions; nativeRef?: string };
export type ClaudeApprovalInput = { targetRunId: string; response: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string; remember?: "session" | "global" | null };

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} 含未知字段`);
};
const text = (value: unknown, label: string, max = 1024 * 1024): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new Error(`${label} 非法`);
  return value;
};
const absolute = (value: unknown, label: string): string => {
  const result = text(value, label, 4096);
  if (!isAbsolute(result) || result.includes("\0")) throw new Error(`${label} 必须是绝对路径`);
  return result;
};
const model = (value: unknown): string => {
  const result = text(value, "model", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result)) throw new Error("model 非法");
  return result;
};
const effort = (value: unknown): ClaudeEffort => {
  if (!CLAUDE_EFFORTS.includes(value as ClaudeEffort)) throw new Error("effort 非法");
  return value as ClaudeEffort;
};
function parseImages(value: unknown): ClaudeImage[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("images 非法");
  return value.map((raw) => {
    if (!plain(raw)) throw new Error("image 非法"); exact(raw, ["mediaType", "blob"], "image");
    const mediaType = text(raw.mediaType, "mediaType", 128); if (!plain(raw.blob)) throw new Error("image blob 非法"); exact(raw.blob, ["ref", "sha256", "bytes"], "image blob");
    if (!/^image\/[A-Za-z0-9.+-]+$/.test(mediaType)) throw new Error("mediaType 非法");
    if (typeof raw.blob.ref !== "string" || typeof raw.blob.sha256 !== "string" || !Number.isSafeInteger(raw.blob.bytes)) throw new Error("image blob 非法");
    return { mediaType, blob: { ref: raw.blob.ref, sha256: raw.blob.sha256, bytes: raw.blob.bytes as number } };
  });
}
export function parseClaudeOptions(raw: unknown): ClaudeSessionOptions {
  if (!plain(raw)) throw new Error("options 非法"); exact(raw, ["model", "effort", "access", "extraDirs"], "options");
  if (raw.access !== "standard" && raw.access !== "bypass") throw new Error("access 非法");
  if (!Array.isArray(raw.extraDirs) || raw.extraDirs.length > 32) throw new Error("extraDirs 非法");
  const extraDirs = [...new Set(raw.extraDirs.map((dir) => absolute(dir, "extraDir")))];
  return { access: raw.access, extraDirs, ...(raw.model === undefined ? {} : { model: model(raw.model) }), ...(raw.effort === undefined ? {} : { effort: effort(raw.effort) }) };
}
export function parseClaudeStartInput(input: string): ClaudeStartInput {
  const raw = JSON.parse(input) as unknown;
  if (!plain(raw)) throw new Error("Claude start input 非法"); exact(raw, ["text", "cwd", "images", "options"], "Claude start input");
  return { text: text(raw.text, "text"), cwd: absolute(raw.cwd, "cwd"), images: parseImages(raw.images), options: parseClaudeOptions(raw.options) };
}
export function parseClaudeSendInput(input: string): ClaudeSendInput {
  const raw = JSON.parse(input) as unknown;
  if (!plain(raw)) throw new Error("Claude send input 非法"); exact(raw, ["text", "images", "cwd", "options", "nativeRef"], "Claude send input");
  const hasRecovery = raw.cwd !== undefined || raw.options !== undefined || raw.nativeRef !== undefined;
  if (hasRecovery && (raw.cwd === undefined || raw.options === undefined || raw.nativeRef === undefined)) throw new Error("恢复续聊必须同时提供 cwd/options/nativeRef");
  return { text: text(raw.text, "text"), images: parseImages(raw.images), ...(hasRecovery ? { cwd: absolute(raw.cwd, "cwd"), options: parseClaudeOptions(raw.options), nativeRef: text(raw.nativeRef, "nativeRef", 512) } : {}) };
}
export function parseClaudeApprovalInput(input: string): ClaudeApprovalInput {
  const raw = JSON.parse(input) as unknown;
  if (!plain(raw)) throw new Error("approval input 非法"); exact(raw, ["targetRunId", "response", "updatedInput", "message", "remember"], "approval input");
  if (typeof raw.targetRunId !== "string" || !raw.targetRunId) throw new Error("targetRunId 非法");
  if (raw.response !== "allow" && raw.response !== "deny") throw new Error("approval response 非法");
  if (raw.updatedInput !== undefined && !plain(raw.updatedInput)) throw new Error("updatedInput 非法");
  if (raw.remember !== undefined && raw.remember !== null && raw.remember !== "session" && raw.remember !== "global") throw new Error("approval remember 非法");
  return { targetRunId: raw.targetRunId, response: raw.response, ...(raw.updatedInput === undefined ? {} : { updatedInput: structuredClone(raw.updatedInput) as Record<string, unknown> }), ...(raw.message === undefined ? {} : { message: text(raw.message, "message", 16 * 1024) }), ...(raw.remember === undefined ? {} : { remember: raw.remember as "session" | "global" | null }) };
}
export function parseClaudeAddDir(input: string): string {
  const raw = JSON.parse(input) as unknown; if (!plain(raw)) throw new Error("add-dir input 非法"); exact(raw, ["dir"], "add-dir input"); return absolute(raw.dir, "dir");
}
export function parseClaudeAccess(input: string): ClaudeAccess {
  const raw = JSON.parse(input) as unknown; if (!plain(raw)) throw new Error("set-access input 非法"); exact(raw, ["access"], "set-access input");
  if (raw.access !== "standard" && raw.access !== "bypass") throw new Error("access 非法"); return raw.access;
}
export function parseClaudeNewSession(input: string): Record<string, never> {
  const raw = JSON.parse(input) as unknown; if (!plain(raw) || Object.keys(raw).length) throw new Error("new-session input 必须为空对象"); return {};
}

export function claudeUserFrame(textValue: string, images: ClaudeMaterializedImage[]): string {
  const content = images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }));
  content.push({ type: "text", text: textValue } as any);
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

export function buildClaudeProviderArgs(command: readonly string[], options: ClaudeSessionOptions, nativeRef?: string, supportsEffort=true, supportsPermissionPromptTool=true): string[] {
  const args = [...command, "--print", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (options.access === "bypass") args.push("--dangerously-skip-permissions");
  else if (supportsPermissionPromptTool) args.push("--permission-prompt-tool", "stdio", "--permission-mode", "acceptEdits");
  // 无审批桥的克隆 CLI（codebuddy）：编辑自动过，高危工具由 CLI 自己拒——宁可拒绝，不可静默放行
  else args.push("--permission-mode", "acceptEdits");
  for (const dir of options.extraDirs) args.push("--add-dir", dir);
  if (options.model) args.push("--model", options.model);
  if (options.effort&&supportsEffort) args.push("--effort", options.effort);
  if (nativeRef) args.push("--resume", nativeRef);
  return args;
}
