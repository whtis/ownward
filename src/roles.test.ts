// Role 持久化层单测：跑在临时 vault 上（useVaultForTest 只换根，路径推导与生产同一条）。
// 重点锁死三条硬约束：scope 物理隔离、路径白名单、候选人工晋升门——这三条被绕过时
// 表现是"看起来能用"，只有测试能拦住。
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Scope } from "./paths.ts";
import {
  archiveRole,
  createRole,
  createRoleCandidate,
  dismissRoleCandidate,
  getRole,
  listProjectSlugs,
  listRoleCandidates,
  listRoles,
  promoteRoleCandidate,
  resolveRole,
  roleMemoryPack,
  roleOrg,
  updateRole,
  useVaultForTest,
} from "./roles.ts";
import type { Fail } from "./roles.ts";

const roots: string[] = [];

/** 每个测试一份干净 vault；scopes 传 ["work","private"] 即模拟分流开启 */
function freshVault(scopes: Scope[] = [""]): string {
  const root = mkdtempSync(join(tmpdir(), "ownward-roles-test-"));
  roots.push(root);
  useVaultForTest(root, scopes);
  return root;
}

/** 造一个项目 README（scope 为空时平铺在根下） */
function seedProject(root: string, scope: Scope, slug: string, body: string) {
  const dir = join(scope ? join(root, scope) : root, "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), body);
}

/** 绕过 API 直接落一份 role.json：模拟人在 Obsidian 里手改、或同步冲突写回来的文件。
 *  传字符串就原样写（造坏 JSON 用）。 */
function writeRoleJson(root: string, scope: Scope, id: string, m: unknown) {
  const dir = join(scope ? join(root, scope) : root, "roles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.json"), typeof m === "string" ? m : JSON.stringify(m, null, 2));
}

/** 一份合法 manifest（各 case 在它上面改一个字段） */
const RAW_MANIFEST = {
  name: "研发", description: "", icon: "star", color: "#5b8def",
  projects: [], instructions: "", status: "active",
  createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
};

const ok = <T extends { ok: boolean }>(r: T): T => {
  expect((r as any).ok, `期望成功，实际：${(r as any).msg}`).toBe(true);
  return r;
};
const bad = (r: { ok: boolean }): Fail => {
  expect(r.ok).toBe(false);
  return r as Fail;
};

const NEW_ROLE = { id: "dev", name: "研发", description: "写代码的那个我", icon: "code", color: "#5B8DEF" };

afterEach(() => useVaultForTest(null));
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("createRole 骨架与校验", () => {
  test("创建后文件骨架完整（manifest + 四份 markdown + _candidates）", () => {
    const root = freshVault();
    const r = ok(createRole({ ...NEW_ROLE, instructions: "负责 ownward 的实现", projects: ["ownward"] }));
    expect((r as any).role.status).toBe("active");
    expect((r as any).role.color).toBe("#5b8def");   // 颜色规范化成小写

    const dir = join(root, "roles", "dev");
    for (const f of ["role.json", "README.md", "principles.md", "decisions.md", "backlog.md"]) {
      expect(existsSync(join(dir, f)), `缺少 ${f}`).toBe(true);
    }
    expect(existsSync(join(dir, "_candidates"))).toBe(true);

    const m = JSON.parse(readFileSync(join(dir, "role.json"), "utf8"));
    expect(m.id).toBe("dev");
    expect(m.projects).toEqual(["ownward"]);
    expect(m.createdAt).toBeTruthy();
    expect(m.scope).toBeUndefined();   // scope 由目录位置决定，不进 manifest（两处记必不一致）
    expect(existsSync(join(dir, "role.json.tmp"))).toBe(false);   // 原子写不留临时文件
  });

  test("重启后仍读得到（重新扫描目录，不依赖内存）", () => {
    freshVault();
    ok(createRole(NEW_ROLE));
    expect(getRole("dev")?.name).toBe("研发");
    expect(listRoles().map((x) => x.id)).toEqual(["dev"]);
  });

  test("非法 id 拒绝：大写/路径穿越/过短/过长", () => {
    freshVault();
    for (const id of ["Dev", "../evil", "a/b", "x", "-lead", "d".repeat(41), "", "研发"]) {
      expect(bad(createRole({ ...NEW_ROLE, id })).code).toBe("invalid");
    }
    expect(readdirSync(join(roots[roots.length - 1]))).not.toContain("evil");
  });

  test("非法颜色 / icon / 超长字段拒绝", () => {
    freshVault();
    expect(bad(createRole({ ...NEW_ROLE, color: "red" })).msg).toContain("#RRGGBB");
    expect(bad(createRole({ ...NEW_ROLE, color: "#ABC" })).code).toBe("invalid");
    expect(bad(createRole({ ...NEW_ROLE, icon: "<svg onload=1>" })).msg).toContain("预设");
    expect(bad(createRole({ ...NEW_ROLE, name: "" })).code).toBe("invalid");
    expect(bad(createRole({ ...NEW_ROLE, name: "名".repeat(31) })).msg).toContain("1–30");
    expect(bad(createRole({ ...NEW_ROLE, description: "描".repeat(201) })).msg).toContain("200");
    expect(bad(createRole({ ...NEW_ROLE, instructions: "职".repeat(2001) })).msg).toContain("2000");
    expect(bad(createRole({ ...NEW_ROLE, projects: ["../../etc"] })).msg).toContain("slug");
    expect(bad(createRole({ ...NEW_ROLE, projects: "ownward" })).msg).toContain("数组");
    expect(listRoles()).toEqual([]);   // 一个都没落盘
  });

  test("缺名称拒绝，重复 id 是 conflict 不是静默覆盖", () => {
    freshVault();
    expect(bad(createRole({ id: "dev" })).msg).toContain("名称");
    ok(createRole(NEW_ROLE));
    const dup = bad(createRole({ ...NEW_ROLE, name: "另一个研发" }));
    expect(dup.code).toBe("conflict");
    expect(getRole("dev")?.name).toBe("研发");   // 原角色没被顶掉
  });

  test("多项目关联去重（大小写/空白归一）", () => {
    freshVault();
    const r = ok(createRole({ ...NEW_ROLE, projects: ["ownward", "Ownward", " ownward ", "desk"] }));
    expect((r as any).role.projects).toEqual(["ownward", "desk"]);
  });
});

