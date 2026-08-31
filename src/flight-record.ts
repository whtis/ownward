// 任务飞行记录器：把「事后 prose 总结」升级成结构化飞行记录。
// 每个任务沉淀一份结构化 md（prompts / 审批决策 / 执行命令 / diff+commit / 结论 / 未完成项），
// 写入 Obsidian vault 的 <scope>/flights/，并双链回项目 README（[[<scope>/projects/<slug>/README|<slug>]]）。
// 与 harvest（codex prose 总结）互补：harvest 讲「问题→解决」，flight 讲「过程事实」。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { DevMsg, PlanStep, TokenUsage } from "./kernel/sessions/types.ts";
import type { DecisionAudit } from "./approval.ts";
import type { WorkTask } from "./dispatch.ts";
import type { KernelSessionState } from "./kernel/sessions/contracts.ts";
import { ALL_SCOPES, flightsDir, type Scope } from "./paths.ts";
import { DATA, fmt, log, run } from "./util.ts";

const AUDIT_FILE = join(DATA, "approval-audit.jsonl");
const MAX_FLIGHT_ATTEMPTS = 3; // 写失败的有限重试上限（durable 重试）

// —— 纯装配层（无 IO，单测覆盖）——

/** 项目名 → vault 里 projects/<slug> 的 slug（与 harvest 保持一致：小写项目名） */
export function slugOf(project: string): string {
  return project.trim().toLowerCase();
}

/** 双链回项目 README：带 scope 的完整路径，指得到真 README（旧的 [[<slug>]] 指不到）。
 *  不分流时 scope 为空，路径退化成 projects/<slug>/README */
export function projectLink(scope: Scope, slug: string): string {
  const prefix = scope ? `${scope}/` : "";
  return `[[${prefix}projects/${slug}/README|${slug}]]`;
}

/** 会话里所有 user 消息（首个通常是任务描述，后续是追问）。空白与机器补帧过滤掉 */
export function extractPrompts(messages: DevMsg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.text.trim())
    .filter(Boolean);
}

/** prompts + canonical 首 prompt 兜底：长会话裁剪后可能丢首个 prompt，用 task.task 补回。
 *  会话首条已是 canonical（正常情况）就不重复；首条是追问（被裁过）才把 canonical 顶到最前。 */
export function buildPrompts(messages: DevMsg[], canonicalTask?: string): string[] {
  const prompts = extractPrompts(messages);
  const canon = (canonicalTask || "").trim();
  if (!canon) return prompts;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!prompts.length) return [canon];
  if (norm(prompts[0]) !== norm(canon)) return [canon, ...prompts];
  return prompts;
}

/** 是否是「执行命令」类工具：CC 引擎 name=Bash，codex 回放 name=exec / exec_command */
export function isCommandTool(name?: string): boolean {
  return name === "Bash" || name === "exec" || name === "exec_command";
}

/** tool 消息里执行的命令。按序去重 */
export function extractCommands(messages: DevMsg[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    if (!isCommandTool(m.name)) continue;
    const cmd = m.text.trim();
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

/** 结论：最后一条有内容的 assistant 消息（截断） */
export function extractConclusion(messages: DevMsg[], max = 1200): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.text.trim()) {
      const t = m.text.trim();
      return t.length > max ? t.slice(0, max) + "…" : t;
    }
  }
  return "";
}

/** 未完成项：plan 里 status != completed 的步骤 */
export function extractUnfinished(plan: PlanStep[]): PlanStep[] {
  return (plan || []).filter((p) => p.status !== "completed");
}

/** 从审计流里筛该任务的决策条目（审计 taskId 即 ownward 任务 id） */
export function filterAudit(audit: DecisionAudit[], taskId: string): DecisionAudit[] {
  return audit.filter((a) => a.taskId === taskId);
}

// git 快照状态：区分几种情形，别把空仓库/非 git 目录误写成「无改动」
export type GitStatus = "clean" | "dirty" | "not-a-repo" | "empty-repo" | "error";

