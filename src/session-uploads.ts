// 会话上传文件仓。
//
// 为什么文件不能照搬图片那条路：图片有 base64 image block，能直接进 stream-json 的用户帧；
// 任意文件没有这种块，CLI agent（claude/codex/codebuddy）读文件只能靠自己的 Read/Bash 从磁盘读。
// 所以文件走的是「落盘 → 把绝对路径写进消息 → 把该子目录授权给 agent」这条路，和图片是两套机制。
//
// 目录按 scope 分：派发弹窗里任务还没有 id，先用 draft-<uuid>；派发成功后整目录改名成 taskId，
// 之后同一会话里再传的文件都落进同一个已授权目录，不用每次再发一次 add-dir 控制命令。
//
// 授权边界：只授权 uploads/<scope>/ 这一层目录，**绝不**授权 data/ 本身——data/secrets 就在隔壁。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve, sep } from "path";
import { DATA, ensureDir } from "./util.ts";

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;          // 单文件；daemon 全局 body 上限是 32MB
export const UPLOAD_MAX_FILES = 20;                        // 每个 scope 的件数
export const UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;   // 每个 scope 合计
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;                  // 没派发出去的草稿目录活 24h

/** scope = draft-<uuid> 或 taskId。两者都不许含路径分隔符或 ..，落盘前还会再做一次包含校验。 */
const SCOPE_RE = /^(?:draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._:-]{0,79})$/;

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "UploadError"; this.code = code; }
}

export function uploadsRoot(): string { return join(DATA, "uploads"); }

/** scope → 绝对目录。校验失败即抛，绝不返回一个「大概对」的路径。 */
export function uploadScopeDir(scope: string): string {
  if (typeof scope !== "string" || !SCOPE_RE.test(scope) || scope.includes("..")) throw new UploadError("UPLOAD_SCOPE_INVALID", "上传 scope 非法");
  const root = uploadsRoot(), dir = resolve(root, scope);
  // 正则之外再做一次物理包含校验：scope 里允许 . 和 :，别让某天放宽正则时静默逃出 uploads/
  if (dir !== root && !dir.startsWith(root + sep)) throw new UploadError("UPLOAD_SCOPE_INVALID", "上传 scope 越界");
  return dir;
}

/** 文件名归一：去目录成分与控制字符，压掉前导点，限长。空名兜底成 upload。 */
export function sanitizeUploadName(raw: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\x00-\x1f\x7f]/g, "").replace(/^\.+/, "").trim();
  if (name.length > 120) {   // 留出扩展名：截断主干而不是把扩展名切掉
    const dot = name.lastIndexOf("."), ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || "upload";
}

/** 同名不覆盖：a.pdf → a (2).pdf。用户连传两份同名文件时两份都要在。 */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) { const candidate = `${stem} (${i})${ext}`; if (!existsSync(join(dir, candidate))) return candidate; }
  throw new UploadError("UPLOAD_NAME_EXHAUSTED", "同名文件太多");
}

export type StagedUpload = { name: string; path: string; bytes: number };

export function stageUpload(scope: string, rawName: string, data: Buffer): StagedUpload {
  if (!Buffer.isBuffer(data) || !data.length) throw new UploadError("UPLOAD_EMPTY", "文件是空的");
  if (data.length > UPLOAD_MAX_BYTES) throw new UploadError("UPLOAD_TOO_LARGE", `单个文件不能超过 ${(UPLOAD_MAX_BYTES / 1048576).toFixed(0)}MB`);
  const dir = uploadScopeDir(scope), existing = listUploads(scope);
  if (existing.length >= UPLOAD_MAX_FILES) throw new UploadError("UPLOAD_TOO_MANY", `一个会话最多带 ${UPLOAD_MAX_FILES} 个文件`);
  const total = existing.reduce((sum, f) => sum + f.bytes, 0);
  if (total + data.length > UPLOAD_MAX_TOTAL_BYTES) throw new UploadError("UPLOAD_TOTAL_TOO_LARGE", `附件合计不能超过 ${(UPLOAD_MAX_TOTAL_BYTES / 1048576).toFixed(0)}MB`);
  ensureDir(uploadsRoot()); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = uniqueName(dir, sanitizeUploadName(rawName)), file = join(dir, name);
  const tmp = join(dir, `.${process.pid}.${crypto.randomUUID()}.part`);
  try { writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, file); }
  catch (error) { try { unlinkSync(tmp); } catch { /* 清不掉就留着，sweep 会收 */ } throw error; }
  return { name, path: file, bytes: data.length };
}