describe("updateRole / archiveRole", () => {
  test("不允许改 id 与 scope，其余字段可改", () => {
    freshVault(["work", "private"]);
    ok(createRole({ ...NEW_ROLE, scope: "work" }));
    expect(bad(updateRole("dev", { id: "dev2" })).msg).toContain("id 不可修改");
    expect(bad(updateRole("dev", { scope: "private" })).msg).toContain("scope 不可修改");
    expect(getRole("dev")!.id).toBe("dev");
    expect(getRole("dev")!.scope).toBe("work");

    const r = ok(updateRole("dev", { name: "研发（新）", projects: ["a", "a", "b"] }));
    expect((r as any).role.name).toBe("研发（新）");
    expect((r as any).role.projects).toEqual(["a", "b"]);
    expect((r as any).role.createdAt).toBe(getRole("dev")!.createdAt);
  });

  test("patch 只动给出的键，没给的保持不变", () => {
    freshVault();
    ok(createRole({ ...NEW_ROLE, instructions: "只管实现", projects: ["ownward"] }));
    ok(updateRole("dev", { description: "换个描述" }));
    const role = getRole("dev")!;
    expect(role.description).toBe("换个描述");
    expect(role.instructions).toBe("只管实现");
    expect(role.projects).toEqual(["ownward"]);
  });

  test("改状态必须走归档接口，不在 update 里静默生效", () => {
    freshVault();
    ok(createRole(NEW_ROLE));
    expect(bad(updateRole("dev", { status: "archived" })).msg).toContain("归档");
    expect(getRole("dev")!.status).toBe("active");
  });

  test("归档后默认列表不出现，includeArchived 能看到，恢复后回来", () => {
    freshVault();
    ok(createRole(NEW_ROLE));
    ok(createRole({ ...NEW_ROLE, id: "design", name: "设计", icon: "design" }));

    ok(archiveRole("dev", true));
    expect(listRoles().map((x) => x.id)).toEqual(["design"]);
    expect(listRoles({ includeArchived: true }).map((x) => x.id).sort()).toEqual(["design", "dev"]);
    expect(getRole("dev")!.status).toBe("archived");            // 文件仍在，历史对话引得到
    expect(existsSync(join(roots[roots.length - 1], "roles", "dev", "README.md"))).toBe(true);

    ok(archiveRole("dev", false));
    expect(listRoles().map((x) => x.id).sort()).toEqual(["design", "dev"]);
  });

  test("不存在的角色：明确 404 语义，不是假成功", () => {
    freshVault();
    expect(bad(updateRole("ghost", { name: "x" })).code).toBe("not_found");
    expect(bad(archiveRole("ghost", true)).code).toBe("not_found");
    expect(getRole("ghost")).toBeNull();
    expect(getRole("../../etc/passwd")).toBeNull();
  });
});

describe("roleMemoryPack 组装", () => {
  test("含角色定义与三份 markdown，缺省注入全部已关联项目", () => {
    const root = freshVault();
    seedProject(root, "", "ownward", "# ownward\n个人工作台");
    seedProject(root, "", "desk", "# desk\n桌面端");
    ok(createRole({ ...NEW_ROLE, instructions: "负责实现与验证", projects: ["ownward", "desk"] }));
    writeFileSync(join(root, "roles", "dev", "principles.md"), "# 原则\n- 证据优先");
    writeFileSync(join(root, "roles", "dev", "decisions.md"), "# 决策\n- 用 bun");

    const pack = roleMemoryPack("dev");
    expect(pack).toContain("角色：研发（dev）");
    expect(pack).toContain("负责实现与验证");
    expect(pack).toContain("证据优先");
    expect(pack).toContain("用 bun");
    expect(pack).toContain("个人工作台");
    expect(pack).toContain("桌面端");
  });

  test("只读「已关联且本次选择」的项目", () => {
    const root = freshVault();
    seedProject(root, "", "ownward", "OWNWARD_README");
    seedProject(root, "", "desk", "DESK_README");
    seedProject(root, "", "secret", "SECRET_README");
    ok(createRole({ ...NEW_ROLE, projects: ["ownward", "desk"] }));

    const narrowed = roleMemoryPack("dev", ["ownward"]);
    expect(narrowed).toContain("OWNWARD_README");
    expect(narrowed).not.toContain("DESK_README");

    // 没关联的项目即便被显式选中也不注入（选择只能缩小范围，不能扩大）
    const forced = roleMemoryPack("dev", ["ownward", "secret"]);
    expect(forced).not.toContain("SECRET_README");

    // 空选择 = 只要角色自身记忆
    const none = roleMemoryPack("dev", []);
    expect(none).not.toContain("OWNWARD_README");
    expect(none).toContain("角色：研发");
  });

  test("角色不存在时抛错，不静默返回空串（假成功禁令）", () => {
    freshVault();
    expect(() => roleMemoryPack("ghost")).toThrow("角色不存在");
  });
});

describe("scope 物理隔离", () => {
  test("角色落在自己 scope 的 roles/ 下，跨 scope 同名项目不串味", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "shared", "WORK_SHARED_README");
    seedProject(root, "private", "shared", "PRIVATE_SHARED_README");
    seedProject(root, "private", "sideproj", "PRIVATE_SIDE_README");

    ok(createRole({ ...NEW_ROLE, scope: "work", projects: ["shared", "sideproj"] }));
    expect(existsSync(join(root, "work", "roles", "dev", "role.json"))).toBe(true);
    expect(existsSync(join(root, "private", "roles", "dev"))).toBe(false);

    const pack = roleMemoryPack("dev");
    expect(pack).toContain("WORK_SHARED_README");
    expect(pack).not.toContain("PRIVATE_SHARED_README");
    expect(pack).not.toContain("PRIVATE_SIDE_README");   // 私人项目只是关联了个名字，读不到内容
  });

  test("两个 scope 各自的角色都能列出，scope 字段如实标注", () => {
    freshVault(["work", "private"]);
    ok(createRole({ ...NEW_ROLE, scope: "work" }));
    ok(createRole({ ...NEW_ROLE, id: "life", name: "生活", icon: "life", scope: "private" }));
    expect(listRoles().map((r) => `${r.scope}:${r.id}`).sort()).toEqual(["private:life", "work:dev"]);
  });

  test("非法 scope 拒绝（不分流时给 work 也拒）", () => {
    freshVault();
    expect(bad(createRole({ ...NEW_ROLE, scope: "work" })).code).toBe("invalid");
    freshVault(["work", "private"]);
    expect(bad(createRole({ ...NEW_ROLE, scope: "../private" })).code).toBe("invalid");
  });

  test("listProjectSlugs 只列本 scope 的项目", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "ownward", "x");
    seedProject(root, "private", "sideproj", "y");
    expect(listProjectSlugs("work")).toEqual(["ownward"]);
    expect(listProjectSlugs("private")).toEqual(["sideproj"]);
  });
});