export interface GitIdentity {
  name: string;
  email: string;
}

export type GitIdentitySource = "frozen" | "repository-config" | "unavailable";

export interface GitInfo {
  status: GitStatus;
  base: string;         // 用作基线的 commit（startHead / merge-base），空=无基线
  diffStat: string;     // 归属于任务身份的 commits 聚合文件统计（不含他人 commit）
  commits: string;      // 归属于任务身份的 commit，保留 author/email/date 供审计
  untracked: string[];  // git status --porcelain 里的未跟踪文件（旧版漏了）
  workingTreeStat?: string;       // 当前未提交 tracked 改动，独立展示且不声称作者归属
  identity?: GitIdentity;         // 用于过滤 commit author 的身份
  identitySource?: GitIdentitySource;
  excludedCommitCount?: number;   // 基线范围内因 author 不匹配/身份不可用而排除的 commit 数
}

/** 纯分类：据 git 探针信号判定快照状态。error > not-a-repo > empty-repo > dirty/clean */
export function classifyGit(probe: {
  isRepo: boolean;
  hasHead: boolean;
  error: boolean;
  diffStat: string;
  commits: string;
  untracked: string[];
  workingTreeStat?: string;
}): GitStatus {
  if (probe.error) return "error";
  if (!probe.isRepo) return "not-a-repo";
  if (!probe.hasHead) return "empty-repo";
  const changed = !!probe.diffStat.trim() || !!probe.commits.trim() || !!probe.workingTreeStat?.trim() || probe.untracked.length > 0;
  return changed ? "dirty" : "clean";
}

export interface FlightInput {
  task: Pick<WorkTask, "id" | "project" | "branch"> & { backend?: string };
  canonicalTask?: string;   // task.task 原文：canonical 首 prompt 兜底
  messages: DevMsg[];
  audit: DecisionAudit[];
  git: GitInfo;
  plan: PlanStep[];
  tokens: TokenUsage;
  scope: Scope;
  now?: Date;
}

export interface FlightRecord {
  slug: string;
  filename: string;   // 相对 <scope>/flights/ 的文件名
  content: string;    // 完整 md（frontmatter + 正文）
}

/** 纯装配：给定消息/审计/git/plan → 结构化飞行记录 md。不做任何 IO */
export function assembleFlightRecord(input: FlightInput): FlightRecord {
  const now = input.now || new Date();
  const date = fmt(now, "date");
  const slug = slugOf(input.task.project);
  const backend = input.task.backend || "claude";
  const filename = `${date}-${slug}-${input.task.id}.md`;
  const link = projectLink(input.scope, slug);

  const prompts = buildPrompts(input.messages, input.canonicalTask);
  const commands = extractCommands(input.messages);
  const audit = filterAudit(input.audit, input.task.id);
  const conclusion = extractConclusion(input.messages);
  const unfinished = extractUnfinished(input.plan);

  // frontmatter：date/project/task_id/backend/tokens
  const tk = input.tokens || {};
  const tokenStr = tk.total ?? ((tk.input || 0) + (tk.output || 0));
  const fm = [
    "---",
    `type: flight_record`,
    `date: ${date}`,
    `project: ${slug}`,
    `task_id: ${input.task.id}`,
    `backend: ${backend}`,
    input.task.branch ? `branch: ${input.task.branch}` : null,
    `tokens: ${tokenStr}`,
    `git: ${input.git.status}`,
    input.scope ? `scope: ${input.scope}` : null,
    "---",
  ].filter(Boolean).join("\n");

  const body: string[] = [];
  body.push(`# ✈️ 飞行记录 · ${slug} · ${input.task.id}`, "");
  // 顶部双链回项目 README（Obsidian 反链，带 scope 完整路径）
  body.push(`> 项目：${link}`, "");

  // Prompts（首个=任务描述，后续=追问）
  body.push("## Prompts");
  if (prompts.length) {
    prompts.forEach((p, i) => {
      const label = i === 0 ? "任务" : `追问 ${i}`;
      body.push(`${i + 1}. **${label}**：${oneLine(p, 500)}`);
    });
  } else {
    body.push("(无)");
  }
  body.push("");

  // 审批决策
  body.push("## 审批决策");
  if (audit.length) {
    for (const a of audit) {
      const who = a.by === "rule" ? "规则自动" : a.by === "user" ? "人工" : "系统";
      const scope = a.ruleScope ? `/${a.ruleScope}` : "";
      body.push(`- \`${a.pattern}\` → **${a.decision}**（${who}${scope}）${a.detail ? ` — ${oneLine(a.detail, 120)}` : ""}`);
    }
  } else {
    body.push("(无高危操作或未触发审批)");
  }
  body.push("");

  // 执行的命令
  body.push("## 执行的命令");
  if (commands.length) {
    body.push("```bash");
    for (const c of commands) body.push(c);
    body.push("```");
  } else {
    body.push("(无)");
  }
  body.push("");

  // diff / commit：按 git 快照状态区分几种情形
  body.push("## 改动");
  renderGit(body, input.git);
  body.push("");

  // 结论
  body.push("## 结论");
  body.push(conclusion || "(无 assistant 结论)");
  body.push("");

  // 未完成项
  body.push("## 未完成项");
  if (unfinished.length) {
    for (const s of unfinished) body.push(`- [ ] ${s.text}（${s.status}）`);
  } else {
    body.push("(计划全部完成或无计划)");
  }
  body.push("");

  // 底部再放一次双链，方便从文末跳回
  body.push("---", `关联项目：${link}`, "");

  return { slug, filename, content: `${fm}\n\n${body.join("\n")}` };
}

