import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { dirname } from "path";

export const RUNNER_JOURNAL_LOCK_STALE_MS = 5_000;
export const RUNNER_JOURNAL_LOCK_WAIT_MS = 50;

export type JournalDiagnosticCode = "invalid-json" | "unsupported-schema" | "invalid-shape" | "missing-newline";
export interface JournalDiagnostic { line: number; code: JournalDiagnosticCode; reason: string; fingerprint: string; unterminated: boolean; }
export interface JournalRead<T> { records: T[]; diagnostics: JournalDiagnostic[]; }
export interface JournalTailRepair { repaired: boolean; outcome: "none" | "kept-newline" | "dropped-tail"; backup?: string; removedFingerprint?: string; }

export class RunnerJournalBusyError extends Error {
  readonly code = "RUNNER_JOURNAL_BUSY";
  constructor(message = "Runner journal 正由其他进程写入，请稍后重试") { super(message); this.name = "RunnerJournalBusyError"; }
}
type JournalCache = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; records: unknown[]; identities: Map<string, unknown> };
const journalCaches = new Map<string, JournalCache>();

const fingerprint = (line: string) => new Bun.CryptoHasher("sha256").update(line).digest("hex").slice(0, 16);
/** 进缓存的记录一律深冻结：readStrict 共享它们给所有调用方，隐藏的变更者会在严格模式下
 *  立刻 TypeError（fail closed），而不是悄悄污染跨调用方共享的缓存。 */
