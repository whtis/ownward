import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { redactHome, scanSkills } from "./scanner.ts";
import { skillEngineVersionStatus, skillRoots } from "./adapters.ts";

const temps: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "ownward-skills-")); temps.push(root); return root; }
function skill(path: string, name: string, body = "body") {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`);
}
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("skill root matrix", () => {
  test("uses injected home, CODEX_HOME and projects", () => {
    const home = fixture(), codex = join(home, "custom-codex"), project = join(home, "work", "p");
    const roots = skillRoots({ home, codexHome: codex, projectRoots: [project] });
    expect(roots.some((x) => x.path === join(home, ".claude", "skills"))).toBe(true);
    expect(roots.some((x) => x.path === join(codex, "skills", ".system") && x.protected)).toBe(true);
    expect(roots.some((x) => x.path === join(project, ".codebuddy", "skills"))).toBe(true);
    expect(roots.filter((x) => x.engine === "codex" && x.scope === "user").every((x) => x.precedenceStatus === "unknown")).toBe(true);
    expect(roots.filter((x) => x.engine === "codex" && x.scope === "user").every((x) => x.mutationCapability === "explicit-only")).toBe(true);
    expect(skillEngineVersionStatus("codex", "0.9.0").status).toBe("supported");
    expect(skillEngineVersionStatus("codex", "1.0.0").status).toBe("unsupported");
    expect(skillEngineVersionStatus("claude", null).status).toBe("unknown");
  });
});

describe("read-only inventory", () => {
  test("parses metadata, redacts home, and classifies duplicate/conflict/protected/broken", () => {
    const home = fixture();
    skill(join(home, ".claude", "skills", "same"), "same", "one");
    skill(join(home, ".agents", "skills", "same"), "same", "one");
    skill(join(home, ".codebuddy", "skills", "same"), "same", "two");
    skill(join(home, ".codex", "skills", ".system", "builtin"), "builtin");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(home, "does-not-exist"), join(home, ".claude", "skills", "broken"));
    const result = scanSkills({ home });
    expect(result.observations.every((x) => !JSON.stringify({ entryPath: x.entryPath, linkTarget: x.linkTarget, readError: x.readError }).includes(home))).toBe(true);
    expect(result.observations.find((x) => x.name === "builtin")?.findings).toContain("protected");
    expect(result.observations.some((x) => x.name === ".system" && x.ownership !== "protected")).toBe(false);
    expect(result.observations.find((x) => x.displayPath.endsWith("/broken"))?.findings).toContain("broken");
    expect(result.observations.filter((x) => x.name === "same").every((x) => x.findings.includes("conflict"))).toBe(true);
    expect(result.warnings[0]).toContain("优先级尚未确认");
  });

  test("tree digest is deterministic and does not follow symlinks", () => {
    const home = fixture(), target = join(home, "outside.txt"), path = join(home, ".claude", "skills", "linked");
    mkdirSync(path, { recursive: true }); writeFileSync(target, "first"); symlinkSync(target, join(path, "asset"));
    const first = scanSkills({ home }).observations.find((x) => x.name === "linked")!;
    writeFileSync(target, "second");
    const second = scanSkills({ home }).observations.find((x) => x.name === "linked")!;
    expect(second.treeDigest).toBe(first.treeDigest);
    expect(second.targetTreeDigest).toBe(first.targetTreeDigest);
  });

  test("shared physical targets are duplicates even when link text differs", () => {
    const home = fixture(), canonical = join(home, "canonical"); skill(canonical, "shared");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true }); mkdirSync(join(home, ".codebuddy", "skills"), { recursive: true });
    symlinkSync(canonical, join(home, ".claude", "skills", "shared")); symlinkSync("../../canonical", join(home, ".codebuddy", "skills", "shared"));
    const items = scanSkills({ home }).observations.filter((x) => x.name === "shared");
    expect(items).toHaveLength(2); expect(items.every((x) => x.findings.includes("duplicate"))).toBe(true);
    expect(items.every((x) => x.state === "external")).toBe(true);
  });

  test("redaction does not redact sibling prefixes", () => {
    const home = fixture(); expect(redactHome(`${home}-other/a`, home)).toBe(`${home}-other/a`);
  });

  test("does not classify incomplete observations", () => {
    const home = fixture(); skill(join(home, ".claude", "skills", "large"), "large", "x".repeat(100)); skill(join(home, ".agents", "skills", "large"), "large", "x".repeat(100));
    const result = scanSkills({ home, limits: { maxBytesPerSkill: 8 } });
    expect(result.completeness).toBe("partial");
    expect(result.observations.filter((x) => x.name === "large").every((x) => x.state === "bounded" && !x.findings.includes("duplicate") && !x.findings.includes("conflict"))).toBe(true);
    expect(result.warnings.some((x) => x.includes("扫描不完整"))).toBe(true);
  });

  test("recursively discovers actual plugin skills as protected", () => {
    const home = fixture(), nested = join(home, ".codex", "plugins", "cache", "vendor", "pkg", "skills", "nested"); skill(nested, "plugin-nested"); writeFileSync(join(nested, "large.asset"), "x".repeat(1024));
    const result = scanSkills({ home, limits: { maxBytes: 1 } });
    const item = result.observations.find((x) => x.name === "plugin-nested");
    expect(item?.scope).toBe("plugin"); expect(item?.ownership).toBe("protected"); expect(item?.findings).toContain("protected"); expect(result.completeness).toBe("complete");
  });

  test("reports unreadable roots and global truncation as partial", () => {
    const home = fixture(), codexHome = join(home, "codex-file"); writeFileSync(codexHome, "not a directory");
    skill(join(home, ".claude", "skills", "one"), "one"); skill(join(home, ".claude", "skills", "two"), "two");
    const result = scanSkills({ home, codexHome, limits: { maxEntries: 1 } });
    expect(result.completeness).toBe("partial"); expect(result.budget.entries).toBe(1);
    expect(result.warnings.some((x) => x.includes("无法读取 skill 根") || x.includes("扫描不完整"))).toBe(true);
  });
});
