import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ackBatch, claimBatch, recoverClaims, releaseBatch, type OwnwardEvent } from "./spool.ts";
import { markClaimCompleted, pendingClaimEvents, triageEventKey } from "./triage-checkpoint.ts";
import { excludeDomainOnlyEvents } from "./triage.ts";

const roots: string[] = [];
function root(): string { const r = mkdtempSync(join(tmpdir(), "ownward-triage-cp-")); roots.push(r); return r; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const current: OwnwardEvent = { id: "event-1", source: "github", ts: "2026-01-01T00:00:00Z", payload: { n: 1 } };
const legacy: OwnwardEvent = { source: "gmail", ts: "2026-01-01T00:00:00Z", payload: { n: 2 } };
test("domain-projected events in legacy and namespaced forms stay out of LLM triage",()=>{const make=(source:string,key:string,payload:unknown={})=>({id:`${source}:${key}`,source,key,ts:new Date().toISOString(),payload})as OwnwardEvent,bigDaily={items:Array.from({length:10_000},(_,i)=>({i,text:"x".repeat(100)}))},domainOnly=[make("lark","daily",bigDaily),make("lark","lark.inbox.daily",bigDaily),make("lark","card.action.trigger"),make("lark","lark.inbox.card.action.trigger"),make("github","snapshot"),make("github","github.inbox.snapshot")];expect(excludeDomainOnlyEvents([...domainOnly,current])).toEqual([current]);expect(JSON.stringify(excludeDomainOnlyEvents(domainOnly))).not.toContain("items");});

describe("triage consumer checkpoint", () => {
  test("新事件按 id，legacy 按原始行 sha256 得到稳定 fallback key", () => {
    expect(triageEventKey(current, "arbitrary")).toBe("id:event-1");
    const a = triageEventKey(legacy, JSON.stringify(legacy));
    expect(a).toStartWith("legacy:");
    expect(triageEventKey(legacy, JSON.stringify(legacy))).toBe(a);
    expect(triageEventKey(legacy, JSON.stringify({ ...legacy, payload: { n: 3 } }))).not.toBe(a);
  });

  test("副作用完成后 checkpoint 原子落盘，重投先过滤", () => {
    const r = root();
    writeFileSync(join(r, "queue.jsonl"), JSON.stringify(current) + "\n" + JSON.stringify(legacy) + "\n");
    const claim = claimBatch(10, r)!;
    expect(pendingClaimEvents(claim, r)).toHaveLength(2);
    markClaimCompleted(claim, r);
    expect(pendingClaimEvents(claim, r)).toEqual([]);
    const cp = JSON.parse(readFileSync(join(r, "triage-checkpoint.json"), "utf8"));
    expect(cp.completed).toHaveLength(2);
    expect(readFileSync(join(r, "triage-checkpoint.json"), "utf8")).toEndWith("\n");
    releaseBatch(claim, r);
  });

  test("模拟 checkpoint 后、ack 前崩溃：恢复后的批次不会再次执行副作用", () => {
    const r = root();
    writeFileSync(join(r, "queue.jsonl"), JSON.stringify(current) + "\n");
    const first = claimBatch(10, r)!;
    markClaimCompleted(first, r); // 此处后模拟 crash，不调用 ack/release
    expect(recoverClaims(r)).toBe(1);
    const replay = claimBatch(10, r)!;
    expect(pendingClaimEvents(replay, r)).toEqual([]);
    ackBatch(replay, r);
  });

  test("损坏 checkpoint 宁可重放，不丢关键事件", () => {
    const r = root();
    writeFileSync(join(r, "queue.jsonl"), JSON.stringify(current) + "\n");
    writeFileSync(join(r, "triage-checkpoint.json"), "{");
    const claim = claimBatch(10, r)!;
    expect(pendingClaimEvents(claim, r)).toEqual([current]);
    releaseBatch(claim, r);
  });
});
