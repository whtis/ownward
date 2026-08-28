import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { PublicSkillTransaction, SkillScanOptions, SkillTransactionPhase } from "./contracts.ts";
import { atomicWrite, assertPath, copyTreeSecure, matchesPath, removeEntry, snapshotPath, treeDigest } from "./filesystem.ts";
import type { InternalSkillEffect, InternalSkillPlan, PathPrecondition, RawSkillSnapshot } from "./internal.ts";

type OperationStatus = "pending" | "running" | "completed" | "rolled-back";
type OperationSubphase = "none" | "backup-reserved" | "backup-renamed" | "effect-started" | "effect-applied";
interface JournalOperation extends InternalSkillEffect { status: OperationStatus; subphase: OperationSubphase; backupPath: string | null; postcondition: PathPrecondition | null }
interface TransactionJournal extends PublicSkillTransaction { schemaVersion: 1; planDigest: string; inventoryRevision: string; idempotencyKey: string; effects: JournalOperation[]; rollbackAvailable: boolean; rollbackOf: string | null }
const terminal = new Set<SkillTransactionPhase>(["committed", "rolled-back", "manual-repair"]);
const txDir = (storeRoot: string) => join(storeRoot, "transactions");
const backupDir = (storeRoot: string, id: string) => join(storeRoot, "backups", id);
const pathFor = (storeRoot: string, id: string) => join(txDir(storeRoot), `${id}.json`);
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const publicTx = (j: TransactionJournal): PublicSkillTransaction => ({ id: j.id, planId: j.planId, phase: j.phase, createdAt: j.createdAt, updatedAt: j.updatedAt, currentEffect: j.currentEffect, errorCode: j.errorCode, rollbackStatus: j.rollbackStatus, verification: j.verification });
export interface SkillTransactionHooks { beforeEffect?: (effect: InternalSkillEffect) => void; afterEffect?: (effect: InternalSkillEffect) => void; duringCopy?: (source: string, target: string) => void }

