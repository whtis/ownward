import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const scriptPath = join(import.meta.dir, "../../scripts/export-public.sh");
const script = readFileSync(scriptPath, "utf8");

test("public exporter is shell-valid and has the release metadata gate", () => {
  const result = Bun.spawnSync(["bash", "-n", scriptPath], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  for (const marker of [
    "read_package_version()",
    "RELEASE_CHECKER=\"$STAGE/scripts/release-metadata.ts\"",
    "bun \"$RELEASE_CHECKER\" check \"$STAGE\"",
    "bun \"$RELEASE_CHECKER\" check \"$STAGE\" \"$TARGET\"",
    "read_kernel_version()",
    "read_changelog_version()",
    "CANDIDATE_TREE=$(git -C \"$STAGE\" write-tree)",
    "TARGET_TREE=$(git -C \"$TARGET\" rev-parse 'HEAD^{tree}')",
    "source version $SOURCE_VERSION equals target version $TARGET_VERSION",
    "must be greater than target version",
  ]) expect(script).toContain(marker);
  expect(script.indexOf("CANDIDATE_TREE=$(git -C \"$STAGE\" write-tree)")).toBeLessThan(script.indexOf("Running the verification gate"));
});

test("public exporter uses tools available on a clean macOS runner", () => {
  expect(script).not.toContain("rg ");
});

test("public exporter compares strict semver without allowing equal or lower releases", () => {
  const start = script.indexOf("version_component_gt() {");
  const end = script.indexOf("\n\nwhile (($#));", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const functionBody = script.slice(start, end);
  const probe = `${functionBody}
version_gt 1.1.1 1.1.0 && echo greater || echo not-greater
version_gt 1.1.0 1.1.0 && echo greater || echo not-greater
version_gt 0.9.0 1.0.0 && echo greater || echo not-greater
version_gt 100000000000000000000.0.0 99999999999999999999.0.0 && echo greater || echo not-greater
`;
  const result = Bun.spawnSync(["bash", "-c", probe], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(new TextDecoder().decode(result.stdout).trim().split("\n")).toEqual(["greater", "not-greater", "not-greater", "greater"]);
});

test("first changelog heading is validated rather than skipped", () => {
  expect(script).toContain('header=$(awk \'/^##[[:space:]]+/{ print; exit }\' "$file")');
  expect(script).toContain("CHANGELOG.md must start with a ## [x.y.z] release heading.");
});

test("fallback metadata parser works with nounset when the reusable checker is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-export-metadata-"));
  try {
    mkdirSync(join(root, "src/kernel/extensions"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "src/kernel/extensions/contracts.ts"), 'export const KERNEL_VERSION = "1.2.3";\n');
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3] - 2026-08-28\n");
    const start = script.indexOf("SEMVER_RE=");
    const end = script.indexOf("\nwhile (($#));", start);
    const declarations = script.slice(start, end);
    const probe = `set -euo pipefail\n${declarations}\nprintf '%s\\n' "$(read_package_version \"$1/package.json\")" "$(read_kernel_version \"$1\")" "$(read_changelog_version \"$1/CHANGELOG.md\")"`;
    const result = Bun.spawnSync(["bash", "-c", probe, "bash", root], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim().split("\n")).toEqual(["1.2.3", "1.2.3", "1.2.3"]);
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## [1.2.3]\n");
    const invalidProbe = `set -euo pipefail\n${declarations}\nread_changelog_version "$1/CHANGELOG.md"`;
    const invalid = Bun.spawnSync(["bash", "-c", invalidProbe, "bash", root], { stdout: "pipe", stderr: "pipe" });
    expect(invalid.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(invalid.stderr)).toContain("CHANGELOG.md must start");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
