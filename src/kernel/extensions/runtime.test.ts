import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ExtensionRuntime,
  parseVerticalManifest,
  validateExtensionImports,
} from "./runtime.ts";
import { ExtensionHostClient } from "./host-client.ts";
import {
  buildVerticalContext,
  SchedulerScope,
  scopedStorage,
} from "./services.ts";
import type { VerticalManifest } from "./contracts.ts";

const roots: string[] = [];
const runtimes = new Set<ExtensionRuntime>();
afterEach(async () => {
  await Promise.allSettled([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function runtime(options: ConstructorParameters<typeof ExtensionRuntime>[0]) {
  const value = new ExtensionRuntime(options);
  runtimes.add(value);
  return value;
}
function root() {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "ownward-vertical-")));
  roots.push(r);
  return r;
}
function fixture(
  kind:
    | "ok"
    | "throw"
    | "timeout"
    | "route-throw"
    | "route-timeout"
    | "route-child-timeout"
    | "health-timeout"
    | "no-content"
    | "unhandled"
    | "ipc"
    | "stderr" = "ok",
) {
  const dir = join(root(), "extension"),
    data = join(dir, "data-root");
  mkdirSync(dir, { recursive: true });
  const manifest: VerticalManifest = {
    id: "journal",
    name: "Journal Fixture",
    version: "1.0.0",
    kernelApiVersion: 1,
    entry: "index.ts",
    capabilities: ["storage"],
    routes: ["/api/verticals/journal/view"],
  };
  writeFileSync(join(dir, "ownward.vertical.json"), JSON.stringify(manifest));
  const activate =
    kind === "throw"
      ? `throw new Error("activate boom")`
      : kind === "timeout"
        ? `await new Promise(()=>{})`
        : kind === "stderr"
          ? `context=ctx; console.error("password=private-value "+"x".repeat(20000))`
          : `context=ctx; await ctx.storage.writeJson("boot.json", {ok:true,pid:process.pid})`;
  const route =
    kind === "route-throw"
      ? `throw new Error("route boom")`
      : kind === "route-timeout"
        ? `await new Promise(()=>{})`
        : kind === "route-child-timeout"
          ? `const p=Bun.spawn(["sleep","30"]); await context.storage.writeJson("child.json",{pid:p.pid}); await new Promise(()=>{})`
          : kind === "no-content"
            ? `return new Response(null,{status:204})`
            : kind === "unhandled"
              ? `return null`
              : kind === "ipc"
                ? `const input=await arguments[0].request.json(); return new Response(JSON.stringify({seq:input.seq,payload:"r".repeat(input.seq===-1?400000:1000)}))`
                : `return new Response(JSON.stringify({ok:true}))`;
  const health =
    kind === "health-timeout"
      ? `return new Promise(()=>{})`
      : kind === "ipc"
        ? `return {ok:true,payload:context.config.payload}`
        : `return {ok:true,pid:process.pid}`;
  writeFileSync(
    join(dir, "index.ts"),
    `let context; export default { async activate(ctx){${kind === "ipc" ? `context=ctx; await ctx.storage.writeJson("large.json",{payload:"s".repeat(200000)})` : activate}}, async route(){${route}}, health(){${health}} }`,
  );
  return { dir, data, manifest };
}
const grants = {
  verticals: {
    journal: { enabled: true, trusted: true, grantedCapabilities: ["storage"] },
  },
};

describe("Vertical manifest and import boundary", () => {
  test("strict manifest rejects future API, core route and bad asset", () => {
    const base = {
      id: "x",
      name: "X",
      version: "1.0.0",
      kernelApiVersion: 1,
      entry: "index.ts",
    };
    expect(() =>
      parseVerticalManifest({ ...base, kernelApiVersion: 2 }),
    ).toThrow("Kernel API");
    expect(() =>
      parseVerticalManifest({ ...base, routes: ["/api/tasks"] }),
    ).toThrow("命名空间");
    expect(() =>
      parseVerticalManifest({
        ...base,
        assets: [{ path: "/x", file: "../secret" }],
      }),
    ).toThrow("asset");
    expect(() => parseVerticalManifest({ ...base, surprise: true })).toThrow(
      "未知字段",
    );
  });
  test("external source cannot import Kernel/Runner/private data helpers or escape root", () => {
    for (const spec of [
      "../../kernel/sessions/service.ts",
      "../../runner/client.ts",
      "../../providers/codex/adapter.ts",
      "../../paths.ts",
      "../../util.ts",
      "../../actions.ts",
      "../../dispatch.ts",
    ]) {
      const dir = join(root(), "ext");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "index.ts"),
        `import x from "${spec}"; export default x`,
      );
      expect(() => validateExtensionImports(dir), spec).toThrow(
        /import (?:越界|禁止)/,
      );
    }
    const dir = join(root(), "dynamic");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "index.ts"),
      `const target = "./other.ts"; import(target)`,
    );
    expect(() => validateExtensionImports(dir)).toThrow("动态 import");
    // node_modules 里的三方产物（pdfjs-dist 等常带计算型动态 import）不进 lint——审计对象是第一方源码
    const pkg = join(root(), "with-deps");
    mkdirSync(join(pkg, "node_modules", "some-dep"), { recursive: true });
    writeFileSync(join(pkg, "index.ts"), `import dep from "some-dep"; export default dep`);
    writeFileSync(join(pkg, "node_modules", "some-dep", "index.js"), `const w = "./worker.js"; import(w);`);
    expect(() => validateExtensionImports(pkg)).not.toThrow();
  });
  test("trusted bare dependencies warn instead of failing and explicit JSON imports work", () => {
    const dir = join(root(), "trusted");
    mkdirSync(dir);
    writeFileSync(join(dir, "data.json"), "{}");
    writeFileSync(
      join(dir, "index.ts"),
      `import pkg from "third-party"; import data from "./data.json"; export default [pkg,data]`,
    );
    const warnings: string[] = [];
    expect(() =>
      validateExtensionImports(dir, (warning) => warnings.push(warning)),
    ).not.toThrow();
    expect(warnings).toEqual([expect.stringContaining("third-party")]);
  });
  test("server Host/Origin/CSRF checks execute before any Vertical route", () => {
    const server = readFileSync(
        join(import.meta.dir, "../../server.ts"),
        "utf8",
      ),
      route = server.indexOf("const vr = await routeVerticals");
    expect(server.indexOf('new Response("invalid host"')).toBeLessThan(route);
    expect(server.indexOf('new Response("csrf blocked"')).toBeLessThan(route);
  });
});