function writeJournal(storeRoot: string, journal: TransactionJournal) { journal.updatedAt = new Date().toISOString(); atomicWrite(pathFor(storeRoot, journal.id), JSON.stringify(journal, null, 2) + "\n"); }
function readJournal(storeRoot: string, id: string): TransactionJournal { if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("SKILL_TRANSACTION_INVALID", "Skill transaction 不存在或损坏"); try { const value = JSON.parse(readFileSync(pathFor(storeRoot, id), "utf8")); if (value?.schemaVersion !== 1 || !Array.isArray(value.effects)) throw new Error(); return value; } catch { return fail("SKILL_TRANSACTION_INVALID", "Skill transaction 不存在或损坏"); } }
function journals(storeRoot: string): TransactionJournal[] { try { return readdirSync(txDir(storeRoot)).filter((x) => x.endsWith(".json")).map((x) => { const id = x.slice(0, -5); if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("SKILL_TRANSACTION_INVALID", "transactions 目录含未知 journal"); return readJournal(storeRoot, id); }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; } }

function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function acquire(storeRoot: string): () => void {
  const lock = join(storeRoot, "mutation.lock"); mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  try { mkdirSync(lock); atomicWrite(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
  catch (error: any) {
    let stale = false; try { const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); stale = Number.isSafeInteger(owner.pid) && !pidAlive(owner.pid); } catch {}
    if (!stale) fail("SKILL_MUTATION_BUSY", "已有 Skill 写事务正在执行"); rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); atomicWrite(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

function durableRename(from: string, to: string): void { mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); renameSync(from, to); for (const dir of new Set([dirname(from), dirname(to)])) { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } }
function reserveBackup(effect: JournalOperation, root: string): void { if (effect.precondition.exists && !effect.backupPath) effect.backupPath = join(root, String(effect.index), basename(effect.path)); effect.subphase = "backup-reserved"; }
function renameBackup(effect: JournalOperation): void { if (effect.backupPath && !existsSync(effect.backupPath)) durableRename(effect.path, effect.backupPath); effect.subphase = effect.backupPath ? "backup-renamed" : "effect-started"; }
function applyEffect(effect: JournalOperation, hooks: SkillTransactionHooks): void {
  if (!effect.backupPath) assertPath(effect.path, effect.precondition); else if (existsSync(effect.path)) fail("SKILL_PRECONDITION_DRIFT", "原路径未被原子备份"); if (effect.source && effect.sourcePrecondition) assertPath(effect.source, effect.sourcePrecondition, "source");
  switch (effect.kind) {
    case "mkdir": mkdirSync(effect.path); break;
    case "copy-tree": hooks.duringCopy ? hooks.duringCopy(effect.source!, effect.path) : copyTreeSecure(effect.source!, effect.path); break;
    case "create-link": symlinkSync(effect.target!, effect.path); break;
    case "replace-with-link": symlinkSync(effect.target!, effect.path); break;
    case "delete-entry": break; // atomic rename to backup is the forward delete effect
    case "write-registry": atomicWrite(effect.path, effect.content!, effect.mode || 0o600); break;
  }
}
function looksApplied(effect: JournalOperation): boolean {
  const current = snapshotPath(effect.path);
  if (effect.kind === "mkdir" && effect.postcondition) return current.nodeType === "directory" && current.identity?.dev === effect.postcondition.identity?.dev && current.identity?.ino === effect.postcondition.identity?.ino;
  if (effect.postcondition) return matchesPath(effect.path, effect.postcondition, false);
  if (effect.kind === "delete-entry") return !current.exists;
  if (effect.kind === "create-link" || effect.kind === "replace-with-link") return current.nodeType === "symlink" && current.linkTarget === resolve(effect.target!);
  if (effect.kind === "copy-tree") return current.exists && current.digest === treeDigest(effect.source!);
  if (effect.kind === "mkdir") return current.nodeType === "directory";
  if (effect.kind === "write-registry") return current.exists && readFileSync(effect.path, "utf8") === effect.content;
  return false;
}
function rollbackEffect(effect: JournalOperation): void {
  if (matchesPath(effect.path, effect.precondition, false)) { effect.status = "rolled-back"; return; }
  const hasBackup = !!effect.backupPath && existsSync(effect.backupPath);
  if (hasBackup) {
    if (existsSync(effect.path)) { if (!looksApplied(effect)) fail("SKILL_ROLLBACK_DRIFT", `回滚前 ${basename(effect.path)} 已被其他操作修改`); removeEntry(effect.path); }
    durableRename(effect.backupPath!, effect.path);
  } else {
    if (effect.precondition.exists) fail("SKILL_ROLLBACK_BACKUP_MISSING", `缺少 ${basename(effect.path)} 的原子备份`);
    if (existsSync(effect.path)) {
      const partialOwnedCopy = effect.kind === "copy-tree" && effect.subphase === "effect-started";
      if (!partialOwnedCopy && !looksApplied(effect)) fail("SKILL_ROLLBACK_DRIFT", `回滚前 ${basename(effect.path)} 已被其他操作修改`);
      if (effect.kind === "mkdir" && readdirSync(effect.path).length) fail("SKILL_ROLLBACK_DRIFT", `回滚目录 ${basename(effect.path)} 中出现计划外内容`); removeEntry(effect.path);
    }
  }
  if (!matchesPath(effect.path, effect.precondition, false)) {
    // Restored copies necessarily have new inode identities; content, node and link state are the rollback truth.
    const restored = snapshotPath(effect.path); if (restored.exists !== effect.precondition.exists || restored.nodeType !== effect.precondition.nodeType || restored.digest !== effect.precondition.digest || restored.linkTarget !== effect.precondition.linkTarget) fail("SKILL_ROLLBACK_VERIFY_FAILED", `无法验证 ${basename(effect.path)} 的回滚结果`);
  }
  effect.status = "rolled-back";
}
function rollback(storeRoot: string, journal: TransactionJournal): void {
  journal.phase = "rolling-back"; journal.rollbackStatus = "pending"; writeJournal(storeRoot, journal);
  try { for (const effect of [...journal.effects].reverse()) if (effect.status === "completed" || effect.status === "running") { rollbackEffect(effect); writeJournal(storeRoot, journal); } journal.phase = "rolled-back"; journal.rollbackStatus = "complete"; journal.currentEffect = null; writeJournal(storeRoot, journal); }
  catch (error: any) { journal.phase = "manual-repair"; journal.rollbackStatus = "failed"; journal.errorCode = error?.code || "SKILL_ROLLBACK_FAILED"; writeJournal(storeRoot, journal); throw error; }
}
function assertNotFrozen(storeRoot: string) { if (journals(storeRoot).some((x) => x.phase === "manual-repair")) fail("SKILL_MUTATION_FROZEN", "存在需要人工修复的 Skill 事务，写操作已冻结"); }
function pruneBackups(storeRoot: string, maxTransactions = 50, maxBytes = 1024 * 1024 * 1024) {
  const candidates = journals(storeRoot).filter((x) => terminal.has(x.phase) && x.rollbackAvailable); let bytes = 0;
  const size = (path: string): number => { try { const st = lstatSync(path); if (st.isDirectory()) return readdirSync(path).reduce((n,x)=>n+size(join(path,x)),0); return st.size; } catch { return 0; } };
  for (const item of candidates) bytes += size(backupDir(storeRoot, item.id));
  while (candidates.length > maxTransactions || bytes > maxBytes) { const item = candidates.shift()!; const path = backupDir(storeRoot, item.id), removed = size(path); rmSync(path, { recursive: true, force: true }); bytes -= removed; item.rollbackAvailable = false; writeJournal(storeRoot, item); }
}

export class SkillTransactionExecutor {
  constructor(private readonly options: SkillScanOptions, private readonly hooks: SkillTransactionHooks = {}) {}
  get storeRoot() { return resolve(this.options.storeRoot || join(this.options.home, ".ownward", "skills")); }
  list(): PublicSkillTransaction[] { return journals(this.storeRoot).map(publicTx); }
  get(id: string): PublicSkillTransaction { return publicTx(readJournal(this.storeRoot, id)); }
  rollbackPreview(id: string) {
    const journal = readJournal(this.storeRoot, id);
    if (journal.phase !== "committed" || !journal.rollbackAvailable) fail("SKILL_ROLLBACK_UNAVAILABLE", "该事务不可回滚");
    const alias = (path: string) => path === this.options.home ? "~" : path.startsWith(this.options.home + "/") ? `~${path.slice(this.options.home.length)}` : `[external]/${basename(path)}`;
    return { transactionId: id, effects: [...journal.effects].reverse().map((effect) => ({ index: effect.index, path: alias(effect.path), action: effect.precondition.exists ? "restore-backup" : "remove-created-entry", destructive: true, summary: effect.precondition.exists ? `恢复 ${basename(effect.path)} 的事务前备份` : `移除事务创建的 ${basename(effect.path)}` })) };
  }
  apply(plan: InternalSkillPlan, idempotencyKey: string, verify: () => RawSkillSnapshot, authorize: () => void = () => {}): PublicSkillTransaction {
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) fail("SKILL_IDEMPOTENCY_INVALID", "幂等键格式无效");
    const release = acquire(this.storeRoot); try {
      assertNotFrozen(this.storeRoot); const found = journals(this.storeRoot).find((x) => x.idempotencyKey === idempotencyKey); if (found) { if (found.planDigest !== plan.public.digest) fail("SKILL_IDEMPOTENCY_CONFLICT", "幂等键已绑定其他 Skill 计划"); return publicTx(found); } authorize(); const now = new Date().toISOString(), id = plan.public.transactionId; if (journals(this.storeRoot).some((x) => x.id === id)) fail("SKILL_TRANSACTION_CONFLICT", "计划 transactionId 已被使用");
      const journal: TransactionJournal = { schemaVersion: 1, id, planId: plan.public.id, planDigest: plan.public.digest, inventoryRevision: plan.public.inventoryRevision, idempotencyKey, phase: "prepared", createdAt: now, updatedAt: now, currentEffect: null, errorCode: null, rollbackStatus: "not-needed", verification: [], effects: plan.effects.map((x) => ({ ...x, status: "pending", subphase: "none", backupPath: null, postcondition: null })), rollbackAvailable: true, rollbackOf: null };
      writeJournal(this.storeRoot, journal); journal.phase = "approved"; writeJournal(this.storeRoot, journal); journal.phase = "applying"; writeJournal(this.storeRoot, journal);
      try {
        for (const operation of journal.effects) { journal.currentEffect = operation.index; operation.status = "running"; reserveBackup(operation, backupDir(this.storeRoot, id)); writeJournal(this.storeRoot, journal); renameBackup(operation); writeJournal(this.storeRoot, journal); operation.subphase = "effect-started"; writeJournal(this.storeRoot, journal); this.hooks.beforeEffect?.(operation); applyEffect(operation, this.hooks); this.hooks.afterEffect?.(operation); operation.postcondition = snapshotPath(operation.path); operation.subphase = "effect-applied"; operation.status = "completed"; writeJournal(this.storeRoot, journal); }
        journal.phase = "verifying"; journal.currentEffect = null; writeJournal(this.storeRoot, journal);
        const snapshot = verify(); if (snapshot.inventory.completeness !== "complete") fail("SKILL_VERIFY_PARTIAL", "写后扫描不完整");
        for (const skill of plan.registryAfter.skills) { if (!existsSync(skill.managedPath) || treeDigest(skill.managedPath) !== skill.digest) fail("SKILL_VERIFY_MANAGED_DIGEST", `受管 Skill ${skill.name} 校验失败`); for (const deployment of skill.deployments.filter((x) => x.desired)) { const current = snapshotPath(deployment.path); if (current.nodeType !== "symlink" || current.linkTarget !== resolve(skill.managedPath)) fail("SKILL_VERIFY_DEPLOYMENT", `Skill ${skill.name} 部署校验失败`); } }
        journal.verification = snapshot.inventory.adapters.filter((x) => plan.registryAfter.skills.some((s) => s.deployments.some((d) => d.engine === x.engine))).map((x) => ({ engine: x.engine, status: x.verification === "loadable" ? "loadable" : "disk-only", message: x.verification === "loadable" ? "已确认引擎加载" : "已确认磁盘部署；引擎无可验证刷新协议" })); journal.phase = "committed"; writeJournal(this.storeRoot, journal); pruneBackups(this.storeRoot); return publicTx(journal);
      } catch (error: any) { journal.errorCode = error?.code || "SKILL_APPLY_FAILED"; writeJournal(this.storeRoot, journal); if (error?.simulateCrash === true) throw error; rollback(this.storeRoot, journal); throw error; }
    } finally { release(); }
  }
  recover(verify: () => RawSkillSnapshot): void {
    const release = acquire(this.storeRoot); try { for (const journal of journals(this.storeRoot).filter((x) => !terminal.has(x.phase))) { if (journal.phase === "verifying" && journal.effects.every(looksApplied)) { try { verify(); journal.phase = "committed"; journal.currentEffect = null; writeJournal(this.storeRoot, journal); continue; } catch {} } rollback(this.storeRoot, journal); } } finally { release(); }
  }
  rollbackCommitted(id: string): PublicSkillTransaction {
    const release = acquire(this.storeRoot); try { assertNotFrozen(this.storeRoot); const journal = readJournal(this.storeRoot, id); if (journal.phase === "rolled-back") return publicTx(journal); if (journal.phase !== "committed" || !journal.rollbackAvailable) fail("SKILL_ROLLBACK_UNAVAILABLE", "该事务不可回滚"); const later = journals(this.storeRoot).filter((x) => x.phase === "committed" && x.createdAt > journal.createdAt), overlaps = (a:string,b:string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); if (later.some((x) => x.effects.some((e) => journal.effects.some((own) => overlaps(e.path, own.path))))) fail("SKILL_ROLLBACK_DEPENDENCY", "后续事务依赖本事务输出，需要生成新的逆向计划"); if (!journal.effects.every(looksApplied)) fail("SKILL_ROLLBACK_DRIFT", "当前文件状态已变化，需要生成新的逆向计划"); rollback(this.storeRoot, journal); return publicTx(journal); } finally { release(); }
  }
}