function deepFreeze<V>(value: V): V {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
const lockPaths = (file: string) => ({ lock: `${file}.write.lock`, gate: `${file}.recovery.gate` });

function releaseOwned(path: string, cleanup: string, token: string): void {
  try { renameSync(path, cleanup); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
  if (JSON.parse(readFileSync(cleanup, "utf8")).token !== token) throw new Error("Runner journal 锁在释放时换代；保留现场并拒绝继续");
  unlinkSync(cleanup);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export interface RunnerJournalLockValue { pid: number; token: string; at: number; }
type LockValue = RunnerJournalLockValue;
export function canRecoverRunnerLock(v: LockValue, now: number, isAlive = alive): boolean {
  return Number.isInteger(v.pid) && v.pid > 0 && typeof v.token === "string" && !!v.token && Number.isFinite(v.at)
    && now - v.at >= RUNNER_JOURNAL_LOCK_STALE_MS && !isAlive(v.pid);
}
export function claimStaleRunnerGate(gate: string, recovery: string, expectedToken: string): void {
  renameSync(gate, recovery);
  const claimed = JSON.parse(readFileSync(recovery, "utf8")) as LockValue;
  if (claimed.token !== expectedToken) throw new Error("Runner journal gate 在认领窗口换代；保留 recovery 证据并 fail closed");
}
function recoverDeadGate(gate: string): boolean {
  let old: LockValue | undefined; try { old = JSON.parse(readFileSync(gate, "utf8")); } catch { return false; }
  if (!canRecoverRunnerLock(old, Date.now())) return false;
  const recovery = `${gate}.recovery.${process.pid}.${crypto.randomUUID()}`;
  try { claimStaleRunnerGate(gate, recovery, old.token); }
  catch (e: any) { if (e?.code === "ENOENT" || e?.code === "EEXIST") return false; throw e; }
  unlinkSync(recovery); return true;
}

/** gate 也可能在 writer SIGKILL 后残留；只原子认领 dead pid + grace 的旧代，token 歧义保留证据。 */
function acquireGate(gate: string, token: string, deadline: number): { cleanup: string; recovery?: string } {
  const cleanup = `${gate}.cleanup.${process.pid}.${token}`;
  for (;;) {
    try { writeFileSync(gate, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: "wx", mode: 0o600 }); return { cleanup }; }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let old: LockValue | undefined; try { old = JSON.parse(readFileSync(gate, "utf8")); } catch {}
      if (old && canRecoverRunnerLock(old, Date.now())) {
        const recovery = `${gate}.recovery.${process.pid}.${token}`;
        try { claimStaleRunnerGate(gate, recovery, old.token); }
        catch (r: any) { if ((r?.code === "ENOENT" || r?.code === "EEXIST") && Date.now() < deadline) continue; throw new RunnerJournalBusyError("Runner journal gate recovery 竞争失败"); }
        unlinkSync(recovery);
        continue;
      }
      if (Date.now() >= deadline) throw new RunnerJournalBusyError("Runner journal recovery gate 正在使用");
      Bun.sleepSync(2);
    }
  }
}

function withLock<T>(file: string, waitMs: number, fn: (recheck: () => void) => T): T {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const { lock, gate } = lockPaths(file), token = crypto.randomUUID(), gateToken = crypto.randomUUID();
  const cleanup = `${lock}.cleanup.${process.pid}.${token}`, gateCleanup = `${gate}.cleanup.${process.pid}.${gateToken}`;
  const recovery = `${lock}.recovery.${process.pid}.${token}`;
  const deadline = Date.now() + waitMs;
  let owned = false, claimed = false, preserve = false, gateOwned = false, gateCleanupOwned = "";
  const acquire = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: "wx", mode: 0o600 });
  const recheck = () => {
    try { if (JSON.parse(readFileSync(lock, "utf8")).token === token) return; } catch {}
    throw new RunnerJournalBusyError("Runner journal 写锁所有权已变化");
  };
  try {
    for (;;) {
      if (existsSync(gate)) recoverDeadGate(gate);
      let acquired = false;
      try { acquire(); acquired = true; }
      catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        let old: LockValue | undefined; try { old = JSON.parse(readFileSync(lock, "utf8")); } catch {}
        if (old && canRecoverRunnerLock(old, Date.now())) {
          const acquiredGate = acquireGate(gate, gateToken, deadline); gateOwned = true; gateCleanupOwned = acquiredGate.cleanup;
          try {
            let current: LockValue | undefined; try { current = JSON.parse(readFileSync(lock, "utf8")); } catch {}
            if (!current || current.token !== old.token) { releaseOwned(gate, gateCleanupOwned, gateToken); gateOwned = false; if (Date.now() >= deadline) throw new RunnerJournalBusyError(); continue; }
            try { renameSync(lock, recovery); } catch (x: any) {
              releaseOwned(gate, gateCleanupOwned, gateToken); gateOwned = false;
              if ((x?.code === "ENOENT" || x?.code === "EEXIST") && Date.now() < deadline) continue;
              throw x;
            }
            claimed = true;
            if (JSON.parse(readFileSync(recovery, "utf8")).token !== old.token) { preserve = true; throw new Error("Runner journal stale lock 认领后换代"); }
            for (;;) {
              try { acquire(); owned = true; break; }
              catch (a: any) {
                if (a?.code !== "EEXIST") throw a;
                if (Date.now() >= deadline) {
                  releaseOwned(gate, gateCleanupOwned, gateToken); gateOwned = false; unlinkSync(recovery); claimed = false;
                  throw new RunnerJournalBusyError("继任 writer 尚未退出 recovery gate");
                }
                Bun.sleepSync(2);
              }
            }
            releaseOwned(gate, gateCleanupOwned, gateToken); gateOwned = false;
            break;
          } catch (fatal) { preserve ||= claimed; throw fatal; }
        }
        if (existsSync(gate)) { if (Date.now() >= deadline) throw new RunnerJournalBusyError("Runner journal recovery 正在进行"); Bun.sleepSync(2); continue; }
        if (Date.now() >= deadline) throw new RunnerJournalBusyError();
        Bun.sleepSync(2);
      }
      if (!acquired) continue;
      if (existsSync(gate)) { releaseOwned(lock, cleanup, token); if (Date.now() >= deadline) throw new RunnerJournalBusyError(); Bun.sleepSync(2); continue; }
      owned = true; break;
    }
    recheck();
    return fn(recheck);
  } finally {
    if (owned) releaseOwned(lock, cleanup, token);
    if (gateOwned) releaseOwned(gate, gateCleanupOwned || gateCleanup, gateToken);
    if (!preserve) { try { unlinkSync(recovery); } catch {} }
  }
}

/** 通用跨进程文件锁。调用方必须为每类资源固定唯一 lock file，并自行规定嵌套锁序。 */
export function withRunnerFileLock<T>(lockFile: string, fn: (recheck: () => void) => T, waitMs = RUNNER_JOURNAL_LOCK_WAIT_MS): T {
  return withLock(lockFile, waitMs, fn);
}