describe("Extension runtime lifecycle and recovery", () => {
  test("disabled builtin never activates, schedules, or routes", async () => {
    let activates = 0,
      routes = 0;
    const manifest: VerticalManifest = {
        id: "sample",
        name: "Sample",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:sample",
        capabilities: ["scheduler"],
        routes: ["/api/verticals/sample/view"],
      },
      rt = runtime({
        dataRoot: root(),
        config: { verticals: { sample: { enabled: false } } },
        builtins: [
          {
            manifest,
            load: async () => ({
              activate() {
                activates++;
              },
              route() {
                routes++;
                return new Response("bad");
              },
            }),
          },
        ],
      });
    await rt.start();
    expect(rt.statuses()[0].state).toBe("disabled");
    expect(
      await rt.route(
        new Request("http://x/api/verticals/sample/view"),
        new URL("http://x/api/verticals/sample/view"),
      ),
    ).toBeNull();
    expect({ activates, routes }).toEqual({ activates: 0, routes: 0 });
  });
  test("disabled builtin legacy domain routes return an explicit 503", async () => {
    const manifest: VerticalManifest = {
        id: "dev",
        name: "Development",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:dev",
      },
      rt = runtime({
        dataRoot: root(),
        config: { verticals: { dev: { enabled: false } } },
        builtins: [
          {
            manifest,
            legacyRoutes: ["/api/work", "/api/cc-hook"],
            load: async () => {
              throw new Error("must not load");
            },
          },
        ],
      });
    await rt.start();
    for (const path of ["/api/work", "/api/cc-hook"]) {
      const response = await rt.route(
        new Request(`http://x${path}`),
        new URL(`http://x${path}`),
      );
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({
        ok: false,
        code: "VERTICAL_DISABLED",
        vertical: "dev",
      });
    }
  });
  test("loads explicit absolute fixture, exposes health and scoped storage", async () => {
    const f = fixture(),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
        routeTimeoutMs: 50,
      });
    await rt.start();
    expect(rt.statuses()[0].state).toBe("ready");
    const boot = JSON.parse(
      readFileSync(join(f.data, "verticals/journal/boot.json"), "utf8"),
    );
    expect(boot.ok).toBeTrue();
    expect(boot.pid).not.toBe(process.pid);
    const response = await rt.route(
      new Request("http://x/api/verticals/journal/view"),
      new URL("http://x/api/verticals/journal/view"),
    );
    expect(response?.status).toBe(200);
    const report = (await rt.health())[0].report!;
    expect(report.ok).toBeTrue();
    expect(report.pid).toBe(boot.pid);
    await rt.stop();
  });
  test("disabled state survives runtime restart and never imports module", async () => {
    const f = fixture(),
      options = {
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: {
          verticals: {
            journal: {
              enabled: false,
              trusted: true,
              grantedCapabilities: ["storage"],
            },
          },
        },
      };
    const one = runtime(options);
    await one.start();
    expect(one.statuses()[0].state).toBe("disabled");
    expect(() =>
      readFileSync(join(f.data, "verticals/journal/boot.json")),
    ).toThrow();
    const two = runtime(options);
    await two.start();
    expect(two.statuses()[0].state).toBe("disabled");
  });
  test.each([
    ["throw", "EXTENSION_HOST_ERROR"],
    ["timeout", "EXTENSION_HOST_TIMEOUT"],
  ] as const)("activate %s is isolated", async (kind, code) => {
    const f = fixture(kind),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
        activateTimeoutMs: 20,
      });
    await rt.start();
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: code,
    });
  });
  test.each([
    ["route-throw", 502, "ready"],
    ["route-timeout", 504, "degraded"],
  ] as const)("route %s is bounded", async (kind, status, state) => {
    const f = fixture(kind),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
        routeTimeoutMs: 20,
      });
    await rt.start();
    const response = await rt.route(
      new Request("http://x/api/verticals/journal/view"),
      new URL("http://x/api/verticals/journal/view"),
    );
    expect(response?.status).toBe(status);
    expect(rt.statuses()[0].state).toBe(state);
  });
  test("bad manifest and relative configured path remain diagnosable without blocking good extension", async () => {
    const good = fixture(),
      bad = join(root(), "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "ownward.vertical.json"), "{");
    const rt = runtime({
      dataRoot: good.data,
      externalPaths: ["relative", bad, good.dir],
      config: grants,
    });
    await rt.start();
    expect(rt.statuses().filter((s) => s.state === "failed")).toHaveLength(2);
    expect(
      rt.statuses().some((s) => s.id === "journal" && s.state === "ready"),
    ).toBeTrue();
    await rt.stop();
  });
  test("external capability and root claims require explicit Kernel grants", async () => {
    const f = fixture(),
      manifest = JSON.parse(
        readFileSync(join(f.dir, "ownward.vertical.json"), "utf8"),
      );
    manifest.roots = [tmpdir()];
    writeFileSync(
      join(f.dir, "ownward.vertical.json"),
      JSON.stringify(manifest),
    );
    const capabilityDenied = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: {
        verticals: {
          journal: { enabled: true, trusted: true, grantedCapabilities: [] },
        },
      },
    });
    await capabilityDenied.start();
    expect(capabilityDenied.statuses()[0].errorCode).toBe(
      "VERTICAL_CAPABILITY_NOT_GRANTED",
    );
    const rootDenied = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: grants,
    });
    await rootDenied.start();
    expect(rootDenied.statuses()[0].errorCode).toBe(
      "VERTICAL_ROOT_NOT_GRANTED",
    );
  });
  test("tasks capability without a declared root fails closed", () => {
    const manifest: VerticalManifest = {
      id: "rootless",
      name: "Rootless",
      version: "1.0.0",
      kernelApiVersion: 1,
      entry: "builtin",
      capabilities: ["tasks"],
    };
    expect(() =>
      buildVerticalContext({
        manifest,
        dataRoot: root(),
        config: {},
        taskFactory: () => ({ startWork: async () => null, list: () => [] }),
        scheduler: new SchedulerScope("rootless", () => {}),
        logger: () => {},
      }),
    ).toThrow("Task capability 必须声明 root");
  });
  test("actions capability receives only the lifecycle-scoped service supplied by Kernel", () => {
    const service = { list: () => [], open: () => false, resolve: () => false, dismiss: () => false },
      manifest: VerticalManifest = {
        id: "dev",
        name: "Dev",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin",
        capabilities: ["actions"],
      },
      ctx = buildVerticalContext({
        manifest,
        dataRoot: root(),
        config: {},
        actionFactory: (id) => {
          expect(id).toBe("dev");
          return service;
        },
        scheduler: new SchedulerScope("dev", () => {}),
        logger: () => {},
      });
    expect(ctx.actions).toBeDefined();
    expect(ctx.actions!.list()).toEqual([]);
    expect(ctx.actions!.resolve("missing", "done")).toBe(false);
    expect(Object.isFrozen(ctx)).toBeTrue();
  });
  test("external code stays discovered until enabled and explicitly trusted", async () => {
    const f = fixture(),
      absent = runtime({ dataRoot: f.data, externalPaths: [f.dir] });
    await absent.start();
    expect(absent.statuses()[0]).toMatchObject({ state: "discovered" });
    const untrusted = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: {
        verticals: {
          journal: { enabled: true, grantedCapabilities: ["storage"] },
        },
      },
    });
    await untrusted.start();
    expect(untrusted.statuses()[0]).toMatchObject({
      state: "discovered",
      errorCode: "EXTENSION_TRUST_CONFIRMATION_REQUIRED",
    });
  });
  test("external routes enforce declarations and JSON mutation bodies", async () => {
    const f = fixture(),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
      });
    await rt.start();
    expect(
      await rt.route(
        new Request("http://x/api/verticals/journal/undeclared"),
        new URL("http://x/api/verticals/journal/undeclared"),
      ),
    ).toBeNull();
    expect(
      (
        await rt.route(
          new Request("http://x/api/verticals/journal/view", {
            method: "POST",
            body: "x",
          }),
          new URL("http://x/api/verticals/journal/view"),
        )
      )?.status,
    ).toBe(415);
    await rt.stop();
  });
  test("diagnostic health timeouts do not consume route breaker budget", async () => {
    const f = fixture("health-timeout"),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
        healthTimeoutMs: 15,
      });
    await rt.start();
    for (let i = 0; i < 4; i++)
      expect((await rt.health())[0].report).toMatchObject({
        ok: false,
        code: "EXTENSION_HEALTH_UNAVAILABLE",
      });
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    await rt.stop();
  });
  test("route timeout kills the whole Host process group including descendants", async () => {
    const f = fixture("route-child-timeout"),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
        routeTimeoutMs: 40,
      });
    await rt.start();
    const response = await rt.route(
      new Request("http://x/api/verticals/journal/view"),
      new URL("http://x/api/verticals/journal/view"),
    );
    expect(response?.status).toBe(504);
    const pid = JSON.parse(
      readFileSync(join(f.data, "verticals/journal/child.json"), "utf8"),
    ).pid;
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      await Bun.sleep(20);
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBeFalse();
    await rt.stop();
  });
  test("large bidirectional frames and concurrent responses stay intact and correlated", async () => {
    const f = fixture("ipc"),
      config = {
        verticals: {
          journal: {
            enabled: true,
            trusted: true,
            grantedCapabilities: ["storage"],
            payload: "k".repeat(200000),
          },
        },
      },
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config,
        routeTimeoutMs: 3000,
        healthTimeoutMs: 3000,
      });
    await rt.start();
    expect(
      JSON.parse(
        readFileSync(join(f.data, "verticals/journal/large.json"), "utf8"),
      ).payload,
    ).toHaveLength(200000);
    expect((await rt.health())[0].report?.payload).toHaveLength(200000);
    const largeRequest = new Request("http://x/api/verticals/journal/view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: -1 }),
      }),
      large = (await (await rt.route(
        largeRequest,
        new URL(largeRequest.url),
      ))!.json()) as { payload: string };
    expect(large.payload).toHaveLength(400000);
    const responses = await Promise.all(
      Array.from({ length: 12 }, async (_, seq) => {
        const request = new Request("http://x/api/verticals/journal/view", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ seq }),
          }),
          response = await rt.route(request, new URL(request.url));
        return (await response!.json()) as { seq: number; payload: string };
      }),
    );
    expect(responses.map((value) => value.seq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
    expect(
      responses.every((value) => value.payload.length === 1000),
    ).toBeTrue();
    await rt.stop();
  });
  test("declared oversized route body is rejected before reading its stream", async () => {
    const f = fixture(),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
      });
    await rt.start();
    const request = new Request("http://x/api/verticals/journal/view", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(256 * 1024 + 1),
      },
      body: "{}",
    });
    Object.defineProperty(request, "arrayBuffer", {
      value: () => {
        throw new Error("must not read");
      },
    });
    expect((await rt.route(request, new URL(request.url)))?.status).toBe(413);
    await rt.stop();
  });
  test("non-numeric Content-Length is 400 and unhandled Host route records success", async () => {
    const f = fixture("unhandled"),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
      });
    await rt.start();
    const invalid = new Request("http://x/api/verticals/journal/view", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "nope" },
      body: "{}",
    });
    Object.defineProperty(invalid, "arrayBuffer", {
      value: () => {
        throw new Error("must not read");
      },
    });
    expect((await rt.route(invalid, new URL(invalid.url)))?.status).toBe(400);
    const item = (rt as any).loaded.get("journal");
    item.status.state = "degraded";
    item.status.errorCode = "EXTENSION_TRANSIENT";
    item.status.consecutiveFailures = 2;
    expect(
      await rt.route(
        new Request("http://x/api/verticals/journal/view"),
        new URL("http://x/api/verticals/journal/view"),
      ),
    ).toBeNull();
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    expect(rt.statuses()[0].errorCode).toBeUndefined();
  });
  test("Host disconnect rejects every pending request immediately", async () => {
    const f = fixture("health-timeout"),
      client = new ExtensionHostClient(
        f.dir,
        f.manifest,
        scopedStorage(f.data, "journal"),
        () => {},
        () => {},
      );
    await client.start({}, 2000, 2000);
    const pending = [
      client.request("health", {}, 5000, false),
      client.request("health", {}, 5000, false),
    ];
    await Bun.sleep(5);
    const started = Date.now();
    client.kill();
    const settled = await Promise.allSettled(pending);
    expect(settled.every((result) => result.status === "rejected")).toBeTrue();
    expect(Date.now() - started).toBeLessThan(500);
  });
  test("unexpected socket disconnect terminates Host and degrades runtime", async () => {
    const f = fixture(),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
      });
    await rt.start();
    const item = (rt as any).loaded.get("journal"),
      pid = JSON.parse(
        readFileSync(join(f.data, "verticals/journal/boot.json"), "utf8"),
      ).pid;
    item.host.socket.close();
    for (let i = 0; i < 50 && rt.statuses()[0].state === "ready"; i++)
      await Bun.sleep(10);
    expect(rt.statuses()[0]).toMatchObject({
      state: "degraded",
      errorCode: "EXTENSION_HOST_EXITED",
    });
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBeFalse();
  });
  test("Host stderr diagnostics are bounded and redact secret-like values", async () => {
    const f = fixture("stderr"),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
      });
    await rt.start();
    await Bun.sleep(20);
    const report = (await rt.health())[0].report as any,
      tail = String(report?.host?.stderrTail || "");
    expect(tail.length).toBeLessThanOrEqual(16 * 1024);
    expect(tail).not.toContain("private-value");
  });
  test("热重载：新代码即时生效换 host 进程；坏 manifest 不打断旧实例；内置/未知拒绝", async () => {
    const f = fixture(),
      rt = runtime({ dataRoot: f.data, externalPaths: [f.dir], config: grants });
    await rt.start();
    const url = new URL("http://x/api/verticals/journal/view");
    expect(await (await rt.route(new Request(url.toString()), url))!.json()).toEqual({ ok: true });
    const pidBefore = ((await rt.health())[0].report as any)?.pid;
    // 改 route 实现 → reload → 新逻辑生效，host 换了进程
    const source = readFileSync(join(f.dir, "index.ts"), "utf8");
    writeFileSync(join(f.dir, "index.ts"), source.replace(`JSON.stringify({ok:true})`, `JSON.stringify({ok:true,reloaded:true})`));
    const status = await rt.reload("journal");
    expect(status.state).toBe("ready");
    expect(await (await rt.route(new Request(url.toString()), url))!.json()).toEqual({ ok: true, reloaded: true });
    expect(((await rt.health())[0].report as any)?.pid).not.toBe(pidBefore);
    // 坏 manifest：reload 报错，但旧实例继续服务
    const manifestRaw = readFileSync(join(f.dir, "ownward.vertical.json"), "utf8");
    writeFileSync(join(f.dir, "ownward.vertical.json"), JSON.stringify({ ...JSON.parse(manifestRaw), id: "renamed", routes: ["/api/verticals/renamed/view"] }));
    await expect(rt.reload("journal")).rejects.toMatchObject({ code: "VERTICAL_ID_MISMATCH" });
    expect(await (await rt.route(new Request(url.toString()), url))!.json()).toEqual({ ok: true, reloaded: true });
    writeFileSync(join(f.dir, "ownward.vertical.json"), manifestRaw);
    // 未知 id
    await expect(rt.reload("nope")).rejects.toMatchObject({ code: "VERTICAL_NOT_FOUND" });
    await rt.stop();
  });
  test("assets are read in Host, reject symlinks, and dangerous MIME becomes attachment", async () => {
    const f = fixture(),
      manifest = JSON.parse(
        readFileSync(join(f.dir, "ownward.vertical.json"), "utf8"),
      );
    writeFileSync(join(f.dir, "payload.bin"), "<svg onload=alert(1)>");
    manifest.assets = [
      {
        path: "/verticals/journal/payload",
        file: "payload.bin",
        contentType: "image/svg+xml",
      },
    ];
    writeFileSync(
      join(f.dir, "ownward.vertical.json"),
      JSON.stringify(manifest),
    );
    const rt = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: grants,
    });
    await rt.start();
    const response = await rt.route(
      new Request("http://x/verticals/journal/payload"),
      new URL("http://x/verticals/journal/payload"),
    );
    expect(response?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response?.headers.get("content-disposition")).toBe("attachment");
    await rt.stop();
    const outside = join(root(), "outside.bin");
    writeFileSync(outside, "secret");
    rmSync(join(f.dir, "payload.bin"));
    symlinkSync(outside, join(f.dir, "payload.bin"));
    const rt2 = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: grants,
    });
    await rt2.start();
    expect(
      (
        await rt2.route(
          new Request("http://x/verticals/journal/payload"),
          new URL("http://x/verticals/journal/payload"),
        )
      )?.status,
    ).toBe(403);
    await rt2.stop();
  });
  test("html/css/js 页面资产 inline 渲染，带同源收紧 CSP（受信 Vertical 的前端本体）", async () => {
    const f = fixture(),
      manifest = JSON.parse(
        readFileSync(join(f.dir, "ownward.vertical.json"), "utf8"),
      );
    writeFileSync(join(f.dir, "page.html"), "<title>example</title><script src=\"/verticals/journal/page.js\"></script>");
    writeFileSync(join(f.dir, "page.js"), "console.log(1)");
    manifest.assets = [
      { path: "/verticals/journal/page.html", file: "page.html", contentType: "text/html; charset=utf-8" },
      { path: "/verticals/journal/page.js", file: "page.js", contentType: "text/javascript" },
    ];
    writeFileSync(
      join(f.dir, "ownward.vertical.json"),
      JSON.stringify(manifest),
    );
    const rt = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: grants,
    });
    await rt.start();
    for (const [path, mime] of [["page.html", "text/html; charset=utf-8"], ["page.js", "text/javascript; charset=utf-8"]] as const) {
      const response = await rt.route(
        new Request(`http://x/verticals/journal/${path}`),
        new URL(`http://x/verticals/journal/${path}`),
      );
      expect(response?.headers.get("content-type")).toBe(mime);
      expect(response?.headers.get("content-disposition")).toBe("inline");
      const csp = response?.headers.get("content-security-policy") || "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain("default-src 'none'");
    }
    await rt.stop();
  });
  test("application errors do not consume breaker and null-body statuses are valid", async () => {
    const f = fixture(),
      manifest = JSON.parse(
        readFileSync(join(f.dir, "ownward.vertical.json"), "utf8"),
      );
    manifest.assets = [
      { path: "/verticals/journal/missing", file: "missing.bin" },
    ];
    writeFileSync(
      join(f.dir, "ownward.vertical.json"),
      JSON.stringify(manifest),
    );
    const rt = runtime({
      dataRoot: f.data,
      externalPaths: [f.dir],
      config: grants,
    });
    await rt.start();
    for (let i = 0; i < 3; i++)
      expect(
        (
          await rt.route(
            new Request("http://x/verticals/journal/missing"),
            new URL("http://x/verticals/journal/missing"),
          )
        )?.status,
      ).toBe(404);
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    const n = fixture("no-content"),
      nr = runtime({
        dataRoot: n.data,
        externalPaths: [n.dir],
        config: grants,
      });
    await nr.start();
    const response = await nr.route(
      new Request("http://x/api/verticals/journal/view"),
      new URL("http://x/api/verticals/journal/view"),
    );
    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
  });
  test("builtin namespaced routes use the single configured route deadline", async () => {
    const data = root(),
      manifest: VerticalManifest = {
        id: "dev",
        name: "Dev",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:dev",
        routes: ["/api/verticals/dev/work"],
      },
      rt = runtime({
        dataRoot: data,
        routeTimeoutMs: 10,
        builtins: [
          {
            manifest,
            load: async () => ({
              activate() {},
              async route() {
                await Bun.sleep(30);
                return new Response("late");
              },
            }),
          },
        ],
      });
    await rt.start();
    const url = new URL("http://x/api/verticals/dev/work");
    expect((await rt.route(new Request(url.toString()), url))?.status).toBe(
      504,
    );
  });
  test("trusted builtin namespaced mutations share legacy no-timeout semantics", async () => {
    let effects = 0;
    const manifest: VerticalManifest = {
        id: "dev",
        name: "Dev",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:dev",
        routes: ["/api/verticals/dev/work"],
      },
      rt = runtime({
        dataRoot: root(),
        routeTimeoutMs: 5,
        builtins: [
          {
            manifest,
            legacyRoutes: ["/api/work"],
            load: async () => ({
              activate() {},
              async route() {
                await Bun.sleep(20);
                effects++;
                return new Response("done");
              },
            }),
          },
        ],
      });
    await rt.start();
    for (const path of ["/api/work", "/api/verticals/dev/work"]) {
      const url = new URL(`http://x${path}`);
      expect(
        (await rt.route(new Request(url.toString(), { method: "POST" }), url))
          ?.status,
      ).toBe(200);
    }
    expect(effects).toBe(2);
  });
  test("builtin legacy routes return 503 while starting and after fatal startup failure", async () => {
    const manifest: VerticalManifest = {
        id: "dev",
        name: "Dev",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:dev",
      },
      starting = runtime({
        dataRoot: root(),
        builtins: [
          {
            manifest,
            legacyRoutes: ["/api/work"],
            load: async () => {
              await Bun.sleep(30);
              return {
                activate() {},
                route() {
                  return new Response("ok");
                },
              };
            },
          },
        ],
      });
    starting.discover();
    const boot = starting.start(),
      url = new URL("http://x/api/work");
    expect(
      (await starting.route(new Request(url.toString()), url))?.status,
    ).toBe(503);
    await boot;
    const failed = runtime({
      dataRoot: root(),
      builtins: [
        {
          manifest,
          legacyRoutes: ["/api/work"],
          load: async () => {
            throw new Error("broken");
          },
        },
      ],
    });
    await failed.start();
    const response = await failed.route(new Request(url.toString()), url);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      ok: false,
      code: "VERTICAL_RUNTIME_ERROR",
    });
  });
  test("three slow builtin legacy routes complete each external side effect exactly once without poisoning work", async () => {
    const effects = new Map<string, number>();
    const slow = ["/api/cc-hook", "/api/cc/adopt", "/api/task/done"],
      manifest: VerticalManifest = {
        id: "dev",
        name: "Dev",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:dev",
        routes: ["/api/verticals/dev/work"],
      },
      rt = runtime({
        dataRoot: root(),
        routeTimeoutMs: 5,
        builtins: [
          {
            manifest,
            legacyRoutes: [...slow, "/api/work"],
            load: async () => ({
              activate() {},
              async route({ url }) {
                if (slow.includes(url.pathname)) {
                  await Bun.sleep(20);
                  effects.set(
                    url.pathname,
                    (effects.get(url.pathname) ?? 0) + 1,
                  );
                  return new Response("done");
                }
                return new Response("work");
              },
            }),
          },
        ],
      });
    await rt.start();
    for (const path of slow) {
      const url = new URL(`http://x${path}`);
      expect((await rt.route(new Request(url.toString()), url))?.status).toBe(
        200,
      );
    }
    expect(Object.fromEntries(effects)).toEqual(
      Object.fromEntries(slow.map((path) => [path, 1])),
    );
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    const work = new URL("http://x/api/work");
    expect((await rt.route(new Request(work.toString()), work))?.status).toBe(
      200,
    );
  });
  test("builtin legacy exceptions are 500 application errors and never trip the breaker", async () => {
    const manifest: VerticalManifest = {
        id: "dev",
        name: "Dev",
        version: "1.0.0",
        kernelApiVersion: 1,
        entry: "builtin:dev",
      },
      rt = runtime({
        dataRoot: root(),
        routeTimeoutMs: 5,
        builtins: [
          {
            manifest,
            legacyRoutes: ["/api/cc-hook", "/api/work"],
            load: async () => ({
              activate() {},
              route({ url }) {
                if (url.pathname === "/api/cc-hook") throw new Error("boom");
                return new Response("work");
              },
            }),
          },
        ],
      });
    await rt.start();
    for (let i = 0; i < 3; i++) {
      const url = new URL("http://x/api/cc-hook"),
        response = await rt.route(new Request(url.toString()), url);
      expect(response?.status).toBe(500);
      expect(await response?.json()).toEqual({
        ok: false,
        code: "VERTICAL_LEGACY_ROUTE_ERROR",
      });
    }
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
    const work = new URL("http://x/api/work");
    expect((await rt.route(new Request(work.toString()), work))?.status).toBe(
      200,
    );
  });
  test("failed breaker half-open has one starter and concurrent routes receive 503", async () => {
    const f = fixture("route-timeout"),
      rt = runtime({
        dataRoot: f.data,
        externalPaths: [f.dir],
        config: grants,
        routeTimeoutMs: 100,
        restartBaseMs: 2,
      });
    await rt.start();
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await rt.route(
            new Request("http://x/api/verticals/journal/view"),
            new URL("http://x/api/verticals/journal/view"),
          )
        )?.status,
      ).toBe(504);
      if (i < 2) await Bun.sleep(20);
    }
    expect(rt.statuses()[0].state).toBe("failed");
    writeFileSync(
      join(f.dir, "index.ts"),
      `export default {async activate(ctx){const old=await ctx.storage.readJson("starts.json");await ctx.storage.writeJson("starts.json",{count:(old?.count||0)+1});await Bun.sleep(50)},async route(){return new Response(JSON.stringify({ok:true}))}}`,
    );
    await Bun.sleep(25);
    const first = rt.route(
      new Request("http://x/api/verticals/journal/view"),
      new URL("http://x/api/verticals/journal/view"),
    );
    await Bun.sleep(5);
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () =>
        rt.route(
          new Request("http://x/api/verticals/journal/view"),
          new URL("http://x/api/verticals/journal/view"),
        ),
      ),
    );
    expect(
      concurrent.every(
        (r) => r?.status === 503 && r.headers.has("retry-after"),
      ),
    ).toBeTrue();
    expect((await first)?.status).toBe(200);
    expect(
      JSON.parse(
        readFileSync(join(f.data, "verticals/journal/starts.json"), "utf8"),
      ).count,
    ).toBe(1);
    expect(rt.statuses()[0]).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    });
  });
});

