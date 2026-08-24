import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { ExtensionRuntime, validateExtensionImports } from "./runtime.ts";
import { scopedStorage } from "./services.ts";
import type { VerticalManifest } from "./contracts.ts";

const packageRoot = realpathSync(resolve(import.meta.dir, "../../../examples/verticals/sample-readonly"));
const tempRoots: string[] = [];
const runtimes = new Set<ExtensionRuntime>();
const config = { verticals: { "sample-readonly": { enabled: true, trusted: true, grantedCapabilities: ["storage"] } } };
const candidate = {
  id: "candidate-example-01", type: "candidate", displayName: "候选人 A", stage: "screening",
  stageLabel: "初步沟通", headline: "示例行业 · 示例岗位", updatedAt: "2026-08-17T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.allSettled([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fresh(prefix = "ownward-sample-readonly-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function runtime(dataRoot: string, externalRoot = packageRoot, override: Record<string, unknown> = config) {
  const value = new ExtensionRuntime({ dataRoot, externalPaths: [externalRoot], config: override, routeTimeoutMs: 100 });
  runtimes.add(value);
  return value;
}

function copyPackage(): string {
  const root = join(fresh(), "sample-readonly");
  cpSync(packageRoot, root, { recursive: true });
  return root;
}

function mutateManifest(root: string, mutate: (manifest: VerticalManifest) => void) {
  const path = join(root, "ownward.vertical.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as VerticalManifest;
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

describe("external read-only Vertical sample", () => {
  test("loads as a real external Host and exposes only the anonymized namespaced DTO and asset", async () => {
    validateExtensionImports(packageRoot);
    const data = fresh();
    scopedStorage(data, "sample-readonly").writeJson("candidates.json", [candidate]);
    const rt = runtime(data);
    await rt.start();
    expect(rt.statuses()).toEqual([expect.objectContaining({ id: "sample-readonly", source: "external", state: "ready" })]);
    const response = await rt.route(new Request("http://x/api/verticals/sample-readonly/candidates"), new URL("http://x/api/verticals/sample-readonly/candidates"));
    expect(await response?.json()).toEqual({ schemaVersion: 1, candidates: [candidate] });
    expect((await rt.health())[0].report).toMatchObject({ ok: true, mode: "read-only", schemaVersion: 1, candidateCount: 1 });
    const asset = await rt.route(new Request("http://x/verticals/sample-readonly/about.txt"), new URL("http://x/verticals/sample-readonly/about.txt"));
    expect(asset?.headers.get("content-type")).toBe("text/plain");
    expect(await asset?.text()).toContain("does not");
  });

  test("is behaviorally read-only, ignores path-like query input, and rejects mutation methods", async () => {
    const data = fresh(), sentinel = join(data, "outside-secret.json");
    writeFileSync(sentinel, JSON.stringify({ secret: "must-not-leak" }));
    scopedStorage(data, "sample-readonly").writeJson("candidates.json", [candidate]);
    const before = readFileSync(join(data, "verticals/sample-readonly/candidates.json"), "utf8"), rt = runtime(data);
    await rt.start();
    const url = new URL("http://x/api/verticals/sample-readonly/candidates?path=../../outside-secret.json");
    const response = await rt.route(new Request(url.toString()), url);
    expect(await response?.text()).not.toContain("must-not-leak");
    const post = await rt.route(new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), url);
    expect(post?.status).toBe(405);
    expect(readFileSync(join(data, "verticals/sample-readonly/candidates.json"), "utf8")).toBe(before);
    expect(existsSync(sentinel)).toBeTrue();
  });

  test("has no cwd roots and root claims fail closed without an exact Kernel grant", async () => {
    const ext = copyPackage(), claimed = fresh("ownward-sample-claimed-root-");
    mutateManifest(ext, (manifest) => { manifest.roots = [claimed]; });
    const rt = runtime(fresh(), ext);
    await rt.start();
    expect(rt.statuses()[0]).toMatchObject({ state: "degraded", errorCode: "VERTICAL_ROOT_NOT_GRANTED" });
  });

  test("Vault is denied by default, sensitive scope needs policy, and notify is unavailable to the Host", async () => {
    const vaultExt = copyPackage();
    mutateManifest(vaultExt, (manifest) => { manifest.capabilities = ["storage", "vault"]; manifest.vault = { scopes: ["sample"], sensitivity: "sensitive" }; });
    const vault = runtime(fresh(), vaultExt, { verticals: { "sample-readonly": { enabled: true, trusted: true, grantedCapabilities: ["storage", "vault"], vaultScopes: ["sample"], allowSensitiveVault: false } } });
    await vault.start();
    expect(vault.statuses()[0]).toMatchObject({ state: "degraded", errorCode: "VERTICAL_CAPABILITY_UNAVAILABLE" });

    const notifyExt = copyPackage();
    mutateManifest(notifyExt, (manifest) => { manifest.capabilities = ["storage", "notify"]; });
    const notify = runtime(fresh(), notifyExt, { verticals: { "sample-readonly": { enabled: true, trusted: true, grantedCapabilities: ["storage", "notify"] } } });
    await notify.start();
    expect(notify.statuses()[0]).toMatchObject({ state: "degraded", errorCode: "VERTICAL_CAPABILITY_UNAVAILABLE" });
  });

  test("core route override and future kernel API stay diagnosable without loading code", async () => {
    for (const [change, code] of [
      [(manifest: VerticalManifest) => { manifest.routes = ["/api/tasks"]; }, "VERTICAL_ROUTE_DENIED"],
      [(manifest: VerticalManifest) => { manifest.kernelApiVersion = 2; }, "VERTICAL_KERNEL_API_INCOMPATIBLE"],
      // minKernelVersion：同一代 API 内，Vertical 要求的 Kernel 比现装的新 → 拒载。
      // 不拦的话会一路放行到调用时才抛 EXTENSION_KERNEL_METHOD_DENIED。
      [(manifest: VerticalManifest) => { manifest.minKernelVersion = "9999.0.0"; }, "VERTICAL_KERNEL_TOO_OLD"],
      [(manifest: VerticalManifest) => { manifest.minKernelVersion = "1.0"; }, "VERTICAL_MANIFEST_INVALID"],
      [(manifest: VerticalManifest) => { (manifest as any).minKernelVersion = 1; }, "VERTICAL_MANIFEST_INVALID"],
    ] as const) {
      const ext = copyPackage();
      mutateManifest(ext, change);
      const rt = runtime(fresh(), ext);
      await rt.start();
      expect(rt.statuses()[0]).toMatchObject({ state: "failed", errorCode: code });
    }
  });

  test("satisfiable minKernelVersion still loads（这道门只拦太旧的 Kernel，不拦正常情况）", async () => {
    const { KERNEL_VERSION } = await import("./contracts.ts");
    for (const required of [KERNEL_VERSION, "0.0.1"]) {
      const ext = copyPackage();
      mutateManifest(ext, (manifest) => { manifest.minKernelVersion = required; });
      const rt = runtime(fresh(), ext);
      await rt.start();
      expect(rt.statuses()[0]).toMatchObject({ id: "sample-readonly", state: "ready" });
      await rt.stop();
    }
  });

  test("config disable survives restart and never starts the external Host", async () => {
    const data = fresh(), options = { verticals: { "sample-readonly": { enabled: false, trusted: true, grantedCapabilities: ["storage"] } } };
    const first = runtime(data, packageRoot, options); await first.start();
    expect(first.statuses()[0]).toMatchObject({ state: "disabled" });
    await first.stop(); runtimes.delete(first);
    const second = runtime(data, packageRoot, options); await second.start();
    expect(second.statuses()[0]).toMatchObject({ state: "disabled" });
    expect(existsSync(join(data, "verticals/sample-readonly"))).toBeFalse();
  });

  test("in-process timeout returns 504 but does not claim Promise cancellation", async () => {
    let finished = false;
    const manifest: VerticalManifest = { id: "timeout-proof", name: "Timeout Proof", version: "1.0.0", kernelApiVersion: 1, entry: "builtin:timeout", routes: ["/api/verticals/timeout-proof/view"] };
    const rt = new ExtensionRuntime({ dataRoot: fresh(), routeTimeoutMs: 10, builtins: [{ manifest, load: async () => ({ activate() {}, async route() { await Bun.sleep(40); finished = true; return new Response("late"); } }) }] });
    runtimes.add(rt); await rt.start();
    const url = new URL("http://x/api/verticals/timeout-proof/view");
    expect((await rt.route(new Request(url.toString()), url))?.status).toBe(504);
    expect(finished).toBeFalse();
    await Bun.sleep(50);
    expect(finished).toBeTrue();
  });
});
