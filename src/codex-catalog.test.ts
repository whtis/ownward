import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BUILTIN_CODEX_CATALOG, codexCatalogModel, parseCodexCatalog, parseCodexConfigDefaults, readCodexCatalog, readCodexCliDefaults } from "./codex-catalog.ts";
import { assertProviderOptions, CODEX_MODEL_EFFORTS, defaultCodexModel, DEFAULT_CODEX_MODEL, isCodexModelEffortPair } from "./session-options.ts";

// 形状照抄 codex-cli 0.148 写出的 ~/.codex/models_cache.json（2026-09-05），字段裁剪到解析用到的
const level = (effort: string) => ({ effort, description: "" });
const official = (now: string) => JSON.stringify({
  fetched_at: now, etag: "x", client_version: "0.148.0",
  models: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 6, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(level), default_reasoning_level: "low", service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }], context_window: 272000, upgrade: null },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(level), default_reasoning_level: "medium", service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }], context_window: 272000, upgrade: null },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 3, supported_reasoning_levels: ["low"].map(level), default_reasoning_level: "low", service_tiers: [] },
    { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list", priority: 23, supported_reasoning_levels: ["low", "medium"].map(level), default_reasoning_level: "medium", service_tiers: [], upgrade: { model: "gpt-5.6-luna", retirement_at: "2026-08-31T19:00:00Z" } },
    { slug: "gpt-5.3-codex-spark", display_name: "GPT-5.3-Codex-Spark", visibility: "list", priority: 26, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "hyper"].map(level), default_reasoning_level: "hyper", service_tiers: [], context_window: 128000 },
    { slug: "bad slug!", visibility: "list", priority: 0, supported_reasoning_levels: [] },
  ],
});
const NOW = Date.parse("2026-09-05T12:00:00Z");

