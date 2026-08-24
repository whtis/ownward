import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { canRecoverRunnerLock, claimStaleRunnerGate, stableJson, RUNNER_JOURNAL_LOCK_STALE_MS } from "./durable-journal.ts";
import { RunnerCommandJournal, RunnerEventJournal } from "./journals.ts";

const roots: string[] = [], root = () => { const r = mkdtempSync(join(tmpdir(), "ownward-runner-durable-")); roots.push(r); return r; };
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const command = (i: number) => ({ commandId: `cmd-${i}`, kind: "interrupt" as const, runId: `run-${i}`, sessionId: `session-${i}`, providerId: "fake" });

describe("DurableJsonlJournal hardening", () => {
  test("pid 必须是正整数才允许 stale recovery", () => {
    expect(canRecoverRunnerLock({ pid: 0, token: "x", at: 0 }, RUNNER_JOURNAL_LOCK_STALE_MS + 1, () => false)).toBe(false);
    expect(canRecoverRunnerLock({ pid: -1, token: "x", at: 0 }, RUNNER_JOURNAL_LOCK_STALE_MS + 1, () => false)).toBe(false);
  });
  test("SIGKILL 遗留 dead gate 过 grace 后可恢复", () => {
    const r = root(), runner = join(r, "runner"), file = join(runner, "commands.jsonl"), gate = `${file}.recovery.gate`;
    mkdirSync(runner, { recursive: true }); writeFileSync(gate, JSON.stringify({ pid: 99999999, token: "dead-gate", at: Date.now() - RUNNER_JOURNAL_LOCK_STALE_MS - 1 }));
    expect(new RunnerCommandJournal(r).accept(command(1)).appended).toBe(true); expect(existsSync(gate)).toBe(false);
  });
  test("gate token 换代时 fail closed 并保留 recovery", () => {
    const r = root(), gate = join(r, "gate"), recovery = join(r, "gate.recovery"); writeFileSync(gate, JSON.stringify({ pid: 1, token: "new", at: 0 }));
    expect(() => claimStaleRunnerGate(gate, recovery, "old")).toThrow("换代"); expect(existsSync(recovery)).toBe(true);
  });
  test("stale lock 恢复后业务校验失败也不遗留 gate", () => {
    const r = root(), runner = join(r, "runner"), file = join(runner, "commands.jsonl"), lock = `${file}.write.lock`, gate = `${file}.recovery.gate`;
    mkdirSync(runner, { recursive: true }); writeFileSync(file, "bad-json\n"); writeFileSync(lock, JSON.stringify({ pid: 99999999, token: "dead-lock", at: Date.now() - RUNNER_JOURNAL_LOCK_STALE_MS - 1 }));
    expect(() => new RunnerCommandJournal(r).accept(command(1))).toThrow("已损坏"); expect(existsSync(gate)).toBe(false);
  });
  test("canonical semantic 丢弃 undefined，跨 Repository 实例仍幂等", () => {
    expect(stableJson({ a: 1, absent: undefined })).toBe(stableJson({ a: 1 }));
    const r = root(), first = new RunnerCommandJournal(r).accept(command(1), "2026-01-01T00:00:00.000Z");
    expect(first.appended).toBe(true); expect(new RunnerCommandJournal(r).accept({ ...command(1), approvalRequestId: undefined }, "2026-02-01T00:00:00.000Z").appended).toBe(false);
  });
  test("进程内索引避免大 journal 每次重解析/线性 identity 扫描", () => {
    const r = root(), repo = new RunnerCommandJournal(r), started = performance.now();
    for (let i = 0; i < 5_000; i++) repo.accept(command(i));
    expect(repo.readStrict()).toHaveLength(5_000); expect(performance.now() - started).toBeLessThan(8_000);
  });
  test("event journal 的 per-run lifecycle index 支撑长流", () => {
    const r = root(), commands = new RunnerCommandJournal(r), events = new RunnerEventJournal(r), c = commands.accept({ commandId: "stream", kind: "start-run", runId: "stream-run", sessionId: "stream-session", providerId: "fake", input: "x" }).record;
    events.append({ eventId: "stream-0", type: "started", at: "2026-01-01T00:00:00.000Z", commandId: c.commandId, runId: c.runId, sessionId: c.sessionId, providerId: c.providerId });
    const started = performance.now();
    for (let i = 1; i <= 1_000; i++) events.append({ eventId: `stream-${i}`, type: "delta", at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(), commandId: c.commandId, runId: c.runId, sessionId: c.sessionId, providerId: c.providerId, payload: `d-${i}` });
    expect(events.readStrict()).toHaveLength(1_001); expect(performance.now() - started).toBeLessThan(8_000);
  });
});