describe("候选记忆与人工晋升门", () => {
  const setup = () => {
    const root = freshVault();
    ok(createRole(NEW_ROLE));
    return root;
  };

  test("创建候选写进 _candidates（带 frontmatter 与证据），不碰正式文件", () => {
    const root = setup();
    const before = readFileSync(join(root, "roles", "dev", "principles.md"), "utf8");
    const r = ok(createRoleCandidate("dev", { text: "先写测试再改实现", evidence: "对话里说过", sourceChatId: "chat-1" }));
    const cid = (r as any).candidate.id;

    const raw = readFileSync(join(root, "roles", "dev", "_candidates", `${cid}.md`), "utf8");
    expect(raw).toContain("role: dev");
    expect(raw).toContain("source_chat: chat-1");
    expect(raw).toContain("status: pending");
    expect(raw).toContain("先写测试再改实现");
    expect(raw).toContain("证据：对话里说过");
    expect(readFileSync(join(root, "roles", "dev", "principles.md"), "utf8")).toBe(before);   // 正式记忆纹丝不动

    const list = ok(listRoleCandidates("dev")) as any;
    expect(list.candidates).toHaveLength(1);
    expect(list.candidates[0]).toMatchObject({ id: cid, role: "dev", text: "先写测试再改实现", evidence: "对话里说过", status: "pending" });
  });

  test("空内容 / 超长内容 / 不存在的角色都明确拒绝", () => {
    setup();
    expect(bad(createRoleCandidate("dev", { text: "   " })).code).toBe("invalid");
    expect(bad(createRoleCandidate("dev", { text: "x".repeat(1001) })).code).toBe("invalid");
    expect(bad(createRoleCandidate("ghost", { text: "x" })).code).toBe("not_found");
    expect(bad(listRoleCandidates("ghost")).code).toBe("not_found");
  });

  test("晋升：追加进目标 markdown 并删除候选（只有人能触发）", () => {
    const root = setup();
    const cid = (ok(createRoleCandidate("dev", { text: "接口先定契约", evidence: "改了三次都是契约没定", sourceChatId: "chat-9" })) as any).candidate.id;

    const pr = ok(promoteRoleCandidate("dev", cid, "principles")) as any;
    expect(pr.target).toBe("principles");
    expect(pr.file).toBeUndefined();                          // 不回绝对路径：客户端不需要知道 vault 的磁盘布局
    expect(JSON.stringify(pr)).not.toContain(root);
    const md = readFileSync(join(root, "roles", "dev", "principles.md"), "utf8");
    expect(md).toContain("- 接口先定契约");
    expect(md).toContain("来源：对话 chat-9");
    expect(md).toContain("证据：「改了三次都是契约没定」");
    expect(existsSync(join(root, "roles", "dev", "_candidates", `${cid}.md`))).toBe(false);
    expect((ok(listRoleCandidates("dev")) as any).candidates).toHaveLength(0);

    // 晋升过的候选再晋升一次：明确 404，不是重复追加
    expect(bad(promoteRoleCandidate("dev", cid, "principles")).code).toBe("not_found");
  });

  test("晋升目标只能是 principles/decisions/backlog", () => {
    const root = setup();
    const cid = (ok(createRoleCandidate("dev", { text: "x" })) as any).candidate.id;
    for (const t of ["README", "role.json", "../../../etc/passwd", "principles.md", ""]) {
      expect(bad(promoteRoleCandidate("dev", cid, t)).code).toBe("invalid");
    }
    expect(existsSync(join(root, "roles", "dev", "_candidates", `${cid}.md`))).toBe(true);   // 拒绝时候选还在
  });

  test("晋升到 decisions / backlog 各写各的文件", () => {
    const root = setup();
    const c1 = (ok(createRoleCandidate("dev", { text: "用 bun 不引运行时依赖" })) as any).candidate.id;
    const c2 = (ok(createRoleCandidate("dev", { text: "把 Role 前端排到第 3 阶段" })) as any).candidate.id;
    ok(promoteRoleCandidate("dev", c1, "decisions"));
    ok(promoteRoleCandidate("dev", c2, "backlog"));
    expect(readFileSync(join(root, "roles", "dev", "decisions.md"), "utf8")).toContain("用 bun 不引运行时依赖");
    expect(readFileSync(join(root, "roles", "dev", "backlog.md"), "utf8")).toContain("把 Role 前端排到第 3 阶段");
    expect(readFileSync(join(root, "roles", "dev", "decisions.md"), "utf8")).not.toContain("第 3 阶段");
  });

  test("丢弃：删候选、不动正式文件；重复丢弃是 404", () => {
    const root = setup();
    const before = readFileSync(join(root, "roles", "dev", "backlog.md"), "utf8");
    const cid = (ok(createRoleCandidate("dev", { text: "要不要做角色对话" })) as any).candidate.id;
    ok(dismissRoleCandidate("dev", cid));
    expect(existsSync(join(root, "roles", "dev", "_candidates", `${cid}.md`))).toBe(false);
    expect(readFileSync(join(root, "roles", "dev", "backlog.md"), "utf8")).toBe(before);
    expect(bad(dismissRoleCandidate("dev", cid)).code).toBe("not_found");
  });

  test("候选 id 路径穿越拒绝（晋升与丢弃两条路都拦）", () => {
    const root = setup();
    writeFileSync(join(root, "outside.md"), "OUTSIDE");
    for (const cid of ["../../outside", "../role", "a/b", "./x", "", "A".repeat(70), "/etc/passwd"]) {
      expect(bad(promoteRoleCandidate("dev", cid, "principles")).code).toBe("invalid");
      expect(bad(dismissRoleCandidate("dev", cid)).code).toBe("invalid");
    }
    expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("OUTSIDE");
    expect(existsSync(join(root, "roles", "dev", "role.json"))).toBe(true);
  });

  test("候选按 scope 隔离：private 角色的候选不落在 work 目录", () => {
    const root = freshVault(["work", "private"]);
    ok(createRole({ ...NEW_ROLE, id: "life", name: "生活", icon: "life", scope: "private" }));
    const cid = (ok(createRoleCandidate("life", { text: "周末不看工作消息" })) as any).candidate.id;
    expect(existsSync(join(root, "private", "roles", "life", "_candidates", `${cid}.md`))).toBe(true);
    expect(existsSync(join(root, "work", "roles", "life"))).toBe(false);
  });
});

