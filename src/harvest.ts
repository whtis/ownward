// 过程数据收割：从 Claude Code transcript / bg 日志提取工作过程，
// codex 总结成 Problem→Solution 笔记，按 vault 规范写 projects/{项目}/。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { llmJson } from "./llm.ts";
import { appendDaily } from "./obsidian.ts";
import type { WorkTask } from "./dispatch.ts";
import { cfg, ensureDir, expandHome, fmt, log, run } from "./util.ts";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

/** Claude Code 把 cwd 编码成目录名（/ 和 . 替换为 -），找该目录下任务开始后最新的 transcript */
function findTranscript(cwd: string, sinceIso: string): string | null {
  const since = new Date(sinceIso).getTime() - 60_000;
  const candidates = [cwd.replaceAll("/", "-"), cwd.replaceAll(/[/.]/g, "-")];
  for (const name of candidates) {
    const dir = join(CLAUDE_PROJECTS, name);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .filter((f) => f.mtime >= since)
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length) return files[0].path;
  }
  return null;
}

/** 从 transcript 提取对话文本（user/assistant 的 text 部分），控制总长度 */
function extractConversation(transcriptPath: string, maxChars = 15_000): string {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const role = e.type === "user" ? "USER" : e.type === "assistant" ? "ASSISTANT" : null;
      if (!role) continue;
      const content = e.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      }
      text = text.trim();
      if (text) out.push(`[${role}] ${text.slice(0, 2000)}`);
    } catch { /* skip */ }
  }
  let joined = out.join("\n\n");
  if (joined.length > maxChars) joined = "…(前文截断)…\n" + joined.slice(-maxChars);
  return joined;
}

async function gitSummary(cwd: string): Promise<string> {
  const status = await run(["git", "-C", cwd, "status", "--short"], { timeoutMs: 15_000 });
  const logR = await run(["git", "-C", cwd, "log", "--oneline", "-8"], { timeoutMs: 15_000 });
  const diff = await run(["git", "-C", cwd, "diff", "--stat", "HEAD"], { timeoutMs: 15_000 });
  return [
    "## git status --short", status.stdout.slice(0, 1500),
    "## 最近提交", logR.stdout.slice(0, 800),
    "## 未提交改动 diff --stat", diff.stdout.slice(0, 1500),
  ].join("\n");
}

/** 旁观会话手动落盘：任意 CC transcript（clawd / Terminal 会话）→ 总结 → vault 笔记 */
export async function harvestTranscript(transcriptPath: string, project: string, cwd: string): Promise<string | null> {
  const conversation = extractConversation(transcriptPath);
  if (conversation.length < 200) return null; // 没聊出东西的会话不值得落盘

  const prompt = [
    "把下面这次开发会话的过程总结成一条工作日志。输出严格 JSON（不要代码块）：",
    `{"title": "<简短有辨识度的标题，<=20字，不含特殊字符>",`,
    ` "problem": "<要解决什么问题/做什么改动>",`,
    ` "failed_attempts": "<失败的尝试和原因，没有则空字符串>",`,
    ` "solution": "<最终方案和关键实现细节>",`,
    ` "files_changed": "<涉及的文件和改动说明>"}`,
    "",
    `项目：${project}`,
    "",
    "=== git 状态 ===",
    existsSync(cwd) ? await gitSummary(cwd) : "(工作目录已不存在)",
    "",
    "=== 会话记录 ===",
    conversation,
  ].join("\n");

  const res = await llmJson(prompt);
  if (!res?.title) return null;

  // 新结构：inbox（按天）+ 项目 log（按月），工作/私人按路径分流
  const { appendKnowledge } = await import("./capture.ts");
  const entry = [
    `## ${fmt(new Date(), "time")} | ${project} | ${String(res.title).slice(0, 60)}`,
    `- **Problem**: ${res.problem || "(见会话)"}`,
    ...(res.failed_attempts ? [`- **Failed attempt**: ${res.failed_attempts}`] : []),
    `- **Solution**: ${res.solution || "(见会话)"}`,
    `- **Files**: ${res.files_changed || "(无)"}`,
    "", "",
  ].join("\n");
  appendKnowledge(cwd, project.toLowerCase(), entry);
  log(`harvest transcript: [${project}] ${res.title}`);
  return `${project}/${res.title}`;
}