// 增量尾读：daemon（跨进程读者）对着 runner 在写的 journal 50ms 轮询，
// 原先每次 append 都让读者全文件重读重解析。增量只在 append-only 前提下生效，
// 任何异常必须回退全量，且可观测语义（diagnostics/readStrict 抛错）与全量完全一致。
describe("DurableJsonlJournal 增量尾读", () => {
  const { DurableJsonlJournal } = require("./durable-journal.ts") as typeof import("./durable-journal.ts");
  const { appendFileSync, renameSync } = require("fs") as typeof import("fs");
  interface Rec { id: string; v: string; }
  const line = (r: Rec) => JSON.stringify(r) + "\n";
  function makeJournal(name: string) {
    const dir = mkdtempSync(join(tmpdir(), "ownward-dj-tail-"));
    const file = join(dir, name);
    const j = new DurableJsonlJournal<Rec>(
      file,
      (raw: any) => { if (typeof raw?.id !== "string" || typeof raw?.v !== "string") throw new Error("bad record"); return { id: raw.id, v: raw.v }; },
      (r) => r.id,
      (r) => r.v,
    );
    return { j, file };
  }

  test("外部进程追加后读到全量且顺序正确（缓存增量推进）", () => {
    const { j, file } = makeJournal("a.jsonl");
    j.append({ id: "1", v: "a" }); j.append({ id: "2", v: "b" });   // 建缓存
    appendFileSync(file, line({ id: "3", v: "c" }) + line({ id: "4", v: "d" }));  // 模拟另一进程 append
    expect(j.readStrict().map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
    expect(j.get("4")?.v).toBe("d");   // identities 索引也要增量跟上
  });

  test("外部追加后的 identity 去重仍然生效", () => {
    const { j, file } = makeJournal("b.jsonl");
    j.append({ id: "1", v: "a" });
    appendFileSync(file, line({ id: "2", v: "b" }));
    expect(j.append({ id: "2", v: "b" })).toMatchObject({ appended: false });   // 同 id 同语义 → 幂等
    expect(() => j.append({ id: "2", v: "DIFF" })).toThrow(/冲突/);             // 同 id 异语义 → fail closed
  });

  test("外部追加半行（无换行）→ 与全量同语义：diagnostics + readStrict 抛错；补全后恢复", () => {
    const { j, file } = makeJournal("c.jsonl");
    j.append({ id: "1", v: "a" });
    appendFileSync(file, JSON.stringify({ id: "2", v: "b" }));   // 无 \n：写入中/截断
    const r = j.read();
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.at(-1)!.unterminated).toBe(true);
    expect(() => j.readStrict()).toThrow(/损坏|不支持/);
    appendFileSync(file, "\n");                                   // 写完了
    expect(j.readStrict().map((x) => x.id)).toEqual(["1", "2"]);
  });

  test("外部追加损坏 JSON → 回退全量并报错，不产出错数据", () => {
    const { j, file } = makeJournal("d.jsonl");
    j.append({ id: "1", v: "a" });
    appendFileSync(file, "{broken\n");
    expect(() => j.readStrict()).toThrow(/损坏|不支持/);
  });

  test("tmp+rename 重写（inode 变化）→ 全量重读新内容", () => {
    const { j, file } = makeJournal("e.jsonl");
    j.append({ id: "1", v: "a" }); j.append({ id: "2", v: "b" });
    const tmp = file + ".tmp";
    writeFileSync(tmp, line({ id: "9", v: "z" }));
    renameSync(tmp, file);
    expect(j.readStrict().map((r) => r.id)).toEqual(["9"]);
  });

  test("同 inode 截短 → 尺寸回退走全量，返回截短后的真实内容", () => {
    const { j, file } = makeJournal("f.jsonl");
    j.append({ id: "1", v: "a" }); j.append({ id: "2", v: "b" });
    writeFileSync(file, line({ id: "1", v: "a" }));   // 原地覆盖成 1 条（size 变小，inode 不变）
    expect(j.readStrict().map((r) => r.id)).toEqual(["1"]);
  });
});
