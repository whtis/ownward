import { describe, expect, test } from "bun:test";
import { canonicalConnectorOverlay, connectorConfig, connectorSourceSnapshot, setConnectorConfig } from "./connector-config.ts";
import { mergeDeep } from "./util.ts";

describe("canonical Connector config", () => {
  test("connectors always wins over one-release legacy sources fallback", () => {
    const config = {
      connectors: { lark: { enabled: false, pollMin: 2 }, stock: { enabled: true, watchlist: ["TSLA.US"] } },
      sources: { lark: { enabled: true, pollMin: 9 }, stock: { enabled: false, watchlist: [] } },
    };
    expect(connectorConfig(config, "lark")).toEqual({ enabled: false, pollMin: 2 });
    expect(connectorSourceSnapshot(config)).toEqual({ lark: false, github: false, gmail: false, stock: true });
    expect(connectorConfig({ sources: { github: { enabled: true } } }, "github").enabled).toBeTrue();
  });

  test("writes canonical namespace without mutating legacy source", () => {
    const config: any = { sources: { stock: { enabled: false } } };
    setConnectorConfig(config, "stock", { enabled: true });
    expect(config.connectors.stock.enabled).toBeTrue();
    expect(config.sources.stock.enabled).toBeFalse();
  });

  test("raw local provenance is resolved before defaults merge for all first-party connectors", () => {
    const defaults: any = { connectors: Object.fromEntries(["lark", "github", "gmail", "stock"].map((id) => [id, { enabled: false, pollMin: 3 }])) };
    const local: any = { sources: Object.fromEntries(["lark", "github", "gmail", "stock"].map((id) => [id, { enabled: true }])) };
    const merged = mergeDeep(defaults, canonicalConnectorOverlay(local));
    for (const id of ["lark", "github", "gmail", "stock"]) {
      expect(merged.connectors[id]).toEqual({ enabled: true, pollMin: 3 });
    }
  });

  test("explicit partial canonical object wins over legacy and still deep-merges defaults", () => {
    const defaults = { connectors: { lark: { enabled: false, pollMin: 3, groupPolicy: "unmuted" } } };
    const local = { connectors: { lark: { enabled: false } }, sources: { lark: { enabled: true, pollMin: 99 } } };
    expect(mergeDeep(defaults, canonicalConnectorOverlay(local)).connectors.lark)
      .toEqual({ enabled: false, pollMin: 3, groupPolicy: "unmuted" });
  });
});
