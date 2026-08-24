import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { canRecoverRunLock, claimStaleRunLock, projectTaskRunState, readRunJournal, readRunJournalStrict, readRunJournalStrictIndexed, recoverDispatchingRuns, reduceRuns, RUN_LOCK_STALE_MS, RunRepository, RunRepositoryBusyError, type RunEvent } from "./repository.ts";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "ownward-runs-")); roots.push(r); return r; };
test("indexed reader consumes appends and rebuilds on truncate while corrupt tails fail closed",()=>{const data=root(),repo=new RunRepository(data),base={schemaVersion:1 as const,commandId:"c",runId:"r",taskId:"t",sessionId:"s",providerId:"claude"};repo.append({type:"command-accepted",eventId:"a",at:"2026-08-17T00:00:00.000Z",...base});expect(readRunJournalStrictIndexed(data)).toHaveLength(1);repo.append({type:"run-started",eventId:"b",at:"2026-08-17T00:00:01.000Z",...base});expect(readRunJournalStrictIndexed(data)).toHaveLength(2);writeFileSync(join(data,"runs.jsonl"),"{bad");expect(()=>readRunJournalStrictIndexed(data)).toThrow();writeFileSync(join(data,"runs.jsonl"),"");expect(readRunJournalStrictIndexed(data)).toEqual([]);});
test("indexed reader snapshots one fd and never duplicates an append after fstat",()=>{const data=root(),repo=new RunRepository(data),base={schemaVersion:1 as const,commandId:"snapshot-c",runId:"snapshot-r",taskId:"snapshot-t",sessionId:"snapshot-s",providerId:"claude"};repo.append({type:"command-accepted",eventId:"snapshot-a",at:"2026-08-17T00:00:00.000Z",...base});expect(readRunJournalStrictIndexed(data)).toHaveLength(1);const next={schemaVersion:1 as const,type:"run-started" as const,eventId:"snapshot-b",at:"2026-08-17T00:00:01.000Z",...base};const during=readRunJournalStrictIndexed(data,()=>appendFileSync(join(data,"runs.jsonl"),JSON.stringify(next)+"\n"));expect(during.map(x=>x.eventId)).toEqual(["snapshot-a"]);const after=readRunJournalStrictIndexed(data);expect(after.map(x=>x.eventId)).toEqual(["snapshot-a","snapshot-b"]);expect(reduceRuns(after)).toEqual(reduceRuns(readRunJournalStrictIndexed(data)));});
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function event(type: RunEvent["type"], patch: Partial<RunEvent> = {}): RunEvent {
  return { schemaVersion: 1, eventId: `${type}-1`, type, at: "2026-08-16T00:00:00.000Z",
    commandId: "cmd-1", runId: "run-1", taskId: "task-1", sessionId: "session-1", providerId: "claude", ...patch } as RunEvent;
}

