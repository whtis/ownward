import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { acquireDeploymentLock, releaseDeploymentLock, type DeploymentLockLease } from "../release/deployment-lock.ts";
import { configDigest } from "../release/config-snapshot.ts";
import { sourceBuildIdentity } from "../release/build.ts";
import { writeRestartIntent } from "../restart.ts";
import { DATA, ROOT, SOURCE_ROOT } from "../util.ts";
import { applySettingsOperation, recoverSettingsOperations, settingsSchemaDigest, SettingsOperationStore, type SettingsDeploymentExecutor, type SettingsOperation } from "./operations.ts";
import type { SettingsFiles } from "./service.ts";

interface ReleaseState { current?: string; currentConfigDigest?: string }
interface DeploymentRecord {
  previousBuild: string;
  previousConfigDigest: string;
  oldSourceConfigDigest: string;
  candidateBuild?: string;
  candidateConfigDigest?: string;
}

function releaseState(): ReleaseState {
  const file = join(DATA, "releases", "state.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

async function runRelease(lease: DeploymentLockLease, env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", join(SOURCE_ROOT, "launchd", "install-release.sh")], {
    cwd: SOURCE_ROOT,
    env: { ...process.env, ...env, OWNWARD_BUN: process.execPath, OWNWARD_DATA_ROOT: DATA, OWNWARD_DEPLOYMENT_LOCK_TOKEN: lease.token },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw Object.assign(new Error(`release transaction failed (${code}): ${(stderr || stdout).slice(-800)}`), { code: "SETTINGS_RELEASE_FAILED" });
  return { code, output: `${stdout}\n${stderr}`.trim().slice(-4_000) };
}

async function probe(origin: string, expectedBuild: string, expectedConfig: string) {
  const deadline = Date.now() + 150_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/system/runtime-health`, { signal: AbortSignal.timeout(3_000) });
      last = await response.text();
      if (response.ok) {
        const health = JSON.parse(last);
        if (health.ok === true && health.buildIdentity === expectedBuild && health.configDigest === expectedConfig) return;
      }
    } catch (error) { last = String(error); }
    await Bun.sleep(1_000);
  }
  throw Object.assign(new Error(`candidate runtime health mismatch: ${last.slice(0, 300)}`), { code: "SETTINGS_RUNTIME_VERIFY_FAILED" });
}

function deployment(op: SettingsOperation): DeploymentRecord {
  const value = op.deployment as Partial<DeploymentRecord> | undefined;
  if (!value?.oldSourceConfigDigest) throw Object.assign(new Error("settings operation missing deployment baseline"), { code: "SETTINGS_DEPLOYMENT_BASELINE_MISSING" });
  return value as DeploymentRecord;
}

function executor(lease: DeploymentLockLease, files: SettingsFiles): SettingsDeploymentExecutor {
  return {
    async runtime() { return { buildIdentity: sourceBuildIdentity(SOURCE_ROOT), schemaDigest: settingsSchemaDigest(files) }; },
    async install(operation) {
      const baseline = deployment(operation), expectedConfig = configDigest(SOURCE_ROOT);
      writeRestartIntent(DATA, `settings-apply:${operation.id}`);
      await runRelease(lease, { OWNWARD_EXPECTED_SOURCE_CONFIG_DIGEST: expectedConfig, OWNWARD_EXPECTED_BUILD: operation.runtime.buildIdentity });
      const state = releaseState();
      if (!state.current || state.currentConfigDigest !== expectedConfig)
        throw Object.assign(new Error("release state did not commit candidate config"), { code: "SETTINGS_RELEASE_STATE_MISMATCH" });
      return { ...baseline, candidateBuild: state.current, candidateConfigDigest: expectedConfig };
    },
    async verify(operation) {
      const record = deployment(operation);
      if (!record.candidateBuild || !record.candidateConfigDigest) throw new Error("candidate deployment identity missing");
      await probe(`http://127.0.0.1:${operation.origins.candidatePort}`, record.candidateBuild, record.candidateConfigDigest);
    },
    async restore(operation) {
      const record = deployment(operation);
      if (!record.previousBuild || !record.previousConfigDigest) throw new Error("previous paired release unavailable for automatic restore");
      const restoredSource = configDigest(SOURCE_ROOT);
      if (restoredSource !== record.oldSourceConfigDigest) throw new Error("restored source config digest mismatch");
      writeRestartIntent(DATA, `settings-restore:${operation.id}`);
      await runRelease(lease, {
        OWNWARD_TARGET_RELEASE_ID: record.previousBuild,
        OWNWARD_TARGET_CONFIG_DIGEST: record.previousConfigDigest,
        OWNWARD_EXPECTED_SOURCE_CONFIG_DIGEST: record.oldSourceConfigDigest,
      });
      const state = releaseState();
      if (state.current !== record.previousBuild || state.currentConfigDigest !== record.previousConfigDigest)
        throw new Error("previous paired release was not restored");
      await probe(`http://127.0.0.1:${operation.origins.previousPort}`, record.previousBuild, record.previousConfigDigest);
    },
  };
}

function attachBaseline(store: SettingsOperationStore, operation: SettingsOperation) {
  const current = operation.deployment as Partial<DeploymentRecord> | undefined;
  if (current?.oldSourceConfigDigest) return operation;
  const state = releaseState();
  return store.write({ ...operation, deployment: {
    previousBuild: String(state.current || ""), previousConfigDigest: String(state.currentConfigDigest || ""),
    oldSourceConfigDigest: configDigest(SOURCE_ROOT),
  } satisfies DeploymentRecord });
}

export async function runSettingsHelper(command: "apply" | "recover", operationId?: string) {
  const store = new SettingsOperationStore(join(DATA, "settings", "operations"));
  const files: SettingsFiles = { defaultFile: join(ROOT, "config.default.json"), overrideFile: join(SOURCE_ROOT, "config.json") };
  const lease = acquireDeploymentLock(DATA);
  try {
    const deploy = executor(lease, files);
    if (command === "apply") {
      if (!operationId) throw new Error("settings apply requires operation id");
      attachBaseline(store, store.read(operationId));
      return await applySettingsOperation(store, operationId, files, deploy);
    }
    for (const operation of store.list().filter((item) => !["committed", "restored", "manual-repair"].includes(item.phase))) attachBaseline(store, operation);
    return await recoverSettingsOperations(store, files, deploy);
  } finally { releaseDeploymentLock(DATA, lease.token); }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "apply" && command !== "recover") throw new Error("settings helper: apply <operation-id> | recover");
  runSettingsHelper(command, process.argv[3]).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1);
  });
}