export function listUploads(scope: string): StagedUpload[] {
  const dir = uploadScopeDir(scope);
  let names: string[]; try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => !n.startsWith("."))   // .part 临时文件与隐藏项都以 . 开头，一条就够
    .map((n) => { try { const st = statSync(join(dir, n)); return st.isFile() ? { name: n, path: join(dir, n), bytes: st.size } : null; } catch { return null; } })
    .filter((f): f is StagedUpload => !!f)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeUpload(scope: string, rawName: string): boolean {
  const dir = uploadScopeDir(scope), name = sanitizeUploadName(rawName), file = resolve(dir, name);
  if (!file.startsWith(dir + sep)) throw new UploadError("UPLOAD_NAME_INVALID", "文件名非法");
  try { if (!statSync(file).isFile()) return false; unlinkSync(file); return true; } catch { return false; }
}

const mb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

/** 附在用户消息尾巴上的附件清单。给绝对路径——agent 的 cwd 不一定是这儿。 */
export function uploadTrailer(files: readonly StagedUpload[]): string {
  if (!files.length) return "";
  return `\n\n[附件]\n${files.map((f) => `- ${f.path} (${mb(f.bytes)})`).join("\n")}`;
}

/* 附件必须是「每条消息一份」：客户端每次组消息用一个新的 draft-<uuid>，发送时在这里落定成
 * 不会被 sweep 收走的永久目录，正文里写的就是落定后的最终路径。
 * 落定前就把路径写进正文会留下一串失效路径——所以顺序永远是「先落定，再拼正文」。 */

/** 派发用：draft-<uuid> → sent-<uuid>。派发时任务还没 id，只能就地改名换个不被 sweep 收的前缀。 */
export function sealUploadScope(draftScope: string): { scope: string; files: StagedUpload[] } {
  const from = uploadScopeDir(draftScope);
  if (!existsSync(from) || !draftScope.startsWith("draft-")) return { scope: draftScope, files: listUploads(draftScope) };
  const sealed = `sent-${draftScope.slice("draft-".length)}`, to = uploadScopeDir(sealed);
  if (existsSync(to)) return { scope: draftScope, files: listUploads(draftScope) };
  try { renameSync(from, to); return { scope: sealed, files: listUploads(sealed) }; }
  catch { return { scope: draftScope, files: listUploads(draftScope) }; }   // 改不动就用原目录，它也已在 extraDirs 里
}

/** 会话追问用：把草稿目录里的文件搬进 uploads/<taskId>/（任务 id 此时已知），草稿目录随即删掉。
 *  同名不覆盖——同一会话里两次传同名文件，两份都要在。 */
export function mergeUploadScope(draftScope: string, taskId: string): { scope: string; files: StagedUpload[] } {
  const from = uploadScopeDir(draftScope), to = uploadScopeDir(taskId);
  if (from === to) return { scope: taskId, files: listUploads(taskId) };
  const pending = listUploads(draftScope);
  if (!pending.length) return { scope: taskId, files: [] };
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const moved: StagedUpload[] = [];
  for (const file of pending) {
    const name = uniqueName(to, file.name), target = join(to, name);
    try { renameSync(file.path, target); moved.push({ name, path: target, bytes: file.bytes }); }
    catch { moved.push(file); }   // 搬不动就保留原路径：文件还在，agent 照样读得到（草稿目录也已授权）
  }
  try { rmSync(from, { recursive: true, force: true }); } catch { /* 空目录清不掉不影响正确性 */ }
  return { scope: taskId, files: moved };
}

/** 过期草稿目录清理（没派发出去的）。已提升成 taskId 的目录不动——会话还活着。 */
export function sweepUploads(now = Date.now()): number {
  let removed = 0;
  let names: string[]; try { names = readdirSync(uploadsRoot()); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith("draft-")) continue;
    const dir = join(uploadsRoot(), name);
    try { if (now - statSync(dir).mtimeMs > DRAFT_TTL_MS) { rmSync(dir, { recursive: true, force: true }); removed++; } } catch { /* 清理是尽力而为 */ }
  }
  return removed;
}
