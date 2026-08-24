import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfigFiles } from "./util.ts";
import { migrateLegacySources } from "../scripts/config-bootstrap.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(local: unknown) {
  const root = mkdtempSync(join(tmpdir(), "ownward-config-load-")); roots.push(root);
  const defaults = join(root, "default.json"), file = join(root, "config.json");
  writeFileSync(defaults, JSON.stringify({ connectors: {
    lark: { enabled: false, pollMin: 3 }, github: { enabled: false, pollMin: 5 },
    gmail: { enabled: false, pollMin: 10 }, stock: { enabled: false, watchlist: [], checkTimes: ["09:40"] },
  } }));
  writeFileSync(file, typeof local === "string" ? local : JSON.stringify(local));
  return { defaults, file };
}

describe("config loading provenance", () => {
  test("existing sources-only install remains enabled on direct daemon restart", () => {
    const { defaults, file } = fixture({ sources: {
      lark: { enabled: true }, github: { enabled: true }, gmail: { enabled: true }, stock: { enabled: true, watchlist: ["TSLA.US"] },
    } });
    const loaded = loadConfigFiles(defaults, file);
    expect(loaded.local.connectors).toBeUndefined();
    expect(Object.values(loaded.config.connectors).every((value: any) => value.enabled === true)).toBeTrue();
    expect(loaded.config.connectors.stock).toMatchObject({ watchlist: ["TSLA.US"], checkTimes: ["09:40"] });
  });

  test("installer migration produces the same effective config", () => {
    const legacy: any = { sources: { lark: { enabled: true, pollMin: 7 }, stock: { enabled: true, watchlist: ["AAPL.US"] } } };
    const beforeFiles = fixture(legacy), before = loadConfigFiles(beforeFiles.defaults, beforeFiles.file).config;
    const migrated = structuredClone(legacy); migrateLegacySources(migrated);
    writeFileSync(beforeFiles.file, JSON.stringify(migrated));
    const after = loadConfigFiles(beforeFiles.defaults, beforeFiles.file).config;
    expect(after.connectors).toEqual(before.connectors);
  });

  test("malformed local config fails closed instead of falling back to defaults", () => {
    const { defaults, file } = fixture("{ bad json");
    expect(() => loadConfigFiles(defaults, file)).toThrow("config.json 解析失败");
  });
});
