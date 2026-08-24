import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { auditRunnerBlobs, quarantineRunnerOrphans, RunnerCommandJournal, RunnerEventJournal } from "./journals.ts";
import { planRunnerRecovery } from "./recovery.ts";
import { reconcileRunnerStartup } from "./startup-reconcile.ts";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "ownward-runner-journal-")); roots.push(r); return r; };
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const command = (id = "cmd-1", input = "TOP SECRET prompt") => ({ commandId: id, kind: "start-run" as const, runId: `run-${id}`, sessionId: `session-${id}`, providerId: "fake", input });

describe("Runner journals", () => {
  test("敏感输入只进 0600 blob，command journal 仅保存 ref/hash", () => {
    const r = root(), repo = new RunnerCommandJournal(r), result = repo.accept(command());
    const journalFile = join(r, "runner", "commands.jsonl"), journal = readFileSync(journalFile, "utf8");
    expect(journal).not.toContain("TOP SECRET"); expect(result.record.inputRef).toMatch(/^inputs\/[a-f0-9]{64}\.blob$/);
    const blob = join(r, "runner", result.record.inputRef!);
    expect(readFileSync(blob, "utf8")).toBe("TOP SECRET prompt"); expect(statSync(blob).mode & 0o777).toBe(0o600);
    expect(repo.readInput(result.record)).toBe("TOP SECRET prompt");
    expect(statSync(join(r, "runner")).mode & 0o777).toBe(0o700); expect(statSync(join(r, "runner", "commands.jsonl")).mode & 0o777).toBe(0o600);
    chmodSync(journalFile, 0o666); chmodSync(blob, 0o666); repo.accept(command(), "2026-01-02T00:00:00.000Z"); repo.accept({ commandId: "interrupt-1", kind: "interrupt", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake" });
    expect(statSync(journalFile).mode & 0o777).toBe(0o600); expect(statSync(blob).mode & 0o777).toBe(0o600);
    writeFileSync(blob, "tampered"); expect(() => repo.readInput(result.record)).toThrow("校验失败");
  });
  test("同 commandId 同内容跨重启幂等，不同内容 fail closed", () => {
    const r = root(); expect(new RunnerCommandJournal(r).accept(command(), "2026-01-01T00:00:00.000Z").appended).toBe(true);
    expect(new RunnerCommandJournal(r).accept(command(), "2026-01-02T00:00:00.000Z").appended).toBe(false);
    expect(() => new RunnerCommandJournal(r).accept(command("cmd-1", "DIFFERENT"))).toThrow("内容冲突");
    expect(new RunnerCommandJournal(r).readStrict()).toHaveLength(1);
  });
  test("Claude 控制命令严格区分有输入与无输入 kind", () => {
    const repo = new RunnerCommandJournal(root());
    for (const kind of ["resume-run", "send-input", "approval-response", "add-dir", "set-access", "new-session"] as const) {
      const record = repo.accept({ commandId: `cmd-${kind}`, kind, runId: `run-${kind}`, sessionId: "session-claude", providerId: "claude", input: "{}", ...(kind === "approval-response" ? { approvalRequestId: "approval-1" } : {}) }).record;
      expect(repo.readInput(record)).toBe("{}");
    }
    expect(repo.accept({ commandId: "cmd-interrupt", kind: "interrupt", runId: "run-interrupt", sessionId: "session-claude", providerId: "claude" }).record.inputRef).toBeUndefined();
    expect(() => repo.accept({ commandId: "bad-new", kind: "new-session", runId: "run-bad", sessionId: "session-claude", providerId: "claude" } as any)).toThrow("输入契约");
  });
  test("accepted 记录可查询但没有 replay API", () => {
    const r = root(), repo = new RunnerCommandJournal(r); repo.accept(command());
    expect(repo.find("cmd-1")?.kind).toBe("start-run"); expect("replay" in repo).toBe(false);
    const [accepted, dispatching, missing] = [repo.accept(command("cmd-2")).record, repo.accept(command("cmd-3")).record, repo.accept(command("cmd-4")).record];
    const followup = repo.accept({ commandId: "followup", kind: "send-input", runId: accepted.runId, sessionId: accepted.sessionId, providerId: "fake", input: "next" }).record;
    expect(planRunnerRecovery([accepted, followup, dispatching, missing], [
      { runId: accepted.runId, commandId: accepted.commandId, taskId: "t", sessionId: accepted.sessionId, providerId: "fake", status: "accepted", firstSequence: 0 },
      { runId: dispatching.runId, commandId: dispatching.commandId, taskId: "t", sessionId: dispatching.sessionId, providerId: "fake", status: "dispatching", firstSequence: 1 },
    ]).map((x) => x.action)).toEqual(["manual-confirm", "mark-unknown-outcome", "manual-inspect"]);
  });
  test("eventId 幂等且冲突拒绝", () => {
    const r = root(); new RunnerCommandJournal(r).accept(command()); const repo = new RunnerEventJournal(r);
    const e = { eventId: "event-1", type: "started" as const, at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake", nativeRef: "fake:1" };
    expect(repo.append(e).appended).toBe(true); expect(repo.append({ ...e, at: "2026-01-02T00:00:00.000Z" }).appended).toBe(false);
    expect(() => repo.append({ ...e, nativeRef: "fake:2" })).toThrow("内容冲突");
  });
  test("event 必须绑定 durable command，identity/sequence/lifecycle 全部严格", () => {
    const r = root(), events = new RunnerEventJournal(r), started = { eventId: "e-1", type: "started" as const, at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake" };
    expect(() => events.append(started)).toThrow("durable accepted");
    new RunnerCommandJournal(r).accept(command()); expect(events.append(started).record.sequence).toBe(1);
    expect(() => events.append({ ...started, eventId: "e-2" })).toThrow("started 只能");
    expect(() => events.append({ ...started, eventId: "e-3", type: "delta", payload: "x", sessionId: "wrong" })).toThrow("sessionId");
    expect(events.append({ ...started, eventId: "e-4", type: "failed", reason: "provider_exit" }).record.sequence).toBe(2);
    expect(() => events.append({ ...started, eventId: "e-5", type: "delta", payload: "late" })).toThrow("terminal 后");
    expect(() => events.append({ ...started, eventId: "e-6", type: "failed", reason: "raw provider secret" as any })).toThrow("分类码");
  });
  test("started 前只允许诊断 notice 与 failed/unknown-outcome 明确终态", () => {
    { const r = root(); new RunnerCommandJournal(r).accept(command()); const events = new RunnerEventJournal(r); expect(events.append({ eventId: "pre-notice", type: "provider-notice", at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake", payload: "diagnostic" }).record.sequence).toBe(1); expect(events.append({ eventId: "pre-notice-failed", type: "failed", at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake", reason: "provider_exit" }).record.sequence).toBe(2); }
    for (const type of ["failed", "unknown-outcome"] as const) {
      const r = root(); new RunnerCommandJournal(r).accept(command()); const events = new RunnerEventJournal(r);
      expect(events.append({ eventId: `pre-${type}`, type, at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake", reason: type === "failed" ? "provider_exit" : "runner_lost_ownership" }).record.sequence).toBe(1);
      expect(events.readStrict()[0].type).toBe(type);
    }
    for (const type of ["completed", "interrupted", "delta", "approval-requested"] as const) {
      const r = root(); new RunnerCommandJournal(r).accept(command()); const events = new RunnerEventJournal(r);
      const extra = type === "delta" ? { payload: "x" } : type === "approval-requested" ? { approvalRequestId: "approval-1", payload: "{}" } : {};
      expect(() => events.append({ eventId: `pre-${type}`, type, at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake", ...extra })).toThrow("started 前");
    }
  });
  test("启动对账只将 started 非终态收敛为 unknown-outcome，且幂等不 replay accepted", () => {
    const r = root(), commands = new RunnerCommandJournal(r), events = new RunnerEventJournal(r);
    const accepted = commands.accept(command("accepted")).record;
    const running = commands.accept(command("running")).record;
    const completed = commands.accept(command("completed")).record;
    events.append({ eventId: "running-started", type: "started", at: "2026-01-01T00:00:00.000Z", commandId: running.commandId, runId: running.runId, sessionId: running.sessionId, providerId: running.providerId });
    events.append({ eventId: "completed-started", type: "started", at: "2026-01-01T00:00:00.000Z", commandId: completed.commandId, runId: completed.runId, sessionId: completed.sessionId, providerId: completed.providerId });
    events.append({ eventId: "completed-done", type: "completed", at: "2026-01-01T00:00:01.000Z", commandId: completed.commandId, runId: completed.runId, sessionId: completed.sessionId, providerId: completed.providerId });

    const first = reconcileRunnerStartup(r, "2026-01-02T00:00:00.000Z");
    expect(first.untouchedAccepted).toEqual([accepted.commandId]);
    expect(first.reconciled).toHaveLength(1);
    expect(first.reconciled[0]).toMatchObject({ commandId: running.commandId, sequence: 2, type: "unknown-outcome", reason: "runner_lost_ownership" });
    const second = reconcileRunnerStartup(r, "2026-01-03T00:00:00.000Z");
    expect(second.reconciled).toEqual([]);
    expect(new RunnerEventJournal(r).readStrict().filter((event) => event.commandId === running.commandId)).toHaveLength(2);
  });
  test("strict read 从磁盘全量复核 command tuple/sequence/lifecycle", () => {
    const writeEvents = (r: string, rows: unknown[]) => { const dir = join(r, "runner"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "events.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); };
    const base = { schemaVersion: 1, eventId: "e-1", sequence: 1, type: "started", at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake" };
    const orphanRoot = root(); writeEvents(orphanRoot, [base]); expect(new RunnerEventJournal(orphanRoot).read().diagnostics[0].reason).toContain("command 不存在"); expect(() => new RunnerEventJournal(orphanRoot).readStrict()).toThrow("跨 journal");
    const mismatchRoot = root(); new RunnerCommandJournal(mismatchRoot).accept(command()); writeEvents(mismatchRoot, [{ ...base, sessionId: "wrong" }]); expect(new RunnerEventJournal(mismatchRoot).read().diagnostics[0].reason).toContain("sessionId");
    const earlyFailureRoot = root(); new RunnerCommandJournal(earlyFailureRoot).accept(command()); writeEvents(earlyFailureRoot, [{ ...base, type: "failed", reason: "provider_exit" }]); expect(new RunnerEventJournal(earlyFailureRoot).readStrict()[0].type).toBe("failed");
    const earlyCompletedRoot = root(); new RunnerCommandJournal(earlyCompletedRoot).accept(command()); writeEvents(earlyCompletedRoot, [{ ...base, type: "completed" }]); expect(new RunnerEventJournal(earlyCompletedRoot).read().diagnostics[0].reason).toContain("started 前");
    const lateRoot = root(); new RunnerCommandJournal(lateRoot).accept(command()); writeEvents(lateRoot, [base, { ...base, eventId: "e-2", sequence: 2, type: "completed" }, { ...base, eventId: "e-3", sequence: 3, type: "failed", reason: "provider_exit" }]);
    expect(new RunnerEventJournal(lateRoot).read().diagnostics[0].reason).toContain("terminal 后");
    const gapRoot = root(); new RunnerCommandJournal(gapRoot).accept(command()); writeEvents(gapRoot, [{ ...base, sequence: 2 }]); expect(new RunnerEventJournal(gapRoot).read().diagnostics[0].reason).toContain("sequence 非连续");
  });
  test("截断尾行先备份再修；完整坏行拒写拒修", () => {
    const r = root(), repo = new RunnerCommandJournal(r); repo.accept(command());
    const file = join(r, "runner", "commands.jsonl"); writeFileSync(file, readFileSync(file, "utf8") + "{\"schemaVersion\":1");
    expect(() => repo.accept(command("cmd-2"))).toThrow("已损坏");
    const repaired = repo.repairTruncatedTail(); expect(repaired.repaired).toBe(true); expect(repaired.backup).toBeTruthy(); expect(repo.readStrict()).toHaveLength(1);
    expect(repaired.outcome).toBe("dropped-tail"); expect(statSync(repaired.backup!).mode & 0o777).toBe(0o600); expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, readFileSync(file, "utf8") + "not-json\n");
    expect(() => repo.repairTruncatedTail()).toThrow("只允许修复"); expect(() => repo.accept(command("cmd-3"))).toThrow("已损坏");
  });
  test("合法无换行只补 newline 并保留事件", () => {
    const r = root(), repo = new RunnerCommandJournal(r); repo.accept(command()); const file = join(r, "runner", "commands.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").trimEnd()); const result = repo.repairTruncatedTail();
    expect(result.outcome).toBe("kept-newline"); expect(repo.readStrict()).toHaveLength(1); expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });
  test("orphan 只审计，显式请求后隔离而不删除", () => {
    const r = root(), repo = new RunnerCommandJournal(r); const accepted = repo.accept(command());
    const dir = join(r, "runner", "inputs"), orphan = "b".repeat(64) + ".blob"; writeFileSync(join(dir, orphan), "orphan", { mode: 0o600 }); writeFileSync(join(r, "runner", ".left.tmp"), "tmp");
    const audit = auditRunnerBlobs(r); expect(audit.referenced).toContain(accepted.record.inputRef!); expect(audit.orphans).toEqual([`inputs/${orphan}`]); expect(audit.temporary).toContain(".left.tmp");
    expect(() => quarantineRunnerOrphans(r, [accepted.record.inputRef!])).toThrow("审计确认");
    const [quarantined] = quarantineRunnerOrphans(r, audit.orphans); expect(existsSync(quarantined)).toBe(true); expect(existsSync(join(dir, orphan))).toBe(false);
  });
  test("quarantine audit 后与 accept 竞争也不会产生 journal ref 缺 blob", async () => {
    const r = root(), content = "race-content", sha = new Bun.CryptoHasher("sha256").update(content).digest("hex"), ref = `inputs/${sha}.blob`, dir = join(r, "runner", "inputs");
    mkdirSync(dir, { recursive: true }); writeFileSync(join(r, "runner", ref), content, { mode: 0o600 });
    const moduleUrl = new URL("./journals.ts", import.meta.url).href; let worker: ReturnType<typeof Bun.spawn> | undefined;
    quarantineRunnerOrphans(r, [ref], { afterAudit: () => {
      worker = Bun.spawn([process.execPath, "-e", `import {RunnerCommandJournal} from ${JSON.stringify(moduleUrl)}; new RunnerCommandJournal(${JSON.stringify(r)}).accept({commandId:"race-command",kind:"start-run",runId:"race-run",sessionId:"race-session",providerId:"fake",input:${JSON.stringify(content)}});`], { stdout: "pipe", stderr: "pipe" });
    } });
    expect(worker).toBeTruthy(); const code = await worker!.exited;
    if (code) throw new Error(await new Response(worker!.stderr as ReadableStream<Uint8Array>).text());
    const record = new RunnerCommandJournal(r).find("race-command")!; expect(record.inputRef).toBe(ref); expect(existsSync(join(r, "runner", record.inputRef!))).toBe(true);
  });
  test("带 payload 的 event 持 blob 锁跨越 blob 与 journal append", () => {
    const r = root(), commands = new RunnerCommandJournal(r); commands.accept(command()); let blocked = false;
    const events = new RunnerEventJournal(r, { afterBlobWritten: () => { try { quarantineRunnerOrphans(r, []); } catch (e: any) { blocked = e?.code === "RUNNER_JOURNAL_BUSY"; } } });
    events.append({ eventId: "locked-start", type: "started", at: "2026-01-01T00:00:00.000Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake" });
    const delta = events.append({ eventId: "locked-delta", type: "delta", at: "2026-01-01T00:00:00.001Z", commandId: "cmd-1", runId: "run-cmd-1", sessionId: "session-cmd-1", providerId: "fake", payload: "locked" }).record;
    expect(blocked).toBe(true); expect(existsSync(join(r, "runner", delta.payloadRef!))).toBe(true);
  });
  test("合法 JSON 的未知 schema/字段严格拒绝", () => {
    const r = root(), file = join(r, "runner", "commands.jsonl");
    new RunnerCommandJournal(r).accept(command());
    const first = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...first, future: true }) + "\n"); expect(() => new RunnerCommandJournal(r).readStrict()).toThrow("损坏或不支持");
    writeFileSync(file, JSON.stringify({ ...first, schemaVersion: 2 }) + "\n"); expect(new RunnerCommandJournal(r).read().diagnostics[0].code).toBe("unsupported-schema");
  });
  // 锁等待只有 RUNNER_JOURNAL_LOCK_WAIT_MS=50ms，是按生产实际并发（单实例 Runner）定的。
  // 8 个进程硬抢时 BUSY 属于契约内结果（错误文案就写着「请稍后重试」），不重试就等于在断言
  // 「50ms 在满载机器上也够用」——整套测试并行跑时这条会随机假红。按契约重试后，断言的是
  // 真正的不变量：8 条记录一条不丢、一条不重、且 readStrict 能全部解析。
  test("多进程并发 writer 不丢记录", async () => {
    const r = root(), moduleUrl = new URL("./journals.ts", import.meta.url).href;
    const worker = (i: number) => `
      import {RunnerCommandJournal} from ${JSON.stringify(moduleUrl)};
      const j = new RunnerCommandJournal(${JSON.stringify(r)});
      const rec = {commandId:"cmd-${i}",kind:"start-run",runId:"run-${i}",sessionId:"session-${i}",providerId:"fake",input:"secret-${i}"};
      for (let n = 0; ; n++) {
        try { j.accept(rec); break; }
        catch (e) { if (e?.code !== "RUNNER_JOURNAL_BUSY" || n >= 300) throw e; Bun.sleepSync(10); }
      }`;
    const workers = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, "-e", worker(i)], { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(workers.map((p) => p.exited));
    if (codes.some(Boolean)) throw new Error((await Promise.all(workers.map((p) => new Response(p.stderr).text()))).join("\n"));
    const records = new RunnerCommandJournal(r).readStrict();
    expect(records).toHaveLength(8);
    expect(new Set(records.map((x) => x.commandId)).size).toBe(8);
  }, 30_000);
  test("owner 可修复的 runner 目录权限主动收敛到 0700", () => {
    const r = root(), runner = join(r, "runner"); mkdirSync(runner, { mode: 0o777 }); chmodSync(runner, 0o777); new RunnerCommandJournal(r).accept(command()); chmodSync(runner, 0o500);
    expect(new RunnerCommandJournal(r).accept(command("cmd-2")).appended).toBe(true); expect(statSync(runner).mode & 0o777).toBe(0o700);
  });
});