describe("坏数据兜底", () => {
  test("坏掉的 role.json 不炸列表（跳过并留痕），其余角色照常", () => {
    const root = freshVault();
    ok(createRole(NEW_ROLE));
    mkdirSync(join(root, "roles", "broken"), { recursive: true });
    writeFileSync(join(root, "roles", "broken", "role.json"), "{ not json");
    mkdirSync(join(root, "roles", "no-manifest"), { recursive: true });   // 半途手删的目录

    expect(listRoles().map((r) => r.id)).toEqual(["dev"]);
    expect(getRole("broken")).toBeNull();
  });

  test("roles 目录还不存在时列表是空数组，不抛", () => {
    freshVault();
    expect(listRoles()).toEqual([]);
    expect(listProjectSlugs()).toEqual([]);
  });
});

// 跨 scope 同 id 只可能来自人工建目录或 vault 同步冲突（API 侧的查重挡得住）。
// 一旦出现，"按 id 寻址"就是歧义——命中谁都可能把另一份角色的记忆写没了，只能人工改名。
describe("跨 scope 同 id 冲突", () => {
  /** work + private 各一份 dev；返回 vault root */
  const conflicted = (privateOver: Record<string, unknown> = {}) => {
    const root = freshVault(["work", "private"]);
    ok(createRole({ ...NEW_ROLE, scope: "work" }));
    writeRoleJson(root, "private", "dev", { ...RAW_MANIFEST, name: "私人研发", ...privateOver });
    return root;
  };

  test("列表两份都在且都标 conflict：藏掉一份等于让那份角色的记忆凭空消失", () => {
    conflicted();
    const list = listRoles();
    expect(list.map((r) => `${r.scope}:${r.name}`)).toEqual(["work:研发", "private:私人研发"]);
    expect(list.map((r) => r.conflict)).toEqual([true, true]);
  });

  test("按 id 的读写一律 conflict，绝不静默命中第一份", () => {
    const root = conflicted();
    expect(getRole("dev")).toBeNull();                 // 说不清是哪一份 = 拿不到
    const c = bad(resolveRole("dev"));
    expect(c.code).toBe("conflict");
    expect(c.msg).toContain("各有一份");

    for (const r of [
      updateRole("dev", { name: "改一下" }),
      archiveRole("dev", true),
      createRoleCandidate("dev", { text: "写点什么" }),
      listRoleCandidates("dev"),
      promoteRoleCandidate("dev", "20260101-abcdef", "principles"),
      dismissRoleCandidate("dev", "20260101-abcdef"),
      createRole({ ...NEW_ROLE, scope: "private" }),   // 冲突上再叠一份更不行
    ]) expect(bad(r).code).toBe("conflict");
    expect(() => roleMemoryPack("dev")).toThrow("各有一份");   // 注入更不行：猜错就长在错的记忆上

    // 两份文件一个字都没被动过（冲突期间任何写入都可能写错一份）
    const nameOf = (s: string) => JSON.parse(readFileSync(join(root, s, "roles", "dev", "role.json"), "utf8")).name;
    expect([nameOf("work"), nameOf("private")]).toEqual(["研发", "私人研发"]);
    expect(readdirSync(join(root, "work", "roles", "dev", "_candidates"))).toEqual([]);
  });

  test("其中一份已归档：默认列表只剩一份，但它照样标 conflict、照样不能操作", () => {
    conflicted({ status: "archived" });
    const list = listRoles();
    expect(list.map((r) => r.scope)).toEqual(["work"]);   // 归档的不进默认列表
    expect(list[0].conflict).toBe(true);                  // 冲突却照旧——列表与接口不能对不上
    expect(bad(updateRole("dev", { name: "x" })).code).toBe("conflict");
    expect(listRoles({ includeArchived: true }).map((r) => r.conflict)).toEqual([true, true]);
  });

  test("坏 manifest 不参与冲突判定：手滑写坏的那份不能把好的那份也拖下水", () => {
    const root = freshVault(["work", "private"]);
    ok(createRole({ ...NEW_ROLE, scope: "work" }));
    writeRoleJson(root, "private", "dev", "{ not json");
    expect(getRole("dev")!.scope).toBe("work");
    expect(listRoles().map((r) => r.conflict)).toEqual([undefined]);
    expect(ok(updateRole("dev", { name: "研发（新）" })) as any).toMatchObject({ ok: true });
  });
});

