// 项目知识候选层单测：跑在临时 vault 上（useVaultForTest 换根，两个模块共用 activeVault）。
// 锁死的还是那三条：scope 物理隔离、路径白名单（slug + candidateId 双白名单 + 前缀复核）、
// 人工晋升门（候选写完，README/decisions/operations 一个字都不能变）。
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Scope } from "./paths.ts";
import {
  createProjectCandidate,
  dismissProjectCandidate,
  listProjectCandidates,
  promoteProjectCandidate,
} from "./project-memory.ts";
import { useVaultForTest, type Fail } from "./roles.ts";

const roots: string[] = [];

function freshVault(scopes: Scope[] = [""]): string {
  const root = mkdtempSync(join(tmpdir(), "ownward-projmem-test-"));
  roots.push(root);
  useVaultForTest(root, scopes);
  return root;
}

function seedProject(root: string, scope: Scope, slug: string, body = "# 项目\n现状") {
  const dir = join(scope ? join(root, scope) : root, "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), body);
  return dir;
}

const ok = <T extends { ok: boolean }>(r: T): T => {
  expect((r as any).ok, `期望成功，实际：${(r as any).msg}`).toBe(true);
  return r;
};
const bad = (r: { ok: boolean }): Fail => {
  expect(r.ok).toBe(false);
  return r as Fail;
};
const newCand = (slug = "ownward", scope: Scope = "", text = "daemon 用 launchd 托管") =>
  (ok(createProjectCandidate(slug, scope, { text, sourceChatId: "chat-1", sourceRoleId: "ownward-dev" })) as any).candidate;

afterEach(() => useVaultForTest(null));
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("创建候选", () => {
  test("落在 projects/<slug>/_candidates/，带来源与 pending 状态，正式文件纹丝不动", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward", "README_ORIGINAL");
    const c = newCand();

    const raw = readFileSync(join(dir, "_candidates", `${c.id}.md`), "utf8");
    expect(raw).toContain("project: ownward");
    expect(raw).toContain("source_chat: chat-1");
    expect(raw).toContain("source_role: ownward-dev");
    expect(raw).toContain("status: pending");
    expect(raw).toContain("daemon 用 launchd 托管");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("README_ORIGINAL");   // 人工晋升门
    expect(existsSync(join(dir, "decisions.md"))).toBe(false);
    expect(existsSync(join(dir, "operations.md"))).toBe(false);

    const list = ok(listProjectCandidates("ownward", "")) as any;
    expect(list.candidates).toHaveLength(1);
    expect(list.candidates[0]).toMatchObject({ id: c.id, project: "ownward", status: "pending", sourceRole: "ownward-dev" });
  });

  test("空内容 / 超长内容明确拒绝（超长不截断：截断=悄悄改写结论）", () => {
    const root = freshVault();
    seedProject(root, "", "ownward");
    expect(bad(createProjectCandidate("ownward", "", { text: "   " })).code).toBe("invalid");
    expect(bad(createProjectCandidate("ownward", "", { text: "长".repeat(1001) })).msg).toContain("1000");
    expect(readdirSync(join(root, "projects", "ownward"))).not.toContain("_candidates");
  });

  test("项目不存在是 not_found，不会凭空造一个项目目录出来", () => {
    const root = freshVault();
    expect(bad(createProjectCandidate("ghost", "", { text: "x" })).code).toBe("not_found");
    expect(bad(listProjectCandidates("ghost", "")).code).toBe("not_found");
    expect(existsSync(join(root, "projects", "ghost"))).toBe(false);
  });

  test("证据与改写：原文留证据，候选正文可以是人改写过的一句话", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward");
    const c = (ok(createProjectCandidate("ownward", "", {
      text: "端口写死 4517", evidence: "客户端 kickstart 里也是 4517",
    })) as any).candidate;
    const raw = readFileSync(join(dir, "_candidates", `${c.id}.md`), "utf8");
    expect(raw).toContain("证据：客户端 kickstart 里也是 4517");
    expect((ok(listProjectCandidates("ownward", "")) as any).candidates[0].evidence).toBe("客户端 kickstart 里也是 4517");
  });
});

