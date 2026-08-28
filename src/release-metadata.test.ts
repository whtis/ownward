import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compareVersions, readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(version: string, changelogVersion = version): string {
  const root = mkdtempSync(join(tmpdir(), "ownward-release-metadata-"));
  roots.push(root);
  mkdirSync(join(root, "src/kernel/extensions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }) + "\n");
  writeFileSync(join(root, "src/kernel/extensions/contracts.ts"), `export const KERNEL_VERSION = "${version}";\n`);
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${changelogVersion}] - 2026-08-28\n\n- Public release notes.\n`);
  return root;
}

test("release metadata keeps package, kernel, and first changelog entry in lockstep", () => {
  const root = fixture("1.1.1");
  expect(readReleaseMetadata(root)).toEqual({ version: "1.1.1", kernelVersion: "1.1.1", changelogVersion: "1.1.1" });
});

test("release metadata rejects mismatched changelog and non-release first headings", () => {
  const mismatch = fixture("1.1.1", "1.1.0");
  expect(() => readReleaseMetadata(mismatch)).toThrow("release metadata mismatch");
  const heading = fixture("1.1.1");
  writeFileSync(join(heading, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## [1.1.1]\n");
  expect(() => readReleaseMetadata(heading)).toThrow("semantic-version release entry");
  const unbracketed = fixture("1.1.1");
  writeFileSync(join(unbracketed, "CHANGELOG.md"), "# Changelog\n\n## 1.1.1 - 2026-08-28\n");
  expect(() => readReleaseMetadata(unbracketed)).toThrow("semantic-version release entry");
});

test("release metadata requires a strictly newer package version than the baseline", () => {
  const baseline = fixture("1.1.0");
  expect(validateReleaseMetadata(fixture("1.1.1"), baseline).version).toBe("1.1.1");
  expect(() => validateReleaseMetadata(fixture("1.1.0"), baseline)).toThrow("must be greater than baseline");
  expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
  expect(compareVersions("1.0.9", "1.1.0")).toBe(-1);
});
