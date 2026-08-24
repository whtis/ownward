import {
  chmodSync, closeSync, cpSync, existsSync, fstatSync, lstatSync,
  linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { modeBitsClear, ownedByCurrentUser } from "../../posix-owner.ts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import type { ScopedStorage } from "./contracts.ts";
import { scopedStorageAt } from "./services.ts";
import { LifecycleCapability } from "./lifecycle.ts";

type Kind = "vertical" | "connector";
type Stage = "after-backup" | "after-staging" | "after-migrate" | "after-marker" | "after-target-away" | "after-target-swap" | "after-applied";
type Ledger = { schemaVersion: 1; applied: string[] };
type Marker = { schemaVersion: 1; kind: Kind; id: string; version: string; migrationId: string; tx: string; hadTarget: boolean; phase: "prepared" | "target-swapped" | "applied"; parentDev: number; parentIno: number; sourceDev: number | null; sourceIno: number | null; stagingDev: number; stagingIno: number };
type Lease = { token: string; path: string; lock: FileIdentity; root: string; rootId: { dev: number; ino: number }; migrations: string; migrationsId: { dev: number; ino: number } };
type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; content: string };
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TX = /^[a-f0-9-]{36}$/;
const MARKER_KEYS = ["hadTarget", "id", "kind", "migrationId", "parentDev", "parentIno", "phase", "schemaVersion", "sourceDev", "sourceIno", "stagingDev", "stagingIno", "tx", "version"];
const LEDGER_KEYS = ["applied", "schemaVersion"];
const LOCK_KEYS = ["createdAt", "pid", "processIdentity", "schemaVersion", "token"];

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function fsyncDir(path: string) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function syncTree(path: string) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !ownedByCurrentUser(stat) || !modeBitsClear(stat, 0o022)) fail("EXTENSION_MIGRATION_PATH_UNSAFE", "migration tree owner/mode/symlink invalid");
  if (stat.isDirectory()) { for (const name of readdirSync(path)) syncTree(join(path, name)); fsyncDir(path); }
  else if (stat.isFile()) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  else fail("EXTENSION_MIGRATION_PATH_UNSAFE", "migration tree contains unsupported node");
}
function removeDurable(path: string) { if (!existsSync(path)) return; const parent = dirname(path); rmSync(path, { recursive: true, force: true }); fsyncDir(parent); }
function renameDurable(from: string, to: string) { renameSync(from, to); fsyncDir(dirname(from)); if (dirname(to) !== dirname(from)) fsyncDir(dirname(to)); }
function exact(value: unknown, keys: string[]) { return !!value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value as object).sort()) === JSON.stringify(keys); }
function ownedChainIsSafe(path: string) {
  let current = path;
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail("EXTENSION_MIGRATION_PATH_UNSAFE", "dataRoot parent chain contains symlink");
      if (!ownedByCurrentUser(stat)) break;
      if (!modeBitsClear(stat, 0o022)) fail("EXTENSION_MIGRATION_PATH_UNSAFE", "dataRoot parent chain is group/other writable");
    }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function canonicalRoot(input: string) {
  if (!isAbsolute(input)) fail("EXTENSION_MIGRATION_ROOT_INVALID", "dataRoot must be absolute");
  const root = resolve(input); let ancestor = root;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  ownedChainIsSafe(ancestor); const ancestorReal = realpathSync(ancestor);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = realpathSync(root);
  if (!contained(ancestorReal, real)) fail("EXTENSION_MIGRATION_ROOT_INVALID", "created dataRoot escaped nearest real ancestor");
  ownedChainIsSafe(root);
  const stat = lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat) || !modeBitsClear(stat, 0o022)) fail("EXTENSION_MIGRATION_ROOT_INVALID", "dataRoot owner/mode invalid");
  return real;
}
function contained(root: string, path: string) { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function safeExistingChain(root: string, path: string) {
  if (!contained(root, path)) fail("EXTENSION_MIGRATION_PATH_UNSAFE", "migration path escaped dataRoot");
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part); if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !ownedByCurrentUser(stat) || !modeBitsClear(stat, 0o022)) fail("EXTENSION_MIGRATION_PATH_UNSAFE", "migration path owner/mode/symlink invalid");
  }
}
function nodeId(path: string) { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino }; }
function assertNode(path: string, expected: { dev: number; ino: number }, code = "EXTENSION_MIGRATION_PATH_CHANGED") { const current = nodeId(path); if (current.dev !== expected.dev || current.ino !== expected.ino) fail(code, "migration path inode changed"); }
function paths(root: string, kind: Kind, id: string, tx?: string) {
  const target = kind === "vertical" ? join(root, "verticals", id) : join(root, "connectors", id, "extension"), parent = dirname(target);
  return { target, parent, marker: join(root, "migrations", `${kind}-${id}.json`), ledger: join(root, "migrations", "extensions-applied.json"), ...(tx ? { staging: join(parent, `.${id}.migration.${tx}`), rollback: join(parent, `.${id}.rollback.${tx}`), backup: join(root, "backups", "extensions", kind, id, tx) } : {}) };
}
function readLedger(path: string): Ledger {
  if (!existsSync(path)) return { schemaVersion: 1, applied: [] };
  let value: unknown; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("EXTENSION_MIGRATION_LEDGER_INVALID", "extension migration ledger corrupt"); }
  if (!exact(value, LEDGER_KEYS)) fail("EXTENSION_MIGRATION_LEDGER_INVALID", "extension migration ledger schema invalid");
  const ledger = value as Ledger;
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.applied) || ledger.applied.some((id) => typeof id !== "string" || !/^(vertical|connector):[a-z][a-z0-9-]{0,63}@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(id)) || new Set(ledger.applied).size !== ledger.applied.length) fail("EXTENSION_MIGRATION_LEDGER_INVALID", "extension migration ledger values invalid");
  return { schemaVersion: 1, applied: [...ledger.applied] };
}
function readMarker(path: string, expected: { kind: Kind; id: string }): Marker {
  let value: unknown; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("EXTENSION_MIGRATION_RECOVERY_FAILED", "migration marker corrupt"); }
  if (!exact(value, MARKER_KEYS)) fail("EXTENSION_MIGRATION_RECOVERY_FAILED", "migration marker schema invalid");
  const marker = value as Marker;
  const ids = [marker.parentDev, marker.parentIno, marker.stagingDev, marker.stagingIno];
  if (marker.schemaVersion !== 1 || marker.kind !== expected.kind || marker.id !== expected.id || !ID.test(marker.id) || !VERSION.test(marker.version) || marker.migrationId !== `${marker.kind}:${marker.id}@${marker.version}` || !TX.test(marker.tx) || typeof marker.hadTarget !== "boolean" || !["prepared", "target-swapped", "applied"].includes(marker.phase) || ids.some((id) => !Number.isSafeInteger(id) || id < 0) || (marker.hadTarget ? !Number.isSafeInteger(marker.sourceDev) || !Number.isSafeInteger(marker.sourceIno) : marker.sourceDev !== null || marker.sourceIno !== null)) fail("EXTENSION_MIGRATION_RECOVERY_FAILED", "migration marker identity invalid");
  return marker;
}
function pidAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; } }
function bootIdentity(): string {
  if (process.platform === "linux") { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {} }
  const out = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]); return out.exitCode === 0 ? out.stdout.toString().trim() : "unknown-boot";
}
function processIdentity(pid: number): string | undefined {
  if (!pidAlive(pid)) return undefined;
  if (process.platform === "win32") {
    // Windows 既没有 /proc 也没有 ps，原来的 `/bin/ps` 分支会让 Bun.spawnSync 直接抛
    // ENOENT，migration gate 在这里必然失败，所有启用的 Vertical 都无法启动。
    // 进程创建时间是绝对墙钟值：pid 被回收后新进程的 StartTime 必然更晚，
    // 单独就能区分实例，所以这条路径不再叠加 boot identity。
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;   // 拼进命令行前先确认是纯整数
    const out = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.Ticks`]);
    const ticks = out.exitCode === 0 ? out.stdout.toString().trim() : "";
    return /^\d+$/.test(ticks) ? `win-start:${ticks}` : undefined;
  }
  if (process.platform === "linux") { try { const fields = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" "); return `${bootIdentity()}:${fields[21]}`; } catch { return undefined; } }
  const out = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)]); return out.exitCode === 0 && out.stdout.toString().trim() ? `${bootIdentity()}:${out.stdout.toString().trim()}` : undefined;
}
function fileIdentity(path: string): FileIdentity {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd), content = readFileSync(fd, "utf8"), after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("EXTENSION_MIGRATION_CAS_FAILED", "migration metadata changed while reading");
    return { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, content };
  } finally { closeSync(fd); }
}
function sameFile(a: FileIdentity, b: FileIdentity) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.content === b.content; }
function lockRecord(value: unknown): value is { schemaVersion: 1; token: string; pid: number; processIdentity: string; createdAt: number } {
  if (!exact(value, LOCK_KEYS)) return false;
  const row = value as any;
  return row.schemaVersion === 1 && TX.test(row.token) && Number.isSafeInteger(row.pid) && row.pid > 0
    && typeof row.processIdentity === "string" && row.processIdentity.length > 0 && row.processIdentity.length <= 512
    && Number.isSafeInteger(row.createdAt) && row.createdAt > 0;
}
function assertLeaseContainer(lease: Lease) {
  if (realpathSync(lease.root) !== lease.root) fail("EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST", "migration root identity changed");
  assertNode(lease.root, lease.rootId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST");
  safeExistingChain(lease.root, lease.migrations); assertNode(lease.migrations, lease.migrationsId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST");
}
function assertLease(lease: Lease) {
  assertLeaseContainer(lease);
  if (!existsSync(lease.path)) fail("EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST", "migration lock disappeared");
  const lock = fileIdentity(lease.path); if (!sameFile(lock, lease.lock)) fail("EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST", "migration lock file identity changed");
  let value: any; try { value = JSON.parse(lock.content); } catch { fail("EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST", "migration lock record changed"); }
  if (value.token !== lease.token) fail("EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST", "migration lock token changed");
}
function atomicCasWithLease(path: string, value: unknown, expected: FileIdentity | null, lease: Lease) {
  assertLease(lease); safeExistingChain(lease.root, path);
  const parent = dirname(path); assertNode(parent, lease.migrationsId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST");
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDir(parent); assertLease(lease);
    if (expected === null) {
      if (existsSync(path)) fail("EXTENSION_MIGRATION_CAS_FAILED", "migration metadata appeared before commit");
    } else {
      if (!existsSync(path) || !sameFile(fileIdentity(path), expected)) fail("EXTENSION_MIGRATION_CAS_FAILED", "migration metadata changed before commit");
    }
    renameSync(tmp, path); chmodSync(path, 0o600); fsyncDir(parent); assertLease(lease);
  } finally { rmSync(tmp, { force: true }); }
}
function snapshot(path: string): FileIdentity | null { return existsSync(path) ? fileIdentity(path) : null; }
async function acquire(root: string): Promise<Lease> {
  const dir = join(root, "migrations"), path = join(dir, "extensions.lock"); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); safeExistingChain(root, dir);
  const rootId = nodeId(root), migrationsId = nodeId(dir), timeout = process.env.OWNWARD_TEST === "1" ? Number(process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS || 10_000) : 10_000, deadline = Date.now() + Math.max(50, timeout);
  while (Date.now() < deadline) {
    assertNode(root, rootId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST"); assertNode(dir, migrationsId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST");
    const token = crypto.randomUUID(), tmp = join(dir, `.extensions.lock.owner.${token}`);
    try {
      const identity = processIdentity(process.pid); if (!identity) fail("EXTENSION_MIGRATION_LOCK_IDENTITY_UNAVAILABLE", "process start identity unavailable");
      writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, token, pid: process.pid, processIdentity: identity, createdAt: Date.now() }) + "\n", { flag: "wx", mode: 0o600 });
      const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } fsyncDir(dir);
      if (process.env.OWNWARD_TEST === "1" && process.env.OWNWARD_MIGRATION_LOCK_FAULT === "before-publish") process.kill(process.pid, "SIGKILL");
      assertNode(dir, migrationsId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST"); linkSync(tmp, path); fsyncDir(dir);
      const lock = fileIdentity(path), lease = { token, path, lock, root, rootId, migrations: dir, migrationsId }; assertLease(lease); unlinkSync(tmp); fsyncDir(dir); return lease;
    } catch (error: any) {
      if (existsSync(tmp)) { unlinkSync(tmp); fsyncDir(dir); }
      if (error?.code !== "EEXIST") throw error;
      let observed: FileIdentity | undefined, stale = false;
      try {
        observed = fileIdentity(path); const age = Date.now() - observed.mtimeMs;
        try {
          const value = JSON.parse(observed.content);
          if (lockRecord(value)) {
            const currentIdentity = processIdentity(value.pid);
            // Identity lookup can fail transiently for an alive/paused owner. Only a proven-dead
            // process or a positive start-identity mismatch permits takeover.
            stale = currentIdentity !== undefined ? currentIdentity !== value.processIdentity : !pidAlive(value.pid);
          } else stale = age >= 2_000;
        }
        catch { stale = age >= 2_000; }
        if (!observed.content.trim()) stale = age >= 2_000;
      } catch {}
      if (stale && observed) {
        const claim = join(dir, `.extensions.lock.stale.${crypto.randomUUID()}`);
        try { assertNode(root, rootId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST"); assertNode(dir, migrationsId, "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST"); if (!sameFile(fileIdentity(path), observed)) continue; renameSync(path, claim); fsyncDir(dir); const claimed = fileIdentity(claim); if (!sameFile(claimed, observed)) fail("EXTENSION_MIGRATION_LOCK_CAS_FAILED", "stale lock file identity changed"); removeDurable(claim); } catch (error: any) { if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error; }
        continue;
      }
      await Bun.sleep(20);
    }
  }
  fail("EXTENSION_MIGRATION_LOCK_TIMEOUT", "extension migration global lock timeout");
}
function release(lease: Lease) {
  assertLease(lease); unlinkSync(lease.path); fsyncDir(lease.migrations); assertLeaseContainer(lease);
  if (existsSync(lease.path)) fail("EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST", "migration lock reappeared during release");
}
function recover(root: string, kind: Kind, id: string, lease: Lease) {
  assertLease(lease);
  const base = paths(root, kind, id); if (!existsSync(base.marker)) return;
  const marker = readMarker(base.marker, { kind, id }), tx = paths(root, kind, id, marker.tx); assertLease(lease); const ledger = readLedger(base.ledger); assertLease(lease);
  for (const path of [tx.target, tx.parent, tx.staging!, tx.rollback!, tx.backup!, tx.marker, tx.ledger]) safeExistingChain(root, path);
  assertNode(tx.parent, { dev: marker.parentDev, ino: marker.parentIno }, "EXTENSION_MIGRATION_RECOVERY_FAILED");
  if (ledger.applied.includes(marker.migrationId) || marker.phase === "applied") {
    if (!existsSync(tx.target) && existsSync(tx.staging!)) renameDurable(tx.staging!, tx.target);
    if (!existsSync(tx.target)) fail("EXTENSION_MIGRATION_RECOVERY_FAILED", "applied migration target missing");
    assertNode(tx.target, { dev: marker.stagingDev, ino: marker.stagingIno }, "EXTENSION_MIGRATION_RECOVERY_FAILED"); syncTree(tx.target);
    for (const path of [tx.rollback!, tx.staging!, tx.marker]) { assertLease(lease); safeExistingChain(root, path); removeDurable(path); assertLease(lease); } return;
  }
  if (existsSync(tx.rollback!)) { assertNode(tx.rollback!, { dev: marker.sourceDev!, ino: marker.sourceIno! }, "EXTENSION_MIGRATION_RECOVERY_FAILED"); syncTree(tx.rollback!); safeExistingChain(root, tx.target); if (existsSync(tx.target) && marker.phase === "target-swapped") assertNode(tx.target, { dev: marker.stagingDev, ino: marker.stagingIno }, "EXTENSION_MIGRATION_RECOVERY_FAILED"); removeDurable(tx.target); assertNode(tx.parent, { dev: marker.parentDev, ino: marker.parentIno }, "EXTENSION_MIGRATION_RECOVERY_FAILED"); renameDurable(tx.rollback!, tx.target); }
  else if (!marker.hadTarget) { safeExistingChain(root, tx.target); if (existsSync(tx.target)) assertNode(tx.target, { dev: marker.stagingDev, ino: marker.stagingIno }, "EXTENSION_MIGRATION_RECOVERY_FAILED"); removeDurable(tx.target); }
  for (const path of [tx.staging!, tx.marker]) { assertLease(lease); safeExistingChain(root, path); removeDurable(path); assertLease(lease); }
}

export type MigrationContext = { readonly migrationId: string; readonly storage: ScopedStorage };
export async function runExtensionMigration(input: { dataRoot: string; kind: Kind; id: string; version: string; migrate?: (ctx: MigrationContext) => Promise<void> | void; fault?: (stage: Stage) => void }): Promise<{ applied: boolean; migrationId: string }> {
  if (!ID.test(input.id) || !VERSION.test(input.version) || !["vertical", "connector"].includes(input.kind)) fail("EXTENSION_MIGRATION_INPUT_INVALID", "migration identity invalid");
  const root = canonicalRoot(input.dataRoot), migrationId = `${input.kind}:${input.id}@${input.version}`, lease = await acquire(root);
  try {
    recover(root, input.kind, input.id, lease); assertLease(lease);
    const base = paths(root, input.kind, input.id), current = readLedger(base.ledger); assertLease(lease);
    if (current.applied.includes(migrationId) || !input.migrate) return { applied: false, migrationId };
    const txid = crypto.randomUUID(), tx = paths(root, input.kind, input.id, txid), capability = new LifecycleCapability(input.kind, input.id), hadTarget = existsSync(tx.target);
    for (const path of [tx.target, tx.parent, tx.staging!, tx.rollback!, tx.backup!, tx.marker, tx.ledger]) safeExistingChain(root, path);
    mkdirSync(tx.parent, { recursive: true, mode: 0o700 }); chmodSync(tx.parent, 0o700); fsyncDir(dirname(tx.parent)); const parentId = nodeId(tx.parent), sourceId = hadTarget ? nodeId(tx.target) : undefined;
    const backupParent = dirname(tx.backup!); mkdirSync(backupParent, { recursive: true, mode: 0o700 }); chmodSync(backupParent, 0o700); safeExistingChain(root, backupParent); const backupParentId = nodeId(backupParent);
    if (hadTarget) { syncTree(tx.target); assertLease(lease); assertNode(tx.parent, parentId); assertNode(tx.target, sourceId!); assertNode(backupParent, backupParentId); cpSync(tx.target, tx.backup!, { recursive: true, errorOnExist: true }); } else { assertLease(lease); assertNode(backupParent, backupParentId); mkdirSync(tx.backup!, { recursive: true, mode: 0o700 }); } safeExistingChain(root, tx.backup!); syncTree(tx.backup!); assertNode(backupParent, backupParentId); fsyncDir(backupParent); input.fault?.("after-backup"); assertLease(lease); assertNode(tx.parent, parentId); assertNode(backupParent, backupParentId); syncTree(tx.backup!);
    if (hadTarget) { assertNode(tx.target, sourceId!); cpSync(tx.target, tx.staging!, { recursive: true, errorOnExist: true }); } else mkdirSync(tx.staging!, { recursive: true, mode: 0o700 }); syncTree(tx.staging!); const stagingId = nodeId(tx.staging!); fsyncDir(tx.parent); input.fault?.("after-staging"); assertNode(tx.parent, parentId); assertNode(tx.staging!, stagingId); syncTree(tx.staging!);
    try {
      await input.migrate(Object.freeze({ migrationId, storage: scopedStorageAt(tx.staging!, capability) })); capability.revoke(); syncTree(tx.staging!); input.fault?.("after-migrate"); assertLease(lease);
      assertNode(tx.parent, parentId); assertNode(tx.staging!, stagingId); syncTree(tx.staging!); if (hadTarget) assertNode(tx.target, sourceId!);
      let marker: Marker = { schemaVersion: 1, kind: input.kind, id: input.id, version: input.version, migrationId, tx: txid, hadTarget, phase: "prepared", parentDev: parentId.dev, parentIno: parentId.ino, sourceDev: sourceId?.dev ?? null, sourceIno: sourceId?.ino ?? null, stagingDev: stagingId.dev, stagingIno: stagingId.ino };
      atomicCasWithLease(tx.marker, marker, null, lease); input.fault?.("after-marker"); assertLease(lease);
      assertNode(tx.parent, parentId); if (hadTarget) { assertNode(tx.target, sourceId!); renameDurable(tx.target, tx.rollback!); assertNode(tx.rollback!, sourceId!); } input.fault?.("after-target-away");
      assertLease(lease); assertNode(tx.parent, parentId); assertNode(tx.staging!, stagingId); renameDurable(tx.staging!, tx.target); assertNode(tx.target, stagingId); marker = { ...marker, phase: "target-swapped" }; const preparedMarker = snapshot(tx.marker); atomicCasWithLease(tx.marker, marker, preparedMarker, lease); input.fault?.("after-target-swap"); assertLease(lease);
      // Re-read under the global lease immediately before commit and CAS the exact record;
      // this preserves externally-added valid entries instead of overwriting a stale snapshot.
      const ledgerBefore = snapshot(tx.ledger), latest = readLedger(tx.ledger); assertLease(lease); const ledger: Ledger = { schemaVersion: 1, applied: [...new Set([...latest.applied, migrationId])].sort() }; atomicCasWithLease(tx.ledger, ledger, ledgerBefore, lease); marker = { ...marker, phase: "applied" }; const swappedMarker = snapshot(tx.marker); atomicCasWithLease(tx.marker, marker, swappedMarker, lease); input.fault?.("after-applied"); assertLease(lease);
      if (existsSync(tx.rollback!)) { safeExistingChain(root, tx.rollback!); if (!sourceId) fail("EXTENSION_MIGRATION_PATH_CHANGED", "unexpected rollback node"); assertNode(tx.rollback!, sourceId); }
      safeExistingChain(root, tx.marker); removeDurable(tx.rollback!); assertLease(lease); removeDurable(tx.marker); assertLease(lease); return { applied: true, migrationId };
    } catch (error) { capability.revoke(); recover(root, input.kind, input.id, lease); throw error; }
    finally { capability.revoke(); }
  } finally { release(lease); }
}
