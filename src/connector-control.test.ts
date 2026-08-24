import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveStockConnectorConfig } from "./connector-control.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("stock Connector control", () => {
  test("POST-equivalent persists connectors, updates live config, then restarts runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-stock-control-")); roots.push(root);
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ sources: { stock: { enabled: false, watchlist: ["OLD.US"] } } }));
    const live: any = { connectors: { stock: { enabled: false, watchlist: [] } } };
    const calls: string[] = [];
    await saveStockConnectorConfig({ file, liveConfig: live, patch: { enabled: true, watchlist: [" tsla.us ", 42] }, restart: async (id) => { calls.push(`${id}:${live.connectors.stock.watchlist[0]}`); } });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.connectors.stock).toEqual({ enabled: true, watchlist: ["TSLA.US"] });
    expect(saved.sources.stock).toEqual({ enabled: false, watchlist: ["OLD.US"] });
    expect(live.connectors.stock).toEqual({ enabled: true, watchlist: ["TSLA.US"] });
    expect(calls).toEqual(["stock:TSLA.US"]);
  });
});
