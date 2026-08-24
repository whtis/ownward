import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectorDrillSnapshot, drillSurface } from "./connector-drill-snapshot.ts";

describe("connector drill isolation contract", () => {
  test("only explicit daemon operational files are volatile", () => {
    expect(["state.json", "logs/daemon.log", "logs/daemon-life.json", "boots.json", "daemon.pid", "connectors/github/checkpoint.json", "connectors/github/health.json"].every((path) => drillSurface(path) === "volatile")).toBeTrue();
    expect(["tasks.json", "tasks/t.log", "sessions.json", "kernel/sessions.json", "actions.json", "schema.json", "config.json", "migrations/extensions-applied.json", "runner/events.jsonl", "events/2026.jsonl", "feed.jsonl", "connectors/github/accepted-ids.jsonl"].every((path) => drillSurface(path) === "protected")).toBeTrue();
  });

  test("protected digest ignores operational churn but detects business changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-drill-snapshot-"));
    try {
      mkdirSync(join(root, "logs"));
      writeFileSync(join(root, "state.json"), "one");
      writeFileSync(join(root, "logs/daemon.log"), "one");
      writeFileSync(join(root, "tasks.json"), "[]");
      const before = connectorDrillSnapshot(root);
      writeFileSync(join(root, "state.json"), "two");
      writeFileSync(join(root, "logs/daemon.log"), "two");
      expect(connectorDrillSnapshot(root).digest).toBe(before.digest);
      writeFileSync(join(root, "tasks.json"), "[{}]");
      expect(connectorDrillSnapshot(root).digest).not.toBe(before.digest);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("shell uses source only for copy/read snapshots and writes under drill root", () => {
    const shell = readFileSync(join(import.meta.dir, "connector-drill.sh"), "utf8");
    expect(shell).toContain('rsync -a --delete --exclude \'/secrets/\' --exclude \'/secrets\' --exclude \'*.sock\' "$SOURCE_DATA/" "$BASELINE/"');
    expect(shell).toContain('OWNWARD_DATA_ROOT="$RUNTIME_COPY"');
    expect(shell).toContain('OWNWARD_DATA_ROOT="$DRILL_ROOT/fixtures"');
    expect(shell).not.toMatch(/(?:>|--workdir|OWNWARD_DATA_ROOT=)"?\$SOURCE_DATA/);
    expect(shell).not.toMatch(/(?:rm|mv|cp|touch|mkdir)\s+[^\n]*\$SOURCE_DATA/);
  });
});
