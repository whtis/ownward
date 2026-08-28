import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export interface DeploymentLockLease { path: string; token: string; pid: number }

export function deploymentLockPath(dataRoot: string) {
  return join(resolve(dataRoot), "deploy", ".deployment.lock");
}

function ownerFile(path: string) { return join(path, "owner.json"); }
function processStart(pid: number): string {
  try { return Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); }
  catch { return ""; }
}
function live(pid: number, expectedStart: string) { try { process.kill(pid, 0); return !!expectedStart && processStart(pid) === expectedStart; } catch { return false; } }

export function readDeploymentLock(dataRoot: string): { pid: number; processStart: string; token: string; acquiredAt: string } | null {
  try {
    const value = JSON.parse(readFileSync(ownerFile(deploymentLockPath(dataRoot)), "utf8"));
    return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value?.processStart === "string" && typeof value?.token === "string"
      ? { pid: value.pid, processStart: value.processStart, token: value.token, acquiredAt: String(value.acquiredAt || "") } : null;
  } catch { return null; }
}

/** 所有发布入口共享的最外层锁。token 只用于父 helper 把锁委托给 install-release 子进程。 */
export function acquireDeploymentLock(dataRoot: string, pid = process.pid): DeploymentLockLease {
  const path = deploymentLockPath(dataRoot), parent = join(path, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { chmodSync(parent, 0o700); } catch {}
  const claim = () => {
    mkdirSync(path, { mode: 0o700 });
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const started = processStart(pid);
    if (!started) throw new Error(`无法读取 deployment owner pid=${pid} 的启动身份`);
    writeFileSync(ownerFile(path), JSON.stringify({ pid, processStart: started, token, acquiredAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return { path, token, pid };
  };
  try { return claim(); } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const owner = readDeploymentLock(dataRoot);
    if (owner && live(owner.pid, owner.processStart)) throw Object.assign(new Error(`已有 deployment transaction pid=${owner.pid}`), { code: "DEPLOYMENT_BUSY" });
    const stale = `${path}.stale-${pid}-${crypto.randomUUID()}`;
    renameSync(path, stale);
    rmSync(stale, { recursive: true, force: true });
    return claim();
  }
}

export function assertDeploymentLock(dataRoot: string, token: string): DeploymentLockLease {
  const owner = readDeploymentLock(dataRoot);
  if (!owner || !token || owner.token !== token || !live(owner.pid, owner.processStart))
    throw Object.assign(new Error("deployment lock token 无效或 owner 已退出"), { code: "DEPLOYMENT_LOCK_INVALID" });
  return { path: deploymentLockPath(dataRoot), token, pid: owner.pid };
}

export function releaseDeploymentLock(dataRoot: string, token: string) {
  const lease = assertDeploymentLock(dataRoot, token);
  rmSync(ownerFile(lease.path), { force: true });
  try { rmdirSync(lease.path); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

if (import.meta.main) {
  const command = process.argv[2], dataRoot = process.argv[3], token = process.argv[4];
  if (!dataRoot) throw new Error("deployment-lock <acquire|assert|release> <data-root> [token] [pid]");
  if (command === "acquire") console.log(acquireDeploymentLock(dataRoot, Number(process.argv[4]) || process.ppid).token);
  else if (command === "assert") console.log(assertDeploymentLock(dataRoot, token || "").pid);
  else if (command === "release") releaseDeploymentLock(dataRoot, token || "");
  else throw new Error("deployment-lock <acquire|assert|release>");
}
