import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { currentBranch, withBranches, worktreeBranches } from "./git-branch.ts";
import { run } from "./util.ts";

async function initRepo(dir: string, branch: string) {
  mkdirSync(dir, { recursive: true });
  await run(["git", "-c", "init.defaultBranch=" + branch, "init", dir], { timeoutMs: 10_000 });
  writeFileSync(join(dir, "f.txt"), "x");
  await run(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { timeoutMs: 10_000 });
  await run(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { timeoutMs: 10_000 });
}

describe("currentBranch", () => {
  test("resolves the checked-out branch; non-git and missing dirs yield empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-branch-"));
    try {
      const repo = join(root, "repo");
      await initRepo(repo, "br-main");
      expect(await currentBranch(repo)).toBe("br-main");
      expect(await currentBranch(join(root, "plain"))).toBe("");
      expect(await currentBranch(join(root, "nope"))).toBe("");
      expect(await currentBranch("")).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("detached HEAD has no branch name and joins the no-branch group", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-branch-detached-"));
    try {
      const repo = join(root, "repo");
      await initRepo(repo, "br-dev");
      await run(["git", "-C", repo, "checkout", "--detach"], { timeoutMs: 10_000 });
      expect(await currentBranch(repo)).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("hits the TTL cache within the window and re-resolves stale entries in the background (SWR)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-branch-cache-"));
    try {
      const repo = join(root, "repo");
      await initRepo(repo, "br-one");
      expect(await currentBranch(repo)).toBe("br-one");
      await run(["git", "-C", repo, "checkout", "-b", "br-two"], { timeoutMs: 10_000 });
      expect(await currentBranch(repo)).toBe("br-one");          // TTL 内不重解析
      expect(await currentBranch(repo, 0)).toBe("br-one");       // 过期先回旧值，后台刷新
      await new Promise((r) => setTimeout(r, 100));
      expect(await currentBranch(repo)).toBe("br-two");          // 后台刷完，新值进入缓存
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("withBranches", () => {
  test("attaches branch per row, falls back to projectDir, keeps existing branch when resolve fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-withbranches-"));
    try {
      const repo = join(root, "repo");
      await initRepo(repo, "br-feat");
      const rows: { id: string; cwd?: string; projectDir?: string; branch?: string }[] = [
        { id: "a", cwd: repo, projectDir: root },                       // cwd 是 git 仓 → 解析值
        { id: "b", cwd: join(root, "gone"), projectDir: repo },         // cwd 没了 → projectDir 兜底
        { id: "c", cwd: root, branch: "frozen/branch" },                // 非 git 目录 → 保留已有字段
        { id: "d", projectDir: join(root, "void") },                    // 全解析失败 → 空串（前端归无分支）
      ];
      expect(await withBranches(rows)).toEqual([
        { id: "a", cwd: repo, projectDir: root, branch: "br-feat" },
        { id: "b", cwd: join(root, "gone"), projectDir: repo, branch: "br-feat" },
        { id: "c", cwd: root, branch: "frozen/branch" },
        { id: "d", projectDir: join(root, "void"), branch: "" },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("worktreeBranches", () => {
  test("lists linked worktrees with their branches, marks the main checkout, skips detached", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-worktree-"));
    try {
      const repo = join(root, "repo");
      await initRepo(repo, "wt-main");
      const linked = join(root, "linked"), detached = join(root, "det");
      await run(["git", "-C", repo, "worktree", "add", "-b", "feat/wt/linked", linked], { timeoutMs: 10_000 });
      await run(["git", "-C", repo, "worktree", "add", "--detach", detached], { timeoutMs: 10_000 });
      expect(await worktreeBranches(repo)).toEqual([
        { path: realpathSync(repo), branch: "wt-main", isMain: true },       // git 输出的是 realpath 后的路径
        { path: realpathSync(linked), branch: "feat/wt/linked", isMain: false },
      ]);
      expect(await worktreeBranches(linked)).toEqual(await worktreeBranches(repo));   // 从任一 worktree 扫都是同一份集合
      expect(await worktreeBranches(join(root, "plain"))).toEqual([]);                // 非 git 目录
      expect(await worktreeBranches("")).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("hits the TTL cache within the window and re-resolves stale entries in the background (SWR)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-worktree-cache-"));
    try {
      const repo = join(root, "repo");
      await initRepo(repo, "wt-cache");
      expect(await worktreeBranches(repo)).toHaveLength(1);
      await run(["git", "-C", repo, "worktree", "add", "-b", "wt-new", join(root, "linked")], { timeoutMs: 10_000 });
      expect(await worktreeBranches(repo)).toHaveLength(1);       // TTL 内不重解析
      expect(await worktreeBranches(repo, 0)).toHaveLength(1);    // 过期先回旧值，后台刷新
      await new Promise((r) => setTimeout(r, 100));
      expect(await worktreeBranches(repo)).toHaveLength(2);       // 后台刷完，新值进入缓存
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