/** 供 harvest prompt 和飞行记录共用同一份、已做作者归属的 git 证据。 */
export function formatGitSummary(g: GitInfo): string {
  const body: string[] = [];
  renderGit(body, g);
  return body.join("\n");
}

/** 「改动」小节渲染：区分 clean / dirty / not-a-repo / empty-repo / error */
function renderGit(body: string[], g: GitInfo) {
  if (g.status === "not-a-repo") {
    body.push("(非 git 仓库，无版本快照)");
    return;
  }
  if (g.status === "error") {
    body.push("(git 快照读取失败，可能工作目录已被清理)");
    return;
  }
  if (g.status === "empty-repo") {
    body.push("(空仓库，无提交基线)");
    if (g.untracked.length) {
      body.push("### 未跟踪文件（untracked）");
      body.push(codeBlock(g.untracked.join("\n")));
    }
    return;
  }
  if (g.identity) {
    const source = g.identitySource === "frozen" ? "派发时冻结" : "历史任务兜底：收割时仓库配置";
    body.push(`> 提交归属身份：\`${g.identity.name} <${g.identity.email}>\`（${source}）`);
  } else if (g.identitySource === "unavailable") {
    body.push("> 未取得可靠 Git 作者身份；为避免误归属，不计入基线后的任何提交。");
  }
  if (g.excludedCommitCount) {
    body.push(`> 已排除 ${g.excludedCommitCount} 条不属于该身份或无法可靠归属的提交。`);
  }
  if (g.status === "clean") {
    body.push("(未发现归属于任务身份的提交或当前未提交改动)");
    if (g.base) body.push("", `> 基线：\`${g.base.slice(0, 12)}\``);
    return;
  }
  // dirty
  body.push("### 任务身份提交的文件统计");
  body.push(g.diffStat.trim() ? codeBlock(g.diffStat.trim()) : "(无归属于任务身份的已提交改动)");
  if (g.workingTreeStat?.trim()) {
    body.push("### 当前未提交改动（不做作者归属）");
    body.push(codeBlock(g.workingTreeStat.trim()));
  }
  if (g.untracked.length) {
    body.push("### 当前未跟踪文件（不做作者归属）");
    body.push(codeBlock(g.untracked.join("\n")));
  }
  body.push("### 归属该身份的提交（commit）");
  body.push(g.commits.trim() ? codeBlock(g.commits.trim()) : "(无归属于任务身份的新提交)");
  if (g.base) body.push("", `> 基线：\`${g.base.slice(0, 12)}\``);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function codeBlock(s: string): string {
  return "```\n" + s + "\n```";
}

// —— IO 层（daemon reap / capture 调用）——

/** 读审计流（jsonl，逐行 parse，坏行跳过） */
function readAudit(): DecisionAudit[] {
  try {
    return readFileSync(AUDIT_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as DecisionAudit; } catch { return null; } })
      .filter((x): x is DecisionAudit => !!x);
  } catch { return []; }
}

