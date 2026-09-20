// Worktree 清理：状态判定（谁能删）与删除硬闸（越界路径 / 有未提交改动 / 有任务在跑）。
// worktreeRoot 来自 config，所以子进程要同时接管 OWNWARD_CONFIG_ROOT 和 OWNWARD_DATA_ROOT。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Fixture { base: string; repo: string; wtRoot: string; config: string; data: string }

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "ownward-wt-"));
  const repo = join(base, "repo"), wtRoot = join(base, "worktrees"), config = join(base, "config"), data = join(base, "data");
  for (const dir of [repo, wtRoot, config, data]) mkdirSync(dir, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.com");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-q", "-m", "base");

  // clean：分支刚拉出来，一个提交都没多（人起的分支名：删目录后分支保留）
  git(repo, "worktree", "add", "-q", join(wtRoot, "wt-clean"), "-b", "clean-branch");
  // auto：dispatch 自建的 ownward/* 分支，落地后跟目录一起收
  git(repo, "worktree", "add", "-q", join(wtRoot, "wt-auto"), "-b", "ownward/20260101-auto");
  // unmerged：多了一个主检出够不着的提交（删目录不丢提交，但默认不进批量清理）
  git(repo, "worktree", "add", "-q", join(wtRoot, "wt-unmerged"), "-b", "unmerged-branch");
  writeFileSync(join(wtRoot, "wt-unmerged", "feature.txt"), "feature\n");
  git(join(wtRoot, "wt-unmerged"), "add", "feature.txt");
  git(join(wtRoot, "wt-unmerged"), "commit", "-q", "-m", "feature");
  // dirty：有未提交改动
  git(repo, "worktree", "add", "-q", join(wtRoot, "wt-dirty"), "-b", "dirty-branch");
  writeFileSync(join(wtRoot, "wt-dirty", "scratch.txt"), "wip\n");
  // busy：有任务在跑
  git(repo, "worktree", "add", "-q", join(wtRoot, "wt-busy"), "-b", "busy-branch");
  // orphan：不是任何仓库注册的 worktree
  mkdirSync(join(wtRoot, "wt-orphan"), { recursive: true });
  writeFileSync(join(wtRoot, "wt-orphan", "leftover.txt"), "leftover\n");

  writeFileSync(join(config, "config.json"), JSON.stringify({ dispatch: { worktreeRoot: wtRoot } }));
  writeFileSync(join(data, "tasks.json"), JSON.stringify([
    { id: "t-busy", project: "repo", projectDir: repo, cwd: join(wtRoot, "wt-busy"), task: "跑着的任务", mode: "claude-bg",
      startedAt: new Date().toISOString(), status: "running" },
    { id: "t-clean", project: "repo", projectDir: repo, cwd: join(wtRoot, "wt-clean"), task: "已完成的任务", mode: "claude-bg",
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: "exited", exitCode: 0 },
  ]));
  return { base, repo, wtRoot, config, data };
}

