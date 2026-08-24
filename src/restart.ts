// daemon 重启必须由独立的一次性 launchd helper 执行。daemon 子进程（包括 nohup）会在
// bootout 时被整个 job 连坐杀掉；launchctl submit 又会推断 KeepAlive，导致脚本周期重跑。
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { durableWrite } from "./release/durable-write.ts";
import { DATA, run } from "./util.ts";

const LABEL = "ai.ownward.daemon";

export interface RestartIntent {
  schemaVersion: 1;
  at: string;
  by: string;
  expectedGeneration: string;
  expectedPid: number;
}

/** helper 在停旧进程前绑定它的精确身份；没有健康 boot 身份就拒绝伪造“主动重启”。 */
export function writeRestartIntent(dataRoot: string, by: string, now = Date.now()): RestartIntent {
  const boot = JSON.parse(readFileSync(join(dataRoot, "boots.json"), "utf8"));
  if (boot?.schemaVersion !== 1 || !boot.healthy || typeof boot.generation !== "string" || !Number.isInteger(boot.pid)) {
    throw new Error("当前 daemon 没有可验证的 healthy generation，拒绝写 restart intent");
  }
  const intent: RestartIntent = {
    schemaVersion: 1, at: new Date(now).toISOString(), by,
    expectedGeneration: boot.generation, expectedPid: boot.pid,
  };
  const file = join(dataRoot, "restart-intent.json");
  // durable 写（fsync 内容+目录）：intent 丢了会把主动重启误判成崩溃，触发不必要的回滚诊断
  durableWrite(file, JSON.stringify(intent) + "\n");
  return intent;
}

/** 从 launchctl list 输出里取某个 label 的 pid；列是 tab 分隔的 pid/status/label，'-' 表示没在跑 */
export function parseLaunchdPid(out: string, label: string): number | null {
  for (const line of out.split("\n")) {
    const col = line.split("\t");
    if (col.length < 3 || col[2].trim() !== label) continue;
    const pid = parseInt(col[0], 10);
    return Number.isFinite(pid) ? pid : null;
  }
  return null;
}

/** 本进程是不是 launchd 托管的那个？不是就不能自杀——没人会拉起（dev 实例、前台手跑都属此列） */
export async function launchdManaged(): Promise<boolean> {
  const r = await run(["launchctl", "list"], { timeoutMs: 15_000 });
  if (r.code !== 0) return false;
  return parseLaunchdPid(r.stdout, LABEL) === process.pid;
}

/** 主动重启：确定性 bootstrap 独立 helper；helper 自己写 intent、重装并探活。 */
export async function requestRestart(by: string): Promise<string> {
  const { dispatchDeployHelper } = await import("./deploy-helper.ts");
  return dispatchDeployHelper("restart", [], `restart-${by}-${Date.now()}`);
}

/** 下一代启动时读走 intent（读完即删，只认一次）：区分主动重启与崩溃 */
export function takeRestartIntent(dataRoot = DATA, now = Date.now(), maxAgeMs = 120_000): RestartIntent | null {
  const file = join(dataRoot, "restart-intent.json");
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    const boot = JSON.parse(readFileSync(join(dataRoot, "boots.json"), "utf8"));
    if (v?.schemaVersion !== 1 || boot?.schemaVersion !== 1) return null;
    if (v.expectedGeneration !== boot.generation || v.expectedPid !== boot.pid) return null;
    const at = Date.parse(v.at);
    if (!Number.isFinite(at) || now - at < 0 || now - at > maxAgeMs) return null;
    return v as RestartIntent;
  } catch {
    return null;
  } finally {
    try { unlinkSync(file); } catch { /* 校验无论成败都只给一次机会，陈旧 intent 不得累积 */ }
  }
}
