import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runExtensionMigration } from "./migration.ts";
import { scopedStorageAt } from "./services.ts";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "ownward-migration-tx-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extension migration transaction", () => {
  test("commits staging atomically and records an idempotent applied id", async () => {
    const data = root(),
      target = join(data, "verticals", "notes");
    scopedStorageAt(target).writeJson("state.json", { version: 1 });
    let calls = 0;
    const migrate = async ({ storage }: any) => {
      calls++;
      await storage.writeJson("state.json", { version: 2 });
    };
    expect(
      (
        await runExtensionMigration({
          dataRoot: data,
          kind: "vertical",
          id: "notes",
          version: "2.0.0",
          migrate,
        })
      ).applied,
    ).toBe(true);
    expect(
      scopedStorageAt(target).readJson<{ version: number }>("state.json"),
    ).toEqual({
      version: 2,
    });
    expect(
      (
        await runExtensionMigration({
          dataRoot: data,
          kind: "vertical",
          id: "notes",
          version: "2.0.0",
          migrate,
        })
      ).applied,
    ).toBe(false);
    expect(calls).toBe(1);
    expect(
      JSON.parse(
        readFileSync(join(data, "migrations/extensions-applied.json"), "utf8"),
      ).applied,
    ).toContain("vertical:notes@2.0.0");
    expect(existsSync(join(data, "backups/extensions/vertical/notes"))).toBe(
      true,
    );
  });

  test("failed hook preserves live data and revokes the captured staging lease", async () => {
    const data = root(),
      target = join(data, "connectors", "mail", "extension");
    scopedStorageAt(target).writeJson("state.json", { version: 1 });
    let held: any;
    await expect(
      runExtensionMigration({
        dataRoot: data,
        kind: "connector",
        id: "mail",
        version: "2.0.0",
        migrate: async (ctx) => {
          held = ctx.storage;
          await ctx.storage.writeJson("state.json", { version: 2 });
          throw new Error("fixture");
        },
      }),
    ).rejects.toThrow("fixture");
    expect(
      scopedStorageAt(target).readJson<{ version: number }>("state.json"),
    ).toEqual({
      version: 1,
    });
    expect(() => held.writeJson("late.json", true)).toThrow();
    try {
      held.writeJson("late.json", true);
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTOR_CAPABILITY_REVOKED" });
    }
  });

  test("fault after target swap rolls back; fault after applied recovers forward", async () => {
    const data = root(),
      target = join(data, "verticals", "desk");
    scopedStorageAt(target).writeJson("state.json", { version: 1 });
    await expect(
      runExtensionMigration({
        dataRoot: data,
        kind: "vertical",
        id: "desk",
        version: "2.0.0",
        migrate: ({ storage }) =>
          storage.writeJson("state.json", { version: 2 }),
        fault: (stage) => {
          if (stage === "after-target-swap")
            throw new Error("crash-before-applied");
        },
      }),
    ).rejects.toThrow();
    expect(
      scopedStorageAt(target).readJson<{ version: number }>("state.json"),
    ).toEqual({
      version: 1,
    });
    await expect(
      runExtensionMigration({
        dataRoot: data,
        kind: "vertical",
        id: "desk",
        version: "2.0.0",
        migrate: ({ storage }) =>
          storage.writeJson("state.json", { version: 2 }),
        fault: (stage) => {
          if (stage === "after-applied") throw new Error("crash-after-applied");
        },
      }),
    ).rejects.toThrow();
    expect(
      scopedStorageAt(target).readJson<{ version: number }>("state.json"),
    ).toEqual({
      version: 2,
    });
    expect(
      (
        await runExtensionMigration({
          dataRoot: data,
          kind: "vertical",
          id: "desk",
          version: "2.0.0",
          migrate: () => {
            throw new Error("must skip");
          },
        })
      ).applied,
    ).toBe(false);
  });

  test("corrupt, unknown and legacy applied ledgers fail closed", async () => {
    for (const body of ["{", JSON.stringify([]), JSON.stringify({ schemaVersion: 1, applied: [], unknown: true }), JSON.stringify({ schemaVersion: 2, applied: [] })]) {
      const data = root();
      writeFileSync(join(data, "migrations-placeholder"), "");
      rmSync(join(data, "migrations-placeholder"));
      const migrations = join(data, "migrations");
      mkdirSync(migrations, { recursive: true });
      writeFileSync(join(migrations, "extensions-applied.json"), body);
      let called = false;
      await expect(runExtensionMigration({ dataRoot: data, kind: "vertical", id: "strict", version: "1.0.0", migrate: () => { called = true; } })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_LEDGER_INVALID" });
      expect(called).toBe(false);
    }
  });

  test("untrusted marker paths are rejected without touching an external sentinel", async () => {
    const data = root(), outside = join(root(), "sentinel");
    writeFileSync(outside, "keep");
    const migrations = join(data, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, "vertical-evil.json"), JSON.stringify({ migrationId: "vertical:evil@1.0.0", target: outside, staging: outside, rollback: outside }));
    await expect(runExtensionMigration({ dataRoot: data, kind: "vertical", id: "evil", version: "1.0.0", migrate: () => {} })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_RECOVERY_FAILED" });
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  test("global cross-process lease runs same id once and preserves different-id ledger updates", async () => {
    const data = root(), calls = join(data, "calls.log"), child = join(import.meta.dir, "migration-crash-child.ts");
    const run = (id: string) => Bun.spawn([process.execPath, child, data, id, "1.0.0", "never", calls], { stdout: "ignore", stderr: "pipe" });
    const same = [run("same"), run("same")];
    expect(await Promise.all(same.map((proc) => proc.exited))).toEqual([0, 0]);
    expect(readFileSync(calls, "utf8").trim().split("\n").filter((id) => id === "same")).toHaveLength(1);
    const different = [run("alpha"), run("beta")];
    expect(await Promise.all(different.map((proc) => proc.exited))).toEqual([0, 0]);
    const ledger = JSON.parse(readFileSync(join(data, "migrations/extensions-applied.json"), "utf8"));
    expect(ledger.applied).toEqual(["vertical:alpha@1.0.0", "vertical:beta@1.0.0", "vertical:same@1.0.0"]);
  });

  test("real SIGKILL at each visibility boundary recovers one live store and a consistent ledger", async () => {
    const child = join(import.meta.dir, "migration-crash-child.ts");
    for (const stage of ["after-marker", "after-target-away", "after-target-swap", "after-applied"]) {
      const data = root(), calls = join(data, "calls.log"), id = `crash-${stage.replaceAll("after-", "")}`, target = join(data, "verticals", id);
      scopedStorageAt(target).writeJson("state.json", { id, version: "0.0.0" });
      const proc = Bun.spawn([process.execPath, child, data, id, "1.0.0", stage, calls], { stdout: "ignore", stderr: "ignore" });
      expect(await proc.exited).not.toBe(0);
      await runExtensionMigration({ dataRoot: data, kind: "vertical", id, version: "1.0.0", migrate: ({ storage }) => storage.writeJson("state.json", { id, version: "1.0.0" }) });
      expect(scopedStorageAt(target).readJson<{ id: string; version: string }>("state.json")).toEqual({ id, version: "1.0.0" });
      const siblings = readdirSync(join(data, "verticals")).filter((name) => name.includes(`.${id}.migration.`) || name.includes(`.${id}.rollback.`));
      expect(siblings).toEqual([]);
      const ledger = JSON.parse(readFileSync(join(data, "migrations/extensions-applied.json"), "utf8"));
      expect(ledger.applied.filter((entry: string) => entry === `vertical:${id}@1.0.0`)).toHaveLength(1);
      expect(existsSync(join(data, "migrations", `vertical-${id}.json`))).toBe(false);
    }
  });

  test("SIGKILL before atomic lock publish leaves no visible empty owner", async () => {
    const data = root(), calls = join(data, "calls.log"), child = join(import.meta.dir, "migration-crash-child.ts");
    const proc = Bun.spawn([process.execPath, child, data, "empty-lock", "1.0.0", "never", calls], { stdout: "ignore", stderr: "ignore", env: { ...process.env, OWNWARD_TEST: "1", OWNWARD_MIGRATION_LOCK_FAULT: "before-publish" } });
    expect(await proc.exited).not.toBe(0);
    const lock = join(data, "migrations/extensions.lock");
    expect(existsSync(lock)).toBe(false);
    await runExtensionMigration({ dataRoot: data, kind: "vertical", id: "empty-lock", version: "1.0.0", migrate: ({ storage }) => storage.writeJson("state.json", { ok: true }) });
    expect(existsSync(lock)).toBe(false);
  });

  test("schema-invalid old lock is quarantined but a paused valid owner past grace is never stolen", async () => {
    const data = root(), migrations = join(data, "migrations"); mkdirSync(migrations);
    const lock = join(migrations, "extensions.lock"); writeFileSync(lock, "{}", { mode: 0o600 }); const old = new Date(Date.now() - 3_000); utimesSync(lock, old, old);
    await runExtensionMigration({ dataRoot: data, kind: "vertical", id: "invalid-lock", version: "1.0.0", migrate: () => {} });
    const calls = join(data, "paused.log"), child = join(import.meta.dir, "migration-crash-child.ts"), proc = Bun.spawn([process.execPath, child, data, "paused", "1.0.0", "never", calls], { stdout: "ignore", stderr: "ignore", env: { ...process.env, OWNWARD_MIGRATION_HOOK_DELAY_MS: "2300" } });
    const deadline = Date.now() + 1_000; while (!existsSync(lock) && Date.now() < deadline) await Bun.sleep(10); expect(existsSync(lock)).toBe(true); await Bun.sleep(2050);
    const before = readFileSync(lock, "utf8"), priorTest = process.env.OWNWARD_TEST, priorTimeout = process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS; process.env.OWNWARD_TEST = "1"; process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS = "100";
    try { await expect(runExtensionMigration({ dataRoot: data, kind: "vertical", id: "contender", version: "1.0.0", migrate: () => {} })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_LOCK_TIMEOUT" }); }
    finally { process.env.OWNWARD_TEST = priorTest; process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS = priorTimeout; }
    expect(readFileSync(lock, "utf8")).toBe(before); expect(await proc.exited).toBe(0);
  });

  test("nested migration cannot become a second owner", async () => {
    const data = root(), priorTest = process.env.OWNWARD_TEST, priorTimeout = process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS; process.env.OWNWARD_TEST = "1"; process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS = "80";
    try {
      await runExtensionMigration({ dataRoot: data, kind: "vertical", id: "outer", version: "1.0.0", migrate: async () => {
        await expect(runExtensionMigration({ dataRoot: data, kind: "vertical", id: "inner", version: "1.0.0", migrate: () => {} })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_LOCK_TIMEOUT" });
      } });
    } finally { process.env.OWNWARD_TEST = priorTest; process.env.OWNWARD_MIGRATION_LOCK_TIMEOUT_MS = priorTimeout; }
    const ledger = JSON.parse(readFileSync(join(data, "migrations/extensions-applied.json"), "utf8")); expect(ledger.applied).toEqual(["vertical:outer@1.0.0"]);
  });

  test("migrations directory replacement and missing release path fail ownership closed", async () => {
    for (const mode of ["swap-dir", "remove-lock"] as const) {
      const data = root();
      await expect(runExtensionMigration({ dataRoot: data, kind: "vertical", id: mode, version: "1.0.0", migrate: () => {}, fault: (stage) => {
        if (stage !== "after-backup") return; const migrations = join(data, "migrations");
        if (mode === "swap-dir") { renameSync(migrations, join(data, "migrations-old")); mkdirSync(migrations, { mode: 0o700 }); }
        else rmSync(join(migrations, "extensions.lock"));
      } })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_LOCK_OWNERSHIP_LOST" });
    }
  });

  test("PID reuse cannot keep a stale lock when process start identity differs", async () => {
    const data = root(), migrations = join(data, "migrations"); mkdirSync(migrations);
    const lock = join(migrations, "extensions.lock");
    writeFileSync(lock, JSON.stringify({ schemaVersion: 1, token: crypto.randomUUID(), pid: process.pid, processIdentity: "previous-boot:old-start", createdAt: 1 }) + "\n", { mode: 0o600 });
    await runExtensionMigration({ dataRoot: data, kind: "vertical", id: "pid-reuse", version: "1.0.0", migrate: () => {} });
    expect(existsSync(lock)).toBe(false);
  });

  test("rejects ancestor/live/backup/staging symlinks and writable migration nodes", async () => {
    const data = root(), outside = root(), alias = join(data, "alias"); symlinkSync(outside, alias);
    await expect(runExtensionMigration({ dataRoot: join(alias, "data"), kind: "vertical", id: "ancestor", version: "1.0.0", migrate: () => {} })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_PATH_UNSAFE" });
    const liveData = root(); mkdirSync(join(liveData, "verticals")); symlinkSync(outside, join(liveData, "verticals/live-link"));
    await expect(runExtensionMigration({ dataRoot: liveData, kind: "vertical", id: "live-link", version: "1.0.0", migrate: () => {} })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_PATH_UNSAFE" });
    const modeData = root(), modeTarget = join(modeData, "verticals/mode"); mkdirSync(modeTarget, { recursive: true }); chmodSync(modeTarget, 0o770);
    await expect(runExtensionMigration({ dataRoot: modeData, kind: "vertical", id: "mode", version: "1.0.0", migrate: () => {} })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_PATH_UNSAFE" });
    for (const stage of ["after-backup", "after-staging"] as const) {
      const stagedData = root(), id = stage === "after-backup" ? "backup-link" : "staging-link";
      await expect(runExtensionMigration({ dataRoot: stagedData, kind: "vertical", id, version: "1.0.0", migrate: () => {}, fault: (at) => {
        if (at !== stage) return;
        const parent = join(stagedData, "verticals"), candidates = readdirSync(parent).filter((name) => name.startsWith(`.${id}.${stage === "after-backup" ? "never" : "migration"}.`));
        const target = stage === "after-backup" ? join(stagedData, "backups/extensions/vertical", id, readdirSync(join(stagedData, "backups/extensions/vertical", id))[0]!) : join(parent, candidates[0]!);
        rmSync(target, { recursive: true }); symlinkSync(outside, target);
      } })).rejects.toMatchObject({ code: expect.stringMatching(/^EXTENSION_MIGRATION_PATH_(?:UNSAFE|CHANGED)$/) });
    }
  });

  test("parent inode swap during hook fails before marker or destructive rename", async () => {
    const data = root(), target = join(data, "verticals/swap-parent"); scopedStorageAt(target).writeJson("state.json", { version: 1 });
    await expect(runExtensionMigration({ dataRoot: data, kind: "vertical", id: "swap-parent", version: "2.0.0", migrate: ({ storage }) => {
      storage.writeJson("state.json", { version: 2 });
      const parent = join(data, "verticals"), moved = join(data, "verticals-moved"); renameSync(parent, moved); mkdirSync(parent, { mode: 0o700 });
    } })).rejects.toMatchObject({ code: "EXTENSION_MIGRATION_PATH_CHANGED" });
    expect(existsSync(join(data, "migrations/vertical-swap-parent.json"))).toBe(false);
    expect(scopedStorageAt(join(data, "verticals-moved/swap-parent")).readJson<{ version: number }>("state.json")).toEqual({ version: 1 });
  });
});