async function inProcess(f: Fixture, body: string): Promise<any> {
  const mod = JSON.stringify(join(import.meta.dir, "worktrees.ts"));
  const script = `const W=await import(${mod});${body}`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, OWNWARD_DATA_ROOT: f.data, OWNWARD_CONFIG_ROOT: f.config },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
  // util.log() 也写 stdout（清理成功会打一行），只认最后一行的结果 JSON
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("worktree cleanup", () => {
  test("清单按「删了会不会丢东西」分类", async () => {
    const f = fixture();
    try {
      const r = await inProcess(f, `
        const {root,entries}=await W.listWorktrees({withSize:false});
        console.log(JSON.stringify({root,states:Object.fromEntries(entries.map(e=>[e.name,e.state])),
          removable:Object.fromEntries(entries.map(e=>[e.name,e.removable])),
          unmerged:entries.find(e=>e.name==="wt-unmerged")?.unmergedCommits,
          busyTasks:entries.find(e=>e.name==="wt-busy")?.tasks.map(t=>t.id)}));`);
      expect(r.root).toBe(f.wtRoot);
      expect(r.states).toEqual({ "wt-auto": "clean", "wt-clean": "clean", "wt-unmerged": "unmerged", "wt-dirty": "dirty", "wt-busy": "busy", "wt-orphan": "orphan" });
      expect(r.removable).toEqual({ "wt-auto": true, "wt-clean": true, "wt-unmerged": true, "wt-dirty": false, "wt-busy": false, "wt-orphan": false });
      expect(r.unmerged).toBe(1);
      expect(r.busyTasks).toEqual(["t-busy"]);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("批量清理默认只删 clean；人起的分支保留、自建 ownward/* 分支落地后一并删；有改动/在跑的不动并计数", async () => {
    const f = fixture();
    try {
      const r = await inProcess(f, `
        const D=await import(${JSON.stringify(join(import.meta.dir, "dismissed-projects.ts"))});
        const A=await import(${JSON.stringify(join(import.meta.dir, "archived-sessions.ts"))});
        const done=await W.cleanupWorktrees({});
        const {entries}=await W.listWorktrees({withSize:false});
        console.log(JSON.stringify({removed:done.results.filter(x=>x.ok).map(x=>x.name).sort(),
          branchDeleted:Object.fromEntries(done.results.map(x=>[x.name,x.branchDeleted||""])),
          skipped:done.skipped,left:entries.map(e=>e.name).sort(),
          dismissed:Object.keys(D.dismissedProjects()).sort(),archived:Object.keys(A.archivedSessions()).sort()}));`);
      expect(r.removed).toEqual(["wt-auto", "wt-clean"]);
      expect(r.left).toEqual(["wt-busy", "wt-dirty", "wt-orphan", "wt-unmerged"]);
      expect(r.skipped).toEqual({ busy: 1, dirty: 1, orphan: 1, unmerged: 1 });
      // 目录没了 → 工作台里的同名组收起来、里面跑过的任务归档（只隐藏，记录不动）
      expect(r.dismissed).toEqual(["wt-auto", "wt-clean"]);
      expect(r.archived).toEqual(["t-clean"]);
      // 人起的分支：目录删了分支还在——已提交的活一条都没丢
      expect(r.branchDeleted["wt-clean"]).toBe("");
      expect(git(f.repo, "branch", "--list", "clean-branch")).toContain("clean-branch");
      // dispatch 自建的分支：一个提交都没多，跟目录一起收
      expect(r.branchDeleted["wt-auto"]).toBe("ownward/20260101-auto");
      expect(git(f.repo, "branch", "--list", "ownward/*")).toBe("");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("自建分支上还有没落地的提交时，删目录也不删分支", async () => {
    const f = fixture();
    try {
      // 给 wt-auto 加一个主检出够不着的提交 → 状态变 unmerged；显式点名删目录，分支必须留下
      writeFileSync(join(f.wtRoot, "wt-auto", "wip.txt"), "wip\n");
      git(join(f.wtRoot, "wt-auto"), "add", "wip.txt");
      git(join(f.wtRoot, "wt-auto"), "commit", "-q", "-m", "wip");
      const r = await inProcess(f, `
        const done=await W.removeWorktree("wt-auto");
        console.log(JSON.stringify(done));`);
      expect(r.ok).toBeTrue();
      expect(r.branchDeleted).toBeUndefined();
      expect(git(f.repo, "branch", "--list", "ownward/*")).toContain("ownward/20260101-auto");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("有未提交改动要 force；有任务在跑连 force 也不给", async () => {
    const f = fixture();
    try {
      const r = await inProcess(f, `
        const soft=await W.removeWorktree("wt-dirty");
        const busy=await W.removeWorktree("wt-busy",{force:true});
        const forced=await W.removeWorktree("wt-dirty",{force:true});
        console.log(JSON.stringify({soft,busy,forced}));`);
      expect(r.soft.ok).toBeFalse();
      expect(r.soft.msg).toContain("未提交");
      expect(r.busy.ok).toBeFalse();
      expect(r.busy.msg).toContain("任务在跑");
      expect(r.forced.ok).toBeTrue();
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("路径硬闸：名字带分隔符/指向根外的一律拒绝", async () => {
    const f = fixture();
    try {
      const outside = mkdtempSync(join(tmpdir(), "ownward-wt-outside-"));
      writeFileSync(join(outside, "precious.txt"), "keep me\n");
      // worktreeRoot 里放一个指向根外的符号链接：realpath 之后必须被判越界
      Bun.spawnSync(["ln", "-s", outside, join(f.wtRoot, "wt-link")]);
      const r = await inProcess(f, `
        const out=[];
        for(const name of ["../repo","wt-clean/..","/etc","wt-link",".."]){
          try{ out.push([name,(await W.removeWorktree(name)).msg]); }catch(e){ out.push([name,String(e.message||e)]); }
        }
        console.log(JSON.stringify(out));`);
      for (const [, msg] of r) expect(String(msg)).toMatch(/名非法|不在 worktreeRoot 内|目录不存在/);
      expect(Bun.spawnSync(["test", "-f", join(outside, "precious.txt")]).exitCode).toBe(0);
      rmSync(outside, { recursive: true, force: true });
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("orphan 目录要 force 才整个删掉（git 判断不了里面有没有没落地的东西）", async () => {
    const f = fixture();
    try {
      const r = await inProcess(f, `
        const soft=await W.removeWorktree("wt-orphan");
        const done=await W.removeWorktree("wt-orphan",{force:true});
        const {entries}=await W.listWorktrees({withSize:false});
        console.log(JSON.stringify({soft,done,left:entries.map(e=>e.name).sort()}));`);
      expect(r.soft.ok).toBeFalse();
      expect(r.soft.msg).toContain("强制");
      expect(r.done.ok).toBeTrue();
      expect(r.left).not.toContain("wt-orphan");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("点名删时显式给的 states 仍然生效：names 与 states 取交集", async () => {
    const f = fixture();
    try {
      const r = await inProcess(f, `
        const done=await W.cleanupWorktrees({names:["wt-clean","wt-unmerged"],states:["clean"]});
        console.log(JSON.stringify({touched:done.results.map(x=>x.name)}));`);
      expect(r.touched).toEqual(["wt-clean"]);
      expect(git(f.repo, "worktree", "list")).toContain("wt-unmerged");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("retentionDays=0 时定时清理不动手", async () => {
    const f = fixture();
    try {
      const r = await inProcess(f, `
        const swept=await W.sweepWorktrees();
        const {entries}=await W.listWorktrees({withSize:false});
        console.log(JSON.stringify({swept,left:entries.length}));`);
      expect(r.swept.results).toEqual([]);
      expect(r.left).toBe(6);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
});
