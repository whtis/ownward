/**
 * 会话派生索引（SQLite + FTS5）：侧栏「最近会话」和跨会话全文搜索都从这里读，不再每次把全部会话重放一遍。
 *
 * 真相仍是 runner journal / legacy session.json / codex rollout；索引只是它们的可重建投影：
 * 每个来源一行 sessions（计数、末句、turn、待审批）+ 若干 messages 行（进 FTS）。签名（来源文件/事件尾巴指纹）
 * 没变就跳过，变了才重投影那一个会话——所以扫描一次在没事发生时只是几十次 stat。
 * 库损坏 / schema 升级 = 删库重建（rebuild()），不需要迁移。
 *
 * 为什么要它（2026-09-13 实测）：/api/dev/recent 原来对 101 个 runner 会话各做一次完整投影，31k 个 payload blob
 * 逐个读盘+sha256 共 3.8s，且整段同步——网页 tasks 页每 60s 拉一次，daemon 每两分钟卡死 4-6s，
 * 恰好撞上就是「打开任务要等好久」。归档会话以前只有标题能搜；现在正文进 FTS，不必先把会话打开。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { dirname, join } from "path";
import type { DevMsg } from "./kernel/sessions/types.ts";
import { DATA, log } from "./util.ts";

export const SESSION_INDEX_SCHEMA = 1;
export type IndexKind = "runner" | "legacy" | "codex";
export type PendingBrief = { toolName?: string; brief?: string };
export type SessionIndexRow = {
  key: string; kind: IndexKind; sessionId: string; taskId: string; providerId: string; signature: string; source: string;
  msgs: number; userMsgs: number; lastText: string; lastRole: string; lastAt: number; turn: string; pending: PendingBrief[]; indexedAt: number;
};
export type SearchHit = {
  key: string; kind: IndexKind; sessionId: string; taskId: string; providerId: string;
  ord: number; role: string; name: string; ts: string; snippet: string; lastAt: number;
};
export type SweepReport = { at: number; ms: number; scanned: number; updated: number; removed: number; runner: number; legacy: number; codex: number; errors: string[] };

const MESSAGE_TEXT_LIMIT = 20_000;   // 工具结果可能很长；FTS 只要能搜到，不必整段进库
const SCHEMA_SQL = `
create table meta(key text primary key, value text not null);
create table sessions(
  key text primary key, kind text not null, session_id text not null, task_id text not null, provider_id text not null,
  signature text not null, source text not null default '', msgs integer not null, user_msgs integer not null,
  last_text text not null, last_role text not null, last_at integer not null, turn text not null, pending_json text not null, indexed_at integer not null);
create index sessions_task on sessions(task_id);
create table messages(id integer primary key, key text not null, ord integer not null, role text not null, name text not null, ts text not null, text text not null);
create index messages_key on messages(key, ord);
create virtual table messages_fts using fts5(text, content='messages', content_rowid='id', tokenize='trigram');
create trigger messages_ai after insert on messages begin insert into messages_fts(rowid, text) values (new.id, new.text); end;
create trigger messages_ad after delete on messages begin insert into messages_fts(messages_fts, rowid, text) values ('delete', old.id, old.text); end;
`;

/** 从一份消息列表推出侧栏要的读数——与原 /api/dev/recent 的 derive() 同口径。 */
export function summarizeMessages(messages: readonly DevMsg[]): { msgs: number; userMsgs: number; lastText: string; lastRole: string; lastAt: number } {
  let userMsgs = 0, lastAt = 0;
  for (const m of messages) { if (m.role === "user") userMsgs++; lastAt = Math.max(lastAt, Date.parse(m.ts || "") || 0); }
  const real = [...messages].reverse().find((m) => (m.role === "assistant" || m.role === "user") && m.text?.trim());
  return { msgs: messages.length, userMsgs, lastText: real ? `${real.role === "user" ? "我：" : ""}${String(real.text).trim().slice(0, 160)}` : "", lastRole: real?.role ?? "", lastAt };
}

