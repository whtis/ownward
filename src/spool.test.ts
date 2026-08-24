import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ackBatch, appendEvent, claimBatch, queueSize, recoverClaims, releaseBatch, type OwnwardEvent } from "./spool.ts";

const roots: string[] = [];
function root(): string { const r = mkdtempSync(join(tmpdir(), "ownward-spool-")); roots.push(r); return r; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const event = (n: number): OwnwardEvent => ({ source: "github", ts: new Date(n).toISOString(), key: `e${n}`, payload: { n } });
const readyLines = (r: string) => existsSync(join(r, "queue.jsonl"))
  ? readFileSync(join(r, "queue.jsonl"), "utf8").split("\n").filter(Boolean) : [];

describe("durable event spool", () => {
  test("新事件生成稳定 id，archive 与 ready 使用同一原文", () => {
    const r = root();
    const stored = appendEvent(event(1), r);
    expect(stored.id).toBeString();
    const line = readyLines(r)[0];
    const archive = readFileSync(join(r, "events", readdirSync(join(r, "events"))[0]), "utf8").trim();
    expect(archive).toBe(line);
    expect(JSON.parse(line).id).toBe(stored.id);
  });

  test("claim 在 ack 前保留 processing，ack 后才删除", () => {
    const r = root(); appendEvent(event(1), r);
    const claim = claimBatch(10, r)!;
    expect(existsSync(claim.path)).toBe(true);
    expect(existsSync(join(r, "queue.jsonl"))).toBe(false);
    expect(queueSize(r)).toBe(1);
    ackBatch(claim, r);
    expect(existsSync(claim.path)).toBe(false);
    expect(queueSize(r)).toBe(0);
  });

  test("release 将合法原行原样放回，claim id 不碰撞", () => {
    const r = root(); appendEvent(event(1), r); appendEvent(event(2), r);
    const before = readyLines(r);
    const a = claimBatch(10, r)!;
    releaseBatch(a, r);
    const b = claimBatch(10, r)!;
    expect(b.id).not.toBe(a.id);
    expect(b.claimedLines).toEqual(before);
    releaseBatch(b, r);
  });

  test("maxBatch overflow 不重新序列化，ack 后原文仍在 ready", () => {
    const r = root();
    const raw = [
      ' { "source":"github", "ts":"2026-01-01T00:00:00Z", "payload":{"n":1} } ',
      '{"payload":{"n":2},"ts":"2026-01-01T00:00:01Z","source":"github"}',
    ];
    writeFileSync(join(r, "queue.jsonl"), raw.join("\n") + "\n");
    const claim = claimBatch(1, r)!;
    expect(claim.claimedLines).toEqual([raw[0]]);
    expect(claim.overflowLines).toEqual([raw[1]]);
    ackBatch(claim, r);
    expect(readyLines(r)).toEqual([raw[1]]);
  });

  test("坏行隔离到 quarantine，不静默混回队列", () => {
    const r = root();
    writeFileSync(join(r, "queue.jsonl"), '{bad}\n{"source":"github","ts":"x","payload":1}\n');
    const claim = claimBatch(10, r)!;
    expect(claim.events).toHaveLength(1);
    ackBatch(claim, r);
    const q = readFileSync(join(r, "quarantine", "queue-invalid.jsonl"), "utf8");
    expect(q).toContain('"raw":"{bad}"');
    expect(queueSize(r)).toBe(0);
  });

  test("daemon 崩溃遗留的多个 processing 全部恢复；旧事件无 id 仍兼容", () => {
    const r = root();
    const old = '{"source":"gmail","ts":"2026-01-01T00:00:00Z","payload":{"legacy":true}}';
    writeFileSync(join(r, "queue.processing.old-a.jsonl"), old + "\n");
    writeFileSync(join(r, "queue.processing.old-b.jsonl"), JSON.stringify(event(2)) + "\n");
    expect(queueSize(r)).toBe(2);
    expect(recoverClaims(r)).toBe(2);
    expect(readdirSync(r).filter((f) => f.startsWith("queue.processing"))).toEqual([]);
    expect(readyLines(r)[0]).toBe(old);
    const claim = claimBatch(10, r)!;
    expect(claim.events[0].id).toBeUndefined();
    releaseBatch(claim, r);
  });

  test("恢复时坏行隔离、合法行保留", () => {
    const r = root();
    writeFileSync(join(r, "queue.processing.crash.jsonl"), "nope\n" + JSON.stringify(event(3)) + "\n");
    expect(recoverClaims(r)).toBe(1);
    expect(readyLines(r)).toHaveLength(1);
    expect(readFileSync(join(r, "quarantine", "queue-invalid.jsonl"), "utf8")).toContain("nope");
  });

  test("单个 processing 读取失败时保留现场并继续恢复其余文件", () => {
    const r = root();
    // 名字匹配 processing，但实际是目录，readFileSync 会失败；它必须留在原地。
    const { mkdirSync } = require("fs") as typeof import("fs");
    mkdirSync(join(r, "queue.processing.aaa-bad.jsonl"));
    writeFileSync(join(r, "queue.processing.zzz-good.jsonl"), JSON.stringify(event(5)) + "\n");
    expect(recoverClaims(r)).toBe(1);
    expect(existsSync(join(r, "queue.processing.aaa-bad.jsonl"))).toBe(true);
    expect(readyLines(r)).toHaveLength(1);
  });

  test("daemon 用 OWNWARD_DATA_ROOT 在启动 sources 前恢复未 ack claim", async () => {
    const r = root();
    const raw = JSON.stringify(event(4));
    writeFileSync(join(r, "queue.processing.before-restart.jsonl"), raw + "\n");
    const port = 47000 + Math.floor(Math.random() * 1000);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "daemon.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OWNWARD_TEST: "1", OWNWARD_TEST_PORT: String(port), OWNWARD_DATA_ROOT: r },
      stdout: "ignore", stderr: "pipe",
    });
    try {
      for (let i = 0; i < 50 && !existsSync(join(r, "queue.jsonl")); i++) await Bun.sleep(20);
      expect(readyLines(r)).toEqual([raw]);
      expect(readdirSync(r).filter((f) => f.startsWith("queue.processing"))).toEqual([]);
      expect(existsSync(join(r, "schema.json"))).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
