import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { routeSettings } from "./routes.ts";
import { defaultSettingsFiles } from "./routes.ts";
import { SOURCE_ROOT } from "../util.ts";
import { schemaLeafPointers } from "./schema.ts";
import { loadSettings, validateSettingsPatches } from "./service.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function files(local: unknown = {}) {
  const root = mkdtempSync(join(tmpdir(), "ownward-settings-")); roots.push(root);
  const defaultFile = join(root, "default.json"), overrideFile = join(root, "config.json");
  writeFileSync(defaultFile, readFileSync(join(import.meta.dir, "../../config.default.json"), "utf8"));
  writeFileSync(overrideFile, JSON.stringify(local));
  return { defaultFile, overrideFile };
}
function defaultLeaves(value: unknown, prefix = "", result: string[] = []): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) for (const [key, child] of Object.entries(value as Record<string, unknown>)) defaultLeaves(child, `${prefix}/${key}`, result);
  else result.push(prefix);
  return result.sort();
}

describe("settings schema and snapshot", () => {
  test("default mutation target is source checkout, never frozen CONFIG_ROOT", () => {
    expect(defaultSettingsFiles().overrideFile).toBe(join(SOURCE_ROOT, "config.json"));
    expect(readFileSync(join(import.meta.dir, "routes.ts"), "utf8")).not.toContain('join(CONFIG_ROOT, "config.json")');
  });
  test("schema covers every defaults leaf and forces top-level classification", () => {
    const f = files(), defaults = JSON.parse(readFileSync(f.defaultFile, "utf8")), { schema } = loadSettings(f);
    expect(schemaLeafPointers(schema)).toEqual(defaultLeaves(defaults));
    for (const pointer of ["/dashboard/listen", "/dispatch/defaults/dir", "/dispatch/defaults/effort", "/dispatch/defaults/model", "/dispatch/defaults/permission", "/dispatch/defaults/provider"])
      expect(schemaLeafPointers(schema)).toContain(pointer);
    expect(new Set(Object.values(schema.nodes).map((node) => node.tier))).toEqual(new Set(["public", "advanced", "internal"]));
  });

  test("legacy sources are read-compatible with canonical provenance", () => {
    const { snapshot } = loadSettings(files({ sources: { github: { enabled: true } } }));
    expect((snapshot.effective as any).connectors.github.enabled).toBeTrue();
    expect(snapshot.provenance["/connectors/github/enabled"]).toBe("legacy");
    expect((snapshot.override as any).connectors).toBeUndefined();
  });

  test("digest is stable across JSON formatting and changes with source", () => {
    const f = files({ owner: { name: "Tis" } }), first = loadSettings(f).snapshot.sourceDigest;
    writeFileSync(f.overrideFile, '{\n  "owner": { "name": "Tis" }\n}');
    expect(loadSettings(f).snapshot.sourceDigest).toBe(first);
    writeFileSync(f.overrideFile, JSON.stringify({ owner: { name: "Other" } }));
    expect(loadSettings(f).snapshot.sourceDigest).not.toBe(first);
  });

  test("redacts sensitive unknown siblings from all read responses", () => {
    const { snapshot } = loadSettings(files({ custom: { apiToken: "abc", visible: true } }));
    expect(snapshot.override).toEqual({ custom: { apiToken: "[REDACTED]", visible: true } });
  });
});

