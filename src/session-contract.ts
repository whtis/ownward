// 阶段 0 的只读恢复盘点器。它读取当前三类真实持久化位置，输出可对账报告；
// 不修改文件，也不扫描/猜测 Provider home，后续 Session Repository 可直接复用。
import { existsSync, readFileSync, readdirSync } from "fs";
import { isAbsolute, join } from "path";
import type { AgentControl } from "./agent-session.ts";
import type { WorkTask } from "./dispatch.ts";

export interface SessionInventoryEntry {
  sessionId: string;
  providerId: "claude" | "codex" | "codebuddy";
  providerHome?: string;
  nativeRef: string | null;
  control: AgentControl;
  cwd: string;
  recoverable: boolean;
  access?: "workspace" | "full-access" | "bypass";
  extraDirs?: string[];
  metaFile: string | null;
}

export interface SessionInventoryReport {
  taskCount: number;
  sessionCount: number;
  nativeRefCount: number;
  sessions: SessionInventoryEntry[];
  orphanMeta: string[];
  danglingPins: { kind: string; ref: string }[];
  invalidFiles: string[];
}

type TaskLite = Pick<WorkTask, "id" | "mode" | "cwd" | "ccSessionId" | "terminalLaunchId">;
type PinLite = { kind: string; ref: string };

function readJson(path: string, invalid: string[]): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { if (existsSync(path)) invalid.push(path); return null; }
}

function readLegacyMeta(path: string, invalid: string[]): { present: boolean; valid: boolean; raw: Record<string, unknown> | null } {
  if (!existsSync(path)) return { present: false, valid: true, raw: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("meta must be an object");
    return { present: true, valid: true, raw: parsed as Record<string, unknown> };
  } catch {
    invalid.push(path);
    return { present: true, valid: false, raw: null };
  }
}

/**
 * 对账 tasks.json、tasks/*.session|codex.json、pinned-sessions.json。
 * externalSessionRefs 由调用方从 Claude/Codex 原生索引传入，用于判断 cc pin；默认不猜。
 */
export function inventoryLegacySessions(dataRoot: string, externalSessionRefs: ReadonlySet<string> = new Set()): SessionInventoryReport {
  const invalidFiles: string[] = [];
  const rawTasks = readJson(join(dataRoot, "tasks.json"), invalidFiles);
  const tasks: TaskLite[] = Array.isArray(rawTasks)
    ? rawTasks.filter((t): t is TaskLite => !!t && typeof t.id === "string" && typeof t.cwd === "string")
    : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const taskDir = join(dataRoot, "tasks");
  const metaFiles = existsSync(taskDir)
    ? readdirSync(taskDir).filter((f) => /\.(session|codex)\.json$/.test(f)).sort()
    : [];

  const expectedMeta = new Set<string>();
  const sessions = tasks.filter((t) => t.mode !== "terminal" || !!t.ccSessionId).map((task) => {
    const wanted = task.mode === "codex-bg" ? `${task.id}.codex.json` : `${task.id}.session.json`;
    const metaPath = join(taskDir, wanted);
    expectedMeta.add(wanted);
    const meta = readLegacyMeta(metaPath, invalidFiles);
    // A present-but-corrupt record has unknown identity. Do not turn it into a valid
    // nativeRef=null session or let it contaminate other healthy read projections.
    if (!meta.valid) return null;
    const raw = meta.raw;
    const providerId: SessionInventoryEntry["providerId"] = task.mode === "codex-bg" ? "codex" : "claude"; // legacy sidecar 只有这两家；codebuddy 生于 Runner 时代，无 legacy 形态
    const nativeRef = providerId === "codex"
      ? (typeof raw?.rolloutId === "string" && raw.rolloutId || null)
      : (typeof raw?.toolSessionId === "string" && raw.toolSessionId
        || (task.terminalLaunchId ? task.ccSessionId?.split("/").pop() : task.ccSessionId)
        || null);
    return {
      sessionId: task.id,
      providerId: providerId as SessionInventoryEntry["providerId"],
      ...(providerId === "codex" && typeof raw?.home === "string" ? { providerHome: raw.home } : {}),
      nativeRef,
      control: raw?.control === "observing" || raw?.control === "external"
        ? raw.control as AgentControl
        : "ownward" as const,
      cwd: providerId === "codex" && typeof raw?.cwd === "string" ? raw.cwd : task.cwd,
      recoverable: !!nativeRef,
      ...(providerId === "codex" && raw?.fullAccess === true ? { access: "full-access" as const } : providerId === "claude" && raw?.bypass === true ? { access: "bypass" as const } : {}),
      ...(Array.isArray(raw?.extraDirs) && raw.extraDirs.every((d) => typeof d === "string" && isAbsolute(d)) ? { extraDirs: raw.extraDirs as string[] } : {}),
      metaFile: meta.present ? wanted : null,
    };
  }).filter((s): s is SessionInventoryEntry => s !== null);

  // 无 Task，或虽同 id 但 provider 类型与 task.mode 不符，都属于无人认领的 meta。
  // 即使关联 meta 损坏，它仍由对应 Task 认领；invalidFiles 已单独报告，不重复标成 orphan。
  const orphanMeta = metaFiles.filter((file) => !expectedMeta.has(file));
  const rawPins = readJson(join(dataRoot, "pinned-sessions.json"), invalidFiles);
  const pins: PinLite[] = Array.isArray(rawPins)
    ? rawPins.filter((p): p is PinLite => !!p && typeof p.kind === "string" && typeof p.ref === "string")
    : [];
  for (const pin of pins) if (pin.kind !== "task" && pin.kind !== "cc" && pin.kind !== "codex") invalidFiles.push(`pinned-sessions.json#unknown-kind:${pin.kind}`);
  const canonicalExternal=(ref:string)=>ref.split("/").filter(Boolean).at(-1)??ref,canonicalExternalRefs=new Set([...externalSessionRefs].map(canonicalExternal));
  const danglingPins = pins.filter((p) => p.kind === "task" ? !byId.has(p.ref) : !canonicalExternalRefs.has(canonicalExternal(p.ref)));

  return {
    taskCount: tasks.length,
    sessionCount: sessions.length,
    nativeRefCount: sessions.filter((s) => s.nativeRef).length,
    sessions,
    orphanMeta,
    danglingPins,
    invalidFiles: [...new Set(invalidFiles)].sort(),
  };
}