/** 引擎任务的素材：原始日志能到几 MB（一次 6 小时会话实测 5MB），尾部 15k 只覆盖最后一两轮，
 *  拿它总结出来的必然是「最后干了啥」而不是「这个任务干了啥」。飞行记录是每轮幂等刷新的
 *  完整过程（prompts / 审批 / 命令 / git diff / 结论），当主素材；日志尾部只补最近的细节。
 *  没有飞行记录（旧式单发任务）退回原来的日志尾部。 */
function taskMaterial(t: WorkTask): string {
  const raw = t.logFile && existsSync(t.logFile) ? readFileSync(t.logFile, "utf8") : "";
  const flight = t.flightPath && existsSync(t.flightPath) ? readFileSync(t.flightPath, "utf8") : "";
  if (!flight) return raw.length > 15_000 ? "…(前文截断)…\n" + raw.slice(-15_000) : raw;
  const parts = [
    "--- 飞行记录（完整过程：prompts / 审批 / 命令 / git）---",
    flight.length > 12_000 ? flight.slice(0, 12_000) + "\n…(飞行记录截断)…" : flight,
  ];
  if (raw) {
    parts.push("", "--- 原始日志尾部（最近细节）---",
      raw.length > 4_000 ? "…(前文截断)…\n" + raw.slice(-4_000) : raw);
  }
  return parts.join("\n");
}

/** 收割一个任务：提取过程 → codex 总结 → 写 vault 笔记。返回笔记路径或 null。
 *  可重复调用：条目按任务 id 幂等覆盖，多轮任务每次重收都是刷新同一条，不会越积越多。 */
export async function harvestTask(t: WorkTask): Promise<string | null> {
  let process_ = "";
  if (t.mode === "terminal") {
    const transcript = findTranscript(t.cwd, t.startedAt);
    if (!transcript) { log(`harvest [${t.id}]: 未找到 transcript（会话可能还没开始/结束）`); return null; }
    process_ = extractConversation(transcript);
  } else {
    process_ = taskMaterial(t);
    if (!process_ && t.engine) try { const state=await (await import("./session-service.ts")).createSessionService(t.id,[t.cwd,...(t.extraDirs??[])]).state(t.id);process_=(state.messages??[]).filter((m:any)=>!(m.role==="system"&&["history","diagnostic"].includes(String(m.name||"")))).map((m:any)=>`[${m.role}] ${m.text}`).join("\n"); } catch { /* flight/log fallback below */ }
    if (!process_) { log(`harvest [${t.id}]: 无可验证的会话记录`); return null; }
  }

  const prompt = [
    "把下面这次编码任务的过程总结成一条工作日志。输出严格 JSON（不要代码块）：",
    `{"title": "<简短有辨识度的标题，<=20字，不含特殊字符>",`,
    ` "problem": "<要解决什么问题/做什么改动>",`,
    ` "failed_attempts": "<失败的尝试和原因，没有则空字符串>",`,
    ` "solution": "<最终方案和关键实现细节>",`,
    ` "files_changed": "<涉及的文件和改动说明>"}`,
    "",
    `任务描述：${t.task}`,
    `项目：${t.project}${t.branch ? `（分支 ${t.branch}）` : ""}`,
    `结果：${t.exitCode === undefined ? "进行中/手动结束" : t.exitCode === 0 ? "正常退出" : `退出码 ${t.exitCode}`}`,
    "",
    "=== git 状态 ===",
    await gitSummary(t.cwd),
    "",
    "=== 过程记录 ===",
    process_,
  ].join("\n");

  const res = await llmJson(prompt);
  if (!res?.title) { log(`harvest [${t.id}]: codex 总结失败`); return null; }

  const { appendKnowledge } = await import("./capture.ts");
  // 标题时间固定用任务开始时间：重收时条目仍停在它该在的时间点上，覆盖也不会把顺序搅乱
  const started = new Date(t.startedAt);
  const entry = [
    `## ${fmt(started, "time")} | ${t.project} | ${String(res.title).slice(0, 60)}`,
    `- **Problem**: ${res.problem || t.task}`,
    ...(res.failed_attempts ? [`- **Failed attempt**: ${res.failed_attempts}`] : []),
    `- **Solution**: ${res.solution || "(见过程记录)"}`,
    `- **Files**: ${res.files_changed || "(无)"}`,
    `- 来源: Ownward 任务 \`${t.id}\`（${t.mode}${t.branch ? `，分支 ${t.branch}` : ""}）· 收割于 ${fmt(new Date(), "time")}`,
    "", "",
  ].join("\n");
  appendKnowledge(t.projectDir, t.project.toLowerCase(), entry, undefined, {
    key: `\`${t.id}\``, date: fmt(started, "date"),
  });
  log(`harvest [${t.id}]: [${t.project}] ${res.title}`);
  return `${t.project}/${res.title}`;
}

