// GET /api/branches：分支 → 项目/worktree 映射（「按分支」视图补全没任务的项目）。
// 子进程里改 cfg.allowedRoots/dispatch.worktreeRoot 指向临时仓，同 workbench-directories.test.ts 的姿势。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { run } from "./util.ts";

async function initRepo(dir: string, branch: string) {
  mkdirSync(dir, { recursive: true });
  await run(["git", "-c", "init.defaultBranch=" + branch, "init", dir], { timeoutMs: 10_000 });
  writeFileSync(join(dir, "f.txt"), "x");
  await run(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { timeoutMs: 10_000 });
  await run(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { timeoutMs: 10_000 });
}

describe("GET /api/branches", () => {
  test("maps branches to candidate projects and their worktrees; task worktrees stay out", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-branches-")), data = join(root, "data");
    try {
      const repo = join(root, "repo-a");
      await initRepo(repo, "main");
      const linked = join(root, "repo-a-linked");
      await run(["git", "-C", repo, "worktree", "add", "-b", "feat/wyx/TPSSO-1", linked], { timeoutMs: 10_000 });
      const wtRoot = join(root, "wt"), taskWt = join(wtRoot, "repo-a-20260828-ab12");   // 命中任务临时 worktree 排除规则
      await run(["git", "-C", repo, "worktree", "add", "-b", "feat/task-tmp", taskWt], { timeoutMs: 10_000 });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "tasks.json"), JSON.stringify([
        { id: "t1", project: "repo-a", projectDir: repo, cwd: repo, task: "x", mode: "codex-bg", engine: true, startedAt: new Date().toISOString(), status: "running" },
      ]));
      const script = `
        const {cfg}=await import(${JSON.stringify(join(import.meta.dir, "util.ts"))});cfg.architecture.allowedRoots=[${JSON.stringify(root)}];cfg.dispatch={worktreeRoot:${JSON.stringify(wtRoot)}};
        const {handleWorkbench}=await import(${JSON.stringify(join(import.meta.dir, "workbench.ts"))});
        const u=new URL("http://localhost/api/branches"),r=await handleWorkbench(new Request(u),u);
        console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
      const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: data }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, err).toBe(0);
      const result = JSON.parse(out.trim().split("\n").at(-1)!);
      expect(result.status).toBe(200);
      const rows: { branch: string; project: string; dir: string; path: string; isMain: boolean }[] = result.body.worktrees;
      expect(rows).toContainEqual({ branch: "main", project: "repo-a", dir: realpathSync(repo), path: realpathSync(repo), isMain: true });
      expect(rows).toContainEqual({ branch: "feat/wyx/TPSSO-1", project: "repo-a", dir: realpathSync(repo), path: realpathSync(linked), isMain: false });
      expect(rows.map((r) => r.branch)).not.toContain("feat/task-tmp");   // 任务临时 worktree 不进映射
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