describe("路径白名单", () => {
  test("slug 路径穿越拒绝：vault 里的别的文件一个字都碰不到", () => {
    const root = freshVault();
    seedProject(root, "", "ownward");
    writeFileSync(join(root, "outside.md"), "OUTSIDE");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "people.md"), "PEOPLE");

    for (const slug of ["../memory", "../../etc", "a/b", "./ownward", "", "x".repeat(70)]) {
      expect(bad(createProjectCandidate(slug, "", { text: "x" })).code).not.toBe("conflict");
      expect(bad(listProjectCandidates(slug, "")).ok).toBe(false);
      expect(bad(promoteProjectCandidate(slug, "", "20260101-abcdef", "README")).ok).toBe(false);
      expect(bad(dismissProjectCandidate(slug, "", "20260101-abcdef")).ok).toBe(false);
    }
    expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("OUTSIDE");
    expect(readFileSync(join(root, "memory", "people.md"), "utf8")).toBe("PEOPLE");
    // 大小写只是归一（项目 slug 恒小写，同 roles.ts），不是穿越
    const c = (ok(createProjectCandidate("OWNWARD", "", { text: "大写也是同一个项目" })) as any).candidate;
    expect(c.project).toBe("ownward");
    expect(existsSync(join(root, "projects", "ownward", "_candidates", `${c.id}.md`))).toBe(true);
  });

  test("候选 id 路径穿越拒绝（晋升与丢弃两条路都拦）", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward", "README_ORIGINAL");
    writeFileSync(join(root, "outside.md"), "OUTSIDE");
    newCand();
    for (const cid of ["../../outside", "../README", "a/b", "./x", "", "A".repeat(70), "/etc/passwd"]) {
      expect(bad(promoteProjectCandidate("ownward", "", cid, "README")).code).toBe("invalid");
      expect(bad(dismissProjectCandidate("ownward", "", cid)).code).toBe("invalid");
    }
    expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("OUTSIDE");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("README_ORIGINAL");
    expect(readdirSync(join(dir, "_candidates"))).toHaveLength(1);   // 拒绝时候选还在
  });

  test("非法 scope 拒绝（不分流时给 work 也拒）", () => {
    const root = freshVault();
    seedProject(root, "", "ownward");
    expect(bad(createProjectCandidate("ownward", "work" as Scope, { text: "x" })).msg).toContain("scope");
    freshVault(["work", "private"]);
    expect(bad(createProjectCandidate("ownward", "../private" as Scope, { text: "x" })).msg).toContain("scope");
  });

  test("scope 物理隔离：private 项目的候选不落在 work 目录", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "shared");
    seedProject(root, "private", "shared");
    const c = newCand("shared", "private");
    expect(existsSync(join(root, "private", "projects", "shared", "_candidates", `${c.id}.md`))).toBe(true);
    expect(existsSync(join(root, "work", "projects", "shared", "_candidates"))).toBe(false);
    // 同名项目各算各的：work 那边列表是空的
    expect((ok(listProjectCandidates("shared", "work")) as any).candidates).toEqual([]);
  });
});

describe("人工晋升门", () => {
  test("晋升：追加进目标文件并删候选；目标只能是 README/decisions/operations", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward", "# ownward\n## 现状\n端口 4517\n");
    const c = (ok(createProjectCandidate("ownward", "", {
      text: "daemon 归 launchd 管，重启用 kickstart", evidence: "nohup 会被连坐杀掉", sourceChatId: "chat-9", sourceRoleId: "ownward-dev",
    })) as any).candidate;

    for (const t of ["role.json", "principles", "../../../etc/passwd", "README.md", "", "readme"]) {
      expect(bad(promoteProjectCandidate("ownward", "", c.id, t)).code).toBe("invalid");
    }
    expect(existsSync(join(dir, "_candidates", `${c.id}.md`))).toBe(true);   // 拒绝时候选还在

    const pr = ok(promoteProjectCandidate("ownward", "", c.id, "operations")) as any;
    expect(pr.target).toBe("operations");
    expect(JSON.stringify(pr)).not.toContain(root);   // 不回绝对路径：客户端不需要知道磁盘布局
    const md = readFileSync(join(dir, "operations.md"), "utf8");
    expect(md).toContain("# ownward · 部署与排障");
    expect(md).toContain("- daemon 归 launchd 管，重启用 kickstart");
    expect(md).toContain("来源：对话 chat-9 · 角色 ownward-dev");
    expect(md).toContain("证据：「nohup 会被连坐杀掉」");
    expect(existsSync(join(dir, "_candidates", `${c.id}.md`))).toBe(false);
    // README 是另一份文件，不该被顺手改
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# ownward\n## 现状\n端口 4517\n");
    // 晋升过的候选再晋升一次：明确 404，不是重复追加
    expect(bad(promoteProjectCandidate("ownward", "", c.id, "operations")).code).toBe("not_found");
  });

  test("晋升到 README 是追加，不覆盖已有内容", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward", "# ownward\n## 现状\n原有内容\n");
    const c = newCand("ownward", "", "现在是 bun + 纯静态前端");
    ok(promoteProjectCandidate("ownward", "", c.id, "README"));
    const md = readFileSync(join(dir, "README.md"), "utf8");
    expect(md).toContain("原有内容");
    expect(md).toContain("- 现在是 bun + 纯静态前端");
  });

  test("丢弃：删候选、不动正式文件；重复丢弃是 404", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward", "README_ORIGINAL");
    const c = newCand();
    ok(dismissProjectCandidate("ownward", "", c.id));
    expect(existsSync(join(dir, "_candidates", `${c.id}.md`))).toBe(false);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("README_ORIGINAL");
    expect(bad(dismissProjectCandidate("ownward", "", c.id)).code).toBe("not_found");
  });

  test("异常候选文件不炸列表（跳过并留痕），其余候选照常", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward");
    const c = newCand();
    writeFileSync(join(dir, "_candidates", "..evil.md"), "x");
    writeFileSync(join(dir, "_candidates", "notes.txt"), "x");
    const list = ok(listProjectCandidates("ownward", "")) as any;
    expect(list.candidates.map((x: any) => x.id)).toEqual([c.id]);
  });
});