function durableWrite(file: string, line: string): void {
  const existed = existsSync(file), fd = openSync(file, "a", 0o600);
  try {
    const bytes = Buffer.from(line); let offset = 0;
    while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error("Runner journal 短写入"); offset += n; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(file, 0o600);
  if (!existed) { const d = openSync(dirname(file), "r"); try { fsyncSync(d); } finally { closeSync(d); } }
}

export class DurableJsonlJournal<T> {
  constructor(readonly file: string, private readonly parse: (raw: unknown) => T, private readonly identity: (record: T) => string, private readonly semantic: (record: T) => string, private readonly waitMs = RUNNER_JOURNAL_LOCK_WAIT_MS, private readonly validate?: (records: readonly T[], next: T) => void, private readonly onAppended?: (records: readonly T[], next: T) => void) {}

  read(): JournalRead<T> {
    const value = this.readCached();
    return structuredClone(value);
  }
  get(identity: string): T | undefined {
    const value = this.readCached();
    if (value.diagnostics.length) throw new Error(`${this.file} 有 ${value.diagnostics.length} 条损坏或不支持记录`);
    const found = journalCaches.get(this.file)?.identities.get(identity) as T | undefined;
    return found ? structuredClone(found) : undefined;
  }
  private readCached(): JournalRead<T> {
    if (!existsSync(this.file)) return { records: [], diagnostics: [] };
    const st = statSync(this.file, { bigint: true }), cached = journalCaches.get(this.file);
    if (cached && st.dev === cached.dev && st.ino === cached.ino && st.size === cached.size && st.mtimeNs === cached.mtimeNs && st.ctimeNs === cached.ctimeNs)
      return { records: cached.records as T[], diagnostics: [] };
    // 增量尾读：journal 是 append-only（改写一律 tmp+rename 换 inode），同 dev/ino 且只增长时
    // 只读新增字节、只解析新行——跨进程读者（daemon 对着 runner 在写的 events.jsonl 50ms 轮询）
    // 不再每次全文件重读重解析。新块必须以 \n 收尾且全部可解析才采纳；任何异常回退全量路径，
    // 半行/损坏的 diagnostics（行号、unterminated）保持与全量完全一致的可观测语义。
    if (cached && st.dev === cached.dev && st.ino === cached.ino && st.size > cached.size) {
      const appended = this.readRange(Number(cached.size), Number(st.size));
      if (appended !== null && appended.endsWith("\n")) {
        const tail = this.parseSnapshot(appended);
        if (!tail.diagnostics.length) {
          for (const r of tail.records) { cached.records.push(r); cached.identities.set(this.identity(r), r); }
          cached.size = st.size; cached.mtimeNs = st.mtimeNs; cached.ctimeNs = st.ctimeNs;
          return { records: cached.records as T[], diagnostics: [] };
        }
      }
    }
    const parsed = this.parseSnapshot(readFileSync(this.file, "utf8"));
    if (!parsed.diagnostics.length) journalCaches.set(this.file, { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, records: parsed.records, identities: new Map(parsed.records.map((r) => [this.identity(r), r])) });
    return parsed;
  }
  /** 读 [start, end) 字节区间；start 必在行首（缓存只在整行边界推进），end 截半个多字节字符时
   *  解析会失败并回退全量，不会产出错数据。 */
  private readRange(start: number, end: number): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const buf = Buffer.alloc(end - start);
      let done = 0;
      while (done < buf.length) {
        const n = readSync(fd, buf, done, buf.length - done, start + done);
        if (n <= 0) return null;  // 文件比 stat 时短了（被换掉/截断）：回退全量
        done += n;
      }
      return buf.toString("utf8");
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }
  /** 热路径读：返回**共享的冻结记录**（浅拷贝数组）。记录进缓存时已深冻结——
   *  调用方全是只读用法（filter/find/投影），省掉每次 O(N) 的 structuredClone
   *  （daemon 50ms 轮询下深克隆是最大单项开销）。谁要可变副本用 read()/get()。 */
  readStrict(): T[] {
    const value = this.readCached();
    if (value.diagnostics.length) throw new Error(`${this.file} 有 ${value.diagnostics.length} 条损坏或不支持记录`);
    return [...(value.records as T[])];
  }
  append(raw: unknown): { appended: boolean; record: T } {
    const next = this.parse(raw);
    return this.appendParsed(() => next);
  }
  appendWith(factory: (records: readonly T[], lookup: (identity: string) => T | undefined) => unknown): { appended: boolean; record: T } {
    return this.appendParsed((records) => {
      const identities = journalCaches.get(this.file)?.identities;
      return this.parse(factory(records, (identity) => identities?.get(identity) as T | undefined));
    });
  }
  private appendParsed(factory: (records: readonly T[]) => T): { appended: boolean; record: T } {
    return withLock(this.file, this.waitMs, (recheck) => {
      const current = this.readCached();
      if (current.diagnostics.length) throw new Error(`${this.file} 已损坏，拒绝追加`);
      const next = deepFreeze(factory(current.records));  // 与 parseSnapshot 同规：进缓存前冻结
      const currentCache = journalCaches.get(this.file);
      const prior = (currentCache?.identities.get(this.identity(next)) as T | undefined) ?? current.records.find((r) => this.identity(r) === this.identity(next));
      if (prior) {
        if (this.semantic(prior) === this.semantic(next)) return { appended: false, record: prior };
        throw new Error(`Runner journal id 内容冲突: ${this.identity(next)}`);
      }
      this.validate?.(current.records, next);
      recheck(); durableWrite(this.file, JSON.stringify(next) + "\n");
      const st = statSync(this.file, { bigint: true });
      current.records.push(next);
      const identities = currentCache?.identities ?? new Map(current.records.slice(0, -1).map((r) => [this.identity(r), r])); identities.set(this.identity(next), next);
      journalCaches.set(this.file, { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, records: current.records, identities });
      this.onAppended?.(current.records, next);
      return { appended: true, record: next };
    });
  }
  repairTruncatedTail(): JournalTailRepair {
    return withLock(this.file, this.waitMs, (recheck) => {
      if (!existsSync(this.file)) return { repaired: false, outcome: "none" };
      const raw = readFileSync(this.file, "utf8"), result = this.parseSnapshot(raw);
      if (!result.diagnostics.length) return { repaired: false, outcome: "none" };
      const d = result.diagnostics[0];
      if (result.diagnostics.length !== 1 || (d.code !== "invalid-json" && d.code !== "missing-newline") || !d.unterminated)
        throw new Error("只允许修复最后一条无换行的截断 JSON 或补齐合法记录换行");
      const repaired = d.code === "missing-newline" ? raw + "\n" : raw.slice(0, raw.lastIndexOf("\n") + 1);
      const backup = `${this.file}.backup.${Date.now()}.${crypto.randomUUID()}`;
      writeFileSync(backup, raw, { flag: "wx", mode: 0o600 }); const b = openSync(backup, "r"); try { fsyncSync(b); } finally { closeSync(b); }
      const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, repaired, { flag: "wx", mode: 0o600 }); const f = openSync(tmp, "r"); try { fsyncSync(f); } finally { closeSync(f); }
        recheck(); renameSync(tmp, this.file); journalCaches.delete(this.file); const dfd = openSync(dirname(this.file), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
        chmodSync(this.file, 0o600);
        return { repaired: true, outcome: d.code === "missing-newline" ? "kept-newline" : "dropped-tail", backup, removedFingerprint: d.fingerprint };
      } finally { try { rmSync(tmp); } catch {} }
    });
  }
  private parseSnapshot(raw: string): JournalRead<T> {
    const lines = raw.split("\n"), records: T[] = [], diagnostics: JournalDiagnostic[] = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try { records.push(deepFreeze(this.parse(JSON.parse(line)))); }
      catch (e: any) {
        diagnostics.push({ line: i + 1, code: e?.code === "unsupported-schema" ? "unsupported-schema" : e instanceof SyntaxError ? "invalid-json" : "invalid-shape", reason: e instanceof Error ? e.message : String(e), fingerprint: fingerprint(line), unterminated: i === lines.length - 1 && !raw.endsWith("\n") });
      }
    });
    if (raw && !raw.endsWith("\n") && !diagnostics.some((d) => d.line === lines.length)) diagnostics.push({ line: lines.length, code: "missing-newline", reason: "最后一条记录缺少行尾换行", fingerprint: fingerprint(lines.at(-1)!), unterminated: true });
    return { records, diagnostics };
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => v === undefined ? "null" : stableJson(v)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