export class SessionIndexStore {
  private db!: Database;
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    // 打不开（文件不是库 / 半截写坏）或 schema 不对：删库重建。它只是派生物，重扫一遍就回来了。
    let ok = false;
    try { this.db = SessionIndexStore.open(file); ok = this.schemaCurrent(); if (!ok) this.db.close(); } catch { ok = false; }
    if (!ok) { this.wipe(); this.db = SessionIndexStore.open(file); this.db.exec(SCHEMA_SQL); this.db.run("insert into meta(key, value) values ('schema', ?)", [String(SESSION_INDEX_SCHEMA)]); }
  }
  private static open(file: string): Database { const db = new Database(file, { create: true }); db.run("pragma journal_mode = wal"); db.run("pragma synchronous = normal"); return db; }
  private schemaCurrent(): boolean {
    try {
      if (!this.db.query("select name from sqlite_master where type = 'table' and name = 'meta'").get()) return false;
      const row = this.db.query<{ value: string }, []>("select value from meta where key = 'schema'").get();
      return row?.value === String(SESSION_INDEX_SCHEMA);
    } catch { return false; }
  }
  private wipe(): void { for (const suffix of ["", "-wal", "-shm"]) rmSync(this.file + suffix, { force: true }); }
  /** 删库重来：schema 升级、库损坏、或用户点「重建索引」。 */
  reset(): void { this.db.close(); this.wipe(); this.db = SessionIndexStore.open(this.file); this.db.exec(SCHEMA_SQL); this.db.run("insert into meta(key, value) values ('schema', ?)", [String(SESSION_INDEX_SCHEMA)]); }
  close(): void { this.db.close(); }

  get(key: string): SessionIndexRow | null { const row = this.db.query("select * from sessions where key = ?").get(key) as any; return row ? rowOf(row) : null; }
  list(): SessionIndexRow[] { return (this.db.query("select * from sessions").all() as any[]).map(rowOf); }
  signatures(): Map<string, string> { return new Map((this.db.query<{ key: string; signature: string }, []>("select key, signature from sessions").all()).map((r) => [r.key, r.signature])); }
  upsert(row: Omit<SessionIndexRow, "indexedAt">, messages: readonly DevMsg[]): void {
    const write = this.db.transaction(() => {
      this.db.run("delete from messages where key = ?", [row.key]);
      const insert = this.db.prepare("insert into messages(key, ord, role, name, ts, text) values (?, ?, ?, ?, ?, ?)");
      messages.forEach((m, ord) => { const text = String(m.text ?? "").slice(0, MESSAGE_TEXT_LIMIT); if (text.trim()) insert.run(row.key, ord, m.role, m.name ?? "", m.ts ?? "", text); });
      this.db.run(`insert into sessions(key, kind, session_id, task_id, provider_id, signature, source, msgs, user_msgs, last_text, last_role, last_at, turn, pending_json, indexed_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(key) do update set kind = excluded.kind, session_id = excluded.session_id, task_id = excluded.task_id, provider_id = excluded.provider_id, signature = excluded.signature, source = excluded.source,
          msgs = excluded.msgs, user_msgs = excluded.user_msgs, last_text = excluded.last_text, last_role = excluded.last_role, last_at = excluded.last_at, turn = excluded.turn, pending_json = excluded.pending_json, indexed_at = excluded.indexed_at`,
        [row.key, row.kind, row.sessionId, row.taskId, row.providerId, row.signature, row.source, row.msgs, row.userMsgs, row.lastText, row.lastRole, Math.round(row.lastAt), row.turn, JSON.stringify(row.pending), Date.now()]);
    });
    write();
  }
  remove(key: string): void { this.db.transaction(() => { this.db.run("delete from messages where key = ?", [key]); this.db.run("delete from sessions where key = ?", [key]); })(); }
  /** 全文搜索：trigram 分词做子串匹配（中英文都行，不用分词器猜词边界）；不足 3 个字符 FTS 搜不了，退 LIKE。按会话新旧排。 */
  search(query: string, limit = 30): SearchHit[] {
    const q = query.trim(); if ([...q].length < 2) return [];   // 1 个字符只能 LIKE 全表扫，网页也挡在 2 字——服务端一并挡住
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const cols = "m.key, m.ord, m.role, m.name, m.ts, s.kind, s.session_id, s.task_id, s.provider_id, s.last_at";
    const rows = [...q].length >= 3
      ? this.db.query(`select ${cols}, snippet(messages_fts, 0, '[', ']', '…', 64) as snippet from messages_fts join messages m on m.id = messages_fts.rowid join sessions s on s.key = m.key where messages_fts match ? order by s.last_at desc, m.ord desc limit ?`).all(`"${q.replaceAll('"', '""')}"`, n)
      : this.db.query(`select ${cols}, substr(m.text, max(1, instr(lower(m.text), lower(?)) - 30), 90) as snippet from messages m join sessions s on s.key = m.key where m.text like ? escape '\\' order by s.last_at desc, m.ord desc limit ?`).all(q, `%${q.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`, n);
    return (rows as any[]).map((r) => ({ key: r.key, kind: r.kind, sessionId: r.session_id, taskId: r.task_id, providerId: r.provider_id, ord: r.ord, role: r.role, name: r.name, ts: r.ts, snippet: String(r.snippet ?? ""), lastAt: r.last_at }));
  }
  stats(): { sessions: number; messages: number; bytes: number } {
    const sessions = (this.db.query<{ n: number }, []>("select count(*) as n from sessions").get()?.n) ?? 0, messages = (this.db.query<{ n: number }, []>("select count(*) as n from messages").get()?.n) ?? 0;
    let bytes = 0; try { bytes = statSync(this.file).size; } catch { /* 还没落盘 */ }
    return { sessions, messages, bytes };
  }
}
function rowOf(r: any): SessionIndexRow {
  let pending: PendingBrief[] = []; try { pending = JSON.parse(r.pending_json); } catch { /* 坏行当无待审批 */ }
  return { key: r.key, kind: r.kind, sessionId: r.session_id, taskId: r.task_id, providerId: r.provider_id, signature: r.signature, source: r.source ?? "", msgs: r.msgs, userMsgs: r.user_msgs, lastText: r.last_text, lastRole: r.last_role, lastAt: r.last_at, turn: r.turn, pending, indexedAt: r.indexed_at };
}