// vault 是人和同步工具都能碰的目录：role.json 一律当外部输入，坏的整份作废。
describe("篡改 role.json", () => {
  test("projects 混进 ../../：整份作废，scope 外与 vault 外的 marker 一个字都读不到", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "shared", "WORK_SHARED_README");
    seedProject(root, "private", "leak", "PRIVATE_LEAK_MARKER");
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "README.md"), "OUTSIDE_MARKER");

    ok(createRole({ ...NEW_ROLE, scope: "work", projects: ["shared"] }));
    const f = join(root, "work", "roles", "dev", "role.json");
    // 人手改（或同步冲突写回来）：projects 指到别的 scope / vault 之外
    writeFileSync(f, JSON.stringify({
      ...JSON.parse(readFileSync(f, "utf8")),
      projects: ["shared", "../../private/projects/leak", "../../outside"],
    }));

    expect(listRoles()).toEqual([]);                 // 坏 manifest 不出现在列表
    expect(getRole("dev")).toBeNull();
    const r = bad(resolveRole("dev"));
    expect(r.code).toBe("invalid");
    expect(r.msg).toContain("slug");                 // 报清楚坏在哪，人才修得动

    let pack = "";
    try { pack = roleMemoryPack("dev"); } catch { /* 期望就是抛 */ }
    expect(() => roleMemoryPack("dev")).toThrow();   // 组装前就断掉，README 根本读不到
    expect(pack).not.toContain("PRIVATE_LEAK_MARKER");
    expect(pack).not.toContain("OUTSIDE_MARKER");
    expect(pack).not.toContain("WORK_SHARED_README");

    // 坏 manifest 不给任何操作入口：修文件是人的活，不是让 API 顺手覆盖掉
    for (const x of [
      updateRole("dev", { name: "x" }), archiveRole("dev", true),
      createRoleCandidate("dev", { text: "x" }), listRoleCandidates("dev"),
      createRole({ ...NEW_ROLE, scope: "work" }),
    ]) expect(bad(x).code).toBe("invalid");
  });

  test("字段不合法一律整份作废（跳过 + 明确报错，不半信半疑地用半份）", () => {
    const root = freshVault();
    const cases: [string, unknown][] = [
      ["坏 JSON", "{ not json"],
      ["不是对象", JSON.stringify([RAW_MANIFEST])],
      ["name 不是字符串", { ...RAW_MANIFEST, name: { evil: 1 } }],
      ["name 为空", { ...RAW_MANIFEST, name: "   " }],
      ["name 超长", { ...RAW_MANIFEST, name: "名".repeat(31) }],
      ["description 超长", { ...RAW_MANIFEST, description: "描".repeat(201) }],
      ["icon 不在白名单", { ...RAW_MANIFEST, icon: "<svg onload=1>" }],
      ["color 不是 #RRGGBB", { ...RAW_MANIFEST, color: "red" }],
      ["instructions 超长", { ...RAW_MANIFEST, instructions: "职".repeat(2001) }],
      ["projects 不是数组", { ...RAW_MANIFEST, projects: "ownward" }],
      ["projects 里不是字符串", { ...RAW_MANIFEST, projects: [{ x: 1 }] }],
      ["projects 路径穿越", { ...RAW_MANIFEST, projects: ["../../etc"] }],
      ["projects 带斜杠", { ...RAW_MANIFEST, projects: ["a/b"] }],
      ["projects 超量", { ...RAW_MANIFEST, projects: Array.from({ length: 21 }, (_, i) => `p${i}`) }],
      ["status 非法", { ...RAW_MANIFEST, status: "deleted" }],
      ["缺 status", { ...RAW_MANIFEST, status: undefined }],
      ["createdAt 不是时间", { ...RAW_MANIFEST, createdAt: "昨天" }],
      ["缺 updatedAt", { ...RAW_MANIFEST, updatedAt: undefined }],
    ];
    for (const [label, m] of cases) {
      writeRoleJson(root, "", "dev", m);
      expect(listRoles(), label).toEqual([]);
      expect(getRole("dev"), label).toBeNull();
      expect(bad(resolveRole("dev")).code, label).toBe("invalid");
      expect(bad(updateRole("dev", { name: "x" })).code, label).toBe("invalid");
      expect(bad(archiveRole("dev", false)).code, label).toBe("invalid");
    }
  });

  test("合法但写得随意的 role.json：读进来就规范化（id/scope 一律以目录为准）", () => {
    const root = freshVault();
    writeRoleJson(root, "", "dev", {
      id: "另一个 id", scope: "private",                 // 这两个都以目录为准，manifest 里的忽略
      name: " 研发   老王 ", description: "写代码", icon: "code", color: "#5B8DEF",
      projects: ["Ownward", " ownward ", "desk"], instructions: "只管实现", status: "active",
      createdAt: "2026-01-01", updatedAt: "2026-01-02T03:04:05Z",
    });
    const role = getRole("dev")!;
    expect(role.id).toBe("dev");
    expect(role.scope).toBe("");
    expect(role.name).toBe("研发 老王");
    expect(role.color).toBe("#5b8def");
    expect(role.projects).toEqual(["ownward", "desk"]);
    expect(role.createdAt).toBe("2026-01-01T00:00:00.000Z");   // 归一成 ISO，否则列表排序会错位
    expect(role.updatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(role.conflict).toBeUndefined();                      // 只有一份就不标冲突
    expect(listRoles().map((r) => r.id)).toEqual(["dev"]);
  });

  test("selectedProjects 只能缩小范围：客户端传路径穿越也拼不出 scope 外的路径", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "shared", "WORK_SHARED_README");
    seedProject(root, "private", "leak", "PRIVATE_LEAK_MARKER");
    ok(createRole({ ...NEW_ROLE, scope: "work", projects: ["shared"] }));
    const pack = roleMemoryPack("dev", ["../../private/projects/leak", "shared"]);
    expect(pack).toContain("WORK_SHARED_README");
    expect(pack).not.toContain("PRIVATE_LEAK_MARKER");
  });
});

// ==================== Role V2：两层研发组织 ====================
// 组织约束错了，表现是"看起来能用"：对话照发，只是注入了错的记忆——只有测试能拦。

/** 一个 lead + 一个挂在它下面的项目专家（项目目录先造好） */
function seedOrg(scope: Scope = "") {
  const root = freshVault(scope ? ["work", "private"] : [""]);
  seedProject(root, scope, "ownward", "OWNWARD_README_MARKER");
  seedProject(root, scope, "secondary-project", "SECONDARY_PROJECT_README_MARKER");
  ok(createRole({ id: "rd", name: "研发 LD", icon: "code", scope }));
  ok(createRole({
    id: "ownward-dev", name: "ownward 专家", icon: "code", scope,
    type: "project", primaryProject: "ownward", parentRoleId: "rd",
  }));
  return root;
}

describe("V1 角色的向后兼容", () => {
  test("旧 role.json 没有 type/parentRoleId/primaryProject → 按职能负责人读，照常改照常归档", () => {
    const root = freshVault();
    // V1 时代原样落盘的 manifest（三个新键一个都没有）
    writeRoleJson(root, "", "dev", RAW_MANIFEST);
    const role = getRole("dev")!;
    expect(role.type).toBe("lead");
    expect(role.parentRoleId).toBe("");
    expect(role.primaryProject).toBe("");
    expect(role.childCount).toBeUndefined();          // resolveRole 不做全量扫描
    expect(listRoles()[0].childCount).toBe(0);        // 列表里才有派生的组织信息

    ok(updateRole("dev", { description: "还是老角色" }));
    expect(getRole("dev")!.type).toBe("lead");        // 补写的 manifest 明确带上 lead
    expect(JSON.parse(readFileSync(join(root, "roles", "dev", "role.json"), "utf8")).type).toBe("lead");
    ok(archiveRole("dev", true));
    ok(archiveRole("dev", false));
  });

  test("V1 建法（不传 type）仍然建出职能负责人", () => {
    freshVault();
    const r = ok(createRole(NEW_ROLE)) as any;
    expect(r.role.type).toBe("lead");
    expect(roleMemoryPack("dev")).toContain("职能负责人");
  });
});

