import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
    rmSync(root, { recursive: true, force: true });
  }
});
