import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

export interface BootState {
  schemaVersion: 1;
  generation: string;
  pid: number;
  startedAt: number;
  healthy: boolean;
  healthyAt?: number;
  rollbackRequestedAt?: number;
  unexpectedFailures: number[];
}

export interface BootDecision { state: BootState; shouldRollback: boolean; previousCounted: boolean }

/**
 * 只结算上一代。当前进程仅仅“开始启动”不是一次 crash；它必须在下一代出现时仍未 healthy，
 * 且没有主动重启 intent，才算一次意外失败。
 */
export function nextBootState(previous: BootState | null, now: number, pid: number,
  generation: string, intentional: boolean, windowMs = 120_000, threshold = 4,
  rollbackLeaseMs = 120_000): BootDecision {
  let failures = (previous?.unexpectedFailures || []).filter((t) => now - t < windowMs);
  // listening 只是“能接请求”，不是版本已稳定：在一个完整观察窗内死亡仍按启动失败计。
  // 旧状态没有 healthyAt，按长期稳定处理，避免升级 CrashGuard 本身误触发回滚。
  const healthyAge = typeof previous?.healthyAt === "number" ? now - previous.healthyAt : null;
  const previousUnstable = !!previous && (!previous.healthy ||
    (healthyAge !== null && healthyAge >= 0 && healthyAge < windowMs));
  const previousCounted = previousUnstable && !intentional;
  if (intentional) failures = [];
  else if (previousCounted) failures.push(now);
  const rollbackLeaseActive = typeof previous?.rollbackRequestedAt === "number"
    && now - previous.rollbackRequestedAt >= 0 && now - previous.rollbackRequestedAt < rollbackLeaseMs;
  return {
    state: {
      schemaVersion: 1, generation, pid, startedAt: now, healthy: false, unexpectedFailures: failures,
      ...(rollbackLeaseActive ? { rollbackRequestedAt: previous!.rollbackRequestedAt } : {}),
    },
    shouldRollback: failures.length >= threshold && !rollbackLeaseActive,
    previousCounted,
  };
}

export class CrashGuard {
  readonly file: string;
  constructor(dataRoot: string) { mkdirSync(dataRoot, { recursive: true }); this.file = join(dataRoot, "boots.json"); }

  private write(state: BootState) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  begin(intentional: boolean, now = Date.now(), pid = process.pid, generation: string = crypto.randomUUID()): BootDecision {
    let previous: BootState | null = null;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.unexpectedFailures)) previous = parsed;
      // 旧版 number[] 不能证明哪一代 healthy，安全地丢弃，避免升级本身触发误回滚。
    } catch { /* first boot / legacy state */ }
    const decision = nextBootState(previous, now, pid, generation, intentional);
    this.write(decision.state);
    return decision;
  }

  markHealthy(generation: string, now = Date.now()): boolean {
    if (!existsSync(this.file)) return false;
    let state: BootState;
    try { state = JSON.parse(readFileSync(this.file, "utf8")); } catch { return false; }
    if (state.schemaVersion !== 1 || state.generation !== generation) return false;
    state.healthy = true;
    state.healthyAt = now;
    this.write(state);
    return true;
  }

  markRollbackRequested(generation: string, now = Date.now()): boolean {
    let state: BootState;
    try { state = JSON.parse(readFileSync(this.file, "utf8")); } catch { return false; }
    if (state.schemaVersion !== 1 || state.generation !== generation) return false;
    state.rollbackRequestedAt = now;
    this.write(state);
    return true;
  }
}
