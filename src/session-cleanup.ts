// daemon 自己的 claude -p 决策会话（心跳/triage/起标题/收割/日报/记忆/研究摘要）transcript
// 全落在 ownward 项目目录，一天上千个、能堆几千。它们是一次性决策，永不 --resume，删了无损。
// 但 ownward 派发的 claude-bg 引擎任务 transcript 也 entrypoint=sdk-cli，且追问靠 --resume 读它——
// 那些绝不能删。所以用三重保险精准锁定「daemon 决策会话」：
//   ① entrypoint=sdk-cli（排除真人交互 cli）
//   ② 首条 user 文本匹配已知决策 prompt 前缀（真人任务/引擎任务的首条是真实任务文本，不会长这样）
//   ③ session id 不在任何已知引擎任务的 toolSessionId 里（防误删可续聊任务，多一道兜底）
//   ④ 超过 N 天（近期保留，供调试/近期上下文）
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DATA, ROOT, log } from "./util.ts";

const PROJECTS = join(homedir(), ".claude", "projects");
// claude 的项目目录名 = cwd 路径把非字母数字换成 -（ownward 决策会话 cwd 恒为 ROOT）。
// ROOT 带尾斜杠，先剥掉再转，否则多个尾 - 对不上真实目录名。
const OWNWARD_DIR = join(PROJECTS, ROOT.replace(/\/+$/, "").replace(/[^A-Za-z0-9]/g, "-"));

// daemon 决策 prompt 首句前缀（见 heartbeat/triage/capture/harvest/dispatch/daily-digest/memory/workbench）
const DECISION_PROMPT = /^(执行 (Heartbeat|Triage) 任务|把这次开发会话总结成工作日志|把下面这次(开发会话|编码任务)的过程总结成一条工作日志|把下面的开发任务压成一句|根据下面的活动记录，写|从下面的当日工作记录中提取|你是.{0,60}的工作总结代笔|用两三句话总结这个网页)/;

/** 所有已知引擎任务的 toolSessionId（--resume 依赖其 transcript，绝不删） */
export function engineSessionIds(): Set<string> {
  const set = new Set<string>();
  try {
    for (const f of readdirSync(join(DATA, "tasks"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(DATA, "tasks", f), "utf8"));
        if (j.toolSessionId) set.add(String(j.toolSessionId));
        if (j.rolloutId) set.add(String(j.rolloutId));
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 无 tasks 目录 */ }
  return set;
}

/** 读文件头 16KB 取 entrypoint + 首条真实 user 文本（decision prompt 都在开头几行） */
function probe(path: string): { entrypoint: string; firstUser: string } {
  let head = "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const buf = Buffer.alloc(Math.min(16 * 1024, size));
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return { entrypoint: "", firstUser: "" }; }
  let entrypoint = "", firstUser = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (!entrypoint && typeof e.entrypoint === "string") entrypoint = e.entrypoint;
    if (!firstUser && e.type === "user" && !e.isMeta && !e.isSidechain) {
      const c = e.message?.content;
      const t = (typeof c === "string" ? c
        : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "").trim();
      if (t && !t.startsWith("<")) firstUser = t;
    }
    if (entrypoint && firstUser) break;
  }
  return { entrypoint, firstUser };
}

/** 清理超过 days 天的 daemon 决策 transcript。返回删除数量。 */
export function sweepDaemonTranscripts(days = 3): number {
  if (!existsSync(OWNWARD_DIR)) return 0;
  const cutoff = Date.now() - days * 86400_000;
  const engineIds = engineSessionIds();
  let removed = 0, scanned = 0;
  let entries: string[];
  try { entries = readdirSync(OWNWARD_DIR); } catch { return 0; }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(OWNWARD_DIR, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs > cutoff) continue;                 // 近 N 天保留
    const uuid = f.replace(/\.jsonl$/, "");
    if (engineIds.has(uuid)) continue;                 // 引擎任务（--resume 依赖），绝不删
    scanned++;
    const { entrypoint, firstUser } = probe(p);
    if (entrypoint !== "sdk-cli") continue;            // 真人交互 cli 会话不动
    if (!DECISION_PROMPT.test(firstUser)) continue;    // 非决策 prompt 的 sdk-cli（含引擎任务）不动
    try { unlinkSync(p); removed++; } catch { /* 删不掉跳过 */ }
  }
  if (removed) log(`session cleanup: 删除 ${removed}/${scanned} 个 daemon 决策 transcript（>${days}天，ownward 目录）`);
  return removed;
}