describe("项目专家的字段约束", () => {
  test("主项目必填、自动并进关联项目、slug 白名单", () => {
    const root = freshVault();
    seedProject(root, "", "ownward", "x");
    expect(bad(createRole({ ...NEW_ROLE, id: "e1", type: "project" })).msg).toContain("主项目");
    expect(bad(createRole({ ...NEW_ROLE, id: "e2", type: "project", primaryProject: "../../etc" })).msg).toContain("主项目 slug");
    expect(bad(createRole({ ...NEW_ROLE, id: "e3", type: "boss" })).msg).toContain("类型");

    // projects 里没写主项目也不算错：API 侧自动并进去（磁盘侧不做这个兜底，见下一个 describe）
    const r = ok(createRole({ ...NEW_ROLE, id: "e4", type: "project", primaryProject: "Ownward", projects: ["desk"] })) as any;
    expect(r.role.primaryProject).toBe("ownward");
    expect(r.role.projects).toContain("ownward");
    expect(JSON.parse(readFileSync(join(root, "roles", "e4", "role.json"), "utf8")).primaryProject).toBe("ownward");
  });

  test("职能负责人不许带上级/主项目；改类型要显式清空", () => {
    freshVault();
    expect(bad(createRole({ ...NEW_ROLE, id: "l1", primaryProject: "ownward" })).msg).toContain("职能负责人不能有主项目");
    expect(bad(createRole({ ...NEW_ROLE, id: "l2", parentRoleId: "rd" })).msg).toContain("职能负责人不能有上级");

    ok(createRole({ id: "rd", name: "研发 LD" }));
    ok(createRole({ ...NEW_ROLE, id: "ex", type: "project", primaryProject: "ownward", parentRoleId: "rd" }));
    // 只把 type 改回 lead、不清空另外两个字段：明确报错（不静默丢掉主项目）
    expect(bad(updateRole("ex", { type: "lead" })).msg).toContain("清空");
    const back = ok(updateRole("ex", { type: "lead", primaryProject: "", parentRoleId: "" })) as any;
    expect(back.role.type).toBe("lead");
    expect(back.role.primaryProject).toBe("");
  });

  test("自指的上级一律拒（创建与修改两条路）", () => {
    freshVault();
    expect(bad(createRole({ ...NEW_ROLE, id: "solo", type: "project", primaryProject: "p", parentRoleId: "solo" })).msg)
      .toContain("上级不能是自己");
    ok(createRole({ id: "rd", name: "研发 LD" }));
    ok(createRole({ ...NEW_ROLE, id: "ex", type: "project", primaryProject: "ownward", parentRoleId: "rd" }));
    expect(bad(updateRole("ex", { parentRoleId: "ex" })).msg).toContain("上级不能是自己");
    expect(getRole("ex")!.parentRoleId).toBe("rd");
  });
});

describe("挂靠关系（上级）", () => {
  test("上级必须存在、是在岗的职能负责人、且同 scope", () => {
    const root = seedOrg("work");
    seedProject(root, "private", "sideproj", "PRIVATE");
    ok(createRole({ id: "life", name: "生活", icon: "life", scope: "private" }));

    // 不存在的上级 = 这次改动的入参不合法（400），不是"角色不存在"（404）——被改的角色好好的
    const ghost = bad(updateRole("ownward-dev", { parentRoleId: "ghost" }));
    expect(ghost.code).toBe("invalid");
    expect(ghost.msg).toContain("上级角色不可用");
    // 跨 scope
    expect(bad(updateRole("ownward-dev", { parentRoleId: "life" })).msg).toContain("跨 scope");
    // 上级是项目专家
    ok(createRole({ id: "secondary-dev", name: "辅助项目专家", scope: "work", type: "project", primaryProject: "secondary-project" }));
    expect(bad(updateRole("ownward-dev", { parentRoleId: "secondary-dev" })).msg).toContain("必须是职能负责人");
    // 上级已归档
    ok(createRole({ id: "rd2", name: "另一个 LD", scope: "work" }));
    ok(archiveRole("rd2", true));
    expect(bad(updateRole("ownward-dev", { parentRoleId: "rd2" })).msg).toContain("已归档");
    expect(getRole("ownward-dev")!.parentRoleId).toBe("rd");   // 全程没被改坏
  });

  test("项目专家不能当上级：把有下属的负责人改成专家会被拒", () => {
    seedOrg();
    const f = bad(updateRole("rd", { type: "project", primaryProject: "secondary-project" }));
    expect(f.code).toBe("conflict");
    expect(f.msg).toContain("名下还有");
    expect(getRole("rd")!.type).toBe("lead");
  });

  test("成环的父链拦在写入前（磁盘上的环也读不出来）", () => {
    const root = seedOrg();
    // 人手把负责人改成"有上级"的样子 —— 单份 manifest 就自相矛盾，整份作废
    writeRoleJson(root, "", "rd", {
      ...RAW_MANIFEST, name: "研发 LD", type: "lead", parentRoleId: "ownward-dev",
    });
    expect(bad(resolveRole("rd")).code).toBe("invalid");
    expect(listRoles().map((r) => r.id)).toEqual(["ownward-dev"]);
    // 上级读不出来 → 挂靠它的修改也做不了（不会顺着环转下去）
    expect(bad(updateRole("ownward-dev", { parentRoleId: "rd" })).msg).toContain("上级角色不可用");
  });

  test("列表与详情如实标组织关系：childCount / parentMissing / roleOrg", () => {
    seedOrg();
    const list = listRoles();
    const lead = list.find((r) => r.id === "rd")!;
    const expert = list.find((r) => r.id === "ownward-dev")!;
    expect(lead.childCount).toBe(1);
    expect(expert.parentMissing).toBeUndefined();

    const org = roleOrg(getRole("rd")!);
    expect(org.children.map((c) => c.id)).toEqual(["ownward-dev"]);
    expect(org.parent).toBeNull();
    const eorg = roleOrg(getRole("ownward-dev")!);
    expect(eorg.parent!.id).toBe("rd");
    expect(eorg.parentMissing).toBe(false);
  });

  test("上级目录被删：专家还在，但明确标 parentMissing（不装作没挂过）", () => {
    const root = seedOrg();
    rmSync(join(root, "roles", "rd"), { recursive: true, force: true });
    const expert = listRoles().find((r) => r.id === "ownward-dev")!;
    expect(expert.parentMissing).toBe(true);
    const org = roleOrg(getRole("ownward-dev")!);
    expect(org.parent).toBeNull();
    expect(org.parentMissing).toBe(true);
    expect(org.parentMsg).toContain("不存在");
    // 记忆照常注入：组织关系有瑕疵不该让对话发不出去
    expect(roleMemoryPack("ownward-dev")).toContain("OWNWARD_README_MARKER");
  });
});

