import { describe, expect, test } from "bun:test";
import { RunnerCommandJournal, RunnerEventJournal } from "../journals.ts";
import { FakeProvider } from "./fake-provider.ts";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("FakeProvider contract", () => {
  test("确定性产生 started/delta/approval/completed 规范生命周期", () => {
    const r = mkdtempSync(join(tmpdir(), "ownward-fake-provider-"));
    try {
      const commands = new RunnerCommandJournal(r), events = new RunnerEventJournal(r);
      const command = commands.accept({ commandId: "cmd-1", kind: "start-run", runId: "run-1", sessionId: "session-1", providerId: "fake", input: "sensitive input" }, "2026-01-01T00:00:00.000Z").record;
      const fake = new FakeProvider({ deltas: ["one", "two"], approval: { requestId: "approval-1", prompt: "allow tool?" } });
      fake.events(command).forEach((e) => events.append(e));
      expect(events.readStrict().map((e) => e.type)).toEqual(["started", "delta", "delta", "approval-requested", "completed"]);
      const journal = readFileSync(join(r, "runner", "events.jsonl"), "utf8"); expect(journal).not.toContain("one"); expect(journal).not.toContain("allow tool?");
      expect(fake.events(command)).toEqual(fake.events(command));
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
  test("failed/interrupted 终态可确定配置", () => {
    const command: any = { schemaVersion: 1, commandId: "cmd-1", kind: "start-run", acceptedAt: "2026-01-01T00:00:00.000Z", runId: "run-1", sessionId: "session-1", providerId: "fake", inputRef: "inputs/" + "a".repeat(64) + ".blob", inputSha256: "a".repeat(64), inputBytes: 1 };
    expect(new FakeProvider({ terminal: "failed", reason: "test_fixture", exitCode: 9 }).events(command).at(-1)).toMatchObject({ type: "failed", reason: "test_fixture", exitCode: 9 });
    expect(new FakeProvider({ terminal: "interrupted" }).events(command).at(-1)?.type).toBe("interrupted");
  });
  test("非 test runtime 构造明确拒绝，生产源码不越界 import testing provider", () => {
    const old = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { expect(() => new FakeProvider()).toThrow("只能在 NODE_ENV=test"); } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
    const srcRoot = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    for (const entry of new Bun.Glob("**/*.ts").scanSync({ cwd: srcRoot })) {
      if (entry.startsWith("runner/testing/") || entry.endsWith(".test.ts")) continue;
      if (/(?:from\s+|import\()["'][^"']*testing\//.test(readFileSync(join(srcRoot, entry), "utf8"))) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
