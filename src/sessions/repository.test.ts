import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { canRecoverSessionLock, claimStaleSessionLock, mergeCopyForward, migrateLegacySessions, SESSION_LOCK_STALE_MS, SessionRepository, SessionRepositoryError, writeAllSync, type SessionStore } from "./repository.ts";

const roots: string[] = [];
const fresh = () => { const r = mkdtempSync(join(tmpdir(), "ownward-sessions-")); roots.push(r); return r; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function json(root: string, rel: string, value: unknown) {
  const file = join(root, rel); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}
function task(id: string, mode: string, startedAt?: string) { return { id, mode, cwd: `/${id}`, startedAt }; }

describe("SessionRepository dual read", () => {
  test("history reset is durable two-phase and idempotent",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);const repo=new SessionRepository(root);repo.bind({taskId:"reset",providerId:"claude",nativeRef:"old-ref",cwd});expect(repo.beginHistoryReset("reset","command-reset").pendingHistoryReset).toMatchObject({commandId:"command-reset",previousNativeRef:"old-ref"});expect(()=>repo.beginHistoryReset("reset","other-command")).toThrow("SESSION_HISTORY_RESET_PENDING");expect(repo.finishHistoryReset("reset","command-reset",true)).toMatchObject({nativeRef:null,historyResetCommandId:"command-reset",previousRefs:["old-ref"]});expect(repo.finishHistoryReset("reset","command-reset",true).nativeRef).toBeNull();});
  test("legacy sessions.json is a read-only fallback and all new writes go to the Kernel primary", () => {
    const root=fresh(),stamp="2026-01-01T00:00:00.000Z";
    json(root,"sessions.json",{schemaVersion:1,sessions:[{id:"legacy-store",providerId:"claude",nativeRef:"legacy-ref",previousRefs:[],cwd:"/legacy",control:"external",taskIds:["legacy-task"],recoverable:true,source:"legacy",createdAt:stamp,updatedAt:stamp}]});
    const before=readFileSync(join(root,"sessions.json"),"utf8"),repo=new SessionRepository(root);
    expect(repo.getById("legacy-store")?.nativeRef).toBe("legacy-ref");
    repo.reserve({taskId:"new-task",providerId:"claude",cwd:"/new"});
    expect(readFileSync(join(root,"sessions.json"),"utf8")).toBe(before);
    expect(existsSync(join(root,"kernel/sessions.json"))).toBe(true);
    expect(new SessionRepository(root).getByTaskId("new-task")?.id).toBe("new-task");
    expect(new SessionRepository(root).getById("legacy-store")?.nativeRef).toBe("legacy-ref");
  });

  test("archived orphan provenance is strict, remains readable and every repository mutation fails closed", () => {
    const root=fresh(),stamp="2026-01-01T00:00:00.000Z",hash="a".repeat(64),record={id:"archived",providerId:"claude",nativeRef:"native-kept",previousRefs:[],cwd:"/gone",control:"external",taskIds:[],recoverable:true,source:"legacy",createdAt:stamp,updatedAt:stamp,archive:{state:"orphaned-task-link",originalTaskRefs:["lost-task"],migrationId:"stage6-kernel-sessions-v1",reason:"task-record-missing",sourceAggregateSha256:hash}};
    json(root,"kernel/sessions.json",{schemaVersion:1,sessions:[record]});const repo=new SessionRepository(root);
    expect(repo.getById("archived")).toMatchObject({nativeRef:"native-kept",taskIds:[],archive:{originalTaskRefs:["lost-task"]}});
    expect(repo.getByTaskId("lost-task")).toBeNull();
    for(const mutate of[()=>repo.setControl("archived","ownward"),()=>repo.updateGrants("archived",{access:"workspace"}),()=>repo.clearNativeRef("archived"),()=>repo.bind({taskId:"lost-task",providerId:"claude",nativeRef:"native-kept",cwd:"/gone"})])expect(mutate).toThrow("SESSION_ARCHIVED_READ_ONLY");
    for(const bad of[{...record,taskIds:["lost-task"]},{...record,archive:{...record.archive,extra:true}},{...record,archive:{...record.archive,sourceAggregateSha256:"bad"}}]){json(root,"kernel/sessions.json",{schemaVersion:1,sessions:[bad]});expect(()=>new SessionRepository(root).list()).toThrow(SessionRepositoryError);}
  });
  test("projects legacy when kernel/sessions.json is absent and queries aliases/native", () => {
    const root = fresh();
    json(root, "tasks.json", [task("older", "codex-bg", "2026-01-01"), task("newer", "codex-bg", "2026-02-01")]);
    json(root, "tasks/older.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000001", cwd: "/old" });
    json(root, "tasks/newer.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000001", cwd: "/new" });
    const repo = new SessionRepository(root);
    expect(repo.list()).toHaveLength(1);
    expect(repo.getById("newer")?.taskIds).toEqual(["newer", "older"]);
    expect(repo.getByTaskId("older")?.id).toBe("newer");
    expect(repo.findByNative("codex", "00000000-0000-4000-8000-000000000001")?.id).toBe("newer");
  });

  test("primary store is the exclusive read view and legacy misses cannot become phantom sessions", () => {
    const root = fresh();
    json(root, "tasks.json", [task("legacy", "claude-bg", "2026-01-01")]);
    json(root, "tasks/legacy.session.json", { toolSessionId: "native" });
    const store: SessionStore = { schemaVersion: 1, sessions: [{
      id: "repo", providerId: "claude", nativeRef: "repo-native", cwd: "/repo", control: "observing",
      taskIds: ["repo-task"], recoverable: true, source: "native",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] };
    json(root, "kernel/sessions.json", store);
    const repo = new SessionRepository(root);
    expect(repo.getByTaskId("legacy")).toBeNull();
    expect(repo.getByTaskId("repo-task")).toMatchObject({ id: "repo", cwd: "/repo", control: "observing" });
  });

  test("corrupt new store fails closed instead of falling back", () => {
    const root = fresh();
    json(root, "tasks.json", [task("legacy", "claude-bg", "2026-01-01")]);
    mkdirSync(join(root,"kernel")); writeFileSync(join(root, "kernel/sessions.json"), "{");
    expect(() => new SessionRepository(root).list()).toThrow(SessionRepositoryError);
  });

  test("primary reads isolate both healthy and corrupt legacy meta; reconcile still reports corruption", () => {
    const root = fresh();
    json(root, "tasks.json", [task("bad", "claude-bg", "2026-01-01"), task("good", "claude-bg", "2026-01-02")]);
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks/bad.session.json"), "{");
    json(root, "tasks/good.session.json", { toolSessionId: "good-native" });
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [{
      id: "persisted", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000002", cwd: "/persisted", control: "ownward",
      taskIds: ["persisted-task"], recoverable: true, source: "native",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    const repo = new SessionRepository(root);
    expect(repo.getByTaskId("persisted-task")?.id).toBe("persisted");
    expect(repo.getByTaskId("good")).toBeNull();
    expect(repo.getByTaskId("bad")).toBeNull();
    const dry = migrateLegacySessions(root, { dryRun: true });
    expect(dry.invalidFiles).toEqual([join(root, "tasks/bad.session.json")]);
    expect(() => migrateLegacySessions(root, { dryRun: false })).toThrow("拒绝部分写入");
  });

  test("valid legacy provider drift remains a fail-closed migration conflict", () => {
    const root = fresh();
    json(root, "tasks.json", [task("same-task", "codex-bg", "2026-01-01")]);
    json(root, "tasks/same-task.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000003", cwd: "/legacy" });
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [{
      id: "stable", providerId: "claude", nativeRef: "claude-native", cwd: "/repo", control: "ownward",
      taskIds: ["same-task"], recoverable: true, source: "native",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    expect(migrateLegacySessions(root, { dryRun: true }).conflicts).toHaveLength(1);
    expect(() => migrateLegacySessions(root, { dryRun: false })).toThrow(SessionRepositoryError);
  });

  test("atomic writes use private mode and writeAllSync retries short writes", () => {
    const bytes = new TextEncoder().encode("abcdef");
    const chunks: string[] = [];
    writeAllSync(123, bytes, ((_fd: number, data: Uint8Array, offset: number, length: number) => {
      const count = Math.min(2, length);
      chunks.push(new TextDecoder().decode(data.subarray(offset, offset + count)));
      return count;
    }));
    expect(chunks.join("")).toBe("abcdef");
    expect(() => writeAllSync(123, bytes, () => 0)).toThrow("写入无进展");
    const root = fresh();
    new SessionRepository(root).reserve({ taskId: "private", providerId: "claude", cwd: "/repo" });
    expect(statSync(join(root, "kernel/sessions.json")).mode & 0o777).toBe(0o600);
  });

  test("delayed native bind is synchronous and merges an existing native identity", () => {
    const root = fresh();
    const repo = new SessionRepository(root);
    repo.bind({ taskId: "first", providerId: "claude", nativeRef: "native", cwd: "/first", control: "observing" });
    const merged = repo.bind({ taskId: "late", providerId: "claude", nativeRef: "native", cwd: "/late", control: "ownward" });
    expect(merged.taskIds).toEqual(["first", "late"]);
    expect(new SessionRepository(root).list()).toHaveLength(1);
    expect(new SessionRepository(root).getByTaskId("late")?.nativeRef).toBe("native");
  });

  test("reserve fixes canonical identity before native bind and merge keeps the reserved id", () => {
    const root = fresh(), repo = new SessionRepository(root);
    const reserved = repo.reserve({ taskId: "reserved-task", providerId: "claude", cwd: "/reserved" });
    expect(reserved).toMatchObject({ id: "reserved-task", nativeRef: null, recoverable: false });
    repo.bind({ taskId: "older-task", providerId: "claude", nativeRef: "native-shared", cwd: "/older" });
    const bound = repo.bind({ taskId: "reserved-task", providerId: "claude", nativeRef: "native-shared", cwd: "/reserved" });
    expect(bound).toMatchObject({ id: "reserved-task", nativeRef: "native-shared", recoverable: true });
    expect(bound.taskIds).toEqual(["older-task", "reserved-task"]);
    expect(new SessionRepository(root).findByNative("claude", "native-shared")?.id).toBe("reserved-task");
  });

  test("两个进程并发 reserve 经显式 CAS 重试后不丢身份", async () => {
    const root = fresh(), moduleUrl = new URL("./repository.ts", import.meta.url).href;
    const children = ["task-a", "task-b"].map((taskId) => Bun.spawn([process.execPath, "-e", `
      const {SessionRepository,SessionRepositoryError}=await import(${JSON.stringify(moduleUrl)});
      for(let n=0;;n++){try{new SessionRepository(${JSON.stringify(root)}).reserve({taskId:${JSON.stringify(taskId)},providerId:"codex",cwd:"/${taskId}"});break}catch(e){if(!(e instanceof SessionRepositoryError)||n>=30)throw e;await Bun.sleep(5)}}
    `], { stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(children.map((p) => p.exited))).toEqual([0, 0]);
    const repo = new SessionRepository(root);
    expect(repo.list().map((s) => s.id).sort()).toEqual(["task-a", "task-b"]);
    expect(repo.getByTaskId("task-a")?.id).toBe("task-a");
    expect(repo.getByTaskId("task-b")?.id).toBe("task-b");
  });

  test("native ref rotation keeps history searchable and remains healthy after reconcile", () => {
    const root = fresh();
    json(root, "tasks.json", [task("task", "claude-bg", "2026-01-01")]);
    json(root, "tasks/task.session.json", { toolSessionId: "old-ref", control: "observing" });
    migrateLegacySessions(root, { dryRun: false });
    // 真实顺序：Provider 先成功写 legacy meta，再 bind repository。
    json(root, "tasks/task.session.json", { toolSessionId: "new-ref", control: "ownward" });
    const repo = new SessionRepository(root);
    repo.bind({ taskId: "task", providerId: "claude", nativeRef: "new-ref", cwd: "/task", control: "ownward" });
    expect(repo.getByTaskId("task")).toMatchObject({ nativeRef: "new-ref", previousRefs: ["old-ref"] });
    expect(repo.findByNative("claude", "old-ref")?.id).toBe("task");
    expect(repo.findByNative("claude", "new-ref")?.id).toBe("task");
    // Provider legacy meta 随后写入新 ref，reconcile 应自愈而不是报冲突。
    expect(migrateLegacySessions(root, { dryRun: false }).conflicts).toEqual([]);
    expect(new SessionRepository(root).list()).toHaveLength(1);
  });

  test("read view ignores conflicting legacy identity while explicit migration diagnoses it", () => {
    const root = fresh();
    json(root, "tasks.json", [task("conflict", "codex-bg", "2026-01-01")]);
    json(root, "tasks/conflict.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000004", cwd: "/conflict" });
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [
      { id: "conflict", providerId: "claude", nativeRef: "cc-ref", previousRefs: [], cwd: "/repo", control: "ownward",
        taskIds: ["conflict"], recoverable: true, source: "native", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "healthy", providerId: "claude", nativeRef: "healthy-ref", previousRefs: [], cwd: "/healthy", control: "ownward",
        taskIds: ["healthy-task"], recoverable: true, source: "native", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ] });
    const repo = new SessionRepository(root);
    expect(repo.getByTaskId("healthy-task")?.id).toBe("healthy");
    expect(repo.getByTaskId("conflict")?.providerId).toBe("claude");
    expect(repo.getDiagnostics()).toEqual([]);
    expect(migrateLegacySessions(root,{dryRun:true}).conflicts).toHaveLength(1);
  });

  test("final validation failure discards the whole temporary merge view", () => {
    const base = (id: string, ref: string, taskId: string) => ({ id, providerId: "claude" as const,
      nativeRef: ref, previousRefs: [], cwd: `/${id}`, control: "ownward" as const, taskIds: [taskId],
      recoverable: true, source: "native" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const current: SessionStore = { schemaVersion: 1, sessions: [base("healthy", "shared-history", "t1")] };
    const incoming = base("incoming", "new-ref", "t2"); incoming.previousRefs = ["shared-history"];
    const result = mergeCopyForward(current, { schemaVersion: 1, sessions: [incoming] });
    expect(result.conflicts.some((c) => c.key === "store")).toBe(true);
    expect(result.next).toEqual(current);
  });

  test("filesystem legacy projection resolves task/native collisions before validation, so store diagnostics stay isolated", () => {
    const root = fresh();
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [
      { id: "task-owner", providerId: "claude", nativeRef: "old-ref", previousRefs: [], cwd: "/one", control: "ownward", taskIds: ["task"], recoverable: true, source: "native", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "native-owner", providerId: "claude", nativeRef: "new-ref", previousRefs: [], cwd: "/two", control: "ownward", taskIds: ["healthy"], recoverable: true, source: "native", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ] });
    json(root, "tasks.json", [task("task", "claude-bg", "2026-01-01"), task("healthy", "claude-bg", "2026-01-01")]);
    json(root, "tasks/task.session.json", { toolSessionId: "new-ref" }); json(root, "tasks/healthy.session.json", { toolSessionId: "new-ref" });
    const repo = new SessionRepository(root); expect(repo.getDiagnostics()).toEqual([]); expect(repo.getByTaskId("healthy")?.nativeRef).toBe("new-ref");
  });

  test("identical bind is a true no-op while changed cwd/control are persisted", async () => {
    const root = fresh();
    const repo = new SessionRepository(root);
    repo.bind({ taskId: "task", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000005", providerHome: "codex-alt", cwd: "/one", control: "observing" });
    const file = join(root, "kernel/sessions.json");
    const before = readFileSync(file, "utf8"), mtime = statSync(file).mtimeMs;
    await Bun.sleep(5);
    repo.bind({ taskId: "task", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000005", providerHome: "codex-alt", cwd: "/one", control: "observing" });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
    repo.bind({ taskId: "task", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000005", providerHome: "codex-alt", cwd: "/two", control: "ownward" });
    expect(repo.getByTaskId("task")).toMatchObject({ cwd: "/two", control: "ownward", providerHome: join(process.env.HOME!,".codex-alt") });
  });

  test("control lease is persisted by stable Session identity", () => {
    const root = fresh(), repo = new SessionRepository(root); repo.reserve({ taskId: "task", providerId: "claude", cwd: "/repo" });
    expect(repo.setControl("task", "observing").control).toBe("observing");
    expect(new SessionRepository(root).getByTaskId("task")?.control).toBe("observing");
  });

  test("first-run reservation persists provider options and grants atomically", () => {
    const root = fresh(), repo = new SessionRepository(root);
    repo.reserve({
      taskId: "first-run", providerId: "codex", cwd: "/repo", providerHome: "/tmp/codex-home",
      access: "full-access", extraDirs: ["/shared-b", "/shared-a", "/shared-b"], model: "gpt-5.2-codex", effort: "high",
    });
    expect(new SessionRepository(root).getByTaskId("first-run")).toMatchObject({
      providerHome: "/tmp/codex-home", access: "full-access", extraDirs: ["/shared-a", "/shared-b"],
      model: "gpt-5.2-codex", effort: "high",
    });
  });

  test("new Codex reservations persist the server default model",()=>{const root=fresh(),repo=new SessionRepository(root);expect(repo.reserve({taskId:"default-codex",providerId:"codex",cwd:"/repo"})).toMatchObject({model:"gpt-5.6-sol"});expect(new SessionRepository(root).getByTaskId("default-codex")).toMatchObject({model:"gpt-5.6-sol"});expect(repo.reserve({taskId:"explicit-codex",providerId:"codex",cwd:"/repo",model:"gpt-custom"})).toMatchObject({model:"gpt-custom"});expect(repo.reserve({taskId:"claude",providerId:"claude",cwd:"/repo"}).model).toBeUndefined();});

  test("first-run options reject malformed values without creating a session", () => {
    const root = fresh(), repo = new SessionRepository(root);
    expect(() => repo.reserve({ taskId: "bad-home", providerId: "claude", cwd: "/repo", providerHome: "/tmp/claude" })).toThrow(SessionRepositoryError);
    expect(() => repo.reserve({ taskId: "bad-dir", providerId: "codex", cwd: "/repo", extraDirs: ["relative"] })).toThrow(SessionRepositoryError);
    expect(() => repo.reserve({ taskId: "bad-model", providerId: "codex", cwd: "/repo", model: "\0" })).toThrow(SessionRepositoryError);
    expect(() => repo.reserve({ taskId: "bad-effort", providerId: "claude", cwd: "/repo", effort: " ".repeat(2) })).toThrow(SessionRepositoryError);
    expect(repo.list()).toEqual([]);
  });

  test("Kernel grants and native reset survive daemon restart", () => {
    const root = fresh(), repo = new SessionRepository(root); repo.bind({ taskId: "task", providerId: "claude", nativeRef: "native", cwd: "/repo" });
    repo.updateGrants("task", { access: "bypass", addDirectory: "/extra" }); repo.clearNativeRef("task");
    expect(new SessionRepository(root).getByTaskId("task")).toMatchObject({ access: "bypass", extraDirs: ["/extra"], nativeRef: null, previousRefs: ["native"], recoverable: false });
  });

  test("stale lock recovery requires age and a dead owner", () => {
    const now = 1_000_000;
    const old = { pid: 42, token: "owner", at: now - SESSION_LOCK_STALE_MS };
    expect(canRecoverSessionLock(old, now, () => false)).toBe(true);
    expect(canRecoverSessionLock(old, now, () => true)).toBe(false);
    expect(canRecoverSessionLock({ ...old, at: now - SESSION_LOCK_STALE_MS + 1 }, now, () => false)).toBe(false);
  });

  test("two stale-lock recoverers cannot both claim or delete a successor lock", () => {
    const root = fresh();
    const lock = join(root, ".sessions.write.lock");
    const firstRecovery = `${lock}.recovery.first`;
    const secondRecovery = `${lock}.recovery.second`;
    json(root, ".sessions.write.lock", { pid: 999999, token: "stale-owner", at: 1 });
    // A 的 rename 是唯一成功的 claim；B 即使此前也读过 stale token，已不能碰正式路径。
    expect(claimStaleSessionLock(lock, firstRecovery, "stale-owner")).toBe(true);
    expect(claimStaleSessionLock(lock, secondRecovery, "stale-owner")).toBe(false);
    // A acquire 前，普通写者可能抢到新正式锁；A 只能清自己的 recovery，不能删 successor。
    json(root, ".sessions.write.lock", { pid: process.pid, token: "successor", at: Date.now() });
    rmSync(firstRecovery);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("successor");
    expect(existsSync(secondRecovery)).toBe(false);
  });

  test("failed bind leaves the previous repository intact for later reconcile", () => {
    const root = fresh();
    const repo = new SessionRepository(root);
    repo.bind({ taskId: "task", providerId: "claude", nativeRef: "cc", cwd: "/repo" });
    const before = readFileSync(join(root, "kernel/sessions.json"), "utf8");
    expect(() => repo.bind({ taskId: "task", providerId: "codex", nativeRef: "cdx", cwd: "/repo" })).toThrow(SessionRepositoryError);
    expect(readFileSync(join(root, "kernel/sessions.json"), "utf8")).toBe(before);
  });
});

describe("SessionRepository provider handoff",()=>{
  test("rolling back a second handoff restores the first handoff metadata byte-for-byte across restart",()=>{const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);const original=repo.reserve({taskId:"task",providerId:"claude",cwd});const first=repo.handoff({taskId:"task",expectedSessionId:original.id,providerId:"codex",reason:"first"}),before=structuredClone(first.current.handoff),ancestorBefore=structuredClone(first.previous.handoff);const second=repo.handoff({taskId:"task",expectedSessionId:first.current.id,providerId:"codebuddy",reason:"second"});repo.rollbackHandoff(second.current.id);const restarted=new SessionRepository(root);expect(restarted.getById(first.current.id)?.handoff).toEqual(before);expect(restarted.getById(first.previous.id)?.handoff).toEqual(ancestorBefore);expect(restarted.getByTaskId("task")?.id).toBe(first.current.id);});
  test("moves one task atomically, preserves the chain and can roll back a definite submit failure",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);const repo=new SessionRepository(root),original=repo.reserve({taskId:"task",providerId:"claude",cwd,access:"workspace",extraDirs:[cwd]});const moved=repo.handoff({taskId:"task",expectedSessionId:original.id,providerId:"codex",model:"gpt-5.6-sol",reason:"quota"});expect(moved.previous).toMatchObject({providerId:"claude",taskIds:[],handoff:{successorId:moved.current.id,status:"superseded"}});expect(moved.current).toMatchObject({providerId:"codex",nativeRef:null,taskIds:["task"],cwd,access:"workspace",extraDirs:[cwd],handoff:{predecessorId:moved.previous.id,status:"active",reason:"quota"}});expect(new SessionRepository(root).getByTaskId("task")?.id).toBe(moved.current.id);expect(repo.rollbackHandoff(moved.current.id)).toMatchObject({providerId:"claude",taskIds:["task"]});expect(new SessionRepository(root).getById(moved.previous.id)?.handoff).toBeUndefined();expect(new SessionRepository(root).getById(moved.current.id)).toMatchObject({taskIds:[],handoff:{status:"failed"}});});
  test("same-provider handoff requires an option change and preserves immutable options plus lineage",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);const repo=new SessionRepository(root);const original=repo.reserve({taskId:"task",providerId:"codex",cwd,providerHome:"/tmp/codex-alt",model:"gpt-5.6-sol",effort:"high"}),file=join(root,"kernel/sessions.json"),before=readFileSync(file,"utf8");expect(()=>repo.handoff({taskId:"task",expectedSessionId:original.id,providerId:"codex",model:"gpt-5.6-sol",effort:"high"})).toThrow("SESSION_HANDOFF_SAME_PROVIDER");expect(readFileSync(file,"utf8")).toBe(before);const moved=repo.handoff({taskId:"task",expectedSessionId:original.id,providerId:"codex",effort:"xhigh",reason:"deeper"});expect(moved.previous).toMatchObject({id:original.id,taskIds:[],model:"gpt-5.6-sol",effort:"high",handoff:{successorId:moved.current.id,status:"superseded"}});expect(moved.current).toMatchObject({providerId:"codex",providerHome:"/tmp/codex-alt",model:"gpt-5.6-sol",effort:"xhigh",taskIds:["task"],handoff:{predecessorId:original.id,status:"active",reason:"deeper"}});expect(new SessionRepository(root).getByTaskId("task")?.id).toBe(moved.current.id);});
  test("stale predecessor CAS rejects a second handoff without stealing task ownership",()=>{const root=fresh(),cwd=join(root,"repo"),repo=new SessionRepository(root);mkdirSync(cwd);const original=repo.reserve({taskId:"task",providerId:"claude",cwd}),first=repo.handoff({taskId:"task",expectedSessionId:original.id,providerId:"codex",reason:"first"}),before=readFileSync(join(root,"kernel/sessions.json"),"utf8");expect(()=>repo.handoff({taskId:"task",expectedSessionId:original.id,providerId:"codebuddy",reason:"stale"})).toThrow("SESSION_HANDOFF_STALE");expect(readFileSync(join(root,"kernel/sessions.json"),"utf8")).toBe(before);expect(new SessionRepository(root).getByTaskId("task")?.id).toBe(first.current.id);expect(new SessionRepository(root).getById(original.id)?.taskIds).toEqual([]);});
});

describe("legacy session copy-forward", () => {
  test("dry-run performs no writes and reports deterministic native merges", () => {
    const root = fresh();
    json(root, "tasks.json", [task("z-no-time", "claude-bg"), task("a-no-time", "claude-bg")]);
    json(root, "tasks/z-no-time.session.json", { toolSessionId: "same" });
    json(root, "tasks/a-no-time.session.json", { toolSessionId: "same" });
    const before = statSync(join(root, "tasks.json")).mtimeMs;
    const report = migrateLegacySessions(root, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, legacyCandidates: 2, plannedCreates: 1,
      plannedMerges: 1, plannedWrites: 1, fallbackCanonicalIds: 1, wrote: false });
    expect(existsSync(join(root, "kernel/sessions.json"))).toBe(false);
    expect(statSync(join(root, "tasks.json")).mtimeMs).toBe(before);
    // 缺 startedAt 的明确 fallback 是 taskId 字典序。
    expect(new SessionRepository(root).list()[0].id).toBe("a-no-time");
  });

  test("apply is atomic copy-forward and second apply is idempotent", () => {
    const root = fresh();
    json(root, "tasks.json", [task("cc", "claude-bg", "2026-01-01"), task("cdx", "codex-bg", "2026-01-02")]);
    json(root, "tasks/cc.session.json", { toolSessionId: "cc-ref", control: "observing" });
    json(root, "tasks/cdx.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000006", cwd: "/work" });
    const legacyBefore = readFileSync(join(root, "tasks.json"), "utf8");
    expect(migrateLegacySessions(root, { dryRun: false })).toMatchObject({ plannedCreates: 2, plannedWrites: 2, wrote: true });
    expect(readFileSync(join(root, "tasks.json"), "utf8")).toBe(legacyBefore);
    expect(JSON.parse(readFileSync(join(root, "kernel/sessions.json"), "utf8")).schemaVersion).toBe(1);
    expect(migrateLegacySessions(root, { dryRun: false })).toMatchObject({ plannedCreates: 0, plannedUpdates: 0, plannedWrites: 0, wrote: false });
  });

  test("terminal linked session participates in native merge", () => {
    const root = fresh();
    json(root, "tasks.json", [
      { ...task("bg", "claude-bg", "2026-01-01"), cwd: "/bg" },
      { ...task("term", "terminal", "2026-03-01"), cwd: "/term", ccSessionId: "same" },
    ]);
    json(root, "tasks/bg.session.json", { toolSessionId: "same" });
    migrateLegacySessions(root, { dryRun: false });
    const s = new SessionRepository(root).getByTaskId("bg")!;
    expect(s.id).toBe("term");
    expect(s.taskIds).toEqual(["bg", "term"]);
  });

  test("four duplicate-native groups merge independently and keep every task alias", () => {
    const root = fresh();
    const tasks: any[] = [];
    for (let group = 0; group < 4; group++) {
      for (let item = 0; item < (group === 3 ? 4 : 2); item++) {
        const id = `g${group}-t${item}`;
        tasks.push(task(id, group % 2 ? "codex-bg" : "claude-bg", `2026-01-0${item + 1}`));
        json(root, `tasks/${id}.${group % 2 ? "codex" : "session"}.json`,
          group % 2 ? { rolloutId: `00000000-0000-4000-8000-${String(group).padStart(12,"0")}`, cwd: `/${id}` } : { toolSessionId: `native-${group}` });
      }
    }
    json(root, "tasks.json", tasks);
    const report = migrateLegacySessions(root, { dryRun: true });
    expect(report).toMatchObject({ legacyCandidates: 10, plannedCreates: 4, plannedMerges: 6 });
    const repo = new SessionRepository(root);
    expect(repo.list()).toHaveLength(4);
    for (const t of tasks) expect(repo.getByTaskId(t.id)?.nativeRef).toBe(Number(t.id[1])%2?`00000000-0000-4000-8000-${String(Number(t.id[1])).padStart(12,"0")}`:`native-${Number(t.id[1])}`);
  });

  test("duplicate-native projection takes control only from deterministic canonical", () => {
    const root = fresh();
    json(root, "tasks.json", [task("old", "claude-bg", "2026-01-01"), task("new", "claude-bg", "2026-02-01")]);
    json(root, "tasks/old.session.json", { toolSessionId: "same", control: "ownward" });
    json(root, "tasks/new.session.json", { toolSessionId: "same", control: "observing" });
    expect(new SessionRepository(root).findByNative("claude", "same")).toMatchObject({
      id: "new", control: "observing", taskIds: ["new", "old"],
    });
  });

  test("canonical external control is preserved instead of becoming ownward", () => {
    const root = fresh();
    json(root, "tasks.json", [task("old", "claude-bg", "2026-01-01"), task("new", "claude-bg", "2026-02-01")]);
    json(root, "tasks/old.session.json", { toolSessionId: "same", control: "ownward" });
    json(root, "tasks/new.session.json", { toolSessionId: "same", control: "external" });
    expect(new SessionRepository(root).findByNative("claude", "same")?.control).toBe("external");
  });

  test("missing meta remains an explicit unrecoverable session", () => {
    const root = fresh();
    json(root, "tasks.json", [task("missing", "claude-bg", "2026-01-01")]);
    migrateLegacySessions(root, { dryRun: false });
    expect(new SessionRepository(root).getByTaskId("missing")).toMatchObject({ nativeRef: null, recoverable: false });
  });

  test("invalid legacy refuses the entire apply without replacing an existing store", () => {
    const root = fresh();
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [] });
    const before = readFileSync(join(root, "kernel/sessions.json"), "utf8");
    writeFileSync(join(root, "tasks.json"), "{");
    const dry = migrateLegacySessions(root, { dryRun: true });
    expect(dry.invalidFiles).toEqual([join(root, "tasks.json")]);
    expect(() => migrateLegacySessions(root, { dryRun: false })).toThrow("拒绝部分写入");
    expect(readFileSync(join(root, "kernel/sessions.json"), "utf8")).toBe(before);
  });

  test("repository/native and task identity conflicts reject the whole apply", () => {
    const root = fresh();
    json(root, "tasks.json", [task("task-1", "codex-bg", "2026-01-01")]);
    json(root, "tasks/task-1.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000007", cwd: "/task-1" });
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [{
      id: "existing", providerId: "claude", nativeRef: "other", cwd: "/repo", control: "ownward",
      taskIds: ["task-1"], recoverable: true, source: "native",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    const before = readFileSync(join(root, "kernel/sessions.json"), "utf8");
    expect(migrateLegacySessions(root, { dryRun: true }).conflicts).toHaveLength(1);
    expect(() => migrateLegacySessions(root, { dryRun: false })).toThrow(SessionRepositoryError);
    expect(readFileSync(join(root, "kernel/sessions.json"), "utf8")).toBe(before);
  });

  test("same id without task/native evidence is a collision, not an implicit merge", () => {
    const root = fresh();
    json(root, "tasks.json", [task("same-id", "claude-bg")]); // 没 meta，nativeRef=null
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [{
      id: "same-id", providerId: "claude", nativeRef: "real-native", cwd: "/repo", control: "ownward",
      taskIds: ["different-task"], recoverable: true, source: "native",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    expect(migrateLegacySessions(root, { dryRun: true }).conflicts).toHaveLength(1);
  });

  test("copy-forward preserves repository cwd/control while adding aliases", () => {
    const root = fresh();
    json(root, "tasks.json", [task("old", "claude-bg", "2025-01-01"), task("new", "claude-bg", "2026-01-01")]);
    json(root, "tasks/old.session.json", { toolSessionId: "same" });
    json(root, "tasks/new.session.json", { toolSessionId: "same" });
    json(root, "kernel/sessions.json", { schemaVersion: 1, sessions: [{
      id: "stable", providerId: "claude", nativeRef: "same", cwd: "/authoritative", control: "observing",
      taskIds: ["old"], recoverable: true, source: "native",
      createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    }] });
    expect(migrateLegacySessions(root, { dryRun: false })).toMatchObject({ plannedUpdates: 1, wrote: true });
    expect(new SessionRepository(root).getByTaskId("new")).toMatchObject({ id: "stable", cwd: "/authoritative", control: "observing" });
  });
});