describe("写正式文件的失败与越界", () => {
  test("目标文件是只读时：明确失败、候选留着、正式文件一个字没变、不留 .tmp", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward");
    writeFileSync(join(dir, "decisions.md"), "ORIGINAL");
    const c = newCand();

    chmodSync(dir, 0o500);   // 目录只读 → 临时文件建不出来（rename 也就不会发生）
    try {
      const f = bad(promoteProjectCandidate("ownward", "", c.id, "decisions"));
      expect(f.msg).toContain("失败");
      expect(f.msg).toContain("候选还在");
    } finally { chmodSync(dir, 0o700); }

    expect(readFileSync(join(dir, "decisions.md"), "utf8")).toBe("ORIGINAL");   // 没被截断成半份
    expect(existsSync(join(dir, "decisions.md.tmp"))).toBe(false);              // 也没留下临时文件
    expect(existsSync(join(dir, "_candidates", `${c.id}.md`))).toBe(true);      // 候选还在，可重试
    ok(promoteProjectCandidate("ownward", "", c.id, "decisions"));              // 重试就成功
    expect(readFileSync(join(dir, "decisions.md"), "utf8")).toContain("ORIGINAL");
  });

  test("晋升是原子替换：正式文件不会出现半份（临时文件 + rename）", () => {
    const root = freshVault();
    const dir = seedProject(root, "", "ownward");
    const c = newCand("ownward", "", "第一条");
    ok(promoteProjectCandidate("ownward", "", c.id, "operations"));
    // rename 之后 tmp 必须消失（留着会被 Obsidian/同步当成真文件）
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const c2 = newCand("ownward", "", "第二条");
    ok(promoteProjectCandidate("ownward", "", c2.id, "operations"));
    const md = readFileSync(join(dir, "operations.md"), "utf8");
    expect(md).toContain("第一条");     // 第二次晋升是追加，不是覆盖
    expect(md).toContain("第二条");
    expect(md.match(/# ownward · 部署与排障/g)).toHaveLength(1);   // 标题骨架只写一次
  });

  test("项目目录是指向 vault 外的软链：一律拒绝（字符串前缀拦不住这个）", () => {
    const root = freshVault();
    seedProject(root, "", "ownward");
    const outside = mkdtempSync(join(tmpdir(), "ownward-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "README.md"), "OUTSIDE_README");
    symlinkSync(outside, join(root, "projects", "evil"));

    for (const r of [
      createProjectCandidate("evil", "", { text: "x" }),
      listProjectCandidates("evil", ""),
      promoteProjectCandidate("evil", "", "20260101-abcdef", "README"),
      dismissProjectCandidate("evil", "", "20260101-abcdef"),
    ]) expect(bad(r).msg).toContain("软链");

    expect(readFileSync(join(outside, "README.md"), "utf8")).toBe("OUTSIDE_README");
    expect(existsSync(join(outside, "_candidates"))).toBe(false);
    // vault 内的正常项目不受影响
    expect(ok(listProjectCandidates("ownward", "")) as any).toMatchObject({ ok: true });
  });

  test("vault 根自己是软链时照常工作（两边都取 realpath 再比）", () => {
    const real = mkdtempSync(join(tmpdir(), "ownward-realvault-"));
    roots.push(real);
    const link = join(mkdtempSync(join(tmpdir(), "ownward-linkvault-")), "vault");
    roots.push(link);
    symlinkSync(real, link);
    useVaultForTest(link, [""]);
    mkdirSync(join(real, "projects", "ownward"), { recursive: true });
    writeFileSync(join(real, "projects", "ownward", "README.md"), "# ownward");

    const c = (ok(createProjectCandidate("ownward", "", { text: "软链 vault 也要能写" })) as any).candidate;
    expect(existsSync(join(real, "projects", "ownward", "_candidates", `${c.id}.md`))).toBe(true);
    ok(promoteProjectCandidate("ownward", "", c.id, "README"));
    expect(readFileSync(join(real, "projects", "ownward", "README.md"), "utf8")).toContain("软链 vault 也要能写");
  });
});