export interface TaskGitContext {
  cwd: string;
  startHead?: string;
  gitIdentity?: GitIdentity;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

/** 解析该仓库实际生效的 user.name/user.email。旧任务没有冻结身份时只用这个显式兜底，绝不猜作者。 */
export async function resolveGitIdentity(cwd: string): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    run(["git", "-C", cwd, "config", "--get", "user.name"], { timeoutMs: 10_000 }),
    run(["git", "-C", cwd, "config", "--get", "user.email"], { timeoutMs: 10_000 }),
  ]);
  const identity = { name: name.stdout.trim(), email: email.stdout.trim() };
  return name.code === 0 && email.code === 0 && identity.name && identity.email ? identity : null;
}

function parseCommitLog(raw: string): GitCommit[] {
  return raw.split("\x1e").map((record) => record.trim()).filter(Boolean).flatMap((record) => {
    const [hash, shortHash, authorName, authorEmail, authoredAt, ...subject] = record.split("\x1f");
    return hash && shortHash && authorName && authorEmail && authoredAt
      ? [{ hash, shortHash, authorName, authorEmail, authoredAt, subject: subject.join("\x1f") }]
      : [];
  });
}

function belongsToIdentity(commit: GitCommit, identity: GitIdentity): boolean {
  return commit.authorName.trim() === identity.name.trim()
    && commit.authorEmail.trim().toLowerCase() === identity.email.trim().toLowerCase();
}

async function ownerCommitStats(cwd: string, commits: GitCommit[]): Promise<{ text: string; error: boolean }> {
  if (!commits.length) return { text: "", error: false };
  const shown = await run([
    "git", "-C", cwd, "show", "--numstat", "--format=", "--no-renames",
    ...commits.map((commit) => commit.hash), "--",
  ], { timeoutMs: 30_000 });
  if (shown.code !== 0) return { text: "", error: true };

  const files = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (const line of shown.stdout.split("\n")) {
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").trim();
    if (!path || addedRaw === undefined || deletedRaw === undefined) continue;
    const previous = files.get(path) || { added: 0, deleted: 0, binary: false };
    const added = Number(addedRaw), deleted = Number(deletedRaw);
    if (Number.isFinite(added) && Number.isFinite(deleted)) {
      previous.added += added;
      previous.deleted += deleted;
    } else {
      previous.binary = true;
    }
    files.set(path, previous);
  }
  const text = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, stat]) => ` ${path} | ${stat.binary ? "binary" : `+${stat.added} -${stat.deleted}`}`)
    .join("\n");
  return { text, error: false };
}

/** 任务级 git 快照：基线范围内只保留冻结作者的提交，文件统计从这些提交逐条聚合；
 *  当前工作树改动另列为未归属现场状态。旧任务缺身份时读取当前仓库配置并明确标注兜底来源。 */