// ---- 扫描：三类来源各自签名，变了才重投影 ----
const stores = new Map<string, SessionIndexStore>();
const services = new Map<string, import("./kernel/sessions/service.ts").KernelSessionService>();
const sweeps = new Map<string, { last?: SweepReport; inflight?: Promise<SweepReport> }>();
export function sessionIndex(dataRoot = DATA): SessionIndexStore {
  let store = stores.get(dataRoot);
  if (!store) {
    try { store = new SessionIndexStore(join(dataRoot, "index", "sessions.sqlite")); }
    catch (error) { log(`session index: 打不开，删库重建（${error instanceof Error ? error.message : error}）`); for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataRoot, "index", "sessions.sqlite" + suffix), { force: true }); store = new SessionIndexStore(join(dataRoot, "index", "sessions.sqlite")); }
    stores.set(dataRoot, store);
  }
  return store;
}
export function resetSessionIndexForTest(dataRoot = DATA): void { stores.get(dataRoot)?.close(); stores.delete(dataRoot); services.delete(dataRoot); sweeps.delete(dataRoot); }
const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const fileSignature = (file: string): string | null => { try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return null; } };
const CODEX_ROLLOUT_QUIET_MS = 120_000;   // 正在被 codex 写的 rollout（几十 MB）别每次都整份重解析，等它安静下来