const HARVEST_QUIET_MS = 15 * 60_000;   // 会话沉寂多久算「这一段告一段落」，与 sweepCapture 对齐
const HARVEST_MAX_AGE_MS = 48 * 3600_000;

/** 多轮任务的收割补收。
 *
 *  背景（2026-07-17 c527f6b 埋下）：引擎任务只有首轮往日志写 OWNWARD_EXIT 走 reap，追问轮直接
 *  updateTask 收敛成 exited，reap 不再接手——通知不重复了，收割也一起没了。于是一个跑了 6 小时、
 *  追问 13 轮的任务，工作日志里永远停在第 3 分钟那个「还在读代码」的快照上。同一个根因在
 *  07-22（c57f5eb）给飞行记录修过（endTurn 里每轮 refreshFlightRecord），收割漏了。
 *
 *  这里不挂在 turn 边界上，改成按状态补：日志比上次收割新、且已经沉寂的任务重收一遍。
 *  好处是进程被闲杀、daemon 重启、任务异常死亡都同样兜得住，不依赖某个事件一定被触发到。
 *  只写笔记不发通知——当年耦合的正是这两件事。 */
export async function sweepHarvest(): Promise<void> {
  const { loadTasks, updateTask } = await import("./dispatch.ts");
  const now = Date.now();
  let budget = 2;   // 每轮最多重收 2 个，控模型成本
  for (const t of loadTasks()) {
    if (budget <= 0) break;
    if (t.kind === "routine") continue;                      // routine 状态机自己管，从不收割
    if (t.uncertain) continue;                               // unknown outcome 未人工收敛，禁止产出“已结束”记录
    if (t.mode === "terminal") continue;                     // terminal 由 finalizeTerminalTask 收尾
    const logMtime=t.logFile&&existsSync(t.logFile)?statSync(t.logFile).mtimeMs:0;
    const terminalAt=t.endedAt?Date.parse(t.endedAt):0;
    const mtime=Math.max(logMtime,terminalAt);
    if(!mtime)continue;
    if (now - mtime < HARVEST_QUIET_MS) continue;            // 还在动，等它停下来再收
    if (now - mtime > HARVEST_MAX_AGE_MS) continue;          // 太老不追溯
    const since = t.harvestedAt ? new Date(t.harvestedAt).getTime() : 0;
    if (t.harvested && mtime <= since) continue;             // 上次收割之后没有新内容
    budget--;
    try {
      const note = await harvestTask(t);
      if (note) updateTask(t.id, { harvested: true, harvestedAt: new Date().toISOString() });
      log(`re-harvest [${t.id}]: ${note ? "已刷新" : "无产出"}`);
    } catch (e) {
      log(`re-harvest [${t.id}] failed: ${e}`);
    }
  }
}