describe("Scoped storage", () => {
  test("atomic JSON storage rejects traversal and symlink", () => {
    const data = root(),
      store = scopedStorage(data, "fixture");
    store.writeJson("nested/state.json", { n: 1 });
    expect(store.readJson<{ n: number }>("nested/state.json")).toEqual({
      n: 1,
    });
    expect(() => store.writeJson("../escape.json", {})).toThrow("路径非法");
    expect(() => store.writeJson("/tmp/escape.json", {})).toThrow("路径非法");
    symlinkSync(tmpdir(), join(data, "verticals/fixture/link"));
    expect(() => store.writeJson("link/escape.json", {})).toThrow("符号链接");
  });
});

test("能力白名单与类型定义必须一致（漏一处就会让 Vertical 直接下线）", () => {
  // VerticalCapability 是 TS 类型、运行时擦除；manifest 校验只认 runtime.ts 里的 CAPABILITIES 数组。
  // 新能力必须同时加入类型与运行时白名单，否则 manifest 会被拒绝。
  const contracts = readFileSync(join(import.meta.dir, "contracts.ts"), "utf8");
  const declared = (contracts.match(/export type VerticalCapability =([^;]+);/)![1].match(/"([^"]+)"/g) || [])
    .map((s) => s.slice(1, -1)).sort();
  const runtime = readFileSync(join(import.meta.dir, "runtime.ts"), "utf8");
  const listed = (runtime.match(/const CAPABILITIES = new Set<VerticalCapability>\(\[([\s\S]*?)\]\)/)![1].match(/"([^"]+)"/g) || [])
    .map((s) => s.slice(1, -1)).sort();
  expect(listed).toEqual(declared);
  expect(listed).toContain("llm");
});
