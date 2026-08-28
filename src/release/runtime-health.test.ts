import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prepareConfigSnapshot } from "./config-snapshot.ts";

function unlock(path: string) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) unlock(join(path, name));
  } else if (!stat.isSymbolicLink()) chmodSync(path, 0o600);
}

test("runtime health schema probe is read-only for legacy data root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-runtime-health-")), old = process.env.OWNWARD_DATA_ROOT;
  process.env.OWNWARD_DATA_ROOT = root;
  try {
    const module = await import(`./runtime-health.ts?test=${crypto.randomUUID()}`);
    expect(module.runtimeHealth(root)).toMatchObject({ ok: true, schemaCompatible: true });
    expect(existsSync(join(root, "schema.json"))).toBe(false);
    writeFileSync(join(root,"boots.json"),JSON.stringify({pid:process.pid,generation:"generation-1"}));
    expect(module.runtimeHealth(root)).toMatchObject({pid:process.pid,generation:"generation-1"});
  } finally {
    if (old === undefined) delete process.env.OWNWARD_DATA_ROOT; else process.env.OWNWARD_DATA_ROOT = old;
    unlock(root); rmSync(root, { recursive: true, force: true });
  }
});

test("runtime health reports the immutable config snapshot digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-runtime-config-"));
  const snapshotRoot = join(root, "snapshot");
  const old = process.env.OWNWARD_CONFIG_ROOT;
  try {
    writeFileSync(join(root, "config.json"), '{"dashboard":{"port":4517}}');
    const snapshot = prepareConfigSnapshot(root, snapshotRoot);
    process.env.OWNWARD_CONFIG_ROOT = snapshotRoot;
    const module = await import(`./runtime-health.ts?config=${crypto.randomUUID()}`);
    expect(module.runtimeHealth(root)).toMatchObject({ configDigest: snapshot.id });
  } finally {
    if (old === undefined) delete process.env.OWNWARD_CONFIG_ROOT; else process.env.OWNWARD_CONFIG_ROOT = old;
    unlock(root); rmSync(root, { recursive: true, force: true });
  }
});
