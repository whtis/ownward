import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { ensureInstallDefaults, migrateLegacySources } from "./config-bootstrap.ts";
import { devLegacyRoutes } from "../src/verticals.ts";

describe("install config bootstrap", () => {
  test("legacy sources migrate once while canonical connectors always win", () => {
    const config: any = { sources: { lark: { enabled: true, pollMin: 9 }, github: { enabled: true } }, connectors: { lark: { enabled: false, pollMin: 2 } },llm:{claudeBin:"/opt/claude",codexBin:"codex-old"},providers:{codex:{command:["codex-new"]}} };
    expect(migrateLegacySources(config)).toBeTrue();
    expect(config.connectors).toEqual({ lark: { enabled: false, pollMin: 2 }, github: { enabled: true } });expect(config.providers).toEqual({codex:{command:["codex-new"]},"claude-code":{command:["/opt/claude"]}});
    expect(migrateLegacySources(config)).toBeFalse();
    expect(config.sources.lark.enabled).toBeTrue();
  });

  test("safe-parent install also merges every existing task root and preserves explicit empty roots", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-install-")), workspace = join(root, "workspace"), repo = join(workspace, "ownward"), project = join(root, "project"), cwd = join(root, "cwd"), file = join(root, "config.json");
    try {
      mkdirSync(join(repo, "data"), { recursive: true }); mkdirSync(project); mkdirSync(cwd);
      writeFileSync(join(repo, "data/tasks.json"), JSON.stringify([{ projectDir: project, cwd }, { projectDir: project, cwd: join(root, "missing") }, { cwd: homedir() }, { cwd: "/" }]));
      writeFileSync(file, JSON.stringify({ vault: { root: "~/vault" } }));
      const installed = ensureInstallDefaults(file, repo);
      expect(installed).toMatchObject({ changed: true, allowedRoots: [realpathSync(workspace), realpathSync(project), realpathSync(cwd)] });
      expect(devLegacyRoutes(installed.allowedRoots)).toContain("/api/work");
      expect(JSON.parse(readFileSync(file, "utf8")).vault.root).toBe("~/vault");
      writeFileSync(file, JSON.stringify({ architecture: { allowedRoots: [] } }));
      expect(ensureInstallDefaults(file, repo)).toMatchObject({ changed: false, allowedRoots: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("home-level install grants only repo plus existing task roots", () => {
    const root = mkdtempSync(join(homedir(), "ownward-bootstrap-test-")), repo = join(homedir(), `ownward-bootstrap-repo-${process.pid}`), project = join(root, "project"), file = join(root, "config.json");
    try {
      mkdirSync(join(repo, "data"), { recursive: true }); mkdirSync(project);
      writeFileSync(join(repo, "data/tasks.json"), JSON.stringify([{ projectDir: project, cwd: join(root, "missing") }, { cwd: homedir() }])); writeFileSync(file, "{}");
      expect(ensureInstallDefaults(file, repo).allowedRoots).toEqual([realpathSync(repo), realpathSync(project)]);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
  });
});