describe("一个项目只留一个在岗专家", () => {
  test("同 scope 同主项目重复创建是 conflict；归档的不占名额", () => {
    seedOrg();
    const dup = bad(createRole({ id: "ownward-dev2", name: "另一个 ownward 专家", type: "project", primaryProject: "ownward" }));
    expect(dup.code).toBe("conflict");
    expect(dup.msg).toContain("ownward-dev");

    ok(archiveRole("ownward-dev", true));
    ok(createRole({ id: "ownward-dev2", name: "接手的专家", type: "project", primaryProject: "ownward" }));
    // 归档的那个想回来：主项目已被接手，明确 conflict（不是静默覆盖）
    expect(bad(archiveRole("ownward-dev", false)).code).toBe("conflict");
  });

  test("改主项目撞上别人的主项目也拦得住", () => {
    seedOrg();
    ok(createRole({ id: "secondary-dev", name: "辅助项目专家", type: "project", primaryProject: "secondary-project" }));
    expect(bad(updateRole("secondary-dev", { primaryProject: "ownward" })).code).toBe("conflict");
    expect(getRole("secondary-dev")!.primaryProject).toBe("secondary-project");
  });

  test("不同 scope 的同名项目各留一个专家（scope 是物理隔离，不是命名空间借用）", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "shared", "WORK");
    seedProject(root, "private", "shared", "PRIVATE");
    ok(createRole({ id: "w-dev", name: "工作专家", scope: "work", type: "project", primaryProject: "shared" }));
    ok(createRole({ id: "p-dev", name: "私人专家", scope: "private", type: "project", primaryProject: "shared" }));
    expect(listRoles().map((r) => r.id).sort()).toEqual(["p-dev", "w-dev"]);
  });
});

describe("归档负责人要先安置下属", () => {
  test("名下还有在岗专家时归档是 conflict，安置后才放行", () => {
    seedOrg();
    const f = bad(archiveRole("rd", true));
    expect(f.code).toBe("conflict");
    expect(f.msg).toContain("ownward-dev");
    expect(getRole("rd")!.status).toBe("active");

    // 改挂到别的负责人 → 原负责人可以归档
    ok(createRole({ id: "rd2", name: "新 LD" }));
    ok(updateRole("ownward-dev", { parentRoleId: "rd2" }));
    ok(archiveRole("rd", true));

    // 或者把专家一并归档
    ok(archiveRole("ownward-dev", true));
    ok(archiveRole("rd2", true));
    // 上下级一起归档着：改个描述照样可以（这条约束只对在岗角色成立）
    ok(updateRole("ownward-dev", { description: "归档着也能改说明" }));
    // 但不能单独恢复（否则就成了挂着归档上级的在岗专家）
    expect(bad(archiveRole("ownward-dev", false)).msg).toContain("已归档");
    ok(archiveRole("rd2", false));
    ok(archiveRole("ownward-dev", false));
  });
});

describe("项目专家的 Context Pack", () => {
  test("主项目强制注入：选择集为空、或只选了别的项目，主项目照样在", () => {
    const root = seedOrg();
    ok(updateRole("ownward-dev", { projects: ["ownward", "secondary-project"] }));
    writeFileSync(join(root, "roles", "ownward-dev", "principles.md"), "# 原则\n- EXPERT_PRINCIPLE");

    const full = roleMemoryPack("ownward-dev");
    expect(full).toContain("项目专家");
    expect(full).toContain("主项目：ownward");
    expect(full).toContain("上级：研发 LD（rd）");
    expect(full).toContain("### 主项目记忆：ownward");
    expect(full).toContain("EXPERT_PRINCIPLE");

    // 前端/API 想缩小到空 → 主项目仍在，附加项目没了
    const narrowed = roleMemoryPack("ownward-dev", []);
    expect(narrowed).toContain("OWNWARD_README_MARKER");
    expect(narrowed).not.toContain("SECONDARY_PROJECT_README_MARKER");
    // 只选附加项目 → 主项目还是排头
    const other = roleMemoryPack("ownward-dev", ["secondary-project"]);
    expect(other).toContain("OWNWARD_README_MARKER");
    expect(other).toContain("SECONDARY_PROJECT_README_MARKER");
    expect(other.indexOf("OWNWARD_README_MARKER")).toBeLessThan(other.indexOf("SECONDARY_PROJECT_README_MARKER"));
    // 路径穿越的"主项目"进不来：主项目 slug 与 scope 都是落盘校验过的
    expect(roleMemoryPack("ownward-dev", ["../../etc"])).toContain("OWNWARD_README_MARKER");
  });

  test("职能负责人的包一个字没变（V1 行为）", () => {
    const root = freshVault();
    seedProject(root, "", "ownward", "OWNWARD_README_MARKER");
    ok(createRole({ ...NEW_ROLE, projects: ["ownward"] }));
    const pack = roleMemoryPack("dev", []);
    expect(pack).toContain("职能负责人");
    expect(pack).not.toContain("主项目");
    expect(pack).not.toContain("OWNWARD_README_MARKER");   // 选择集为空 = 只要角色自身记忆
  });
});

describe("篡改 role.json 的组织字段", () => {
  test("组织字段自相矛盾一律整份作废（磁盘不许比 API 宽松）", () => {
    const root = freshVault();
    const base = { ...RAW_MANIFEST, projects: ["ownward"] };
    const cases: [string, unknown][] = [
      ["type 非法", { ...base, type: "boss" }],
      ["type 不是字符串", { ...base, type: 1 }],
      ["项目专家缺主项目", { ...base, type: "project" }],
      ["主项目不在关联项目里", { ...base, type: "project", primaryProject: "other" }],
      ["主项目路径穿越", { ...base, type: "project", primaryProject: "../../etc" }],
      ["负责人带主项目", { ...base, type: "lead", primaryProject: "ownward" }],
      ["负责人带上级", { ...base, type: "lead", parentRoleId: "rd" }],
      ["上级 id 路径穿越", { ...base, type: "project", primaryProject: "ownward", parentRoleId: "../../etc" }],
      ["自己是自己的上级", { ...base, type: "project", primaryProject: "ownward", parentRoleId: "dev" }],
    ];
    for (const [label, m] of cases) {
      writeRoleJson(root, "", "dev", m);
      expect(listRoles(), label).toEqual([]);
      expect(getRole("dev"), label).toBeNull();
      expect(bad(resolveRole("dev")).code, label).toBe("invalid");
      expect(bad(updateRole("dev", { name: "x" })).code, label).toBe("invalid");
      expect(() => roleMemoryPack("dev")).toThrow();   // 坏 manifest 绝不拿去注入
    }
  });

  test("合法的项目专家 manifest 读得回来（字段规范化，scope/id 仍以目录为准）", () => {
    const root = freshVault();
    seedProject(root, "", "ownward", "x");
    writeRoleJson(root, "", "rd", { ...RAW_MANIFEST, name: "研发 LD" });
    writeRoleJson(root, "", "expert", {
      ...RAW_MANIFEST, name: "专家", type: "project",
      primaryProject: " Ownward ", projects: ["Ownward", "desk"], parentRoleId: "rd",
    });
    const role = getRole("expert")!;
    expect(role.type).toBe("project");
    expect(role.primaryProject).toBe("ownward");
    expect(role.projects).toEqual(["ownward", "desk"]);
    expect(role.parentRoleId).toBe("rd");
    expect(listRoles().find((r) => r.id === "rd")!.childCount).toBe(1);
  });
});

