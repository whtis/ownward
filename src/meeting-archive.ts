// 会议原文只在生成草稿时归档；内容寻址保留旧版，列表刷新不拉远端文档。
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "fs";
import { link, lstat, mkdir, open, rename, unlink } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { dirname, join, relative, resolve } from "path";
import { meetingSourcesDir, VAULT_ROOT, WORK_SCOPE } from "./paths.ts";

export const MAX_MEETING_BYTES = 2 * 1024 * 1024;
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface MeetingSource { url: string; hash: string; fetchedAt: string }
interface Snapshot extends MeetingSource { content: string }

function sourceDir(url: string, root: string) {
  return join(meetingSourcesDir(WORK_SCOPE, resolve(root)), contentHash(url));
}

async function safeDir(root: string, dir: string, create: boolean) {
  const base = resolve(root), target = resolve(dir);
  if (!target.startsWith(base + "/")) throw new Error("会议归档路径越界");
  for (const path of [base, ...relative(base, target).split("/").map((_, i, parts) => join(base, ...parts.slice(0, i + 1)))]) {
    let stat;
    try { stat = await lstat(path); }
    catch (e: any) {
      if (e.code !== "ENOENT" || !create) throw e;
      try { await mkdir(path, { mode: 0o700 }); } catch (e: any) { if (e.code !== "EEXIST") throw e; }
      stat = await lstat(path);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("会议归档目录不能是符号链接或文件");
  }
}

export async function readBoundedFile(path: string, limit: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("素材必须是普通文件");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`素材超过 ${limit} 字节上限`);
    return buffer.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}

function parseSource(raw: string, url: string): MeetingSource {
  const data = JSON.parse(raw);
  if (data.url !== url || !/^[a-f0-9]{64}$/.test(data.hash) || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error("会议归档元数据无效");
  return { url, hash: data.hash, fetchedAt: data.fetchedAt };
}

export async function readMeetingArchive(url: string, root = VAULT_ROOT): Promise<Snapshot | null> {
  const dir = sourceDir(url, root);
  try {
    await safeDir(root, dir, false);
    const source = parseSource(await readBoundedFile(join(dir, "latest.json"), 4096), url);
    const content = await readBoundedFile(join(dir, `${source.hash}.md`), MAX_MEETING_BYTES);
    if (contentHash(content) !== source.hash) throw new Error("会议归档内容指纹不符");
    return { ...source, content };
  } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}

export async function archiveMeetingSource(url: string, content: string, root = VAULT_ROOT): Promise<MeetingSource> {
  if (Buffer.byteLength(content) > MAX_MEETING_BYTES) throw new Error("会议原文超过归档大小上限");
  const dir = sourceDir(url, root);
  await safeDir(root, dir, true);
  const previous = await readMeetingArchive(url, root);
  const hash = contentHash(content);
  if (previous?.hash === hash) return { url, hash, fetchedAt: previous.fetchedAt };
  const source = { url, hash, fetchedAt: new Date().toISOString() };
  const contentFile = join(dir, `${hash}.md`);
  const contentTemp = join(dir, `.source-${randomUUID()}.tmp`);
  const contentHandle = await open(contentTemp, "wx", 0o600);
  try { await contentHandle.writeFile(content); } finally { await contentHandle.close(); }
  try {
    await safeDir(root, dir, false);
    try { await link(contentTemp, contentFile); }
    catch (e: any) { if (e.code !== "EEXIST" || contentHash(await readBoundedFile(contentFile, MAX_MEETING_BYTES)) !== hash) throw e; }
  } finally { await unlink(contentTemp).catch(() => {}); }
  const temp = join(dir, `.latest-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(source)); } finally { await handle.close(); }
  try { await safeDir(root, dir, false); await rename(temp, join(dir, "latest.json")); }
  finally { await unlink(temp).catch(() => {}); }
  return source;
}

/** 只读最多八份小元数据；不枚举历史、不读原文、不访问网络。 */
export function meetingSourceHash(url: string, root = VAULT_ROOT): string {
  const dir = sourceDir(url, root);
  try {
    for (let path = dir; ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
      if (path === resolve(root)) break;
    }
    const fd = openSync(join(dir, "latest.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096) return "unsafe";
      const buffer = Buffer.alloc(4097);
      let length = 0;
      while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
      if (length > 4096) return "unsafe";
      return parseSource(buffer.subarray(0, length).toString("utf8"), url).hash;
    } finally { closeSync(fd); }
  } catch { return "missing"; }
}
