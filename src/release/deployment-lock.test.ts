import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireDeploymentLock, assertDeploymentLock, deploymentLockPath, releaseDeploymentLock } from "./deployment-lock.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("deployment lock serializes callers and supports token delegation", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-deploy-lock-")); roots.push(root);
  const lease = acquireDeploymentLock(root);
  expect(assertDeploymentLock(root, lease.token).pid).toBe(process.pid);
  expect(() => acquireDeploymentLock(root)).toThrow(/已有 deployment transaction/);
  expect(() => assertDeploymentLock(root, "wrong")).toThrow(/token/);
  releaseDeploymentLock(root, lease.token);
  expect(deploymentLockPath(root)).not.toBe("");
  const next = acquireDeploymentLock(root); releaseDeploymentLock(root, next.token);
});

test("deployment lock rejects PID reuse by comparing process start identity", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-deploy-reuse-")); roots.push(root);
  acquireDeploymentLock(root);
  writeFileSync(join(deploymentLockPath(root), "owner.json"), JSON.stringify({ pid: process.pid, processStart: "reused-pid", token: "old", acquiredAt: new Date().toISOString() }));
  const replacement = acquireDeploymentLock(root);
  expect(replacement.token).not.toBe("old");
  releaseDeploymentLock(root, replacement.token);
});