describe("codex catalog", () => {
  test("官方缓存按 priority 排序，隐藏/退役/非法条目剔除，未知深度档位丢弃、默认档回落到首个已知档", () => {
    const catalog = parseCodexCatalog(official("2026-09-05T11:00:00Z"), "/x/models_cache.json", NOW);
    expect(catalog.source).toBe("official-cache");
    expect(catalog.fetchedAt).toBe("2026-09-05T11:00:00Z");
    expect(catalog.models.map((m) => m.slug)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.3-codex-spark"]);
    expect(catalog.models[0]).toMatchObject({ displayName: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium", fast: { id: "priority", name: "Fast", description: "2x speed, increased usage" }, contextWindow: 272000 });
    expect(catalog.models[1]).toMatchObject({ defaultEffort: "low", fast: { name: "Fast" } });
    // 官方新增了 Ownward 白名单不认识的档位：不画进下拉框（Runner protocol 会拒），默认档也不能指向它
    expect(catalog.models[2]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "low", fast: null, contextWindow: 128000 });
  });

  test("退役日期未到的型号仍列出", () => {
    const catalog = parseCodexCatalog(official("2026-08-01T00:00:00Z"), "/x", Date.parse("2026-08-01T00:00:00Z"));
    expect(catalog.models.map((m) => m.slug)).toContain("gpt-5.4-mini");
  });

  test("缓存缺失或损坏时回退内置快照并说明原因，且不会抛", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-catalog-"));
    const missing = readCodexCatalog({ home, now: NOW });
    expect(missing).toMatchObject({ source: "builtin", models: BUILTIN_CODEX_CATALOG });
    expect(missing.reason).toContain("文件不存在");
    const broken = mkdtempSync(join(tmpdir(), "codex-catalog-broken-"));
    writeFileSync(join(broken, "models_cache.json"), "{not json");
    expect(readCodexCatalog({ home: broken, now: NOW }).source).toBe("builtin");
    const empty = mkdtempSync(join(tmpdir(), "codex-catalog-empty-"));
    writeFileSync(join(empty, "models_cache.json"), JSON.stringify({ models: [{ slug: "x", visibility: "hide" }] }));
    expect(readCodexCatalog({ home: empty, now: NOW })).toMatchObject({ source: "builtin", reason: expect.stringContaining("没有可列出的型号") });
  });

  test("内置快照就是 2026-09-05 的官方目录：astra 在列、gpt-5.4 已下线、各档位与官方一致", () => {
    expect(BUILTIN_CODEX_CATALOG.map((m) => m.slug)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"]);
    expect(CODEX_MODEL_EFFORTS["gpt-6-astra"]).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(CODEX_MODEL_EFFORTS["gpt-5.6-luna"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(CODEX_MODEL_EFFORTS["gpt-5.5"]).toEqual(["low", "medium", "high", "xhigh"]);
    expect(CODEX_MODEL_EFFORTS["gpt-5.4"]).toBeUndefined();
  });

  test("缓存文件变了（mtime/size）就重新解析；2 秒内不重复 stat", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-catalog-refresh-"));
    const file = join(home, "models_cache.json");
    writeFileSync(file, official("2026-09-05T10:00:00Z"));
    expect(readCodexCatalog({ home, now: NOW }).fetchedAt).toBe("2026-09-05T10:00:00Z");
    writeFileSync(file, official("2026-09-05T10:30:00Z") + "\n\n");   // 内容与大小都变
    expect(readCodexCatalog({ home, now: NOW + 1_000 }).fetchedAt).toBe("2026-09-05T10:00:00Z");   // 节流窗口内沿用
    expect(readCodexCatalog({ home, now: NOW + 5_000 }).fetchedAt).toBe("2026-09-05T10:30:00Z");
  });

  test("按 slug 查型号：官方缓存优先，缓存里没有的老型号仍认内置快照", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-catalog-lookup-"));
    writeFileSync(join(home, "models_cache.json"), official("2026-09-05T10:00:00Z"));
    expect(codexCatalogModel("gpt-6-astra", home)?.defaultEffort).toBe("medium");
    expect(codexCatalogModel("gpt-5.6-luna", home)?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);   // 缓存 fixture 没列，内置兜底
    expect(codexCatalogModel("nope", home)).toBeUndefined();
    expect(codexCatalogModel(undefined, home)).toBeUndefined();
  });

  test("Provider 侧统一校验：Codex 组合按目录、Claude 五档、未知型号带深度直接拒", () => {
    expect(isCodexModelEffortPair("gpt-6-astra", "ultra")).toBeTrue();
    expect(isCodexModelEffortPair("gpt-5.5", "ultra")).toBeFalse();
    expect(isCodexModelEffortPair("gpt-unknown", "low")).toBeFalse();
    expect(isCodexModelEffortPair("gpt-unknown", undefined)).toBeTrue();
    expect(() => assertProviderOptions("codex", "gpt-5.5", "ultra")).toThrow("组合非法");
    expect(() => assertProviderOptions("claude", "opus", "ultra")).toThrow("effort 非法");
    expect(() => assertProviderOptions("codebuddy", "hy3", "max")).not.toThrow();
    expect(() => assertProviderOptions("claude", "bad model!", undefined)).toThrow("model 非法");
  });
});

describe("Codex CLI defaults (~/.codex/config.toml)", () => {
  test("only top-level keys count, a selected profile overrides them, other tables are ignored", () => {
    expect(parseCodexConfigDefaults('service_tier = "priority"\nmodel = "gpt-6-astra"   # 顶层\nmodel_reasoning_effort = "high"\n[sandbox_workspace_write]\nmodel = "gpt-5.5"\n'))
      .toEqual({ model: "gpt-6-astra", effort: "high" });
    expect(parseCodexConfigDefaults("profile = \"deep\"\nmodel = 'gpt-5.5'\n[profiles.deep]\nmodel_reasoning_effort = \"ultra\"\n[profiles.\"other.p\"]\nmodel = \"x\"\n"))
      .toEqual({ model: "gpt-5.5", effort: "ultra" });
    expect(parseCodexConfigDefaults("# nothing here\n[notice]\nmodel = \"gpt-5.5\"\n")).toEqual({});
  });

  test("unknown models and unsupported efforts are dropped instead of sent to the CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-cli-defaults-"));
    writeFileSync(join(home, "models_cache.json"), official(new Date().toISOString()));
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
    expect(readCodexCliDefaults({ home, now: 1 })).toMatchObject({ model: "gpt-6-astra", effort: "high" });
    const bad = mkdtempSync(join(tmpdir(), "codex-cli-defaults-"));
    writeFileSync(join(bad, "models_cache.json"), official(new Date().toISOString()));
    writeFileSync(join(bad, "config.toml"), 'model = "gpt-9-imaginary"\nmodel_reasoning_effort = "high"\n');
    expect(readCodexCliDefaults({ home: bad, now: 1 })).toEqual({ file: join(bad, "config.toml") });
    const odd = mkdtempSync(join(tmpdir(), "codex-cli-defaults-"));
    writeFileSync(join(odd, "models_cache.json"), official(new Date().toISOString()));
    writeFileSync(join(odd, "config.toml"), 'model = "gpt-5.3-codex-spark"\nmodel_reasoning_effort = "ultra"\n');   // spark 只到 xhigh
    expect(readCodexCliDefaults({ home: odd, now: 1 })).toEqual({ file: join(odd, "config.toml"), model: "gpt-5.3-codex-spark" });
    expect(readCodexCliDefaults({ home: join(home, "missing"), now: 1 })).toEqual({ file: join(home, "missing", "config.toml") });
  });

  test("defaultCodexModel: CLI config first, then the caller's fallback, then the built-in default", () => {
    const saved = process.env.CODEX_HOME;
    try {
      const configured = mkdtempSync(join(tmpdir(), "codex-default-model-"));
      writeFileSync(join(configured, "config.toml"), 'model = "gpt-5.6-terra"\n');
      process.env.CODEX_HOME = configured;
      expect(defaultCodexModel("gpt-5.5")).toBe("gpt-5.6-terra");
      process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-default-model-"));
      expect(defaultCodexModel("gpt-5.5")).toBe("gpt-5.5");
      expect(defaultCodexModel()).toBe(DEFAULT_CODEX_MODEL);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    }
  });
});