/** 扫一遍所有来源，把变了的会话重新入库。maxAgeMs 内扫过就直接复用上次结果；并发调用合并成一次。 */
export async function sweepSessionIndex(opts: { dataRoot?: string; maxAgeMs?: number; roots?: string[]; force?: boolean } = {}): Promise<SweepReport> {
  const dataRoot = opts.dataRoot ?? DATA, slot = sweeps.get(dataRoot) ?? {}; sweeps.set(dataRoot, slot);
  if (!opts.force && slot.last && Date.now() - slot.last.at < (opts.maxAgeMs ?? 0)) return slot.last;
  if (slot.inflight) return slot.inflight;
  slot.inflight = runSweep(dataRoot, opts.roots ?? [], !!opts.force).then((report) => { slot.last = report; return report; }).finally(() => { slot.inflight = undefined; });
  return slot.inflight;
}
export function lastSweepReport(dataRoot = DATA): SweepReport | undefined { return sweeps.get(dataRoot)?.last; }

async function runSweep(dataRoot: string, roots: string[], force: boolean): Promise<SweepReport> {
  const started = Date.now(), report: SweepReport = { at: started, ms: 0, scanned: 0, updated: 0, removed: 0, runner: 0, legacy: 0, codex: 0, errors: [] };
  const seen = new Set<string>();   // 本轮见到的来源；扫描无误时，库里多出来的行就是被删/改名的任务或会话，要回收
  const store = sessionIndex(dataRoot);
  if (force) store.reset();
  const known = store.signatures();
  const { loadTasks } = await import("./dispatch.ts");
  const tasks = loadTasks().filter((t) => t.engine);
  // 只有 runner 会话（source ≠ legacy）的任务才由 journal 投影；legacy 身份记录只是把旧任务登记进仓库，
  // 它们的正文仍在 tasks/<id>.session.json——按 sessionByTask 一刀切会把这些老会话全漏掉
  const runnerByTask = new Set<string>(), runnerSessions: { id: string; taskIds: string[]; providerId: string }[] = [];
  let repoOk = true, runnerOk = true;
  try {
    const { SessionRepository } = await import("./sessions/repository.ts");
    for (const session of new SessionRepository(dataRoot).list()) {
      if (session.source === "legacy") continue;
      for (const taskId of session.taskIds) runnerByTask.add(taskId);
      runnerSessions.push({ id: session.id, taskIds: [...session.taskIds], providerId: session.providerId });
    }
  } catch (error) { repoOk = false; report.errors.push(`repository: ${error instanceof Error ? error.message : error}`); }

  // 1) runner 会话：一次读稳 journal，按会话签名比对，变了的才投影（投影之间让出事件循环——单个大会话投影 ~300ms）
  if (runnerSessions.length) {
    try {
      const { KernelSessionService, readStableRunnerSnapshot } = await import("./kernel/sessions/service.ts");
      let service = services.get(dataRoot); if (!service) { service = new KernelSessionService(dataRoot, { mode: "runner", roots, taskIds: [] }); services.set(dataRoot, service); }
      const snapshot = readStableRunnerSnapshot(dataRoot);
      for (const session of runnerSessions) {
        report.scanned++;
        const key = `runner:${session.id}`;
        try {
          const signature = service.indexSignature(session.id, snapshot);
          if (signature === null) continue;
          seen.add(key);
          if (!force && known.get(key) === signature) continue;
          const view = service.projectForIndex(session.id, snapshot); if (!view) continue;
          const summary = summarizeMessages(view.state.messages);
          store.upsert({ key, kind: "runner", sessionId: session.id, taskId: session.taskIds.at(-1) ?? session.id, providerId: view.state.providerId ?? session.providerId, signature: view.signature, source: "",
            ...summary, lastAt: Math.max(summary.lastAt, view.state.lastActivityAt || 0), turn: view.state.turn || "",
            pending: (view.state.pending as any[] ?? []).map((p) => ({ toolName: p?.toolName, brief: p?.brief })) }, view.state.messages);
          report.updated++; report.runner++;
          await yieldLoop();
        } catch (error) { report.errors.push(`${key}: ${error instanceof Error ? error.message : error}`); }
      }
    } catch (error) { runnerOk = false; report.errors.push(`runner journal: ${error instanceof Error ? error.message : error}`); }
  }

  // 2) legacy 会话文件 / 3) codex rollout：没有 runner 会话的任务才看它们；文件指纹没变就跳过
  for (const t of tasks) {
    if (runnerByTask.has(t.id)) continue;
    report.scanned++;
    const legacyFile = join(dataRoot, "tasks", `${t.id}.session.json`), legacySig = fileSignature(legacyFile);
    if (legacySig !== null) {
      const key = `legacy:${t.id}`;
      seen.add(key);
      if (!force && known.get(key) === `legacy:${legacySig}`) continue;
      try {
        const s = JSON.parse(readFileSync(legacyFile, "utf8"));
        const messages: DevMsg[] = Array.isArray(s.messages) ? s.messages.filter((m: any) => m && typeof m.text === "string") : [];
        const summary = summarizeMessages(messages);
        store.upsert({ key, kind: "legacy", sessionId: t.id, taskId: t.id, providerId: t.mode === "codex-bg" ? "codex" : t.mode === "codebuddy-bg" ? "codebuddy" : "claude", signature: `legacy:${legacySig}`, source: legacyFile,
          ...summary, lastAt: s.lastActivityAt || summary.lastAt, turn: s.turn || "", pending: ((s.pending ?? s.pendingPerms ?? []) as any[]).map((p) => ({ toolName: p?.toolName, brief: p?.brief })) }, messages);
        report.updated++; report.legacy++;
      } catch (error) { report.errors.push(`${key}: ${error instanceof Error ? error.message : error}`); }
      continue;
    }
    const metaFile = join(dataRoot, "tasks", `${t.id}.codex.json`);
    if (!existsSync(metaFile)) continue;
    const key = `codex:${t.id}`;
    seen.add(key);
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8")), existing = known.get(key);
      const { findCodexRolloutPath, readCodexMessages } = await import("./codex-sessions.ts");
      let path = store.get(key)?.source || "";
      if (!path || !existsSync(path)) path = findCodexRolloutPath(String(meta.rolloutId || ""), meta.home || "codex") ?? "";
      if (!path) {
        // rollout 已清理：记一行空壳（侧栏按 msgs>0 过滤掉），签名按小时变，免得每 5s 都把 ~/.codex/sessions 走一遍
        const signature = `codex:missing:${Math.floor(Date.now() / 3_600_000)}`;
        if (existing !== signature) store.upsert({ key, kind: "codex", sessionId: `cdx:${meta.rolloutId}`, taskId: t.id, providerId: "codex", signature, source: "", msgs: 0, userMsgs: 0, lastText: "", lastRole: "", lastAt: 0, turn: "", pending: [] }, []);
        continue;
      }
      const st = statSync(path), signature = `codex:${st.size}:${st.mtimeMs}`;
      if (!force && existing === signature) continue;
      if (existing && Date.now() - st.mtimeMs < CODEX_ROLLOUT_QUIET_MS) continue;   // 还在被写：等安静再解析
      const messages = readCodexMessages(path).messages as DevMsg[], summary = summarizeMessages(messages);
      store.upsert({ key, kind: "codex", sessionId: `cdx:${meta.rolloutId}`, taskId: t.id, providerId: "codex", signature, source: path, ...summary, lastAt: Math.max(summary.lastAt, st.mtimeMs), turn: "", pending: [] }, messages);
      report.updated++; report.codex++;
      await yieldLoop();
    } catch { /* rollout 掉出最近窗口/已清理：按空壳处理，和原 recent 一致 */ }
  }
  // 回收：来源已经不在的行（任务被删、会话改名）。哪一类扫描出过错就不动哪一类——读不到不等于没了
  for (const key of known.keys()) {
    if (seen.has(key)) continue;
    const kind = key.slice(0, key.indexOf(":"));
    if (kind === "runner" ? (repoOk && runnerOk) : repoOk) { store.remove(key); report.removed++; }
  }
  report.ms = Date.now() - started;
  if (report.updated || report.removed || report.errors.length) log(`session index: 扫 ${report.scanned} 更新 ${report.updated}（runner ${report.runner} legacy ${report.legacy} codex ${report.codex}）回收 ${report.removed} ${report.ms}ms${report.errors.length ? `，${report.errors.length} 个来源出错：${report.errors[0]}` : ""}`);
  return report;
}
