import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendEvent, appendEvents, claimBatch } from "../../spool.ts";
import { createScopedEvents } from "./event-scope.ts";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "ownward-vertical-events-")); roots.push(r); return r; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const ready = (r: string) => existsSync(join(r, "queue.jsonl")) ? readFileSync(join(r, "queue.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const spoolPort = (r: string) => ({ append: (events: any[]) => { appendEvents(events, r); } });
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e?.code; } return "NO_ERROR"; };

describe("ScopedEvents（ADR 0003）", () => {
  test("入队形状：id/source 强制带本 Vertical 前缀，key=type，occurredAt 进 payload，敏感键脱敏", () => {
    const r = root(), events = createScopedEvents("acme", spoolPort(r), { dataRoot: r, now: () => Date.parse("2026-10-16T01:00:00Z") });
    expect(events.publish([{ id: "sig-1", type: "signal.ma50_break", occurredAt: "2026-10-15T20:00:00Z", payload: { symbol: "NVDA.US", nested: { apiToken: "x" } } }])).toEqual({ accepted: 1, duplicates: 0 });
    const [line] = ready(r);
    expect(line).toEqual({ id: "vertical:acme:sig-1", source: "vertical:acme", key: "signal.ma50_break", ts: "2026-10-16T01:00:00.000Z", payload: { symbol: "NVDA.US", nested: { apiToken: "[REDACTED]" }, _occurredAt: "2026-10-15T20:00:00Z" } });
  });

  test("同 id 去重：同批、跨批都只算 duplicates", () => {
    const r = root(), events = createScopedEvents("acme", spoolPort(r), { dataRoot: r });
    expect(events.publish([{ id: "a", type: "t", payload: {} }, { id: "a", type: "t", payload: {} }])).toEqual({ accepted: 1, duplicates: 1 });
    expect(events.publish([{ id: "a", type: "t", payload: {} }, { id: "b", type: "t", payload: {} }])).toEqual({ accepted: 1, duplicates: 1 });
    expect(ready(r).map((e) => e.id)).toEqual(["vertical:acme:a", "vertical:acme:b"]);
  });

  test("重启后去重仍然成立：账本持久；崩在入队与记账之间也能从队列证据恢复", () => {
    const r = root();
    createScopedEvents("acme", spoolPort(r), { dataRoot: r }).publish([{ id: "a", type: "t", payload: {} }]);
    expect(createScopedEvents("acme", spoolPort(r), { dataRoot: r }).publish([{ id: "a", type: "t", payload: {} }])).toEqual({ accepted: 0, duplicates: 1 });
    const ledger = join(r, "kernel", "vertical-events", "acme", "accepted-ids.jsonl");
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    // 只入队、没记账（模拟崩溃窗口）；triage 已 claim 到 processing 也算证据
    appendEvent({ id: "vertical:acme:b", source: "vertical:acme", key: "t", ts: new Date().toISOString(), payload: {} }, r);
    claimBatch(10, r);
    expect(createScopedEvents("acme", spoolPort(r), { dataRoot: r }).publish([{ id: "b", type: "t", payload: {} }])).toEqual({ accepted: 0, duplicates: 1 });
    // 他人前缀不算本 Vertical 的证据
    expect(createScopedEvents("other", spoolPort(r), { dataRoot: r }).publish([{ id: "b", type: "t", payload: {} }])).toEqual({ accepted: 1, duplicates: 0 });
  });

  test("整批一次入队：满批 50 条只调一次 append（一次 fsync），不按条数逐条落盘", () => {
    const r = root(), calls: number[] = [];
    const events = createScopedEvents("acme", { append: (list) => { calls.push(list.length); appendEvents(list, r); } }, { dataRoot: r });
    expect(events.publish(Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, type: "t", payload: { i } })))).toEqual({ accepted: 50, duplicates: 0 });
    expect(calls).toEqual([50]);
    expect(readFileSync(join(r, "kernel", "vertical-events", "acme", "accepted-ids.jsonl"), "utf8").trim().split("\n")).toHaveLength(50);
  });

  test("入队成功但账本写失败：同进程重试仍判 duplicate，不会二次入队", () => {
    const r = root(), events = createScopedEvents("acme", spoolPort(r), { dataRoot: r });
    const ledgerDir = join(r, "kernel", "vertical-events", "acme");
    rmSync(ledgerDir, { recursive: true, force: true });   // 账本目录消失 → append 账本抛错
    expect(code(() => events.publish([{ id: "a", type: "t", payload: {} }]))).not.toBe("NO_ERROR");
    expect(events.publish([{ id: "a", type: "t", payload: {} }])).toEqual({ accepted: 0, duplicates: 1 });
    expect(ready(r).map((e) => e.id)).toEqual(["vertical:acme:a"]);
  });

  test("整批校验：任一条非法整批拒绝，不会半批入队", () => {
    const r = root(), events = createScopedEvents("acme", spoolPort(r), { dataRoot: r });
    const ok = { id: "ok", type: "t", payload: {} };
    for (const bad of [{ id: "", type: "t", payload: {} }, { id: "a/b", type: "t", payload: {} }, { id: "a", type: "Bad", payload: {} }, { id: "a", type: "t", payload: [] },
      { id: "a", type: "t", payload: { big: "x".repeat(16 * 1024) } }, { id: "a", type: "t", occurredAt: "yesterday", payload: {} }, { id: "a", type: "t", payload: {}, source: "lark" }])
      expect(code(() => events.publish([ok, bad as any]))).toBe("VERTICAL_EVENTS_INVALID");
    expect(code(() => events.publish([]))).toBe("VERTICAL_EVENTS_INVALID");
    expect(code(() => events.publish(Array.from({ length: 51 }, (_, i) => ({ id: `e${i}`, type: "t", payload: {} }))))).toBe("VERTICAL_EVENTS_INVALID");
    expect(code(() => events.publish("x" as any))).toBe("VERTICAL_EVENTS_INVALID");
    expect(ready(r)).toEqual([]);
  });

  test("按 Vertical 限流：超额整批拒绝，duplicate 不占额度，满一小时恢复", () => {
    let now = 0;
    const r = root(), events = createScopedEvents("acme", spoolPort(r), { dataRoot: r, perHour: 2, now: () => now });
    events.publish([{ id: "a", type: "t", payload: {} }]);
    expect(code(() => events.publish([{ id: "b", type: "t", payload: {} }, { id: "c", type: "t", payload: {} }]))).toBe("VERTICAL_EVENTS_RATE_LIMITED");
    expect(events.publish([{ id: "a", type: "t", payload: {} }, { id: "b", type: "t", payload: {} }])).toEqual({ accepted: 1, duplicates: 1 });
    expect(code(() => events.publish([{ id: "c", type: "t", payload: {} }]))).toBe("VERTICAL_EVENTS_RATE_LIMITED");
    now = 3_600_000;
    expect(events.publish([{ id: "c", type: "t", payload: {} }])).toEqual({ accepted: 1, duplicates: 0 });
  });
});
