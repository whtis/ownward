import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ConnectorRuntime,
  parseConnectorManifest,
  type BuiltinConnector,
} from "./runtime.ts";
import type {
  Connector,
  ConnectorContext,
  ConnectorEvent,
} from "./contracts.ts";
import { ConnectorStore } from "./storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(tmpdir(), "ownward-connectors-"));
  roots.push(value);
  return value;
}
function event(
  id: string,
  overrides: Partial<ConnectorEvent> = {},
): ConnectorEvent {
  return {
    id,
    namespace: "fixture.inbox",
    type: "received",
    occurredAt: "2026-08-16T00:00:00.000Z",
    payload: { subject: id },
    ...overrides,
  };
}
function builtin(
  start: (ctx: ConnectorContext) => Promise<void> | void,
  health?: () => any,
): BuiltinConnector {
  return {
    manifest: {
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      kernelApiVersion: 1,
      entry: "builtin",
      capabilities: ["events", "checkpoint"],
      eventNamespaces: ["fixture.inbox"],
      priorityEventTypes: ["card.action.trigger"],
    },
    load: async () => ({ start, health }) as Connector,
  };
}

describe("Connector Runtime", () => {
  test("strict manifest/version/namespace", () => {
    expect(() =>
      parseConnectorManifest({
        ...builtin(() => {}).manifest,
        kernelApiVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      parseConnectorManifest({
        ...builtin(() => {}).manifest,
        eventNamespaces: ["other.x"],
      }),
    ).toThrow();
    expect(parseConnectorManifest(builtin(() => {}).manifest).id).toBe(
      "fixture",
    );
  });
  test("disabled by default and source config remains compatible", async () => {
    let starts = 0;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { sources: { fixture: { enabled: false } } },
      builtins: [
        builtin(() => {
          starts++;
        }),
      ],
    });
    await rt.start();
    expect(starts).toBe(0);
    expect(rt.statuses()[0]?.state).toBe("disabled");
  });
  test("canonical config wins and targeted restart applies the new runtime config", async () => {
    let starts = 0, stops = 0;
    const config: any = { connectors: { fixture: { enabled: true, marker: "old" } }, sources: { fixture: { enabled: false } } };
    const rt = new ConnectorRuntime({
      dataRoot: root(), config,
      builtins: [{
        manifest: builtin(() => {}).manifest,
        load: async () => ({
          start(ctx: ConnectorContext) { starts++; expect(ctx.config.marker).toBe(starts === 1 ? "old" : "new"); },
          stop() { stops++; },
        }),
      }],
    });
    await rt.start();
    config.connectors.fixture.marker = "new";
    await rt.restartConnector("fixture");
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(rt.statuses()[0]?.state).toBe("ready");
    await rt.stop();
  });
  test("external connector needs enabled+trusted and runs only in dedicated host", async () => {
    const data = root(),
      ext = root();
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `export default {async start(ctx){await ctx.publish([{id:"external-1",namespace:"fixture.inbox",type:"received",occurredAt:"2026-08-16T00:00:00.000Z",payload:{safe:true}}],{version:1,cursor:"external-1",updatedAt:"2026-08-16T00:00:00.000Z"})},health(){return {hosted:true}}}`,
    );
    const untrusted = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    await untrusted.start();
    expect(untrusted.statuses()[0]).toMatchObject({
      state: "discovered",
      errorCode: "CONNECTOR_TRUST_CONFIRMATION_REQUIRED",
    });
    const trusted = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    await trusted.start();
    expect(trusted.statuses()[0]).toMatchObject({
      state: "ready",
      accepted: 1,
    });
    await trusted.probe();
    expect(await trusted.health()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: { hosted: true } }),
      ]),
    );
    await trusted.stop();
  });
  test("external context shares async checkpoint/secret/health contract", async () => {
    const ext = root(),
      data = root(),
      manifest = {
        ...builtin(() => {}).manifest,
        entry: "index.ts",
        capabilities: ["events", "checkpoint", "secrets"],
      };
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify(manifest),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `export default {async start(ctx){const checkpoint=await ctx.checkpoint();const secret=await ctx.secret("FIXTURE_TOKEN");await ctx.publish([{id:"async-contract",namespace:"fixture.inbox",type:"received",occurredAt:"2026-08-16T00:00:00.000Z",payload:{checkpoint:checkpoint?.cursor||null,secret}}]);await ctx.reportHealth({ok:false,code:"TOKEN_EXPIRED",message:"refresh required"})}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      secretResolver: (_id, ref) =>
        ref === "FIXTURE_TOKEN" ? "brokered" : undefined,
      builtins: [],
      externalPaths: [ext],
    });
    await rt.start();
    expect(
      JSON.parse(readFileSync(join(data, "queue.jsonl"), "utf8")).payload,
    ).toMatchObject({ checkpoint: null, secret: "[REDACTED]" });
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "TOKEN_EXPIRED",
      consecutiveFailures: 1,
    });
    await rt.stop();
  });
  test("external host drains a multi-frame publish burst larger than 1 MiB", async () => {
    const ext = root(),
      data = root();
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `export default {async start(ctx){const payload="x".repeat(400*1024);await Promise.all([0,1,2].map(i=>ctx.publish([{id:"large-"+i,namespace:"fixture.inbox",type:"received",occurredAt:"2026-08-16T00:00:00.000Z",payload:{value:payload}}])))},health(){return {ok:true}}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    await rt.start();
    expect(rt.statuses()[0]).toMatchObject({ state: "ready", accepted: 3 });
    expect(
      readFileSync(join(data, "queue.jsonl"), "utf8").length,
    ).toBeGreaterThan(1024 * 1024);
    await rt.probe();
    expect(rt.statuses()[0]?.state).toBe("ready");
    await rt.stop();
  });
  test("external id conflict is rejected without breaking builtin discovery", () => {
    const ext = root(),
      logs: string[] = [];
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(join(ext, "index.ts"), "export default {start(){}}");
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      builtins: [builtin(() => {})],
      externalPaths: [ext],
      log: (m) => logs.push(m),
    });
    expect(rt.discover()).toHaveLength(1);
    expect(rt.statuses()[0]?.source).toBe("builtin");
    expect(logs.join("\n")).toContain("CONNECTOR_ID_CONFLICT");
  });
  test("external health timeout does not kill host and later success restores ready", async () => {
    const ext = root();
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `let n=0;export default {start(){},async health(){if(n++===0)await Bun.sleep(80);return {ok:true}}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      healthTimeoutMs: 10,
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    await rt.start();
    await rt.probe();
    expect((await rt.health())[0]).toMatchObject({
      state: "degraded",
      detail: { errorCode: "CONNECTOR_HOST_TIMEOUT" },
    });
    await Bun.sleep(100);
    await rt.probe();
    expect((await rt.health())[0]).toMatchObject({
      state: "ready",
      detail: { ok: true },
    });
    await rt.stop();
  });
  test("health without a probe is unknown and does not manufacture success", async () => {
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [builtin(() => {})],
    });
    await rt.start();
    const before = rt.statuses()[0];
    const health = (await rt.health())[0];
    expect(health).toMatchObject({ detail: { status: "unknown" } });
    expect(rt.statuses()[0]?.lastSuccessAt).toBe(before?.lastSuccessAt);
    expect(rt.statuses()[0]?.consecutiveFailures).toBe(
      before?.consecutiveFailures,
    );
    await rt.stop();
  });
  test("probe without connector health preserves the last reported detail", async () => {
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    ctx.reportHealth({ ok: true, detail: { connected: true, source: "push" } });
    await rt.probe();
    expect((await rt.health())[0]).toMatchObject({
      detail: { connected: true, source: "push" },
    });
    await rt.stop();
  });
  test("failed probes accumulate while health reads and unrelated publish cannot clear them", async () => {
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin(
          (c) => {
            ctx = c;
          },
          () => {
            throw Object.assign(new Error("down"), { code: "FIXTURE_DOWN" });
          },
        ),
      ],
    });
    await rt.start();
    await rt.probe();
    await rt.probe();
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "FIXTURE_DOWN",
      consecutiveFailures: 2,
    });
    const before = rt.statuses()[0];
    await rt.health();
    await rt.health();
    expect(rt.statuses()[0]).toEqual(before);
    await ctx.publish([event("unrelated-ingest")]);
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "FIXTURE_DOWN",
      consecutiveFailures: 2,
      accepted: 1,
    });
    await rt.stop();
  });
  test("unexpected external host exit is supervised and restarted", async () => {
    const ext = root();
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `import{existsSync,writeFileSync}from"fs";import{join}from"path";const marker=join(import.meta.dir,"once");export default {start(){if(!existsSync(marker)){writeFileSync(marker,"1");setTimeout(()=>process.exit(9),10)}}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      restartBaseMs: 10,
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    await rt.start();
    const deadline = Date.now() + 2_000;
    let sawExit = false;
    while (Date.now() < deadline) {
      const state = rt.statuses()[0]?.state;
      if (state !== "ready") sawExit = true;
      if (sawExit && state === "ready") break;
      await Bun.sleep(10);
    }
    expect(sawExit).toBe(true);
    expect(rt.statuses()[0]?.state).toBe("ready");
    await rt.stop();
  });
  test("external crash loop counts post-start exits, backs off, and alerts once", async () => {
    const ext = root(),
      alerts: string[] = [];
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `export default {start(){setTimeout(()=>process.exit(9),5)}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      restartBaseMs: 5,
      hostStableMs: 5_000,
      onAlert: (id, code) => alerts.push(id + ":" + code),
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    await rt.start();
    const end = Date.now() + 2_000;
    while (Date.now() < end && (rt.statuses()[0]?.consecutiveFailures ?? 0) < 3)
      await Bun.sleep(10);
    expect(rt.statuses()[0]?.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(alerts).toEqual(["fixture:CONNECTOR_HOST_CRASH_LOOP"]);
    await rt.stop();
  });
  test("stop racing an external start is idempotent and leaves no restart", async () => {
    const ext = root();
    writeFileSync(
      join(ext, "ownward.connector.json"),
      JSON.stringify({ ...builtin(() => {}).manifest, entry: "index.ts" }),
    );
    writeFileSync(
      join(ext, "index.ts"),
      `export default {async start(){await Bun.sleep(500)}}`,
    );
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true, trusted: true } } },
      builtins: [],
      externalPaths: [ext],
    });
    const starting = rt.start();
    await Bun.sleep(20);
    await Promise.all([rt.stop(), rt.stop(), starting]);
    expect(rt.statuses()[0]?.state).toBe("disabled");
    await Bun.sleep(100);
    expect(rt.statuses()[0]?.state).toBe("disabled");
  });
  test("stop is a barrier across a multi-connector builtin start loop", async () => {
    let release!: () => void,
      stops = 0,
      peerStarts = 0;
    const blocked = {
        manifest: builtin(() => {}).manifest,
        load: async () => ({
          start: () => new Promise<void>((r) => (release = r)),
          stop: () => {
            stops++;
            release();
          },
        }),
      },
      peer = {
        manifest: {
          ...builtin(() => {}).manifest,
          id: "peer",
          name: "Peer",
          eventNamespaces: ["peer.inbox"],
        },
        load: async () => ({
          start: () => {
            peerStarts++;
          },
        }),
      };
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: {
        connectors: { fixture: { enabled: true }, peer: { enabled: true } },
      },
      builtins: [blocked, peer],
    });
    const starting = rt.start();
    while (!release) await Bun.sleep(1);
    await Promise.all([rt.stop(), starting]);
    expect(stops).toBe(1);
    expect(peerStarts).toBe(0);
    expect(rt.statuses().map((s) => s.state)).toEqual(["disabled", "disabled"]);
  });
  test("stable id dedupe, out-of-order accepted, checkpoint advances after publish", async () => {
    const data = root();
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    const cp = {
      version: 1 as const,
      cursor: "20",
      updatedAt: new Date().toISOString(),
    };
    expect(await ctx.publish([event("20"), event("10")], cp)).toEqual({
      accepted: 2,
      duplicates: 0,
    });
    expect(await ctx.publish([event("10")])).toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect((await ctx.checkpoint())?.cursor).toBe("20");
    expect(
      readFileSync(join(data, "queue.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(2);
  });
  test("malicious Gmail 2100 timestamp cannot poison spool ordering", async () => {
    const data = root();
    let ctx!: ConnectorContext;
    const gmail = {
      ...builtin((c) => {
        ctx = c;
      }),
      manifest: {
        ...builtin(() => {}).manifest,
        id: "gmail",
        name: "Gmail",
        eventNamespaces: ["gmail.inbox"],
      },
    };
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { gmail: { enabled: true } } },
      builtins: [gmail],
    });
    await rt.start();
    const before = Date.now();
    await ctx.publish([
      {
        id: "msg:future",
        namespace: "gmail.inbox",
        type: "message",
        occurredAt: "2100-01-01T00:00:00.000Z",
        payload: { messageId: "future" },
      },
    ]);
    const stored = JSON.parse(readFileSync(join(data, "queue.jsonl"), "utf8"));
    expect(Date.parse(stored.ts)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored.ts)).toBeLessThanOrEqual(Date.now());
    expect(stored.payload._occurredAt).toBe("2100-01-01T00:00:00.000Z");
    await rt.stop();
  });
  test("restart reconstructs dedupe from spool after crash between queue and id journal", async () => {
    const data = root();
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, "queue.jsonl"),
      JSON.stringify({
        id: "fixture:upstream-1",
        source: "fixture",
        ts: new Date().toISOString(),
        payload: {},
      }) + "\n",
    );
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    expect(await ctx.publish([event("upstream-1")])).toEqual({
      accepted: 0,
      duplicates: 1,
    });
  });
  test("corrupt checkpoint quarantines evidence, alerts, and stays degraded until success", async () => {
    const data = root(),
      alerts: string[] = [];
    mkdirSync(join(data, "connectors", "fixture"), { recursive: true });
    writeFileSync(join(data, "connectors", "fixture", "checkpoint.json"), "{");
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      onAlert: (id, code) => alerts.push(`${id}:${code}`),
      builtins: [builtin(() => {})],
    });
    await rt.start();
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "CONNECTOR_CHECKPOINT_CORRUPT",
    });
    expect(alerts).toEqual(["fixture:CONNECTOR_CHECKPOINT_CORRUPT"]);
    expect(() =>
      readFileSync(
        join(data, "connectors", "fixture", "checkpoint.json"),
        "utf8",
      ),
    ).toThrow();
    expect(
      readdirSync(join(data, "connectors", "fixture")).some((f: string) =>
        f.startsWith("checkpoint.corrupt."),
      ),
    ).toBe(true);
  });
  test("bad schema/namespace and backpressure fail closed", async () => {
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      maxPendingEvents: 1,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    await expect(ctx.publish([event("a"), event("b")])).rejects.toMatchObject({
      code: "CONNECTOR_BACKPRESSURE",
    });
    await expect(
      ctx.publish([event("x", { namespace: "evil.event" })]),
    ).rejects.toMatchObject({ code: "CONNECTOR_EVENT_INVALID" });
  });
  test("whole batch and checkpoint prevalidate before first durable append", async () => {
    const data = root();
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    await expect(
      ctx.publish([event("valid"), event("bad", { namespace: "evil.x" })]),
    ).rejects.toMatchObject({ code: "CONNECTOR_EVENT_INVALID" });
    expect(() => readFileSync(join(data, "queue.jsonl"), "utf8")).toThrow();
    await expect(
      ctx.publish([event("valid")], {
        version: 9,
        cursor: "x",
        updatedAt: new Date().toISOString(),
      } as any),
    ).rejects.toMatchObject({ code: "CONNECTOR_CHECKPOINT_INVALID" });
    expect(() => readFileSync(join(data, "queue.jsonl"), "utf8")).toThrow();
  });
  test("timeout isolates failed connector and healthy peers start", async () => {
    let peer = false;
    const slow = builtin(() => new Promise(() => {}));
    const peerBuiltin = {
      ...builtin(() => {
        peer = true;
      }),
      manifest: {
        ...builtin(() => {}).manifest,
        id: "peer",
        name: "Peer",
        eventNamespaces: ["peer.inbox"],
      },
    };
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      startTimeoutMs: 10,
      config: {
        connectors: { fixture: { enabled: true }, peer: { enabled: true } },
      },
      builtins: [slow, peerBuiltin],
    });
    await rt.start();
    expect(rt.statuses().find((x) => x.id === "fixture")?.errorCode).toBe(
      "CONNECTOR_START_TIMEOUT",
    );
    expect(peer).toBe(true);
  });
  test("builtin restart success clears stale failure and becomes healthy", async () => {
    let attempts = 0;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      restartBaseMs: 5,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin(() => {
          if (++attempts === 1)
            throw Object.assign(new Error("boot failed"), {
              code: "BOOT_FAILED",
            });
        }),
      ],
    });
    await rt.start();
    expect(rt.statuses()[0]).toMatchObject({
      state: "failed",
      errorCode: "BOOT_FAILED",
      consecutiveFailures: 1,
    });
    const end = Date.now() + 500;
    while (Date.now() < end && rt.statuses()[0]?.state !== "ready")
      await Bun.sleep(5);
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    expect(rt.statuses()[0]?.errorCode).toBeUndefined();
    expect(rt.statuses()[0]?.lastSuccessAt).toBeString();
    await rt.stop();
  });
  test("secret references require manifest capability+allowlist and logs redact bearer/json", async () => {
    const previous = process.env.FIXTURE_TOKEN;
    process.env.FIXTURE_TOKEN = "super-secret";
    let ctx!: ConnectorContext;
    const logs: string[] = [];
    try {
      const b = builtin((c) => {
        ctx = c;
        c.log(
          "auth",
          `Authorization: Bearer super-secret {\"access_token\":\"super-secret\"}`,
        );
      });
      b.manifest = {
        ...b.manifest,
        capabilities: ["events", "checkpoint", "secrets"],
      };
      const rt = new ConnectorRuntime({
        dataRoot: root(),
        config: { connectors: { fixture: { enabled: true } } },
        secretEnvAllowlist: { fixture: ["FIXTURE_TOKEN"] },
        log: (m) => logs.push(m),
        builtins: [b],
      });
      await rt.start();
      expect(await ctx.secret("FIXTURE_TOKEN")).toBe("super-secret");
      expect(await ctx.secret("OTHER_TOKEN")).toBeUndefined();
      expect(logs.join("\n")).not.toContain("super-secret");
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_TOKEN;
      else process.env.FIXTURE_TOKEN = previous;
    }
  });
  test("secret payload is redacted durably but trusted immediate projection keeps ephemeral token", async () => {
    const data = root();
    let ctx!: ConnectorContext, immediate: any;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      onEvents: (events) => {
        immediate = events[0]?.payload;
      },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    await ctx.publish([
      event("safe", {
        payload: {
          subject: "ok",
          token: "ephemeral-card-token",
          nested: { password: "nope" },
        },
      }),
    ]);
    const raw = readFileSync(join(data, "queue.jsonl"), "utf8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("ephemeral-card-token");
    expect(raw).not.toContain("nope");
    expect(immediate.token).toBe("ephemeral-card-token");
  });
  test("accepted duplicate is redelivered when the first domain projection failed", async () => {
    const data = root(),
      delivered: string[] = [];
    let ctx!: ConnectorContext,
      fail = true;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      onEvents: (events) => {
        delivered.push(...events.map((e) => e.id));
        if (fail) {
          fail = false;
          throw Object.assign(new Error("projection disk full"), {
            code: "ENOSPC",
          });
        }
      },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    await expect(
      ctx.publish([event("retry-projection")]),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await ctx.publish([event("retry-projection")])).toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(delivered).toEqual([
      "fixture:retry-projection",
      "fixture:retry-projection",
    ]);
    expect(
      readFileSync(join(data, "queue.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    await rt.stop();
  });
  test("abort on stop and health contains no config or secrets", async () => {
    let signal!: AbortSignal;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: {
        connectors: { fixture: { enabled: true, password: "hidden" } },
      },
      builtins: [
        builtin(
          (c) => {
            signal = c.signal;
          },
          () => ({ ok: true }),
        ),
      ],
    });
    await rt.start();
    await rt.stop();
    expect(signal.aborted).toBe(true);
    expect(JSON.stringify(await rt.health())).not.toContain("hidden");
  });
  test("stop revokes late publish and health details redact secret-shaped fields", async () => {
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin(
          (c) => {
            ctx = c;
          },
          () => ({ access_token: "leak", nested: { password: "leak2" } }),
        ),
      ],
    });
    await rt.start();
    await rt.probe();
    expect(JSON.stringify(await rt.health())).not.toContain("leak");
    await rt.stop();
    await expect(ctx.publish([event("late")])).rejects.toMatchObject({
      code: "CONNECTOR_CAPABILITY_REVOKED",
    });
    await expect(ctx.secret("TOKEN")).rejects.toMatchObject({
      code: "CONNECTOR_CAPABILITY_REVOKED",
    });
    await expect(ctx.reportHealth({ ok: true })).rejects.toMatchObject({
      code: "CONNECTOR_CAPABILITY_REVOKED",
    });
  });
  test("backpressure defers durably, merges duplicate checkpoint, exposes depth, then drains", async () => {
    const data = root();
    writeFileSync(
      join(data, "queue.jsonl"),
      JSON.stringify({
        source: "fixture",
        ts: new Date().toISOString(),
        payload: {},
      }) + "\n",
    );
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      maxPendingEvents: 1,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    expect(await ctx.publish([event("deferred")])).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(
      await ctx.publish([event("deferred")], {
        version: 1,
        cursor: "latest",
        updatedAt: "2026-08-16T02:00:00Z",
        metadata: { merged: "yes" },
      }),
    ).toEqual({ accepted: 0, duplicates: 1 });
    const dir = join(data, "connectors", "fixture", "pending"),
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(dir, files[0]!), "utf8")).checkpoint,
    ).toMatchObject({ cursor: "latest", metadata: { merged: "yes" } });
    expect((await rt.health())[0]).toMatchObject({ pendingDepth: 1 });
    unlinkSync(join(data, "queue.jsonl"));
    await Bun.sleep(400);
    expect(readFileSync(join(data, "queue.jsonl"), "utf8")).toContain(
      "fixture:deferred",
    );
    expect((await ctx.checkpoint())?.cursor).toBe("latest");
    await rt.stop();
  });
  test("pending is a strict FIFO barrier for later live GitHub batches", async () => {
    const data = root(),
      queue = join(data, "queue.jsonl"),
      projected: string[] = [],
      filler =
        JSON.stringify({
          source: "fixture",
          ts: new Date().toISOString(),
          payload: {},
        }) + "\n";
    writeFileSync(queue, filler + filler);
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      maxPendingEvents: 2,
      drainBaseMs: 5,
      drainMaxMs: 20,
      onEvents: (events) => {
        projected.push(...events.map((e) => e.id));
      },
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    const review = event("review", { type: "review_requested" }),
      snapshot = event("snapshot", { type: "snapshot" });
    expect(await ctx.publish([review])).toEqual({ accepted: 1, duplicates: 0 });
    unlinkSync(queue);
    expect(await ctx.publish([snapshot])).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    const dir = join(data, "connectors", "fixture", "pending");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(2);
    const end = Date.now() + 1_000;
    while (
      Date.now() < end &&
      readdirSync(dir).some((f) => f.endsWith(".json"))
    )
      await Bun.sleep(10);
    expect(projected).toEqual(["fixture:review", "fixture:snapshot"]);
    expect(
      readFileSync(queue, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual(["fixture:review", "fixture:snapshot"]);
    await rt.stop();
  });
  test("environmental drain failures retry without quarantine and alert only at stages", async () => {
    const data = root(),
      queue = join(data, "queue.jsonl"),
      alerts: string[] = [];
    writeFileSync(
      queue,
      JSON.stringify({
        source: "fixture",
        ts: new Date().toISOString(),
        payload: {},
      }) + "\n",
    );
    let ctx!: ConnectorContext,
      attempts = 0;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      maxPendingEvents: 1,
      drainBaseMs: 1,
      drainMaxMs: 5,
      beforeDrainPublish: () => {
        if (++attempts <= 6)
          throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
      },
      onAlert: (_id, code) => alerts.push(code),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    await ctx.publish([event("recoverable")]);
    unlinkSync(queue);
    const dir = join(data, "connectors", "fixture", "pending"),
      end = Date.now() + 1_000;
    while (
      Date.now() < end &&
      readdirSync(dir).some((f) => f.endsWith(".json"))
    )
      await Bun.sleep(10);
    expect(readFileSync(queue, "utf8")).toContain("fixture:recoverable");
    expect(
      readdirSync(dir).some(
        (f) => f.includes(".invalid.") || f.includes(".failed."),
      ),
    ).toBe(false);
    expect(alerts).toEqual([
      "CONNECTOR_PENDING_RETRYING_1",
      "CONNECTOR_PENDING_RETRYING_5",
    ]);
    await rt.stop();
  });
  test("schema-poison pending is diagnosed, isolated, and explicitly requeueable", async () => {
    const data = root(),
      dir = join(data, "connectors", "fixture", "pending"),
      alerts: string[] = [];
    mkdirSync(dir, { recursive: true });
    const pending = join(dir, "00000000000000000001.json");
    writeFileSync(
      pending,
      JSON.stringify({
        events: [event("poison", { namespace: "wrong.inbox" })],
      }),
    );
    const rt = new ConnectorRuntime({
      dataRoot: data,
      drainBaseMs: 1,
      drainMaxMs: 5,
      onAlert: (_id, code) => alerts.push(code),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [builtin(() => {})],
    });
    await rt.start();
    const end = Date.now() + 500;
    while (
      Date.now() < end &&
      !readdirSync(dir).some((f) => f.includes(".invalid."))
    )
      await Bun.sleep(5);
    const invalid = join(
      dir,
      readdirSync(dir).find((f) => f.includes(".invalid."))!,
    );
    expect(alerts).toContain("CONNECTOR_PENDING_INCOMPATIBLE");
    expect(readdirSync(dir).some((f) => f.includes(".failed."))).toBe(false);
    writeFileSync(invalid, JSON.stringify({ events: [event("repaired")] }));
    const store = new ConnectorStore(data, "fixture");
    expect(store.requeuePending(invalid)).toBe(pending);
    expect(store.pendingBatch()?.events[0]?.id).toBe("repaired");
    await rt.stop();
  });
  test("drain keeps pending when queue grows after its guard, then eventually appends", async () => {
    const data = root(),
      queue = join(data, "queue.jsonl");
    writeFileSync(
      queue,
      JSON.stringify({
        source: "fixture",
        ts: new Date().toISOString(),
        payload: {},
      }) + "\n",
    );
    let ctx!: ConnectorContext,
      injected = false;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      maxPendingEvents: 1,
      beforeDrainPublish: () => {
        if (!injected) {
          injected = true;
          writeFileSync(
            queue,
            JSON.stringify({
              source: "fixture",
              ts: new Date().toISOString(),
              payload: { race: true },
            }) + "\n",
          );
        }
      },
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    expect(
      await ctx.publish([event("deferred")], {
        version: 1,
        cursor: "latest",
        updatedAt: "2026-08-16T02:00:00Z",
      }),
    ).toEqual({ accepted: 1, duplicates: 0 });
    const dir = join(data, "connectors", "fixture", "pending");
    unlinkSync(queue);
    await Bun.sleep(350);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(readFileSync(queue, "utf8")).not.toContain("fixture:deferred");
    unlinkSync(queue);
    const deadline = Date.now() + 1_500;
    while (
      Date.now() < deadline &&
      readdirSync(dir).some((f) => f.endsWith(".json"))
    )
      await Bun.sleep(25);
    expect(readFileSync(queue, "utf8")).toContain("fixture:deferred");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    expect((await ctx.checkpoint())?.cursor).toBe("latest");
    await rt.stop();
  });
  test("priority control events use reserved ingress capacity", async () => {
    const data = root();
    writeFileSync(
      join(data, "queue.jsonl"),
      JSON.stringify({
        source: "fixture",
        ts: new Date().toISOString(),
        payload: {},
      }) + "\n",
    );
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      maxPendingEvents: 1,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    expect(
      await ctx.publish([event("card", { type: "card.action.trigger" })]),
    ).toEqual({ accepted: 1, duplicates: 0 });
    expect(readFileSync(join(data, "queue.jsonl"), "utf8")).toContain(
      "fixture:card",
    );
    await rt.stop();
  });
  test("priority control bypasses older normal pending so ephemeral payload is not redacted", async () => {
    const data = root(),
      queue = join(data, "queue.jsonl"),
      filler =
        JSON.stringify({
          source: "other",
          ts: new Date().toISOString(),
          payload: {},
        }) + "\n";
    writeFileSync(queue, filler + filler);
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      maxPendingEvents: 2,
      drainBaseMs: 5,
      drainMaxMs: 20,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    expect(await ctx.publish([event("normal")])).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(
      await ctx.publish([
        event("card", {
          type: "card.action.trigger",
          payload: { token: "ephemeral" },
        }),
      ]),
    ).toEqual({ accepted: 1, duplicates: 0 });
    expect(readFileSync(queue, "utf8")).toContain("fixture:card");
    expect(readFileSync(queue, "utf8")).not.toContain("ephemeral");
    const dir = join(data, "connectors", "fixture", "pending");
    expect(
      readdirSync(dir).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
    await rt.stop();
  });
  test("checkpoint merge cannot move cursor or overwrite newer metadata and corrupt pending does not block later batch", () => {
    const data = root(),
      store = new ConnectorStore(data, "fixture");
    store.saveCheckpoint({
      version: 1,
      cursor: "new",
      updatedAt: "2026-08-16T02:00:00Z",
      metadata: { keep: "new" },
    });
    store.saveCheckpoint({
      version: 1,
      cursor: "old",
      updatedAt: "2026-08-16T01:00:00Z",
      metadata: { keep: "old", extra: "retained" },
    });
    expect(store.checkpoint()).toMatchObject({
      cursor: "new",
      updatedAt: "2026-08-16T02:00:00Z",
      metadata: { keep: "new", extra: "retained" },
    });
    const dir = join(data, "connectors", "fixture", "pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), "{");
    writeFileSync(
      join(dir, "2.json"),
      JSON.stringify({ events: [event("safe")] }),
    );
    expect(store.pendingBatch()?.events[0]?.id).toBe("safe");
    expect(readdirSync(dir).some((f) => f.includes(".corrupt."))).toBe(true);
  });
  test("duplicate pending checkpoint takes metadata only from the newest timestamp", () => {
    const data = root(),
      store = new ConnectorStore(data, "fixture"),
      newer = {
        version: 1 as const,
        cursor: "new",
        updatedAt: "2026-08-16T02:00:00Z",
        metadata: { keep: "yes" },
      },
      older = {
        version: 1 as const,
        cursor: "old",
        updatedAt: "2026-08-16T01:00:00Z",
        metadata: { extra: "yes" },
      };
    store.deferBatch([event("same")], newer);
    store.deferBatch([event("same")], older);
    expect(store.pendingBatch()?.checkpoint).toEqual(newer);
    expect(store.diagnostics().pendingDepth).toBe(1);
  });
  test("singleton replacement carries the newest checkpoint with or without a new checkpoint across restart", () => {
    for (const next of [
      { version: 1 as const, cursor: "new", updatedAt: "2026-08-16T03:00:00Z" },
      undefined,
    ]) {
      const data = root(),
        store = new ConnectorStore(data, "fixture"),
        singletons = new Set(["snapshot"]),
        old = {
          version: 1 as const,
          cursor: "old",
          updatedAt: "2026-08-16T02:00:00Z",
        };
      store.deferBatch(
        [event("old", { type: "snapshot" })],
        old,
        false,
        singletons,
      );
      store.deferBatch(
        [event("replacement", { type: "snapshot" })],
        next,
        false,
        singletons,
      );
      const recovered = new ConnectorStore(data, "fixture").pendingBatch();
      expect(recovered?.events.map((e) => e.id)).toEqual(["replacement"]);
      expect(recovered?.checkpoint?.cursor).toBe(next ? "new" : "old");
    }
  });
  test("queue and accepted journals are durable before checkpoint advancement", async () => {
    const first = root();
    let ctx!: ConnectorContext,
      failQueue = true;
    const cp = {
      version: 1 as const,
      cursor: "durable",
      updatedAt: "2026-08-16T03:00:00Z",
    };
    const queueFault = new ConnectorRuntime({
      dataRoot: first,
      afterQueueDurable: () => {
        if (failQueue) {
          failQueue = false;
          throw Object.assign(new Error("crash after queue fsync"), {
            code: "EIO",
          });
        }
      },
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await queueFault.start();
    await expect(ctx.publish([event("queue-stage")], cp)).rejects.toMatchObject(
      { code: "EIO" },
    );
    expect(readFileSync(join(first, "queue.jsonl"), "utf8")).toContain(
      "fixture:queue-stage",
    );
    expect(() =>
      readFileSync(
        join(first, "connectors", "fixture", "accepted-ids.jsonl"),
        "utf8",
      ),
    ).toThrow();
    expect(await ctx.checkpoint()).toBeNull();
    await queueFault.stop();
    const second = root();
    let acceptedCtx!: ConnectorContext,
      failAccepted = true;
    const acceptedFault = new ConnectorRuntime({
      dataRoot: second,
      afterAcceptedDurable: () => {
        if (failAccepted) {
          failAccepted = false;
          throw Object.assign(new Error("crash after accepted fsync"), {
            code: "EIO",
          });
        }
      },
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          acceptedCtx = c;
        }),
      ],
    });
    await acceptedFault.start();
    await expect(
      acceptedCtx.publish([event("accepted-stage")], cp),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(
      readFileSync(
        join(second, "connectors", "fixture", "accepted-ids.jsonl"),
        "utf8",
      ),
    ).toContain("accepted-stage");
    expect(await acceptedCtx.checkpoint()).toBeNull();
    expect(await acceptedCtx.publish([event("accepted-stage")], cp)).toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect((await acceptedCtx.checkpoint())?.cursor).toBe("durable");
    await acceptedFault.stop();
  });
  test("priority publish resolves while normal projection is hung and cannot advance cursor", async () => {
    const data = root();
    let ctx!: ConnectorContext,
      release!: () => void,
      normalEntered = false;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      onEvents: async (events) => {
        if (events.some((event) => event.id === "fixture:normal")) {
          normalEntered = true;
          await new Promise<void>((resolve) => (release = resolve));
        }
      },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    const normal = ctx.publish([event("normal")], {
      version: 1,
      cursor: "normal",
      updatedAt: "2026-08-16T01:00:00Z",
    });
    while (!normalEntered) await Bun.sleep(1);
    const card = ctx.publish([event("card", { type: "card.action.trigger" })]);
    expect(await Promise.race([card, Bun.sleep(100).then(() => null)])).toEqual(
      { accepted: 1, duplicates: 0 },
    );
    await expect(
      ctx.publish([event("card-cp", { type: "card.action.trigger" })], {
        version: 1,
        cursor: "card",
        updatedAt: "2026-08-16T02:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_PRIORITY_CHECKPOINT_DENIED" });
    expect(await ctx.checkpoint()).toBeNull();
    release();
    await normal;
    expect((await ctx.checkpoint())?.cursor).toBe("normal");
    await rt.stop();
  });
  test("structured unhealthy probe stays degraded and preserves its code", async () => {
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin(
          () => {},
          () => ({
            ok: false,
            code: "FIXTURE_DISCONNECTED",
            message: "offline",
            detail: { connected: false },
          }),
        ),
      ],
    });
    await rt.start();
    await rt.probe();
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "FIXTURE_DISCONNECTED",
      errorMessage: "offline",
      consecutiveFailures: 1,
    });
    expect((await rt.health())[0]).toMatchObject({
      detail: { connected: false },
    });
    await rt.probe();
    expect(rt.statuses()[0]?.consecutiveFailures).toBe(2);
    await rt.stop();
  });
  test("priority checkpoint denial is surfaced through connector health and alert", async () => {
    let ctx!: ConnectorContext;
    const alerts: string[] = [];
    const rt = new ConnectorRuntime({
      dataRoot: root(),
      onAlert: (_id, code) => alerts.push(code),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    await expect(
      ctx.publish([event("card-alert", { type: "card.action.trigger" })], {
        version: 1,
        cursor: "bad",
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_PRIORITY_CHECKPOINT_DENIED" });
    expect(alerts).toContain("CONNECTOR_PRIORITY_CHECKPOINT_DENIED");
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "CONNECTOR_PRIORITY_CHECKPOINT_DENIED",
    });
    await rt.stop();
  });
  test("runtime checkpoint corruption rotates the live context generation without restart", async () => {
    const data = root(),
      alerts: string[] = [];
    let ctx!: ConnectorContext;
    const rt = new ConnectorRuntime({
      dataRoot: data,
      onAlert: (_id, code) => alerts.push(code),
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [
        builtin((c) => {
          ctx = c;
        }),
      ],
    });
    await rt.start();
    const firstGeneration = ctx.generation,
      dir = join(data, "connectors", "fixture");
    writeFileSync(join(dir, "checkpoint.json"), "{");
    expect(await ctx.checkpoint()).toBeNull();
    expect(ctx.generation).not.toBe(firstGeneration);
    expect(alerts).toContain("CONNECTOR_CHECKPOINT_CORRUPT");
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "CONNECTOR_CHECKPOINT_CORRUPT",
    });
    expect(
      readdirSync(dir).some((name) => name.startsWith("checkpoint.corrupt.")),
    ).toBe(true);
    await rt.stop();
  });
  test("stop then immediate start invalidates stale start and leaves exactly one live instance", async () => {
    const data = root();
    let instance = 0,
      active = 0,
      maxActive = 0,
      firstRelease!: () => void;
    const b = {
      manifest: builtin(() => {}).manifest,
      load: async () => {
        const id = ++instance;
        return {
          start: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            if (id === 1)
              await new Promise<void>((resolve) => (firstRelease = resolve));
          },
          stop: () => {
            active--;
            if (id === 1) firstRelease?.();
          },
        };
      },
    };
    const rt = new ConnectorRuntime({
      dataRoot: data,
      config: { connectors: { fixture: { enabled: true } } },
      builtins: [b],
    });
    const first = rt.start();
    while (!firstRelease) await Bun.sleep(1);
    const stopping = rt.stop(),
      second = rt.start();
    await Promise.all([first, stopping, second]);
    expect(instance).toBe(2);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);
    expect(rt.statuses()[0]).toMatchObject({ state: "ready" });
    await rt.stop();
    expect(active).toBe(0);
  });
});