// 磁盘旁路：写入侧（checkLinks）拦得住重复专家，但人工建目录 / vault 同步冲突能直接落两份
// 各自合法的 role.json。那时"这个项目的专家是谁"是歧义——跟跨 scope 同 id 同一类，读取侧也得判。
describe("同 scope 同主项目多个在岗专家（磁盘旁路）", () => {
  /** 手工落两份都合法的项目专家 manifest（API 建不出来），返回 vault root */
  function duplicated(over: Record<string, unknown> = {}) {
    const root = freshVault();
    seedProject(root, "", "ownward", "OWNWARD_README_MARKER");
    const m = { ...RAW_MANIFEST, type: "project", primaryProject: "ownward", projects: ["ownward"] };
    writeRoleJson(root, "", "ownward-dev", { ...m, name: "ownward 专家" });
    writeRoleJson(root, "", "ownward-dev2", { ...m, name: "另一个 ownward 专家", ...over });
    return root;
  }

  test("列表两份都在、都标 conflict 并带原因（藏掉一份等于让那份记忆凭空消失）", () => {
    duplicated();
    const list = listRoles();
    expect(list.map((r) => r.id).sort()).toEqual(["ownward-dev", "ownward-dev2"]);
    expect(list.map((r) => r.conflict)).toEqual([true, true]);
    for (const r of list) {
      expect(r.conflictMsg).toContain("2 个在岗专家");
      expect(r.conflictMsg).toContain("ownward");
    }
  });

  test("按 id 的读、注入、候选一律 conflict，绝不猜一份", () => {
    const root = duplicated();
    expect(getRole("ownward-dev")).toBeNull();
    const c = bad(resolveRole("ownward-dev"));
    expect(c.code).toBe("conflict");
    expect(c.msg).toContain("在岗专家");
    expect(() => roleMemoryPack("ownward-dev")).toThrow("在岗专家");   // 注入更不行

    for (const r of [
      createRoleCandidate("ownward-dev", { text: "写点什么" }),
      listRoleCandidates("ownward-dev"),
      promoteRoleCandidate("ownward-dev", "20260101-abcdef", "principles"),
      dismissRoleCandidate("ownward-dev", "20260101-abcdef"),
    ]) expect(bad(r).code).toBe("conflict");
    // 两份文件一个字都没被动过
    const nameOf = (id: string) => JSON.parse(readFileSync(join(root, "roles", id, "role.json"), "utf8")).name;
    expect([nameOf("ownward-dev"), nameOf("ownward-dev2")]).toEqual(["ownward 专家", "另一个 ownward 专家"]);
  });

  test("修复出路留着：归档一份就解冲突；改主项目也行；维持冲突的改动照样拒", () => {
    duplicated();
    // 维持冲突的普通改动 → 仍然 conflict（checkLinks 那道门）
    expect(bad(updateRole("ownward-dev", { description: "随便改改" })).code).toBe("conflict");
    // 归档是解法之一：必须放行
    ok(archiveRole("ownward-dev2", true));
    expect(getRole("ownward-dev")!.name).toBe("ownward 专家");        // 立刻恢复可用
    expect(listRoles()[0].conflict).toBeUndefined();
    expect(roleMemoryPack("ownward-dev")).toContain("OWNWARD_README_MARKER");
    // 归档的那份想回来：主项目还被占着 → conflict（不是静默覆盖）
    expect(bad(archiveRole("ownward-dev2", false)).code).toBe("conflict");
  });

  test("改主项目也是解法（改到没人占的项目上就通过）", () => {
    const root = duplicated();
    seedProject(root, "", "desk", "DESK_README_MARKER");
    ok(updateRole("ownward-dev2", { primaryProject: "desk", projects: ["desk"] }));
    expect(getRole("ownward-dev")!.primaryProject).toBe("ownward");
    expect(getRole("ownward-dev2")!.primaryProject).toBe("desk");
    expect(listRoles().every((r) => !r.conflict)).toBe(true);
  });

  test("归档的那份不占名额；坏 manifest 也不参与冲突判定", () => {
    const root = duplicated({ status: "archived" });
    expect(listRoles().map((r) => r.id)).toEqual(["ownward-dev"]);
    expect(listRoles()[0].conflict).toBeUndefined();
    expect(getRole("ownward-dev")!.name).toBe("ownward 专家");

    writeRoleJson(root, "", "ownward-dev3", "{ not json");
    expect(getRole("ownward-dev")!.name).toBe("ownward 专家");        // 坏的那份不拖累好的
  });

  test("跨 scope 同 id 与主项目冲突同时存在：id 冲突优先报（修法是改名）", () => {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "ownward", "W");
    seedProject(root, "private", "ownward", "P");
    const m = { ...RAW_MANIFEST, type: "project", primaryProject: "ownward", projects: ["ownward"] };
    writeRoleJson(root, "work", "ownward-dev", { ...m, name: "工作专家" });
    writeRoleJson(root, "private", "ownward-dev", { ...m, name: "私人专家" });   // 跨 scope 同 id
    writeRoleJson(root, "work", "ownward-dev2", { ...m, name: "同项目第二人" }); // 同 scope 同主项目

    expect(bad(resolveRole("ownward-dev")).msg).toContain("各有一份");            // id 冲突优先
    expect(bad(resolveRole("ownward-dev2")).msg).toContain("在岗专家");
    const list = listRoles();
    expect(list.filter((r) => r.conflict).length).toBe(3);
    expect(list.find((r) => r.id === "ownward-dev")!.conflictMsg).toContain("改名");
    // 不同 scope 的同名项目互不干扰：private 那份只是被 id 冲突牵连，不算主项目冲突
    expect(list.find((r) => r.id === "ownward-dev2")!.conflictMsg).toContain("在岗专家");
  });
});