describe("RunRepository", () => {
  test("accepted → dispatching → started → completed 只追加并正确归约", () => {
    const r = root(), repo = new RunRepository(r);
    repo.append(event("command-accepted"));
    repo.append(event("run-dispatching"));
    repo.append(event("run-started"));
    repo.append(event("run-completed", { providerExitCode: 0 }));
    expect(readFileSync(join(r, "runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
    expect(reduceRuns(repo.read().events)[0]).toMatchObject({ status: "completed", startedAt: "2026-08-16T00:00:00.000Z" });
    expect(projectTaskRunState(repo.read().events, "task-1")).toMatchObject({ status: "completed", runId: "run-1" });
  });

  test("完全相同 eventId 幂等，不重复写", () => {
    const r = root(), repo = new RunRepository(r), e = event("command-accepted");
    expect(repo.append(e).appended).toBe(true);
    expect(repo.append(e).appended).toBe(false);
    expect(repo.read().events).toHaveLength(1);
  });

  test("跨实例缓存会在外部 append 后失效，不漏掉跨进程事实", () => {
    const r = root(), repo = new RunRepository(r);
    repo.append(event("command-accepted"));
    const external = event("command-accepted", { eventId: "external", commandId: "external-c", runId: "external-r", taskId: "external-t" });
    appendFileSync(join(r, "runs.jsonl"), JSON.stringify(external) + "\n");
    new RunRepository(r).append(event("run-started"));
    expect(repo.readStrict().map((e) => e.eventId)).toEqual(["command-accepted-1", "external", "run-started-1"]);
  });

  test("重试产生新 eventId/时间时，commandId 与 runId 仍语义幂等", () => {
    const repo = new RunRepository(root());
    repo.append(event("command-accepted"));
    expect(repo.append(event("command-accepted", { eventId: "retry", at: "2026-08-16T00:00:01.000Z" })).appended).toBe(false);
    repo.append(event("run-started"));
    expect(repo.append(event("run-started", { eventId: "start-retry", at: "2026-08-16T00:00:01.000Z" })).appended).toBe(false);
    repo.append(event("run-completed", { providerExitCode: 0 }));
    expect(repo.append(event("run-completed", { eventId: "done-retry", at: "2026-08-16T00:00:02.000Z", providerExitCode: 0 })).appended).toBe(false);
    expect(repo.read().events).toHaveLength(3);
  });

  test("eventId 或 commandId 冲突 fail closed", () => {
    const repo = new RunRepository(root());
    repo.append(event("command-accepted"));
    expect(() => repo.append(event("command-accepted", { taskId: "other" }))).toThrow("eventId 冲突");
    expect(() => repo.append(event("command-accepted", { eventId: "e2", runId: "run-2" }))).toThrow("commandId 已绑定其他 run");
  });

  test("必须 accepted 后 started，且一个 Run 只有一个 terminal", () => {
    const repo = new RunRepository(root());
    expect(() => repo.append(event("run-started"))).toThrow("尚未 accepted");
    repo.append(event("command-accepted")); repo.append(event("run-started"));
    repo.append(event("run-interrupted", { reason: "user" }));
    expect(() => repo.append(event("run-unknown-outcome", { eventId: "unknown-2" }))).toThrow("已有 terminal");
    expect(reduceRuns(repo.read().events)[0].status).toBe("interrupted");
  });

  test("新状态机要求 dispatching 有 accepted；旧 accepted→started 日志继续兼容", () => {
    const repo = new RunRepository(root());
    expect(() => repo.append(event("run-dispatching"))).toThrow("尚未 accepted");
    repo.append(event("command-accepted"));
    repo.append(event("run-started")); // schema v1 旧日志没有 dispatching，仍允许读取/追加终态。
    repo.append(event("run-completed"));
    expect(reduceRuns(repo.readStrict())[0].status).toBe("completed");
  });

  test("owner 重启只把 dispatching 收敛 unknown_outcome，accepted/running 不 replay 也不误伤", () => {
    const r = root(), repo = new RunRepository(r);
    repo.append(event("command-accepted"));
    repo.append(event("run-dispatching"));
    repo.append(event("command-accepted", { eventId: "accepted-2", commandId: "cmd-2", runId: "run-2", taskId: "task-2" }));
    repo.append(event("command-accepted", { eventId: "accepted-3", commandId: "cmd-3", runId: "run-3", taskId: "task-3" }));
    repo.append(event("run-dispatching", { eventId: "dispatch-3", commandId: "cmd-3", runId: "run-3", taskId: "task-3" }));
    repo.append(event("run-started", { eventId: "started-3", commandId: "cmd-3", runId: "run-3", taskId: "task-3" }));
    expect(recoverDispatchingRuns(r)).toBe(1);
    expect(recoverDispatchingRuns(r)).toBe(0);
    const states = new Map(reduceRuns(repo.readStrict()).map((run) => [run.runId, run]));
    expect(states.get("run-1")).toMatchObject({ status: "unknown_outcome", terminal: { reason: "runner_restarted_during_dispatch" } });
    expect(states.get("run-2")?.status).toBe("accepted");
    expect(states.get("run-3")?.status).toBe("running");
  });

  test("unknown_outcome 与 failed 分开，不伪装可重试", () => {
    const repo = new RunRepository(root());
    repo.append(event("command-accepted")); repo.append(event("run-started"));
    repo.append(event("run-unknown-outcome", { reason: "runner_lost_ownership" }));
    expect(projectTaskRunState(repo.read().events, "task-1").status).toBe("unknown_outcome");
  });

  test("截断尾行可见并阻止继续追加，不静默越过", () => {
    const r = root(), repo = new RunRepository(r);
    repo.append(event("command-accepted"));
    appendFileSync(join(r, "runs.jsonl"), '{"schemaVersion":1,"eventId":');
    const read = readRunJournal(r);
    expect(read.events).toHaveLength(1);
    expect(read.diagnostics).toHaveLength(1);
    expect(read.diagnostics[0]).toMatchObject({ line: 2, code: "invalid-json", unterminated: true });
    expect(read.diagnostics[0]).not.toHaveProperty("preview");
    expect(read.diagnostics[0].reason).toBeString();
    expect(() => readRunJournalStrict(r)).toThrow("损坏或不支持");
    expect(() => repo.append(event("run-started"))).toThrow("损坏或不支持");
    const repaired = repo.repairTruncatedTail();
    expect(repaired.repaired).toBe(true);
    expect(existsSync(repaired.backup!)).toBe(true);
    expect(readFileSync(repaired.backup!, "utf8")).toContain('"eventId":');
    expect(repo.append(event("run-started")).appended).toBe(true);
  });

  test("合法事件缺少末尾换行也显式诊断，repair 只补换行不删事件", () => {
    const r = root(), repo = new RunRepository(r), line = JSON.stringify(event("command-accepted"));
    writeFileSync(join(r, "runs.jsonl"), line);
    expect(repo.read().diagnostics).toMatchObject([{ code: "missing-newline", unterminated: true }]);
    expect(() => repo.append(event("run-started"))).toThrow("损坏或不支持");
    const fixed = repo.repairTruncatedTail();
    expect(fixed.repaired).toBe(true);
    expect(readFileSync(join(r, "runs.jsonl"), "utf8")).toBe(line + "\n");
    expect(repo.readStrict()).toHaveLength(1);
  });

  test("中间坏行、完整换行坏行和未知 schema 均拒绝自动修复", () => {
    for (const bad of ["nope\n", JSON.stringify({ schemaVersion: 2, eventId: "future" }) + "\n"]) {
      const r = root(), repo = new RunRepository(r);
      writeFileSync(join(r, "runs.jsonl"), bad + JSON.stringify(event("command-accepted")) + "\n");
      const d = repo.read().diagnostics[0];
      expect(["invalid-json", "unsupported-schema"]).toContain(d.code);
      expect(d.unterminated).toBe(false);
      expect(() => repo.repairTruncatedTail()).toThrow("只允许修复");
      expect(() => repo.append(event("run-started"))).toThrow("损坏或不支持");
    }
    const shapeRoot = root(), shapeRepo = new RunRepository(shapeRoot);
    writeFileSync(join(shapeRoot, "runs.jsonl"), JSON.stringify({ ...event("command-accepted"), surprise: true }));
    expect(shapeRepo.read().diagnostics).toMatchObject([{ code: "invalid-shape", unterminated: true }]);
    expect(() => shapeRepo.repairTruncatedTail()).toThrow("只允许修复");
  });

  test("严格字段白名单、usage 与 ISO 校验", () => {
    const cases = [
      event("command-accepted", { at: "2026-08-16T00:00:00Z" }),
      { ...event("command-accepted"), surprise: true },
      event("run-completed", { usage: { inputTokens: -1 } }),
      event("run-completed", { usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } }),
      event("run-completed", { usage: { inputTokens: Infinity } }),
      event("run-completed", { usage: { inputTokens: 1, secret: 2 } as any }),
    ];
    for (const e of cases) expect(() => new RunRepository(root()).append(e as RunEvent)).toThrow();
  });

  test("同 eventId 的语义重试幂等，语义变化冲突", () => {
    const repo = new RunRepository(root());
    repo.append(event("command-accepted", { inputRef: "sha:a" }));
    expect(repo.append(event("command-accepted", { at: "2026-08-16T00:00:01.000Z", inputRef: "sha:a" })).appended).toBe(false);
    expect(() => repo.append(event("command-accepted", { inputRef: "sha:b" }))).toThrow("eventId 冲突");
  });

  test("reducer 面对乱序不会从 terminal 回退；Task latest 按 acceptedAt 而非数组尾部", () => {
    const terminal = event("run-completed", { at: "2026-08-16T00:00:03.000Z" });
    expect(reduceRuns([event("command-accepted"), event("run-dispatching"), event("run-started"), terminal, event("run-dispatching", { eventId: "late-dispatch" }), event("run-started", { eventId: "late" })])[0].status).toBe("completed");
    const newer = event("command-accepted", { eventId: "new", commandId: "cmd-new", runId: "run-new", at: "2026-08-16T01:00:00.000Z" });
    const olderAppendedLast = event("command-accepted", { eventId: "old", commandId: "cmd-old", runId: "run-old", at: "2026-08-15T01:00:00.000Z" });
    expect(projectTaskRunState([newer, olderAppendedLast], "task-1").runId).toBe("run-new");
  });

  test("写锁只有足够老且 owner 已死才可回收", () => {
    const lock = { pid: 42, token: "t", at: 1_000 };
    expect(canRecoverRunLock(lock, 1_000 + RUN_LOCK_STALE_MS - 1, () => false)).toBe(false);
    expect(canRecoverRunLock(lock, 1_000 + RUN_LOCK_STALE_MS, () => true)).toBe(false);
    expect(canRecoverRunLock(lock, 1_000 + RUN_LOCK_STALE_MS, () => false)).toBe(true);
  });

  test("stale 预读后出现继任锁时致命留证，绝不恢复后继续争锁", () => {
    const r = root(), lock = join(r, ".runs.write.lock"), recovery = join(r, ".recovery-unique");
    writeFileSync(lock, JSON.stringify({ pid: 2, token: "successor", at: 1 }));
    expect(() => claimStaleRunLock(lock, recovery, "old-token")).toThrow("换代");
    expect(existsSync(lock)).toBe(false);
    expect(JSON.parse(readFileSync(recovery, "utf8")).token).toBe("successor");

    rmSync(recovery);
    writeFileSync(lock, JSON.stringify({ pid: 1, token: "old-token", at: 1 }));
    expect(claimStaleRunLock(lock, recovery, "old-token")).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(JSON.parse(readFileSync(recovery, "utf8")).token).toBe("old-token");
  });

  test("死亡 owner 的 stale lock 经 gate 恢复，成功后不遗留公共或私有锁", () => {
    const r = root();
    writeFileSync(join(r, ".runs.write.lock"), JSON.stringify({ pid: 2_000_000_000, token: "dead", at: 1 }));
    expect(new RunRepository(r).append(event("command-accepted")).appended).toBe(true);
    expect(readdirSync(r).filter((n) => n.startsWith(".runs."))).toEqual([]);
  });

  test("两个进程同时恢复同一 stale lock：输家按 busy 重试，最终都可写且无 gate", async () => {
    const r = root(), moduleUrl = new URL("./repository.ts", import.meta.url).href;
    writeFileSync(join(r, ".runs.write.lock"), JSON.stringify({ pid: 2_000_000_000, token: "dead", at: 1 }));
    const children = [0, 1].map((i) => Bun.spawn([process.execPath, "-e", `
      const { RunRepository } = await import(${JSON.stringify(moduleUrl)});
      const repo=new RunRepository(${JSON.stringify(r)}), value={schemaVersion:1,eventId:"recover-${i}",type:"command-accepted",at:"2026-08-16T00:00:0${i}.000Z",commandId:"recover-c-${i}",runId:"recover-r-${i}",taskId:"recover-t-${i}",sessionId:"recover-s-${i}",providerId:"claude"};
      for(let n=0;;n++) { try { repo.append(value); break; } catch(e) { if(e?.code!=="RUN_REPOSITORY_BUSY" || n>=30) throw e; await Bun.sleep(10); } }
    `], { stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(children.map((p) => p.exited))).toEqual([0, 0]);
    expect(new RunRepository(r).readStrict()).toHaveLength(2);
    expect(readdirSync(r).filter((n) => n.startsWith(".runs."))).toEqual([]);
  });

  test("stale 已认领但正式锁超时是良性 busy：撤 gate/recovery，随后仍可写", async () => {
    const r = root(), marker = join(r, "claimed.marker"), lock = join(r, ".runs.write.lock");
    writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, token: "dead", at: 1 }));
    const crossing = Bun.spawn([process.execPath, "-e", `
      const {existsSync,writeFileSync,unlinkSync}=await import("fs");
      const marker=${JSON.stringify(marker)}, lock=${JSON.stringify(lock)};
      while(!existsSync(marker)) await Bun.sleep(1);
      writeFileSync(lock,JSON.stringify({pid:process.pid,token:"crossing",at:Date.now()}),{flag:"wx"});
      await Bun.sleep(80); unlinkSync(lock);
    `], { stdout: "ignore", stderr: "pipe" });
    const repo = new RunRepository(r, { waitMs: 30, afterStaleClaimed: () => {
      writeFileSync(marker, "1");
      // 不能靠固定 sleep 猜子进程何时获调度；等 crossing 确实持锁后才继续故障路径。
      const deadline = Date.now() + 1_000;
      while (!existsSync(lock) && Date.now() < deadline) Bun.sleepSync(1);
      if (!existsSync(lock)) throw new Error("crossing process did not acquire lock");
    } });
    try { repo.append(event("command-accepted")); throw new Error("expected busy"); }
    catch (e) { expect(e).toBeInstanceOf(RunRepositoryBusyError); expect((e as RunRepositoryBusyError).code).toBe("RUN_REPOSITORY_BUSY"); }
    expect(await crossing.exited).toBe(0);
    expect(readdirSync(r).filter((n) => n.startsWith(".runs."))).toEqual([]);
    expect(new RunRepository(r).append(event("command-accepted")).appended).toBe(true);
  });

  test("认领后 token 歧义集成路径 fail closed，保留 gate 与继任 recovery 证据", () => {
    const r = root(), lock = join(r, ".runs.write.lock");
    writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, token: "dead", at: 1 }));
    const repo = new RunRepository(r, { afterStaleClaimed: () => {
      const recovery = readdirSync(r).find((n) => n.startsWith(".runs.write.lock.recovery."));
      if (!recovery) throw new Error("test recovery missing");
      writeFileSync(join(r, recovery), JSON.stringify({ pid: 424242, token: "successor-private", at: Date.now() }));
    } });
    expect(() => repo.append(event("command-accepted"))).toThrow("认领后 token 发生换代");
    const artifacts = readdirSync(r).filter((n) => n.startsWith(".runs."));
    expect(artifacts.some((n) => n === ".runs.recovery.gate")).toBe(true);
    const recovery = artifacts.find((n) => n.startsWith(".runs.write.lock.recovery."));
    expect(recovery).toBeString();
    expect(JSON.parse(readFileSync(join(r, recovery!), "utf8"))).toMatchObject({ pid: 424242, token: "successor-private" });
    expect(existsSync(join(r, "runs.jsonl"))).toBe(false);
  });

  test("活锁只短等并返回可重试 busy，不在 daemon 同步阻塞", () => {
    const r = root();
    writeFileSync(join(r, ".runs.write.lock"), JSON.stringify({ pid: process.pid, token: "live", at: Date.now() }));
    const started = Date.now();
    try { new RunRepository(r).append(event("command-accepted")); throw new Error("expected busy"); }
    catch (e) { expect(e).toBeInstanceOf(RunRepositoryBusyError); expect((e as RunRepositoryBusyError).code).toBe("RUN_REPOSITORY_BUSY"); }
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("多个进程并发 append 不撕裂 JSONL、不丢事件", async () => {
    const r = root(), moduleUrl = new URL("./repository.ts", import.meta.url).href;
    const children = Array.from({ length: 12 }, (_, i) => Bun.spawn([process.execPath, "-e", `
      const { RunRepository } = await import(${JSON.stringify(moduleUrl)});
      const repo = new RunRepository(${JSON.stringify(r)}), value={schemaVersion:1,eventId:"e-${i}",type:"command-accepted",at:"2026-08-16T00:00:${String(i).padStart(2, "0")}.000Z",commandId:"c-${i}",runId:"r-${i}",taskId:"t-${i}",sessionId:"s-${i}",providerId:"claude"};
      for (let n=0;;n++) { try { repo.append(value); break; } catch(e) { if (e?.code!=="RUN_REPOSITORY_BUSY" || n>=20) throw e; await Bun.sleep(10); } }
    `], { stdout: "ignore", stderr: "pipe" }));
    const codes = await Promise.all(children.map((p) => p.exited));
    expect(codes).toEqual(Array(12).fill(0));
    const read = readRunJournal(r);
    expect(read.diagnostics).toEqual([]);
    expect(read.events).toHaveLength(12);
    expect(new Set(read.events.map((e) => e.eventId)).size).toBe(12);
  });

  test("同一 runId 两进程并发 terminal，恰好一个成功且 journal 只有一个终态", async () => {
    const r = root(), repo = new RunRepository(r), moduleUrl = new URL("./repository.ts", import.meta.url).href;
    repo.append(event("command-accepted")); repo.append(event("run-started"));
    const types = ["run-completed", "run-failed"];
    const children = types.map((type, i) => Bun.spawn([process.execPath, "-e", `
      const { RunRepository } = await import(${JSON.stringify(moduleUrl)});
      const repo=new RunRepository(${JSON.stringify(r)}), value={schemaVersion:1,eventId:"terminal-${i}",type:${JSON.stringify(type)},at:"2026-08-16T00:00:02.000Z",commandId:"cmd-1",runId:"run-1",taskId:"task-1",sessionId:"session-1",providerId:"claude"};
      for(let n=0;;n++) { try { repo.append(value); process.exit(0); } catch(e) { if(String(e).includes("已有 terminal")) process.exit(3); if(e?.code!=="RUN_REPOSITORY_BUSY" || n>=20) throw e; await Bun.sleep(10); } }
    `], { stdout: "ignore", stderr: "pipe" }));
    const codes = (await Promise.all(children.map((p) => p.exited))).sort();
    expect(codes).toEqual([0, 3]);
    const terminal = repo.readStrict().filter((e) => e.type.startsWith("run-") && !["run-started"].includes(e.type) && e.type !== "command-accepted");
    expect(terminal).toHaveLength(1);
  });

  test("Task 投影无事件时明确为 none，多 Run 取追加顺序的最后一轮", () => {
    const events: RunEvent[] = [
      event("command-accepted"), event("run-started"), event("run-completed"),
      event("command-accepted", { eventId: "a2", commandId: "cmd-2", runId: "run-2" }),
      event("run-started", { eventId: "s2", commandId: "cmd-2", runId: "run-2" }),
    ];
    expect(projectTaskRunState(events, "missing")).toEqual({ status: "none" });
    expect(projectTaskRunState(events, "task-1")).toEqual({ status: "running", runId: "run-2" });
  });
});
