import { uptime as osUptime } from "os";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { join } from "path";
import { runnerPaths } from "./capability.ts";

export interface RunnerInstanceLock { release(): void; }
export const RUNNER_INSTANCE_LOCK_GRACE_MS = 1_000;
export function runnerBootId(): string {
  // Windows 没有 sysctl，原来的 spawnSync 直接抛 ENOENT，Runner 起不来。
  // 用 os.uptime() 反推开机时刻代替：抖动在亚秒级，按分钟量化后同一次开机内稳定，
  // 且不需要再 spawn 一个进程（这个函数在每次抢实例锁时都会调）。
  if (process.platform === "win32") return `win-boot:${Math.floor((Date.now() / 1000 - osUptime()) / 60)}`;
  const result = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]); return result.exitCode === 0 ? new Bun.CryptoHasher("sha256").update(result.stdout).digest("hex") : "unknown-boot"; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; } };
const writeOwner = (lock: string, value: object) => {
  const owner = join(lock, "owner.json"), tmp = join(lock, `.owner.${crypto.randomUUID()}.tmp`), bytes = Buffer.from(JSON.stringify(value)), fd = openSync(tmp, "wx", 0o600);
  try { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error("Runner owner 短写入"); offset += n; } fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, owner); const dfd = openSync(lock, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
};
export function acquireRunnerInstanceLock(dataRoot: string): RunnerInstanceLock {
  const dir = runnerPaths(dataRoot).dir, lock = join(dir, ".instance-lock"), bootId = runnerBootId(); mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 }); const owner = join(lock, "owner.json"), token = crypto.randomUUID(), value = { pid: process.pid, token, at: Date.now(), bootId }; writeOwner(lock, value);
      const verified = JSON.parse(readFileSync(owner, "utf8")); if (verified.token !== token) throw new Error("Runner owner 写后校验失败");
      let released = false; return { release() { if (released) return; released = true; try { const found = JSON.parse(readFileSync(owner, "utf8")); if (found.pid !== process.pid || found.token !== token || found.bootId !== bootId) return; unlinkSync(owner); rmdirSync(lock); } catch {} } };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const ownerPath = join(lock, "owner.json"), age = Date.now() - statSync(lock).mtimeMs;
      let found: any; try { found = JSON.parse(readFileSync(ownerPath, "utf8")); } catch { if (age < RUNNER_INSTANCE_LOCK_GRACE_MS) throw Object.assign(new Error("Runner instance lock 正在初始化"), { code: "RUNNER_LOCK_STARTING" }); found = null; }
      if (found?.bootId === bootId && Number.isSafeInteger(found.pid) && found.pid > 0 && alive(found.pid)) throw Object.assign(new Error(`Runner 已由 pid ${found.pid} 持有`), { code: "RUNNER_ALREADY_RUNNING" });
      if (age < RUNNER_INSTANCE_LOCK_GRACE_MS) throw Object.assign(new Error("Runner instance lock 尚在 grace"), { code: "RUNNER_LOCK_GRACE" });
      const token = found?.token, stale = `${lock}.stale.${process.pid}.${crypto.randomUUID()}`;
      if (token) { const recheck = JSON.parse(readFileSync(ownerPath, "utf8")); if (recheck.token !== token) continue; }
      try { renameSync(lock, stale); } catch (claim: any) { if (claim?.code === "ENOENT") continue; throw claim; }
      try { unlinkSync(join(stale, "owner.json")); } catch {} try { for (const name of [`.owner`]) void name; rmdirSync(stale); } catch {}
    }
  }
  throw new Error("Runner instance lock 竞争失败");
}
