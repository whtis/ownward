import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeAdditionalModels, parseHelpEfforts, parseHelpModels, probeCliHelp, resetCliHelpCache } from "./cli-catalog.ts";
import { providerCatalog } from "./provider-catalog.ts";
import { cfg } from "./util.ts";

// 照抄 2026-09-05 两家 CLI 的 help 片段
const CODEBUDDY_HELP = `Usage: codebuddy [options] [command] [prompt]
  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3-pay, minimax-m2.7, kimi-k3-2, kimi-k2.7, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash)
  --text-to-image-model <model>                    Model for text-to-image generation
  --effort <level>                                 Reasoning effort level (minimal, low, medium, high, xhigh, max)
`;
const CLAUDE_HELP = `Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'sonnet' or 'opus') or a model's full name
`;
const fakeCli = (help: string, exit = 0): string => {
  const dir = mkdtempSync(join(tmpdir(), "ownward-fake-cli-")), file = join(dir, "cli");
  writeFileSync(file, `#!/bin/sh\ncat <<'HELP'\n${help}\nHELP\nexit ${exit}\n`); chmodSync(file, 0o755); return file;
};

describe("cli catalog", () => {
  test("解析 --effort 档位与 CodeBuddy 的 Currently supported 型号；Claude help 不列型号", () => {
    expect(parseHelpEfforts(CODEBUDDY_HELP)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(parseHelpModels(CODEBUDDY_HELP)).toEqual(["hy3", "hy3-x", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3-pay", "minimax-m2.7", "kimi-k3-2", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(parseHelpEfforts(CLAUDE_HELP)).toEqual(["low", "medium", "high", "xhigh", "max"]);   // claude 的档位折到下一行
    expect(parseHelpModels(CLAUDE_HELP)).toEqual([]);
    expect(parseHelpEfforts("  --effort <level>   Effort (low, medium, high, xhigh, max)")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("probe 跑真实子进程：解析成功缓存 6 小时，失败带原因，force 重探，并发共用一次探测", async () => {
    resetCliHelpCache();
    const good = fakeCli(CODEBUDDY_HELP), bad = fakeCli("nothing useful", 2), now = Date.now();
    const [a, b] = await Promise.all([probeCliHelp([good], { now }), probeCliHelp([good], { now: now + 1 })]);
    expect(a).toMatchObject({ ok: true, models: expect.arrayContaining(["hy3-x"]), efforts: expect.arrayContaining(["minimal"]) });
    expect(b).toBe(a);                                                                                   // 并发共用 in-flight
    expect((await probeCliHelp([good], { now: now + 60_000 })).at).toBe(now);                            // 命中缓存
    expect((await probeCliHelp([good], { now: now + 7 * 3600_000 })).at).toBe(now + 7 * 3600_000);      // 过期重探
    expect(await probeCliHelp([bad], { now })).toMatchObject({ ok: false, reason: expect.stringContaining("退出码 2") });
    expect(await probeCliHelp(["/nonexistent/cli"], { now })).toMatchObject({ ok: false });
    expect((await probeCliHelp([good], { now, force: true })).at).toBe(now);
  });

  test("~/.claude.json 的 additionalModelOptionsCache 是账号额外型号的来源；坏文件当空", () => {
    const dir = mkdtempSync(join(tmpdir(), "ownward-claude-json-")), file = join(dir, ".claude.json");
    writeFileSync(file, JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable", description: "Fable 5.1 · Most capable" }, { value: "bad value!" }, { nope: 1 }] }));
    expect(claudeAdditionalModels(file)).toEqual([{ value: "claude-fable-5-1[1m]", label: "Fable", description: "Fable 5.1 · Most capable" }]);
    writeFileSync(file, "{broken"); expect(claudeAdditionalModels(file)).toEqual([]);
    expect(claudeAdditionalModels(join(dir, "missing.json"))).toEqual([]);
  });

  test("providerCatalog：CodeBuddy 未启用不探测；启用后型号/档位来自 help；Claude 档位来自 help、型号带账号额外项", async () => {
    resetCliHelpCache();
    const codebuddy = fakeCli(CODEBUDDY_HELP), claude = fakeCli("  --effort <level>   Effort level (low, medium, high, xhigh, max, hyper)");
    const prev = structuredClone(cfg.providers);
    try {
      cfg.providers = { ...cfg.providers, "claude-code": { ...cfg.providers?.["claude-code"], command: [claude] }, codebuddy: { ...cfg.providers?.codebuddy, enabled: false, command: [codebuddy] } } as any;
      let catalog = await providerCatalog();
      expect(catalog.codebuddy).toMatchObject({ source: "disabled", models: expect.arrayContaining(["hy3", "deepseek-v4-flash"]), efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] });
      expect(catalog.claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "hyper"]);   // CLI 加了档位就跟着走（Runner 那边仍按白名单拒，UI 不该先撒谎）
      expect(catalog.claude.models.slice(0, 4)).toEqual(["fable", "opus", "sonnet", "haiku"]);
      expect(["cli-help", "cli-help+account"]).toContain(catalog.claude.source);
      cfg.providers = { ...cfg.providers, codebuddy: { ...cfg.providers?.codebuddy, enabled: true, command: [codebuddy] } } as any;
      catalog = await providerCatalog();
      expect(catalog.codebuddy).toMatchObject({ source: "cli-help", models: expect.arrayContaining(["hy3-x", "glm-5.3-flash"]), efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] });
      cfg.providers = { ...cfg.providers, codebuddy: { ...cfg.providers?.codebuddy, enabled: true, command: ["/nonexistent/codebuddy"] } } as any;
      expect((await providerCatalog()).codebuddy).toMatchObject({ source: "builtin", reason: expect.any(String) });
    } finally { cfg.providers = prev; }
  });
});
