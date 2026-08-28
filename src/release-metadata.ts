import { readFileSync } from "fs";
import { join, resolve } from "path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ReleaseMetadata = {
  version: string;
  kernelVersion: string;
  changelogVersion: string;
};

/** Parse the three-part version used by package.json, Kernel manifests, and Desk locks. */
export function parseVersion(value: unknown): string {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`invalid semantic version: ${String(value)}`);
  }
  return value;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a).split(".").map(Number);
  const right = parseVersion(b).split(".").map(Number);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/** Read and validate only the package version, for comparing with an older checkout. */
export function readPackageVersion(root: string): string {
  const packageJson = JSON.parse(readFileSync(join(resolve(root), "package.json"), "utf8")) as { version?: unknown };
  return parseVersion(packageJson.version);
}

function readKernelVersion(root: string): string {
  const contracts = readFileSync(join(resolve(root), "src/kernel/extensions/contracts.ts"), "utf8");
  const match = contracts.match(/\bexport\s+const\s+KERNEL_VERSION\s*=\s*["']([^"']+)["']/);
  if (!match) throw new Error("src/kernel/extensions/contracts.ts has no KERNEL_VERSION constant");
  return parseVersion(match[1]);
}

function readChangelogVersion(root: string): string {
  const changelog = readFileSync(join(resolve(root), "CHANGELOG.md"), "utf8");
  const firstEntry = changelog.split(/\r?\n/).find((line) => /^##\s+/.test(line));
  const match = firstEntry?.match(/^##\s+\[([^\]\s]+)\](?:\s|$)/);
  if (!match || !SEMVER.test(match[1])) throw new Error("CHANGELOG.md must start with a ## semantic-version release entry");
  return parseVersion(match[1]);
}

/** Read and validate the current checkout's release metadata. */
export function readReleaseMetadata(root = process.cwd()): ReleaseMetadata {
  root = resolve(root);
  const version = readPackageVersion(root);
  const kernelVersion = readKernelVersion(root);
  const changelogVersion = readChangelogVersion(root);
  if (version !== kernelVersion || version !== changelogVersion) {
    throw new Error(`release metadata mismatch: package.json=${version}, KERNEL_VERSION=${kernelVersion}, CHANGELOG=${changelogVersion}`);
  }
  return { version, kernelVersion, changelogVersion };
}

/** Validate metadata and, when provided, require a version increase over a baseline checkout. */
export function assertReleaseMetadata(root = process.cwd(), baselineRoot?: string): ReleaseMetadata {
  const metadata = readReleaseMetadata(root);
  if (baselineRoot !== undefined) {
    const baselineVersion = readPackageVersion(baselineRoot);
    if (compareVersions(metadata.version, baselineVersion) <= 0) {
      throw new Error(`release version ${metadata.version} must be greater than baseline ${baselineVersion}`);
    }
  }
  return metadata;
}

/** Descriptive alias for callers that use validation terminology. */
export const validateReleaseMetadata = assertReleaseMetadata;
