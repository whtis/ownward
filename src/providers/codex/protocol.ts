import { isAbsolute } from "path";
import type { RunnerAttachmentRef } from "../../runner/attachments.ts";
import { CODEX_EFFORTS, DEFAULT_CODEX_MODEL, isCodexEffort, isCodexModelEffortPair, type CodexEffort } from "../../session-options.ts";

export { CODEX_EFFORTS, CODEX_MODEL_EFFORTS, DEFAULT_CODEX_MODEL } from "../../session-options.ts";
export type { CodexEffort } from "../../session-options.ts";

export const CODEX_PROVIDER_ID = "codex" as const;
export const CODEX_PROVIDER_CAPABILITIES = new Set([
  "stream", "resume", "interrupt", "images", "tools", "add-dir", "set-access", "new-session", "model", "effort",
] as const);

export type CodexAccess = "workspace-write" | "full-access";
export type CodexHome = { kind: "default" } | { kind: "path"; path: string };
export type CodexImage = { mediaType: string; blob: RunnerAttachmentRef };
export type CodexOptions = { model?: string; effort?: CodexEffort; access: CodexAccess; extraDirs: string[]; home: CodexHome };
export type CodexStartInput = { text: string; cwd: string; images: CodexImage[]; options: CodexOptions };
export type CodexSendInput = { text: string; images: CodexImage[]; cwd?: string; options?: CodexOptions; nativeRef?: string };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[], label: string) => { if (Object.keys(v).some((k) => !keys.includes(k))) throw new Error(`${label} 含未知字段`); };
const text = (v: unknown, label: string, max = 1024 * 1024, nonempty = false) => { if (typeof v !== "string" || Buffer.byteLength(v) > max || v.includes("\0") || (nonempty && !v.trim())) throw new Error(`${label} 非法`); return v; };
const absolute = (v: unknown, label: string) => { const s = text(v, label, 4096); if (!isAbsolute(s)) throw new Error(`${label} 必须是绝对路径`); return s; };
const codexNativeRef = (v: unknown) => { const s = text(v, "nativeRef", 64, true); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw new Error("nativeRef 必须是 Codex thread UUID"); return s; };
const model = (v: unknown) => { const s = text(v, "model", 128, true); if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s)) throw new Error("model 非法"); return s; };
const effort = (v: unknown): CodexEffort => { if (!isCodexEffort(v)) throw new Error("effort 非法"); return v; };
function images(v: unknown): CodexImage[] {
  if (!Array.isArray(v) || v.length > 20) throw new Error("images 非法");
  return v.map((x) => {
    if (!plain(x)) throw new Error("image 非法"); exact(x, ["mediaType", "blob"], "image");
    if (!plain(x.blob)) throw new Error("image blob 非法"); exact(x.blob, ["ref", "sha256", "bytes"], "image blob");
    const mediaType = text(x.mediaType, "mediaType", 128);
    if (!/^image\/[A-Za-z0-9.+-]+$/.test(mediaType) || typeof x.blob.ref !== "string" || typeof x.blob.sha256 !== "string" || !Number.isSafeInteger(x.blob.bytes)) throw new Error("image 非法");
    return { mediaType, blob: { ref: x.blob.ref, sha256: x.blob.sha256, bytes: x.blob.bytes as number } };
  });
}
export function parseCodexOptions(v: unknown): CodexOptions {
  if (!plain(v)) throw new Error("options 非法"); exact(v, ["model", "effort", "access", "extraDirs", "home"], "options");
  if (v.access !== "workspace-write" && v.access !== "full-access") throw new Error("access 非法");
  if (!Array.isArray(v.extraDirs) || v.extraDirs.length > 32) throw new Error("extraDirs 非法");
  if (!plain(v.home)) throw new Error("home 非法"); exact(v.home, ["kind", "path"], "home");
  let home: CodexHome;
  if (v.home.kind === "default" && v.home.path === undefined) home = { kind: "default" };
  else if (v.home.kind === "path" && v.home.path !== undefined) home = { kind: "path", path: absolute(v.home.path, "home.path") };
  else throw new Error("home 非法");
  const parsedModel = v.model === undefined ? undefined : model(v.model);
  const parsedEffort = v.effort === undefined ? undefined : effort(v.effort);
  if (!isCodexModelEffortPair(parsedModel, parsedEffort)) throw new Error("model/effort 组合非法");
  return { access: v.access, extraDirs: [...new Set(v.extraDirs.map((d) => absolute(d, "extraDir")))].sort(), home, ...(parsedModel === undefined ? {} : { model: parsedModel }), ...(parsedEffort === undefined ? {} : { effort: parsedEffort }) };
}
export function parseCodexStartInput(input: string): CodexStartInput {
  const v = JSON.parse(input) as unknown; if (!plain(v)) throw new Error("Codex start input 非法"); exact(v, ["text", "cwd", "images", "options"], "Codex start input");
  return { text: text(v.text, "text", 1024 * 1024, true), cwd: absolute(v.cwd, "cwd"), images: images(v.images), options: parseCodexOptions(v.options) };
}
export function parseCodexSendInput(input: string): CodexSendInput {
  const v = JSON.parse(input) as unknown; if (!plain(v)) throw new Error("Codex send input 非法"); exact(v, ["text", "images", "cwd", "options", "nativeRef"], "Codex send input");
  const recovery = v.cwd !== undefined || v.options !== undefined || v.nativeRef !== undefined;
  if (recovery && (v.cwd === undefined || v.options === undefined || v.nativeRef === undefined)) throw new Error("恢复续聊必须同时提供 cwd/options/nativeRef");
  return { text: text(v.text, "text", 1024 * 1024, true), images: images(v.images), ...(recovery ? { cwd: absolute(v.cwd, "cwd"), options: parseCodexOptions(v.options), nativeRef: codexNativeRef(v.nativeRef) } : {}) };
}
export function parseCodexAddDir(input: string): string { const v = JSON.parse(input); if (!plain(v)) throw new Error("add-dir input 非法"); exact(v, ["dir"], "add-dir input"); return absolute(v.dir, "dir"); }
export function parseCodexAccess(input: string): CodexAccess { const v = JSON.parse(input); if (!plain(v)) throw new Error("set-access input 非法"); exact(v, ["access"], "set-access input"); if (v.access !== "workspace-write" && v.access !== "full-access") throw new Error("access 非法"); return v.access; }
export function parseCodexNewSession(input: string): void { const v = JSON.parse(input); if (!plain(v) || Object.keys(v).length) throw new Error("new-session input 必须为空对象"); }

export function buildCodexArgs(command: readonly string[], options: CodexOptions, prompt: string, imagePaths: readonly string[], nativeRef?: string): string[] {
  // sandbox/add-dir 属于 exec 父命令；放到 `resume` 后会被 resume parser 拒绝。
  const args = [...command, "exec"];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  if (options.access === "full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", "workspace-write");
  for (const dir of options.extraDirs) args.push("--add-dir", dir);
  // 这些全部是 exec 父 option；resume 后只保留 SESSION_ID / `--` / PROMPT。
  args.push("--json", "--skip-git-repo-check", "--color", "never");
  for (const file of imagePaths) args.push(`--image=${file}`);
  if (nativeRef) args.push("resume", "--", nativeRef, prompt);
  else args.push("--", prompt);
  return args;
}