export async function gitSnapshot(context: TaskGitContext): Promise<GitInfo> {
  const { cwd, startHead } = context;
  const blank: GitInfo = { status: "error", base: "", diffStat: "", commits: "", untracked: [] };
  // 目录已不存在（worktree 被清）：git-error，别误报「无改动」
  if (!cwd || !existsSync(cwd)) return blank;

  const inside = await run(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 10_000 });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ...blank, status: "not-a-repo" };
  }

  const head = await run(["git", "-C", cwd, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
  const hasHead = head.code === 0 && !!head.stdout.trim();

  // 基线：持久化 startHead（校验仍可达）> merge-base master/main
  let base = "";
  if (startHead && hasHead) {
    const ok = await run(["git", "-C", cwd, "cat-file", "-e", `${startHead}^{commit}`], { timeoutMs: 10_000 });
    if (ok.code === 0) base = startHead;
  }
  if (!base && hasHead) {
    for (const ref of ["master", "main"]) {
      const mb = await run(["git", "-C", cwd, "merge-base", ref, "HEAD"], { timeoutMs: 15_000 });
      if (mb.code === 0 && mb.stdout.trim()) { base = mb.stdout.trim(); break; }
    }
  }

  const frozen = context.gitIdentity?.name.trim() && context.gitIdentity.email.trim()
    ? { name: context.gitIdentity.name.trim(), email: context.gitIdentity.email.trim() }
    : null;
  const identity = frozen || await resolveGitIdentity(cwd);
  const identitySource: GitIdentitySource = frozen ? "frozen" : identity ? "repository-config" : "unavailable";

  // 当前工作树是“现在看到的现场”，可能来自共享目录的任意进程，因此与已提交作者证据分开且不归属。
  const st = await run(["git", "-C", cwd, "status", "--porcelain"], { timeoutMs: 15_000 });
  const untracked = st.code === 0
    ? st.stdout.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).trim()).filter(Boolean)
    : [];

  let diffStat = "", commits = "", workingTreeStat = "", excludedCommitCount = 0;
  let error = st.code !== 0;
  if (hasHead) {
    const working = await run(["git", "-C", cwd, "diff", "--stat", "HEAD"], { timeoutMs: 20_000 });
    if (working.code !== 0) error = true; else workingTreeStat = (working.stdout || "").slice(0, 4000);
    if (base) {
      const logr = await run([
        "git", "-C", cwd, "log", `${base}..HEAD`,
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
      ], { timeoutMs: 20_000 });
      if (logr.code !== 0) {
        error = true;
      } else {
        const allCommits = parseCommitLog(logr.stdout || "");
        const ownerCommits = identity ? allCommits.filter((commit) => belongsToIdentity(commit, identity)) : [];
        excludedCommitCount = allCommits.length - ownerCommits.length;
        commits = ownerCommits.map((commit) =>
          `${commit.shortHash} | ${commit.authorName} <${commit.authorEmail}> | ${commit.authoredAt} | ${commit.subject}`,
        ).join("\n").slice(0, 4000);
        const stats = await ownerCommitStats(cwd, ownerCommits);
        if (stats.error) error = true; else diffStat = stats.text.slice(0, 4000);
      }
    }
  }

  const status = classifyGit({ isRepo: true, hasHead, error, diffStat, commits, workingTreeStat, untracked });
  return { status, base, diffStat, commits, workingTreeStat, untracked, identity: identity || undefined, identitySource, excludedCommitCount };
}

/** 兜底素材：codex-bg / terminal 无会话消息时，用 canonical task + 日志尾部拼一个最小 messages，
 *  让装配层照常出记录（不再直接跳过、按钮 404）。 */
function fallbackMessages(task: WorkTask): DevMsg[] {
  const msgs: DevMsg[] = [{ role: "user", text: task.task || "(无任务描述)", ts: task.startedAt }];
  try {
    if (task.logFile && existsSync(task.logFile)) {
      const raw = readFileSync(task.logFile, "utf8");
      const tail = raw.length > 4000 ? "…(前文截断)…\n" + raw.slice(-4000) : raw;
      if (tail.trim()) msgs.push({ role: "assistant", text: tail.trim(), ts: task.endedAt || task.startedAt });
    }
  } catch { /* 日志读不到就只留任务描述 */ }
  return msgs;
}

/** 原子写：tmp + rename，避免半截文件被 findFlightRecord 读到 */
function atomicWrite(path: string, content: string) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** 按 task id 定位已落盘的飞行记录 md（文件名以 -<taskid>.md 结尾）。所有 scope 都找 */
export function findFlightRecord(taskId: string): string | null {
  for (const scope of ALL_SCOPES) {
    const dir = flightsDir(scope);
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.endsWith(`-${taskId}.md`) && !f.includes(".tmp."));
    if (hit) return join(dir, hit);
  }
  return null;
}

