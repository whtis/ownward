import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtensionRuntime } from "./runtime.ts";
import type { VerticalManifest, VerticalContext } from "./contracts.ts";
import { ConnectorRuntime } from "../connectors/runtime.ts";
import type {
  ConnectorMigrationContext,
  ConnectorManifest,
} from "../connectors/contracts.ts";
const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "ownward-migration-gate-"));
  roots.push(value);
  return value;
};
describe("extension migration gate", () => {
  test("Vertical migration failure is diagnostic, never activates or routes, and other Vertical continues", async () => {
    const data = root(),
      bad: VerticalManifest = {
        id: "bad",
        name: "Bad",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:bad",
        routes: ["/api/verticals/bad/view"],
      },
      good: VerticalManifest = {
        id: "good",
        name: "Good",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:good",
        routes: ["/api/verticals/good/view"],
      };
    let activated = 0;
    const rt = new ExtensionRuntime({
      dataRoot: data,
      builtins: [
        {
          manifest: bad,
          load: async () => ({
            migrate() {
              throw new Error("fixture");
            },
            activate() {
              activated++;
            },
            route() {
              return Response.json({ bad: true });
            },
          }),
        },
        {
          manifest: good,
          load: async () => ({
            activate() {},
            route() {
              return Response.json({ ok: true });
            },
          }),
        },
      ],
    });
    await rt.start();
    expect(rt.statuses().find((x) => x.id === "bad")).toMatchObject({
      state: "migration_failed",
      errorCode: "VERTICAL_MIGRATION_FAILED",
    });
    expect(activated).toBe(0);
    expect(
      (
        await rt.route(
          new Request("http://x/api/verticals/bad/view"),
          new URL("http://x/api/verticals/bad/view"),
        )
      )?.status,
    ).toBe(503);
    expect(
      await (
        await rt.route(
          new Request("http://x/api/verticals/good/view"),
          new URL("http://x/api/verticals/good/view"),
        )
      )?.json(),
    ).toEqual({ ok: true });
    await rt.stop();
  });
  test("Connector migration failure disables writes/start while another Connector becomes ready", async () => {
    const data = root(),
      manifest = (id: string): ConnectorManifest => ({
        id,
        name: id,
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin",
        capabilities: ["events", "checkpoint"],
        eventNamespaces: [`${id}.inbox`],
      });
    let badStarts = 0,
      captured: ConnectorMigrationContext | undefined;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: {
        connectors: { bad: { enabled: true }, good: { enabled: true } },
      },
      builtins: [
        {
          manifest: manifest("bad"),
          load: async () => ({
            migrate(ctx) {
              captured = ctx;
              throw new Error("fixture");
            },
            start() {
              badStarts++;
            },
          }),
        },
        { manifest: manifest("good"), load: async () => ({ start() {} }) },
      ],
    });
    await rt.start();
    expect(rt.statuses().find((x) => x.id === "bad")).toMatchObject({
      state: "migration_failed",
      errorCode: "CONNECTOR_MIGRATION_FAILED",
    });
    expect(rt.statuses().find((x) => x.id === "good")?.state).toBe("ready");
    expect(badStarts).toBe(0);
    expect(() => captured!.storage.writeJson("late.json", {})).toThrow();
    try {
      captured!.storage.writeJson("late.json", {});
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTOR_CAPABILITY_REVOKED" });
    }
    await rt.stop();
  });
  test("missing migrate hook is an idempotent no-op", async () => {
    const data = root(),
      manifest: VerticalManifest = {
        id: "plain",
        name: "Plain",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:plain",
      };
    let activations = 0;
    const rt = new ExtensionRuntime({
      dataRoot: data,
      builtins: [
        {
          manifest,
          load: async () => ({
            activate() {
              activations++;
            },
          }),
        },
      ],
    });
    await rt.start();
    expect(rt.statuses()[0]?.state).toBe("ready");
    expect(activations).toBe(1);
    await rt.stop();
  });
  test("stopping a Vertical revokes captured mutating capabilities", async () => {
    const data = root();
    const manifest: VerticalManifest = {
      id: "lease",
      name: "Lease",
      version: "1.0.0",
      kernelApiVersion: 1,
      entry: "builtin:lease",
      capabilities: ["storage"],
    };
    let captured!: VerticalContext;
    const rt = new ExtensionRuntime({
      dataRoot: data,
      builtins: [
        {
          manifest,
          load: async () => ({
            activate(ctx) {
              captured = ctx;
            },
          }),
        },
      ],
    });
    await rt.start();
    await rt.stop();
    expect(() => captured.storage!.writeJson("late.json", true)).toThrow();
    expect(() => captured.scheduler.every("late", 1000, () => {})).toThrow();
  });
  test("canonical connector config wins over a conflicting legacy source", async () => {
    const data = root(),
      manifest: ConnectorManifest = {
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin",
        capabilities: ["events"],
        eventNamespaces: ["fixture.inbox"],
      };
    let starts = 0;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: {
        connectors: { fixture: { enabled: false } },
        sources: { fixture: { enabled: true } },
      },
      builtins: [
        {
          manifest,
          load: async () => ({
            start() {
              starts++;
            },
          }),
        },
      ],
    });
    await rt.start();
    expect(rt.statuses()[0]?.state).toBe("disabled");
    expect(starts).toBe(0);
    await rt.stop();
  });
  test("external child-process Hosts preserve the same migration_failed gate", async () => {
    const data = root(),
      vertical = root(),
      connector = root();
    writeFileSync(
      join(vertical, "ownward.vertical.json"),
      JSON.stringify({
        id: "external-v",
        name: "External V",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "index.ts",
        routes: ["/api/verticals/external-v/view"],
      }),
    );
    writeFileSync(
      join(vertical, "index.ts"),
      `export default {migrate(){throw new Error("migration fixture")},activate(){throw new Error("must not activate")}}`,
    );
    const vrt = new ExtensionRuntime({
      dataRoot: data,
      externalPaths: [vertical],
      config: { verticals: { "external-v": { enabled: true, trusted: true } } },
    });
    await vrt.start();
    expect(vrt.statuses()[0]).toMatchObject({
      state: "migration_failed",
      errorCode: "VERTICAL_MIGRATION_FAILED",
    });
    await vrt.stop();
    writeFileSync(
      join(connector, "ownward.connector.json"),
      JSON.stringify({
        id: "external-c",
        name: "External C",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "index.ts",
        capabilities: ["events"],
        eventNamespaces: ["external-c.inbox"],
      }),
    );
    writeFileSync(
      join(connector, "index.ts"),
      `export default {migrate(){throw new Error("migration fixture")},start(){throw new Error("must not start")}}`,
    );
    const crt = new ConnectorRuntime({
      dataRoot: data,
      externalPaths: [connector],
      config: {
        connectors: { "external-c": { enabled: true, trusted: true } },
      },
      builtins: [],
    });
    await crt.start();
    expect(crt.statuses()[0]).toMatchObject({
      state: "migration_failed",
      errorCode: "CONNECTOR_MIGRATION_FAILED",
    });
    await crt.stop();
  });
  test("external Connector migration lease cannot write after activation", async () => {
    const data = root(),
      connector = root();
    writeFileSync(
      join(connector, "ownward.connector.json"),
      JSON.stringify({
        id: "external-late",
        name: "External Late",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "index.ts",
        capabilities: ["events"],
        eventNamespaces: ["external-late.inbox"],
      }),
    );
    writeFileSync(
      join(connector, "index.ts"),
      `export default {async migrate(ctx){await ctx.storage.writeJson("state.json",{version:2});setTimeout(()=>ctx.storage.writeJson("late.json",true).catch(()=>{}),20)},start(){}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: data,
      externalPaths: [connector],
      config: {
        connectors: { "external-late": { enabled: true, trusted: true } },
      },
      builtins: [],
    });
    await rt.start();
    await Bun.sleep(80);
    expect(rt.statuses()[0]?.state).toBe("ready");
    expect(
      JSON.parse(
        readFileSync(
          join(data, "connectors/external-late/extension/state.json"),
          "utf8",
        ),
      ),
    ).toEqual({ version: 2 });
    expect(
      existsSync(join(data, "connectors/external-late/extension/late.json")),
    ).toBe(false);
    await rt.stop();
  });
});
process.on("exit", () => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
});
