// 项目身份：跑真 git（worktree 归主检出这件事只有真仓库测得出来）。scope 一律注入，不吃本机 config.json
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { projectIdentity, remoteRepoName, slugForName } from "./project-identity.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
}

/** 一个带首个提交的仓库（worktree add 要求至少一个提交） */
function repo(name: string): { base: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ownward-identity-")));
  roots.push(base);
  const root = join(base, name);
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return { base, root };
}

const fixedScope = (remote: string) => (remote.includes("acme-corp") ? "work" as const : "private" as const);

describe("projectIdentity", () => {
  test("主检出：slug 是目录名小写，scope 由注入的判定决定", () => {
    const { root } = repo("Desk-App");
    const id = projectIdentity(root, { scopeFor: fixedScope })!;
    expect(id).toMatchObject({ root, slug: "desk-app", scope: "private", aliases: [], label: "Desk-App" });
  });

  test("linked worktree 和子目录都归到主检出：任务 worktree 和主目录是同一个项目", () => {
    const { base, root } = repo("internal");
    git(root, "remote", "add", "origin", "git@github.com:acme-corp/ownward.git");
    const wt = join(base, "internal-20261014-d7za");
    git(root, "worktree", "add", "-q", wt, "-b", "ownward/20261014-d7za");
    mkdirSync(join(wt, "src", "deep"), { recursive: true });
    for (const dir of [root, wt, join(wt, "src", "deep")]) {
      const id = projectIdentity(dir, { scopeFor: fixedScope })!;
      expect(id.root).toBe(root);
      expect(id.slug).toBe("internal");
      expect(id.scope).toBe("work");
      // 远程仓库名与目录名不同：作为别名（capture 按远程名记过日志），展示名也用远程名
      expect(id.aliases).toEqual(["ownward"]);
      expect(id.label).toBe("ownward");
    }
  });

  test("不是 git 仓库 / 目录不存在 → null（~/workspace 这种目录不配有 Owner）", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "ownward-identity-plain-")));
    roots.push(plain);
    expect(projectIdentity(plain, { scopeFor: fixedScope })).toBeNull();
    expect(projectIdentity(join(plain, "missing"), { scopeFor: fixedScope })).toBeNull();
    expect(projectIdentity("", { scopeFor: fixedScope })).toBeNull();
  });

  test("目录名合不出合法 slug（全是中文）就没有项目身份", () => {
    const { root } = repo("中文项目");
    expect(projectIdentity(root, { scopeFor: fixedScope })).toBeNull();
  });
});

describe("名字归一", () => {
  test("slugForName：小写、非法字符折成连字符、去掉首尾符号", () => {
    expect(slugForName("acme 2")).toBe("acme-2");
    expect(slugForName("My_Repo.v2")).toBe("my_repo.v2");
    expect(slugForName("--Weird--")).toBe("weird");
    expect(slugForName("中文")).toBe("");
    expect(slugForName("../../etc")).toBe("etc");
  });

  test("remoteRepoName：ssh / https / 无 .git 都取最后一段，保留大小写", () => {
    expect(remoteRepoName("origin\tgit@github.com:org/Ownward.git (fetch)")).toBe("Ownward");
    expect(remoteRepoName("origin\thttps://github.com/org/acme-app (fetch)")).toBe("acme-app");
    expect(remoteRepoName("")).toBe("");
  });
});

describe("home 目录是仓库", () => {
  test("HOME 本身是 git 仓库时，它和它下面的普通目录都没有项目身份（不让一个 home Owner 吞掉所有任务）", () => {
    const { base, root } = repo("fakehome");
    const plain = join(root, "workspace");
    mkdirSync(plain);
    const saved = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(projectIdentity(root, { scopeFor: fixedScope })).toBeNull();
      expect(projectIdentity(plain, { scopeFor: fixedScope })).toBeNull();
    } finally { process.env.HOME = saved; }
    expect(projectIdentity(root, { scopeFor: fixedScope })?.slug).toBe("fakehome");   // 不是 home 时照常识别
    expect(base).toBeTruthy();
  });
});
