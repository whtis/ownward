// 飞行记录装配的单测：锁死纯逻辑（prompts/命令去重/审批筛选/未完成项/双链/frontmatter/
// git 状态分类/命令名规范化/canonical 首 prompt 兜底/带 scope 双链路径）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DevMsg, PlanStep } from "./agent-session.ts";
import type { DecisionAudit } from "./approval.ts";
import {
  assembleFlightRecord,
  buildPrompts,
  classifyGit,
  extractCommands,
  extractConclusion,
  extractPrompts,
  extractUnfinished,
  filterAudit,
  gitSnapshot,
  isCommandTool,
  projectLink,
  slugOf,
  type GitInfo,
} from "./flight-record.ts";

const tempRepos: string[] = [];
afterEach(() => {
  for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function attributionRepo() {
  const repo = mkdtempSync(join(tmpdir(), "ownward-flight-git-"));
  tempRepos.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.com");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-q", "-m", "base");
  const startHead = git(repo, "rev-parse", "HEAD");

  writeFileSync(join(repo, "owner.txt"), "owner\n");
  git(repo, "add", "owner.txt");
  git(repo, "commit", "-q", "-m", "owner change");

  writeFileSync(join(repo, "foreign.txt"), "foreign\n");
  git(repo, "add", "foreign.txt");
  git(repo, "-c", "user.name=Foreign", "-c", "user.email=foreign@example.com", "commit", "-q", "-m", "foreign change");

  writeFileSync(join(repo, "owner.txt"), "owner\nworking tree\n");
  writeFileSync(join(repo, "scratch.txt"), "untracked\n");
  return { repo, startHead };
}

const now = new Date("2026-07-22T10:30:00+08:00");

const messages: DevMsg[] = [
  { role: "user", text: "实现飞行记录器", ts: "t1" },
  { role: "thinking", text: "先看代码", ts: "t2" },
  { role: "tool", name: "Bash", text: "git status", ts: "t3" },
  { role: "tool", name: "Read", text: "src/foo.ts", ts: "t4" },
  { role: "tool", name: "Bash", text: "git status", ts: "t5" },   // 重复，应去重
  { role: "tool", name: "exec", text: "bun test", ts: "t6" },     // codex 风格
  { role: "tool", name: "exec_command", text: "ls -la", ts: "t6b" }, // codex 回放风格
  { role: "assistant", text: "第一版做完了", ts: "t7" },
  { role: "user", text: "再加个双链", ts: "t8" },                 // 追问
  { role: "assistant", text: "已加上双链，完成", ts: "t9" },
];

const audit: DecisionAudit[] = [
  { at: "a1", taskId: "20260722-abcd", toolName: "Bash", pattern: "git push", kind: "bash", decision: "allow", by: "user", ruleScope: "session", detail: "git push origin x" },
  { at: "a2", taskId: "OTHER", toolName: "Bash", pattern: "rm -rf", kind: "bash", decision: "deny", by: "user" },
];

const plan: PlanStep[] = [
  { text: "写模块", status: "completed" },
  { text: "接 daemon", status: "in_progress" },
  { text: "写测试", status: "pending" },
];

const dirtyGit: GitInfo = {
  status: "dirty",
  base: "abc123deadbeef",
  diffStat: " src/flight-record.ts | 200 +++",
  commits: "abc123 feat: 飞行记录",
  untracked: ["src/new-file.ts"],
};

describe("flight-record 纯逻辑", () => {
  test("extractPrompts 只取 user 消息、按序", () => {
    expect(extractPrompts(messages)).toEqual(["实现飞行记录器", "再加个双链"]);
  });

  test("isCommandTool 认 Bash/exec/exec_command，其它不认", () => {
    expect(isCommandTool("Bash")).toBe(true);
    expect(isCommandTool("exec")).toBe(true);
    expect(isCommandTool("exec_command")).toBe(true);
    expect(isCommandTool("Read")).toBe(false);
    expect(isCommandTool(undefined)).toBe(false);
  });

  test("extractCommands 取 Bash/exec/exec_command、去重保序、忽略其它工具", () => {
    expect(extractCommands(messages)).toEqual(["git status", "bun test", "ls -la"]);
  });

  test("extractConclusion 取最后一条 assistant", () => {
    expect(extractConclusion(messages)).toBe("已加上双链，完成");
  });

  test("extractUnfinished 只留非 completed", () => {
    expect(extractUnfinished(plan).map((p) => p.text)).toEqual(["接 daemon", "写测试"]);
  });

  test("filterAudit 只筛本任务 taskId", () => {
    expect(filterAudit(audit, "20260722-abcd").length).toBe(1);
    expect(filterAudit(audit, "20260722-abcd")[0].pattern).toBe("git push");
  });

  test("slugOf 小写化项目名", () => {
    expect(slugOf("Ownward")).toBe("ownward");
  });

  test("projectLink 带 scope 的完整 README 路径", () => {
    expect(projectLink("work", "ownward")).toBe("[[work/projects/ownward/README|ownward]]");
    expect(projectLink("private", "demo")).toBe("[[private/projects/demo/README|demo]]");
  });
});

describe("buildPrompts canonical 首 prompt 兜底", () => {
  test("会话首条已是 canonical：不重复", () => {
    expect(buildPrompts(messages, "实现飞行记录器")).toEqual(["实现飞行记录器", "再加个双链"]);
  });

  test("会话被裁剪、首条是追问：canonical 顶到最前", () => {
    const truncated: DevMsg[] = [{ role: "user", text: "再加个双链", ts: "x" }];
    expect(buildPrompts(truncated, "实现飞行记录器")).toEqual(["实现飞行记录器", "再加个双链"]);
  });

  test("完全无会话消息：只留 canonical", () => {
    expect(buildPrompts([], "实现飞行记录器")).toEqual(["实现飞行记录器"]);
  });

  test("无 canonical：原样返回", () => {
    expect(buildPrompts(messages, "")).toEqual(["实现飞行记录器", "再加个双链"]);
  });
});

describe("classifyGit 基线状态分类", () => {
  const probe = (o: Partial<Parameters<typeof classifyGit>[0]>) =>
    classifyGit({ isRepo: true, hasHead: true, error: false, diffStat: "", commits: "", untracked: [], ...o });

  test("error 优先级最高", () => {
    expect(probe({ error: true, isRepo: false })).toBe("error");
  });
  test("非 git 仓库", () => {
    expect(probe({ isRepo: false })).toBe("not-a-repo");
  });
  test("空仓库（无 HEAD）", () => {
    expect(probe({ hasHead: false })).toBe("empty-repo");
  });
  test("干净工作树", () => {
    expect(probe({})).toBe("clean");
  });
  test("有 diff / commit / untracked 任一 → dirty", () => {
    expect(probe({ diffStat: " a | 1 +" })).toBe("dirty");
    expect(probe({ commits: "abc x" })).toBe("dirty");
    expect(probe({ workingTreeStat: " b | 1 +" })).toBe("dirty");
    expect(probe({ untracked: ["new.ts"] })).toBe("dirty");
  });
});

describe("gitSnapshot 任务作者归属", () => {
  test("只计入冻结身份的提交，保留作者审计信息并单列当前未提交改动", async () => {
    const { repo, startHead } = attributionRepo();
    const snapshot = await gitSnapshot({
      cwd: repo,
      startHead,
      gitIdentity: { name: "Owner", email: "owner@example.com" },
    });

    expect(snapshot.identitySource).toBe("frozen");
    expect(snapshot.commits).toContain("Owner <owner@example.com>");
    expect(snapshot.commits).toContain("owner change");
    expect(snapshot.commits).not.toContain("foreign change");
    expect(snapshot.diffStat).toContain("owner.txt");
    expect(snapshot.diffStat).not.toContain("foreign.txt");
    expect(snapshot.workingTreeStat).toContain("owner.txt");
    expect(snapshot.untracked).toEqual(["scratch.txt"]);
    expect(snapshot.excludedCommitCount).toBe(1);
  });

  test("历史任务没有冻结身份时显式使用仓库配置，不从提交历史猜作者", async () => {
    const { repo, startHead } = attributionRepo();
    const snapshot = await gitSnapshot({ cwd: repo, startHead });

    expect(snapshot.identitySource).toBe("repository-config");
    expect(snapshot.identity).toEqual({ name: "Owner", email: "owner@example.com" });
    expect(snapshot.commits).toContain("owner change");
    expect(snapshot.commits).not.toContain("foreign change");
    expect(snapshot.diffStat).not.toContain("foreign.txt");
  });

  test("历史任务且仓库身份不可用时不归属任何提交", async () => {
    const { repo, startHead } = attributionRepo();
    git(repo, "config", "user.name", "");
    git(repo, "config", "user.email", "");
    const snapshot = await gitSnapshot({ cwd: repo, startHead });

    expect(snapshot.identitySource).toBe("unavailable");
    expect(snapshot.identity).toBeUndefined();
    expect(snapshot.commits).toBe("");
    expect(snapshot.diffStat).toBe("");
    expect(snapshot.excludedCommitCount).toBe(2);
    expect(snapshot.workingTreeStat).toContain("owner.txt");
  });
});

describe("assembleFlightRecord 整体装配", () => {
  const rec = assembleFlightRecord({
    task: { id: "20260722-abcd", project: "ownward", branch: "ownward/x", backend: "claude" },
    canonicalTask: "实现飞行记录器",
    messages,
    audit,
    git: dirtyGit,
    plan,
    tokens: { input: 100, output: 50 },
    scope: "private",
    now,
  });

  test("文件名 = 日期-slug-taskid", () => {
    expect(rec.filename).toBe("2026-07-22-ownward-20260722-abcd.md");
    expect(rec.slug).toBe("ownward");
  });

  test("frontmatter 含 date/project/task_id/backend/tokens/branch/git", () => {
    expect(rec.content).toContain("type: flight_record");
    expect(rec.content).toContain("date: 2026-07-22");
    expect(rec.content).toContain("project: ownward");
    expect(rec.content).toContain("task_id: 20260722-abcd");
    expect(rec.content).toContain("backend: claude");
    expect(rec.content).toContain("branch: ownward/x");
    expect(rec.content).toContain("tokens: 150"); // input+output 兜底合计
    expect(rec.content).toContain("git: dirty");
  });

  test("双链回项目 README 带 scope 完整路径（顶部+底部各一次）", () => {
    const links = rec.content.match(/\[\[private\/projects\/ownward\/README\|ownward\]\]/g) || [];
    expect(links.length).toBeGreaterThanOrEqual(2);
  });

  test("分节齐全：prompts/审批/命令/改动/结论/未完成", () => {
    expect(rec.content).toContain("## Prompts");
    expect(rec.content).toContain("**任务**：实现飞行记录器");
    expect(rec.content).toContain("**追问 1**：再加个双链");
    expect(rec.content).toContain("## 审批决策");
    expect(rec.content).toContain("`git push` → **allow**");
    expect(rec.content).not.toContain("rm -rf"); // 别的任务的审批不能混进来
    expect(rec.content).toContain("## 执行的命令");
    expect(rec.content).toContain("git status");
    expect(rec.content).toContain("bun test");
    expect(rec.content).toContain("## 改动");
    expect(rec.content).toContain("src/flight-record.ts");
    expect(rec.content).toContain("src/new-file.ts");        // untracked 也列出
    expect(rec.content).toContain("未跟踪文件");
    expect(rec.content).toContain("abc123 feat: 飞行记录");
    expect(rec.content).toContain("## 结论");
    expect(rec.content).toContain("已加上双链，完成");
    expect(rec.content).toContain("## 未完成项");
    expect(rec.content).toContain("- [ ] 接 daemon");
    expect(rec.content).toContain("- [ ] 写测试");
  });
});

describe("assembleFlightRecord git 状态占位", () => {
  const base = {
    task: { id: "t2", project: "demo" },
    messages: [{ role: "user", text: "hi", ts: "1" }] as DevMsg[],
    audit: [],
    plan: [],
    tokens: {},
    scope: "work" as const,
    now,
  };

  test("clean 不写「无改动或无 git」歧义文案", () => {
    const rec = assembleFlightRecord({ ...base, git: { status: "clean", base: "abc", diffStat: "", commits: "", untracked: [] } });
    expect(rec.content).toContain("(未发现归属于任务身份的提交或当前未提交改动)");
    expect(rec.content).toContain("(无高危操作或未触发审批)");
    expect(rec.content).toContain("(计划全部完成或无计划)");
    expect(rec.content).toContain("backend: claude"); // 默认 backend
  });

  test("not-a-repo 明确标注非 git，而不是「无改动」", () => {
    const rec = assembleFlightRecord({ ...base, git: { status: "not-a-repo", base: "", diffStat: "", commits: "", untracked: [] } });
    expect(rec.content).toContain("(非 git 仓库，无版本快照)");
  });

  test("empty-repo 明确标注空仓库，untracked 仍列出", () => {
    const rec = assembleFlightRecord({ ...base, git: { status: "empty-repo", base: "", diffStat: "", commits: "", untracked: ["a.ts"] } });
    expect(rec.content).toContain("(空仓库，无提交基线)");
    expect(rec.content).toContain("a.ts");
  });

  test("error 标注可能被清理，别误报无改动", () => {
    const rec = assembleFlightRecord({ ...base, git: { status: "error", base: "", diffStat: "", commits: "", untracked: [] } });
    expect(rec.content).toContain("(git 快照读取失败");
  });

  test("canonical 兜底：无会话 user 消息时仍有任务 prompt", () => {
    const rec = assembleFlightRecord({
      ...base,
      messages: [{ role: "assistant", text: "日志尾部", ts: "1" }],
      canonicalTask: "跑 codex exec 任务",
      git: { status: "clean", base: "", diffStat: "", commits: "", untracked: [] },
    });
    expect(rec.content).toContain("**任务**：跑 codex exec 任务");
  });
});