/** 实际装配 + 原子落盘，成功返回路径，失败抛错（由 writeFlightRecord 捕获并记 flightState） */
async function tryWriteFlight(task: WorkTask): Promise<string> {
  const { SessionRepository } = await import("./sessions/repository.ts");
  const { scopeOf } = await import("./capture.ts");

  let state: KernelSessionState | null = null;
  try { const session = new SessionRepository(DATA).getByTaskId(task.id); if (session) state = await (await import("./session-service.ts")).createSessionService(task.id, [session.cwd, ...(session.extraDirs ?? [])]).state(task.id); } catch { /* terminal/旧磁盘会话走兜底 */ }

  let messages = state?.messages || [];
  if (!messages.length) messages = fallbackMessages(task);

  const git = await gitSnapshot({ cwd: task.cwd, startHead: task.startHead, gitIdentity: task.gitIdentity });
  const scope = scopeOf(task.cwd);
  const record = assembleFlightRecord({
    task: { id: task.id, project: task.project, branch: task.branch, backend: state?.backend },
    canonicalTask: task.task,
    messages,
    audit: readAudit(),
    git,
    plan: (state?.plan as PlanStep[]) || [],
    tokens: (state?.tokens as TokenUsage) || {},
    scope,
  });

  const dir = flightsDir(scope);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, record.filename);
  atomicWrite(path, record.content);
  log(`flight [${task.id}]: ${scope ? `${scope}/` : ""}flights/${record.filename} (git:${git.status})`);
  return path;
}

// per-task single-flight：多轮 upsert / reap / 重试可能并发写同一任务，串行化避免
// ①两次写互相截断 ②晚到的失败把已成功的 written 回退成 failed 隐藏按钮（codex review）
const flightInFlight = new Map<string, Promise<string | null>>();

/** 写一份结构化飞行记录到 <scope>/flights/，双链回项目 README。
 *  记 flightState（written/failed）供客户端门控 + durable 重试。返回文件路径或 null */
export function writeFlightRecord(task: WorkTask): Promise<string | null> {
  // 同一任务已有写在跑：复用它（合并这次请求），不叠第二次并发写
  const running = flightInFlight.get(task.id);
  if (running) return running;
  const p = (async () => {
    const { updateTask, loadTasks } = await import("./dispatch.ts");
    try {
      const path = await tryWriteFlight(task);
      updateTask(task.id, { flightState: "written", flightPath: path, flightAttempts: 0 });
      return path;
    } catch (e) {
      const cur = loadTasks().find((t) => t.id === task.id);
      // 已经成功写过（written）就别被一次晚到的失败回退——只累计尝试数
      const attempts = (cur?.flightAttempts || 0) + 1;
      const patch: Partial<WorkTask> = { flightAttempts: attempts };
      if (cur?.flightState !== "written") patch.flightState = "failed";
      updateTask(task.id, patch);
      log(`flight [${task.id}] failed (attempt ${attempts}/${MAX_FLIGHT_ATTEMPTS}): ${e}`);
      return null;
    } finally {
      flightInFlight.delete(task.id);
    }
  })();
  flightInFlight.set(task.id, p);
  return p;
}

/** durable 重试：扫出 flightState=failed 且未超上限的任务，重试写飞行记录。daemon 定时调 */
export async function sweepFlights(): Promise<void> {
  const { loadTasks } = await import("./dispatch.ts");
  const pending = loadTasks()
    .filter((t) =>
      t.status !== "running" &&
      t.kind !== "routine" &&
      t.flightState === "failed" &&
      (t.flightAttempts || 0) < MAX_FLIGHT_ATTEMPTS)
    .slice(0, 3);
  for (const t of pending) {
    try { await writeFlightRecord(t); } catch (e) { log(`flight retry [${t.id}] failed: ${e}`); }
  }
}
