import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

export const RELEASE_FORMAT_VERSION = 1;

export type ReleaseManifest = {
  formatVersion: 1;
  buildIdentity: string;
  sourceRoot: string;
  createdAt: string;
  files: string[];
};

function hashFiles(root: string, files: string[]): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    hash.update(file); hash.update("\0");
    hash.update(readFileSync(join(root, file))); hash.update("\0");
  }
  return hash.digest("hex");
}

export function sourceBuildIdentity(root: string): string {
  root = resolve(root);
  return hashFiles(root, trackedFiles(root));
}

export function trackedFiles(root: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(`git ls-files failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().split("\0").filter(Boolean).sort();
}

/** Build a content-addressed code snapshot. Mutable data/config stay outside it. */
export function prepareRelease(sourceRoot: string, releasesRoot: string): ReleaseManifest {
  sourceRoot = resolve(sourceRoot); releasesRoot = resolve(releasesRoot);
  const files = trackedFiles(sourceRoot);
  const buildIdentity = hashFiles(sourceRoot, files);
  const destination = join(releasesRoot, buildIdentity);
  const manifest: ReleaseManifest = { formatVersion: 1, buildIdentity, sourceRoot, createdAt: new Date().toISOString(), files };
  if (existsSync(join(destination, "release.json"))) {
    const existing = JSON.parse(readFileSync(join(destination, "release.json"), "utf8"));
    if (existing.buildIdentity !== buildIdentity) throw new Error("release identity collision");
    return existing;
  }
  const staging = `${destination}.staging-${process.pid}-${crypto.randomUUID()}`;
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    for (const file of files) {
      const from = join(sourceRoot, file), to = join(staging, file), stat = lstatSync(from);
      mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release refuses non-regular tracked file: ${file}`);
      copyFileSync(from, to); chmodSync(to, stat.mode & 0o111 ? 0o555 : 0o444);
    }
    writeFileSync(join(staging, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o444 });
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging,{recursive:true,force:true});
    throw error;
  }
  return manifest;
}

export function validateRelease(root: string, expected?: string): ReleaseManifest {
  const manifest = JSON.parse(readFileSync(join(root, "release.json"), "utf8")) as ReleaseManifest;
  if (manifest.formatVersion !== RELEASE_FORMAT_VERSION || !/^[a-f0-9]{64}$/.test(manifest.buildIdentity)) throw new Error("release manifest invalid");
  if (expected && manifest.buildIdentity !== expected) throw new Error("release build identity mismatch");
  const actual = hashFiles(root, [...manifest.files].sort());
  if (actual !== manifest.buildIdentity) throw new Error("release content hash mismatch");
  return manifest;
}

if (import.meta.main) {
  const command = process.argv[2], root = resolve(process.argv[3] || process.cwd());
  if (command === "prepare") console.log(JSON.stringify(prepareRelease(root, resolve(process.argv[4] || join(root, "data/releases")))));
  else if (command === "validate") console.log(JSON.stringify(validateRelease(root, process.argv[4])));
  else throw new Error("usage: build.ts prepare <source-root> <releases-root> | validate <release-root> [build-id]");
}