describe("validate-only patches", () => {
  test("set/remove preserve unknown siblings and arrays replace", () => {
    const f = files({ custom: { keep: 1 }, owner: { name: "old", extra: true }, vault: { workRemoteExclude: ["old"] } });
    const digest = loadSettings(f).snapshot.sourceDigest;
    const result = validateSettingsPatches({ sourceDigest: digest, patches: [
      { op: "set", path: "/owner/name", value: "new" },
      { op: "remove", path: "/owner/greeting" },
      { op: "set", path: "/vault/workRemoteExclude", value: ["a", "b"] },
    ] }, f);
    expect(result.valid).toBeTrue();
    expect(result.candidateOverride).toEqual({ custom: { keep: 1 }, owner: { name: "new", extra: true }, vault: { workRemoteExclude: ["a", "b"] } });
    expect(JSON.parse(readFileSync(f.overrideFile, "utf8")).owner.name).toBe("old");
  });

  test("requires leaf patches and marks internal leaves read-only", () => {
    const f = files({ owner: { name: "old", extra: { from: "extension" } } }), digest = loadSettings(f).snapshot.sourceDigest;
    const rejected = validateSettingsPatches({ sourceDigest: digest, patches: [
      { op: "set", path: "/owner", value: { name: "new", injected: true } },
    ] }, f);
    expect(rejected.issues).toContainEqual({ path: "/owner", code: "LEAF_REQUIRED", message: "设置只能按叶子字段修改" });
    const internal = validateSettingsPatches({ sourceDigest: digest, patches: [
      { op: "set", path: "/release/providerCanary", value: true },
    ] }, f);
    expect(internal.issues[0]?.code).toBe("READ_ONLY");
  });

  test("returns normalized no-op-free patches, redacted diff and risk", () => {
    const f = files({ owner: { name: "old" }, dashboard: { port: 4517 } }), digest = loadSettings(f).snapshot.sourceDigest;
    const result = validateSettingsPatches({ sourceDigest: digest, patches: [
      { op: "set", path: "/owner/name", value: "old" },
      { op: "set", path: "/dashboard/port", value: 4519 },
    ] }, f);
    expect(result.normalizedPatches).toEqual([{ op: "set", path: "/dashboard/port", value: 4519 }]);
    expect(result.redactedDiff).toEqual([{ path: "/dashboard/port", before: 4517, after: 4519, risk: "high" }]);
    expect(result.risk).toEqual({ level: "high", approvalRequired: true, confirmations: ["dashboard-origin-change"] });
  });

  test("rejects stale digest, legacy writes, bad types and invalid values", () => {
    const f = files(), digest = loadSettings(f).snapshot.sourceDigest;
    expect(validateSettingsPatches({ sourceDigest: "stale", patches: [] }, f).issues[0]?.code).toBe("STALE_DIGEST");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/sources/github/enabled", value: true }] }, f).issues[0]?.code).toBe("LEGACY_READ_ONLY");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/heartbeat/enabled", value: "yes" }] }, f).issues[0]?.code).toBe("TYPE");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/dashboard/port", value: 70_000 }] }, f).issues[0]?.code).toBe("VALUE");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/dashboard/listen", value: "public" }] }, f).issues[0]?.message).toContain("local 或 all");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/dispatch/defaults/provider", value: "unknown" }] }, f).issues[0]?.message).toContain("默认 Provider");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/dispatch/defaults/permission", value: "danger" }] }, f).issues[0]?.message).toContain("默认权限");
    expect(validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/dispatch/defaults/permission", value: "bypass" }] }, f).issues[0]?.message).toContain("allowFullAccess");
  });

  test("accepts dashboard listen and dispatch defaults exposed by the settings page", () => {
    const f = files(), digest = loadSettings(f).snapshot.sourceDigest;
    const result = validateSettingsPatches({ sourceDigest: digest, patches: [
      { op: "set", path: "/dashboard/listen", value: "all" },
      { op: "set", path: "/dispatch/defaults/dir", value: "~/workspace/example" },
      { op: "set", path: "/dispatch/defaults/provider", value: "codex" },
      { op: "set", path: "/dispatch/defaults/model", value: "gpt-5.6-sol" },
      { op: "set", path: "/dispatch/defaults/effort", value: "high" },
      { op: "set", path: "/dispatch/defaults/permission", value: "safe" },
    ] }, f);
    expect(result.valid).toBeTrue();
    expect(result.risk).toEqual({ level: "high", approvalRequired: true, confirmations: ["dashboard-origin-change"] });
    expect(result.normalizedPatches.map((patch) => patch.path)).toEqual([
      "/dashboard/listen",
      "/dispatch/defaults/dir",
      "/dispatch/defaults/effort",
      "/dispatch/defaults/model",
      "/dispatch/defaults/permission",
      "/dispatch/defaults/provider",
    ]);
  });

  test("rejects invalid dispatch model/effort candidates", () => {
    const check = (patches: any[]) => { const f = files(); return validateSettingsPatches({ sourceDigest: loadSettings(f).snapshot.sourceDigest, patches }, f); };
    expect(check([{ op: "set", path: "/dispatch/defaults/provider", value: "codex" }, { op: "set", path: "/dispatch/defaults/model", value: "default" }]).issues[0]?.path).toBe("/dispatch/defaults/model");
    expect(check([{ op: "set", path: "/dispatch/defaults/provider", value: "codex" }, { op: "set", path: "/dispatch/defaults/model", value: "gpt-5.6-luna" }, { op: "set", path: "/dispatch/defaults/effort", value: "ultra" }]).issues[0]?.message).toContain("组合");
    expect(check([{ op: "set", path: "/dispatch/defaults/provider", value: "codex" }, { op: "set", path: "/dispatch/defaults/model", value: "gpt-custom" }, { op: "set", path: "/dispatch/defaults/effort", value: "high" }]).valid).toBeFalse();
    expect(check([{ op: "set", path: "/dispatch/defaults/provider", value: "codex" }, { op: "set", path: "/dispatch/defaults/model", value: "gpt-custom" }]).valid).toBeTrue();
    expect(check([{ op: "set", path: "/dispatch/defaults/effort", value: "high" }]).issues[0]?.message).toContain("Provider");
    expect(check([{ op: "set", path: "/dispatch/defaults/provider", value: "claude" }, { op: "set", path: "/dispatch/defaults/effort", value: "ultra" }]).valid).toBeFalse();
  });

  test("validates the whole candidate while tolerating extension siblings", () => {
    const f = files({ heartbeat: { intervalMin: -1, extensionValue: "keep" } }), digest = loadSettings(f).snapshot.sourceDigest;
    const result = validateSettingsPatches({ sourceDigest: digest, patches: [{ op: "set", path: "/owner/name", value: "new" }] }, f);
    expect(result.valid).toBeFalse();
    expect(result.issues).toContainEqual({ path: "/heartbeat/intervalMin", code: "VALUE", message: "不能小于 0" });
    expect(result.issues.some((issue) => issue.path.includes("extensionValue"))).toBeFalse();
  });

  test("routes expose schema/effective/validate and ignore unrelated paths", async () => {
    const f = files(), digest = loadSettings(f).snapshot.sourceDigest;
    expect((await routeSettings(new Request("http://x/api/settings/schema"), new URL("http://x/api/settings/schema"), f))?.status).toBe(200);
    const response = await routeSettings(new Request("http://x/api/settings/validate", { method: "POST", body: JSON.stringify({ sourceDigest: digest, patches: [] }) }), new URL("http://x/api/settings/validate"), f);
    expect(((await response?.json()) as any).valid).toBeTrue();
    expect(await routeSettings(new Request("http://x/api/other"), new URL("http://x/api/other"), f)).toBeNull();
  });

  test("validate route uses stable status and error envelopes", async () => {
    const f = files(), digest = loadSettings(f).snapshot.sourceDigest, url = new URL("http://x/api/settings/validate");
    const call = (body: string) => routeSettings(new Request(url.toString(), { method: "POST", body }), url, f);
    const stale = await call(JSON.stringify({ sourceDigest: "stale", patches: [] }));
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toEqual({ error: { code: "STALE_DIGEST", message: "配置已变化，请刷新后重试" }, sourceDigest: digest });
    const invalid = await call(JSON.stringify({ sourceDigest: digest, patches: [{ op: "set", path: "/dashboard/port", value: 0 }] }));
    expect(invalid?.status).toBe(422);
    expect(((await invalid?.json()) as any).error.code).toBe("VALIDATION_FAILED");
    const malformed = await call("[");
    expect(malformed?.status).toBe(400);
    expect(((await malformed?.json()) as any).error.code).toBe("INVALID_REQUEST");
  });
});
