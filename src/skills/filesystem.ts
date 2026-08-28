import { createHash } from "crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import type { FileIdentity, SkillObservation } from "./contracts.ts";
import type { PathPrecondition } from "./internal.ts";

const identity = (s: { dev: number; ino: number; mode: number }): FileIdentity => ({ dev: s.dev, ino: s.ino, mode: s.mode });
const nodeType = (s: ReturnType<typeof lstatSync>): SkillObservation["nodeType"] => s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other";

export function treeDigest(path: string): string {
  const hash = createHash("sha256");
  const walk = (item: string, rel: string) => {
    const st = lstatSync(item);
    if (st.isSymbolicLink()) { hash.update(`L\0${rel}\0${readlinkSync(item)}\0`); return; }
    if (st.isFile()) { const bytes = readFileSync(item); hash.update(`F\0${rel}\0${bytes.length}\0`).update(bytes); return; }
    if (st.isDirectory()) { hash.update(`D\0${rel}\0`); for (const name of readdirSync(item).sort()) walk(join(item, name), rel ? `${rel}/${name}` : name); return; }
    hash.update(`O\0${rel}\0${st.mode}\0`);
  };
  walk(path, ""); return hash.digest("hex");
}

export function snapshotPath(path: string): PathPrecondition {
  let parentIdentity: FileIdentity | null = null;
  try { parentIdentity = identity(statSync(dirname(path))); } catch {}
  try {
    const st = lstatSync(path), type = nodeType(st);
    return { exists: true, nodeType: type, identity: identity(st), parentIdentity, digest: treeDigest(path), linkTarget: type === "symlink" ? resolve(dirname(path), readlinkSync(path)) : null };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false, nodeType: "missing", identity: null, parentIdentity, digest: null, linkTarget: null };
    throw error;
  }
}

const sameIdentity = (a: FileIdentity | null, b: FileIdentity | null) => a === null ? b === null : !!b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
export function matchesPath(path: string, expected: PathPrecondition, checkParent = true): boolean {
  const current = snapshotPath(path);
  return current.exists === expected.exists && current.nodeType === expected.nodeType && sameIdentity(current.identity, expected.identity)
    && (!checkParent || expected.parentIdentity === null || sameIdentity(current.parentIdentity, expected.parentIdentity))
    && current.digest === expected.digest && current.linkTarget === expected.linkTarget;
}

export function assertPath(path: string, expected: PathPrecondition, label = "path"): void {
  if (!matchesPath(path, expected)) throw Object.assign(new Error(`${label} 在计划后发生变化`), { code: "SKILL_PRECONDITION_DRIFT" });
}

function assertContained(root: string, path: string) {
  const r = resolve(root), p = resolve(path);
  if (p !== r && !p.startsWith(r + sep)) throw Object.assign(new Error("Skill 链接逃逸源目录"), { code: "SKILL_LINK_ESCAPE" });
}

export function copyTreeSecure(source: string, target: string): void {
  if (existsSync(target)) throw Object.assign(new Error("目标已经存在"), { code: "SKILL_TARGET_EXISTS" });
  const sourceReal = realpathSync(source);
  const walk = (src: string, dst: string) => {
    const st = lstatSync(src);
    if (st.isSymbolicLink()) {
      const text = readlinkSync(src), resolved = resolve(dirname(src), text); assertContained(sourceReal, resolved);
      symlinkSync(text, dst); return;
    }
    if (st.isDirectory()) { mkdirSync(dst, { mode: st.mode & 0o777 }); for (const name of readdirSync(src).sort()) walk(join(src, name), join(dst, name)); return; }
    if (!st.isFile()) throw Object.assign(new Error("Skill 包含不支持的节点"), { code: "SKILL_NODE_UNSUPPORTED" });
    copyFileSync(src, dst); chmodSync(dst, st.mode & 0o777);
  };
  walk(source, target);
}

export function copyEntry(source: string, target: string): void {
  const st = lstatSync(source);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
  else if (st.isDirectory()) copyTreeSecure(source, target);
  else { copyFileSync(source, target); chmodSync(target, st.mode & 0o777); }
}

export function replaceWithLink(path: string, target: string): void { rmSync(path, { recursive: true, force: true }); symlinkSync(target, path); }

export function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", mode); try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path); const dfd = openSync(dirname(path), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

export function removeEntry(path: string): void { rmSync(path, { recursive: true, force: true }); }
export function restoreEntry(backup: string, path: string): void { rmSync(path, { recursive: true, force: true }); copyEntry(backup, path); }
