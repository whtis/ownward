// Repo 状态栏：引擎任务的验收落地面——看状态/diff、commit、push、开 PR、清 worktree。
// 全部在任务的 cwd 里执行；worktree 清理有脏检查。
import { isStrictlyWithin } from "./path-within.ts";
import { existsSync } from "fs";
import { join, normalize } from "path";
import { loadTasks, updateTask } from "./dispatch.ts";
import { log, run } from "./util.ts";

export interface RepoStatus {
  branch: string;
  dirty: number;         // 未提交文件数
  ahead: number;
  behind: number;
  statusShort: string;
  diffStat: string;
  recentLog: string;
  isWorktree: boolean;
}

function taskCwd(id: string): { cwd: string; projectDir: string } {
  const t = loadTasks().find((x) => x.id === id);
  if (!t) throw new Error("任务不存在");
  if (!existsSync(t.cwd)) throw new Error("工作目录已不存在（可能已清理）");
  return { cwd: t.cwd, projectDir: t.projectDir };
}

/** 任务 diff 基线：优先派发时冻结的 startHead——agent 常自己 commit，只 diff HEAD 会把
 *  「已提交的活」全漏掉（用户看到的就是一句"工作区干净"）。startHead 失效（rebase/换仓）回退 HEAD。 */
async function diffBase(cwd: string, id: string): Promise<string> {
  const sh = loadTasks().find((x) => x.id === id)?.startHead;
  if (!sh) return "HEAD";
  const ok = await run(["git", "-C", cwd, "merge-base", "--is-ancestor", sh, "HEAD"], { timeoutMs: 10_000 });
  return ok.code === 0 ? sh : "HEAD";
}

export async function repoStatus(id: string): Promise<RepoStatus> {
  const { cwd, projectDir } = taskCwd(id);
  const g = (args: string[]) => run(["git", "-C", cwd, ...args], { timeoutMs: 15_000 });
  const base = await diffBase(cwd, id);
  const [branch, status, diffStat, logR, count] = await Promise.all([
    g(["branch", "--show-current"]),
    g(["status", "--short"]),
    g(["diff", "--stat", base]),
    g(["log", "--oneline", "-5"]),
    g(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);
  const [behind, ahead] = count.code === 0
    ? count.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0)
    : [0, 0];
  return {
    branch: branch.stdout.trim() || "(detached)",
    dirty: status.stdout.split("\n").filter(Boolean).length,
    ahead, behind,
    statusShort: status.stdout.slice(0, 2000),
    diffStat: diffStat.stdout.split("\n").slice(-3).join("\n").trim(),
    recentLog: logR.stdout.slice(0, 1000),
    isWorktree: cwd !== projectDir,
  };
}

export async function repoDiff(id: string): Promise<string> {
  const { cwd } = taskCwd(id);
  const base = await diffBase(cwd, id);
  const r = await run(["git", "-C", cwd, "diff", base], { timeoutMs: 30_000 });
  const untracked = await run(["git", "-C", cwd, "ls-files", "--others", "--exclude-standard"], { timeoutMs: 15_000 });
  let out = base !== "HEAD" ? `=== 任务全量改动 ${base.slice(0, 8)}..工作区（含 agent 已提交部分）===\n${r.stdout}` : r.stdout;
  if (untracked.stdout.trim()) out += `\n\n=== 未跟踪的新文件 ===\n${untracked.stdout}`;
  const CAP = 200 * 1024;
  return out.length > CAP ? out.slice(0, CAP) + "\n…(截断)" : out || "(无改动)";
}

/** 在 VSCode 打开任务目录（worktree 任务开的就是 worktree）；带 file 时定位到具体文件。
 *  daemon 的 launchd PATH 不含 /usr/local/bin，code CLI 用绝对路径，LaunchServices 兜底。 */
export async function openInEditor(id: string, file?: string): Promise<string> {
  const { cwd } = taskCwd(id);
  let target = cwd;
  if (file) {
    target = normalize(join(cwd, file));
    if (!isStrictlyWithin(cwd, target)) throw new Error("非法文件路径");   // 防目录逃逸
  }
  for (const cmd of [
    file ? ["/usr/local/bin/code", "-g", target] : ["/usr/local/bin/code", cwd],
    ["open", "-a", "Visual Studio Code", target],
  ]) {
    const r = await run(cmd, { timeoutMs: 10_000 });
    if (r.code === 0) return "已在 VSCode 打开";
  }
  throw new Error("VSCode 打不开（code CLI 与 open -a 都失败）");
}

/** 一轮结束后的改动摘要（相对轮开始的 head，含 agent 本轮 commit 的部分）：无改动/非 git 仓库返回 null。
 *  首行 shortstat，随后 name-status 文件行（M\tpath），未跟踪文件加 ? 前缀。喂消息流的「本轮改动卡片」。 */
export async function turnChanges(cwd: string, base: string): Promise<string | null> {
  const g = (args: string[]) => run(["git", "-C", cwd, ...args], { timeoutMs: 15_000 });
  const [stat, names, untracked] = await Promise.all([
    g(["diff", "--shortstat", base]),
    g(["diff", "--name-status", base]),
    g(["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (stat.code !== 0) return null;
  const files = names.stdout.trim();
  const extra = untracked.stdout.trim();
  if (!files && !extra) return null;
  const lines = [stat.stdout.trim() || "新增未跟踪文件"];
  if (files) lines.push(...files.split("\n").slice(0, 20));
  if (extra) lines.push(...extra.split("\n").slice(0, 10).map((f) => `?\t${f}`));
  return lines.join("\n");
}

export type RepoAction = "commit" | "push" | "pr" | "clean";

export async function repoAct(id: string, action: RepoAction, msg?: string): Promise<string> {
  const { cwd, projectDir } = taskCwd(id);
  const g = (args: string[], t = 30_000) => run(["git", "-C", cwd, ...args], { timeoutMs: t });

  if (action === "commit") {
    if (!msg?.trim()) throw new Error("需要 commit message");
    await g(["add", "-A"]);
    const r = await g(["commit", "-m", msg.trim()]);
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 200) || r.stdout.slice(0, 200));
    return "已提交";
  }
  if (action === "push") {
    const branch = (await g(["branch", "--show-current"])).stdout.trim();
    const r = await g(["push", "-u", "origin", branch], 60_000);
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
    return `已推送 ${branch}`;
  }
  if (action === "pr") {
    const branch = (await g(["branch", "--show-current"])).stdout.trim();
    await g(["push", "-u", "origin", branch], 60_000); // pr 前确保远端有分支
    const r = await run(["gh", "pr", "create", "--fill", "--head", branch], { timeoutMs: 60_000, cwd });
    if (r.code !== 0) {
      // 已存在 PR 时 gh 会报错并带 URL，透传给用户
      throw new Error((r.stderr || r.stdout).slice(0, 300));
    }
    const url = r.stdout.trim().split("\n").pop() || "";
    log(`pr created: ${url}`);
    return url;
  }
  if (action === "clean") {
    if (cwd === projectDir) throw new Error("原地任务没有 worktree 可清");
    const dirty = await g(["status", "--porcelain"]);
    if (dirty.stdout.trim()) throw new Error("worktree 有未提交改动，先 commit 或明确放弃");
    const r = await run(["git", "-C", projectDir, "worktree", "remove", cwd], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 200));
    updateTask(id, { status: "done" });
    return "worktree 已清理";
  }
  throw new Error(`未知动作 ${action}`);
}
