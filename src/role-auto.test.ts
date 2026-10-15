// 自动角色：跑在临时 vault + 假项目身份上（git 解析另有 project-identity.test.ts 跑真仓库）。
// 重点锁死：Owner 只建一次、人建的不碰、归档的不顶替、跨 scope 合不成、预览没有副作用、
// 点名的角色不可用要失败而自动匹配失败只是不带角色。
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Scope } from "./paths.ts";
import type { ProjectIdentity } from "./project-identity.ts";
import {
  crossRoleForDirs, crossRoleSuggestions, defaultCrossName, dismissRoleSuggestion, ensureCrossRole, ensureDomainRole, ensureOwnerForDir,
  ensureProjectOwner, findCoveringRole, findProjectOwner, listDomainRoles, matchDomain, parseDomainMatch, pickRoleForDispatch,
  previewRoleForDirs, previewRoleForDispatch, roleTaskContext, useRoleAutoForTest, type DomainLlm,
} from "./role-auto.ts";
import { splitRoleContext } from "./role-context.ts";
import { archiveRole, createRole, listRoles, resolveRole, useVaultForTest } from "./roles.ts";
import { cfg } from "./util.ts";

const roots: string[] = [];
afterEach(() => { useVaultForTest(null); useRoleAutoForTest(null); });
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** 临时 vault + 临时数据根 + 一张「目录 → 项目身份」表（不在表里的目录 = 不是仓库） */
function setup(identities: Record<string, Omit<ProjectIdentity, "root"> & { root?: string }>, scopes: Scope[] = [""], llm?: DomainLlm) {
  const vault = mkdtempSync(join(tmpdir(), "ownward-roleauto-vault-"));
  const data = mkdtempSync(join(tmpdir(), "ownward-roleauto-data-"));
  roots.push(vault, data);
  useVaultForTest(vault, scopes);
  const table = new Map(Object.entries(identities).map(([dir, id]) => [dir, { root: id.root ?? dir, ...id } as ProjectIdentity]));
  // 缺省的模型一调就失败：没给假模型的用例要是走到了领域匹配，会直接在断言里露出来
  useRoleAutoForTest({ identity: (dir) => table.get(dir) ?? null, dataRoot: data, llm: llm ?? (async () => { throw new Error("这个用例不该调模型"); }) });
  return { vault, data };
}
const id = (slug: string, scope: Scope = "", extra: Partial<ProjectIdentity> = {}) =>
  ({ slug, scope, aliases: [], label: slug, ...extra });
const projDir = (vault: string, scope: Scope, slug: string) => join(scope ? join(vault, scope) : vault, "projects", slug);
function seedLog(vault: string, scope: Scope, slug: string, marker: string) {
  const dir = projDir(vault, scope, slug);
  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "log", "2026-10.md"), `## 10:00 | ${slug} | 修了一个坑\n- **Problem**: ${marker}\n- **Solution**: 换了实现\n\n`);
}

describe("项目 Owner：打开项目就有，只建一次", () => {
  test("第一次派到一个仓库：建出 auto 的项目 Owner + 项目骨架；再来一次复用同一个", () => {
    const { vault } = setup({ "/repo/ownward": id("ownward") });
    const first = ensureOwnerForDir("/repo/ownward");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.role).toMatchObject({
      id: "owner-ownward", name: "ownward Owner", type: "project", primaryProject: "ownward",
      projects: ["ownward"], dirs: ["/repo/ownward"], origin: "auto", status: "active",
    });
    // 一出生就能存项目候选：项目目录与 README 骨架已经建好
    expect(existsSync(join(projDir(vault, "", "ownward"), "README.md"))).toBe(true);
    const again = ensureOwnerForDir("/repo/ownward");
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.role.id).toBe("owner-ownward");
    expect(listRoles().length).toBe(1);
  });

  test("不是仓库的目录没有 Owner，也不建任何东西", () => {
    const { vault } = setup({});
    const r = ensureOwnerForDir("/Users/me/workspace");
    expect(r.ok).toBe(false);
    expect(existsSync(join(vault, "roles"))).toBe(false);
  });

  test("人建的项目专家就是 Owner：直接用，一个字不改（含按远程名起的主项目）", () => {
    const { vault } = setup({ "/repo/internal": id("internal", "", { aliases: ["ownward"], label: "ownward" }) });
    mkdirSync(projDir(vault, "", "ownward"), { recursive: true });
    const mine = createRole({ id: "ownward-dev", name: "我的专家", type: "project", primaryProject: "ownward", instructions: "手写的职责" });
    expect(mine.ok).toBe(true);
    const r = ensureOwnerForDir("/repo/internal");
    expect(r.ok && r.role.id).toBe("ownward-dev");
    expect(r.ok && r.created).toBe(false);
    const after = resolveRole("ownward-dev");
    expect(after.ok && after.role.dirs).toEqual([]);              // 人建的不自动登记目录
    expect(after.ok && after.role.instructions).toBe("手写的职责");
    expect(listRoles().length).toBe(1);
  });

  test("自动建的会顺手维护：新的工作目录、vault 里新冒出来的别名项目", () => {
    const { vault } = setup({
      "/repo/internal": id("internal", "", { aliases: ["ownward"], label: "ownward" }),
      "/clone/internal": id("internal", "", { aliases: ["ownward"], label: "ownward" }),
    });
    const first = ensureOwnerForDir("/repo/internal");
    expect(first.ok && first.role.projects).toEqual(["internal"]);   // 别名目录还不存在：不挂空名字
    mkdirSync(projDir(vault, "", "ownward"), { recursive: true });
    const second = ensureOwnerForDir("/clone/internal");
    expect(second.ok && second.role.id).toBe(first.ok ? first.role.id : "");
    expect(second.ok && second.role.dirs).toEqual(["/repo/internal", "/clone/internal"]);
    expect(second.ok && second.role.projects).toEqual(["internal", "ownward"]);
  });

  test("人归档了 Owner = 这个项目不要 Owner：不自动顶替一个新的", () => {
    setup({ "/repo/ownward": id("ownward") });
    const first = ensureOwnerForDir("/repo/ownward");
    expect(first.ok).toBe(true);
    expect(archiveRole("owner-ownward", true).ok).toBe(true);
    const r = ensureOwnerForDir("/repo/ownward");
    expect(r.ok).toBe(false);
    expect((r as any).msg).toContain("已归档");
    expect(listRoles({ includeArchived: true }).length).toBe(1);
  });

  test("id 被别的角色占了就加序号，绝不覆盖", () => {
    setup({ "/repo/ownward": id("ownward") });
    expect(createRole({ id: "owner-ownward", name: "别的东西", projects: [] }).ok).toBe(true);   // 一个同名的职能负责人
    const r = ensureOwnerForDir("/repo/ownward");
    expect(r.ok && r.role.id).toBe("owner-ownward-2");
  });

  test("scope 跟着项目走：工作项目的 Owner 落在 work/roles/", () => {
    const { vault } = setup({ "/repo/acme-app": id("acme-app", "work") }, ["work", "private"]);
    const r = ensureOwnerForDir("/repo/acme-app");
    expect(r.ok && r.role.scope).toBe("work");
    expect(existsSync(join(vault, "work", "roles", "owner-acme-app", "role.json"))).toBe(true);
    expect(existsSync(join(vault, "private", "roles"))).toBe(false);
  });
});

describe("跨项目角色", () => {
  test("两个同 scope 的项目：建一个 lead 同时关联两边、登记两个目录；再来一次直接复用", () => {
    setup({ "/repo/a": id("alpha"), "/repo/b": id("beta") });
    const r = crossRoleForDirs(["/repo/b", "/repo/a"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toMatchObject({ type: "lead", origin: "auto", projects: ["alpha", "beta"], dirs: ["/repo/a", "/repo/b"], name: "alpha + beta" });
    const again = crossRoleForDirs(["/repo/a", "/repo/b"]);
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.role.id).toBe(r.role.id);
  });

  test("工作 + 私人合不成一个角色；少于两个项目、或混进非仓库目录都拒", () => {
    setup({ "/repo/w": id("w", "work"), "/repo/p": id("p", "private"), "/repo/w2": id("w", "work") }, ["work", "private"]);
    const mixed = crossRoleForDirs(["/repo/w", "/repo/p"]);
    expect(mixed.ok).toBe(false);
    expect((mixed as any).msg).toContain("工作和私人");
    expect(crossRoleForDirs(["/repo/w", "/repo/w2"]).ok).toBe(false);          // 同一个项目算一个
    expect(crossRoleForDirs(["/repo/w", "/not-a-repo"]).ok).toBe(false);
    expect(listRoles().length).toBe(0);
  });

  test("现成角色已经同时管这几个项目：用它，不另建（人建的职能负责人也算）", () => {
    setup({ "/repo/a": id("alpha"), "/repo/b": id("beta") });
    expect(createRole({ id: "dev", name: "研发", projects: ["alpha", "beta", "gamma"] }).ok).toBe(true);
    const r = ensureCrossRole([{ ...id("alpha"), root: "/repo/a" }, { ...id("beta"), root: "/repo/b" }]);
    expect(r.ok && r.role.id).toBe("dev");
    expect(r.ok && r.created).toBe(false);
    expect(findCoveringRole("", [{ ...id("alpha"), root: "/repo/a" }])?.id).toBe("dev");
  });
});

describe("派发弹窗的预览：只看不建", () => {
  test("没有 Owner 时说「将新建」，但 vault 里什么都没多", () => {
    const { vault } = setup({ "/repo/ownward": id("ownward") });
    const p = previewRoleForDirs("/repo/ownward");
    expect(p.auto).toMatchObject({ roleId: "", name: "ownward Owner", willCreate: true });
    expect(p.cross).toBeNull();
    expect(existsSync(join(vault, "roles"))).toBe(false);
    expect(existsSync(join(vault, "projects"))).toBe(false);
  });

  test("跨两个项目又没人同时管：给出跨项目提示；建了之后「自动」就落到它身上", () => {
    setup({ "/repo/a": id("alpha"), "/repo/b": id("beta") });
    const before = previewRoleForDirs("/repo/a", ["/repo/b"]);
    expect(before.cross).toMatchObject({ possible: true, slugs: ["alpha", "beta"], dirs: ["/repo/a", "/repo/b"] });
    expect(crossRoleForDirs(before.cross!.dirs).ok).toBe(true);
    const after = previewRoleForDirs("/repo/a", ["/repo/b"]);
    expect(after.cross).toBeNull();
    expect(after.auto.name).toBe("alpha + beta");
  });

  test("主目录不是仓库 / Owner 被归档 / 工作私人混搭：各有各的原因", () => {
    setup({ "/repo/ownward": id("ownward", "work"), "/repo/home": id("home", "private") }, ["work", "private"]);
    expect(previewRoleForDirs("/tmp/x").auto.reason).toContain("不是 git 仓库");
    expect(ensureOwnerForDir("/repo/ownward").ok).toBe(true);
    expect(archiveRole("owner-ownward", true).ok).toBe(true);
    expect(previewRoleForDirs("/repo/ownward").auto.reason).toContain("已归档");
    const mixed = previewRoleForDirs("/repo/ownward", ["/repo/home"]);
    expect(mixed.cross).toMatchObject({ possible: false });
    expect(mixed.cross?.reason).toContain("工作和私人");
  });
});

describe("派发时定角色", () => {
  test("auto：建 Owner 并把主项目交给收割（记忆写在哪、下次就从哪读）", async () => {
    setup({ "/repo/ownward": id("ownward") });
    const r = await pickRoleForDispatch("auto", "/repo/ownward");
    expect(r).toMatchObject({ created: true, note: "", project: "ownward", scope: "" });
    expect(r.role?.id).toBe("owner-ownward");
    expect((await pickRoleForDispatch(undefined, "/repo/ownward")).created).toBe(false);   // 缺省就是 auto，第二次复用
  });

  test("auto + 附加目录正好有角色同时管：用那个角色", async () => {
    setup({ "/repo/a": id("alpha"), "/repo/b": id("beta") });
    expect(crossRoleForDirs(["/repo/a", "/repo/b"]).ok).toBe(true);
    const r = await pickRoleForDispatch("auto", "/repo/a", ["/repo/b"]);
    expect(r.role?.type).toBe("lead");
    expect(r.project).toBe("");      // 跨项目角色没有主项目：收割照旧按派发目录记
  });

  test("auto 匹配不上不算失败：不是仓库就安静地不带；Owner 被归档就带着原因不带", async () => {
    setup({ "/repo/ownward": id("ownward") });
    expect(await pickRoleForDispatch("auto", "/tmp/x")).toMatchObject({ role: null, note: "" });
    ensureOwnerForDir("/repo/ownward");
    archiveRole("owner-ownward", true);
    const r = await pickRoleForDispatch("auto", "/repo/ownward");
    expect(r.role).toBeNull();
    expect(r.note).toContain("已归档");
  });

  test("none 不带；点名的角色直接用；点名的角色不可用就抛（不许悄悄换一个）", async () => {
    setup({ "/repo/ownward": id("ownward") });
    expect((await pickRoleForDispatch("none", "/repo/ownward")).role).toBeNull();
    expect(createRole({ id: "dev", name: "研发", projects: [] }).ok).toBe(true);
    expect((await pickRoleForDispatch("dev", "/repo/ownward")).role?.id).toBe("dev");
    await expect(pickRoleForDispatch("ghost", "/repo/ownward")).rejects.toThrow("角色不可用");
    archiveRole("dev", true);
    await expect(pickRoleForDispatch("dev", "/repo/ownward")).rejects.toThrow("已归档");
    expect(listRoles({ includeArchived: true }).map((r) => r.id)).toEqual(["dev"]);   // 点名失败时也没顺手建 Owner
  });

  test("dispatch.autoRole=false：auto 什么都不做", async () => {
    setup({ "/repo/ownward": id("ownward") });
    const saved = cfg.dispatch?.autoRole;
    cfg.dispatch = { ...(cfg.dispatch || {}), autoRole: false };
    try {
      expect((await pickRoleForDispatch("auto", "/repo/ownward")).role).toBeNull();
      expect(previewRoleForDirs("/repo/ownward").auto.reason).toContain("dispatch.autoRole");
      expect(listRoles().length).toBe(0);
    } finally { cfg.dispatch = { ...cfg.dispatch, autoRole: saved }; }
  });
});

describe("任务首条消息里的角色记忆", () => {
  test("信封拆得开；正文带着角色说明与项目日志，还附上完整记忆目录", () => {
    const { vault } = setup({ "/repo/ownward": id("ownward") });
    const r = ensureOwnerForDir("/repo/ownward");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    seedLog(vault, "", "ownward", "LOG_MARKER_42");
    const text = roleTaskContext(r.role) + "修 bug";
    const split = splitRoleContext(text)!;
    expect(split.meta).toEqual({ id: "owner-ownward", name: "ownward Owner", projects: ["ownward"] });
    expect(split.rest).toBe("修 bug");
    expect(split.body).toContain("「ownward Owner」");
    expect(split.body).toContain("项目 Owner");
    expect(split.body).toContain("LOG_MARKER_42");
    expect(split.body).toContain(projDir(vault, "", "ownward"));
    expect(split.body).not.toContain("一条一行，写结论不写过程");   // 种子模板不进记忆包
  });
});

describe("跨项目建议", () => {
  test("同时动过几个项目、没有角色管它们：给建议；被角色覆盖的、跨 scope 的不提", () => {
    setup({
      "/repo/a": id("alpha", "work"), "/wt/a-1": id("alpha", "work", { root: "/repo/a" }), "/repo/b": id("beta", "work"),
      "/repo/c": id("gamma", "work"), "/repo/d": id("delta", "work"), "/repo/p": id("home", "private"),
    }, ["work", "private"]);
    expect(crossRoleForDirs(["/repo/c", "/repo/d"]).ok).toBe(true);
    const list = crossRoleSuggestions([
      { dirs: ["/repo/a", "/repo/b"], at: "2026-10-01T00:00:00.000Z" },
      { dirs: ["/wt/a-1", "/repo/b"], at: "2026-10-05T00:00:00.000Z" },   // worktree 也算 alpha
      { dirs: ["/repo/c", "/repo/d"], at: "2026-10-06T00:00:00.000Z" },   // 已经有角色管
      { dirs: ["/repo/a", "/repo/p"], at: "2026-10-07T00:00:00.000Z" },   // 工作 + 私人：建不成，不提
      { dirs: ["/repo/a"], at: "2026-10-08T00:00:00.000Z" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "work|alpha+beta", slugs: ["alpha", "beta"], count: 2, lastAt: "2026-10-05T00:00:00.000Z", dirs: ["/repo/a", "/repo/b"] });
  });

  test("忽略之后不再提；同样的组合之后又一起动了，建议会回来", () => {
    const { data } = setup({ "/repo/a": id("alpha"), "/repo/b": id("beta") });
    const old = [{ dirs: ["/repo/a", "/repo/b"], at: "2026-01-01T00:00:00.000Z" }];
    expect(crossRoleSuggestions(old)).toHaveLength(1);
    expect(dismissRoleSuggestion("|alpha+beta").ok).toBe(true);
    expect(readdirSync(data)).toContain("role-suggestions.json");
    expect(crossRoleSuggestions(old)).toHaveLength(0);
    expect(crossRoleSuggestions([...old, { dirs: ["/repo/b", "/repo/a"], at: "2999-01-01T00:00:00.000Z" }])).toHaveLength(1);
    expect(dismissRoleSuggestion("../../etc").ok).toBe(false);
    expect(JSON.parse(readFileSync(join(data, "role-suggestions.json"), "utf8")).dismissed).toHaveProperty("|alpha+beta");
  });
});

describe("Owner 起名", () => {
  test("同一个远程的两份检出（目录名不同）：第二个 Owner 名字里补上目录名，列表里不会出现两个一模一样的名字", () => {
    setup({
      "/repo/internal": id("internal", "", { aliases: ["ownward"], label: "ownward" }),
      "/repo/ownward-public": id("ownward-public", "", { aliases: ["ownward"], label: "ownward" }),
    });
    const a = ensureOwnerForDir("/repo/internal"), b = ensureOwnerForDir("/repo/ownward-public");
    expect(a.ok && a.role.name).toBe("ownward Owner");
    expect(b.ok && b.role.name).toBe("ownward（ownward-public）Owner");
    expect(b.ok && b.role.id).toBe("owner-ownward-public");
  });
});

describe("vault 本身不是项目", () => {
  test("vault 是 git 仓库、被任务加成附加目录：不配 Owner、不进跨项目建议、自动匹配也不落到它身上", async () => {
    const { vault } = setup({ "/repo/ownward": id("ownward") });
    // 把 vault 根本身也登记成一个「仓库」：模拟 ~/ownward-vault/work-log 这种带远程的 vault
    useRoleAutoForTest({
      identity: (dir) => dir === "/repo/ownward" ? { ...id("ownward"), root: "/repo/ownward" }
        : dir === vault ? { ...id("work-log", "", { label: "tis-brain" }), root: vault } : null,
    });
    expect(ensureOwnerForDir(vault).ok).toBe(false);
    expect(previewRoleForDirs(vault).auto.reason).toContain("vault 本身");
    expect((await pickRoleForDispatch("auto", vault)).role).toBeNull();
    expect(previewRoleForDirs("/repo/ownward", [vault]).cross).toBeNull();   // 只剩一个项目，不算跨项目
    expect(crossRoleSuggestions([{ dirs: ["/repo/ownward", vault], at: "2026-10-01T00:00:00.000Z" }])).toEqual([]);
    expect(listRoles().length).toBe(0);
  });
});

describe("跨项目角色的默认名", () => {
  test("放得下全列；三个放不下退成「a + b 等 N 个项目」，再放不下「a 等 N 个项目」，不截成半句话", () => {
    expect(defaultCrossName(["alpha", "beta"])).toBe("alpha + beta");
    expect(defaultCrossName(["a", "b", "c"])).toBe("a + b + c");
    expect(defaultCrossName(["acme-app", "orbit-svc", "orbit-web-long"])).toBe("acme-app + orbit-svc 等 3 个项目");
    expect(defaultCrossName(["acme-app", "orbit-service", "orbit-web"])).toBe("acme-app 等 3 个项目");
  });
});

describe("领域角色：没有仓库的那类活", () => {
  test("建出来是项目专家形状的领域角色 + 虚拟项目（README 带 kind: domain）；同名再建复用同一个", () => {
    const { vault } = setup({}, ["work", "private"]);
    const r = ensureDomainRole({ name: "手机设备运维", scope: "work", slug: "device-ops", description: "云客手机、平板的装机与排障", dirs: ["/Users/me/workspace"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.role).toMatchObject({
      id: "domain-device-ops", name: "手机设备运维", scope: "work", type: "project", origin: "domain",
      primaryProject: "domain-device-ops", projects: ["domain-device-ops"], dirs: ["/Users/me/workspace"],
    });
    // 虚拟项目目录带 domain- 前缀：仓库的项目 slug 是目录名，同名会互相顶
    const readme = readFileSync(join(projDir(vault, "work", "domain-device-ops"), "README.md"), "utf8");
    expect(readme).toContain("kind: domain");
    expect(readme).toContain("# 手机设备运维");
    expect(readme).toContain("云客手机、平板的装机与排障");
    const again = ensureDomainRole({ name: "随便什么名字", scope: "work", slug: "device-ops" });
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.role.id).toBe("domain-device-ops");
    expect(listDomainRoles().map((x) => x.id)).toEqual(["domain-device-ops"]);
  });

  test("不抢别人的项目目录、短名要合法、scope 要存在", () => {
    const { vault } = setup({}, ["work", "private"]);
    seedLog(vault, "work", "domain-acme-app", "不是领域角色建的同名目录");
    expect(ensureDomainRole({ name: "x", scope: "work", slug: "acme-app" }).ok).toBe(false);   // 同名目录不是领域角色建的
    expect(ensureDomainRole({ name: "x", scope: "work", slug: "../etc" }).ok).toBe(false);
    expect(ensureDomainRole({ name: "x", scope: "" as Scope, slug: "ok-slug" }).ok).toBe(false);   // 分流开着时没有根 scope
    expect(ensureDomainRole({ name: "", scope: "work", slug: "ok-slug" }).ok).toBe(false);
    expect(listRoles().length).toBe(0);
  });

  test("领域角色永远不当某个仓库的 Owner：短名和仓库同名也撞不上（虚拟项目带 domain- 前缀），仓库照样建出自己的 Owner", () => {
    setup({ "/repo/toolchain": id("toolchain", "private"), "/repo/domain-xy": id("domain-xy", "private") }, ["work", "private"]);
    expect(ensureDomainRole({ name: "本机与工具链", scope: "private", slug: "toolchain" }).ok).toBe(true);
    expect(findProjectOwner({ ...id("toolchain", "private"), root: "/repo/toolchain" }).active).toBeUndefined();
    expect(previewRoleForDirs("/repo/toolchain").auto).toMatchObject({ roleId: "", willCreate: true });
    const owner = ensureOwnerForDir("/repo/toolchain");
    expect(owner.ok && owner.role.primaryProject).toBe("toolchain");
    // 就算真有仓库叫 domain-xy、又被建成了领域角色：findProjectOwner 也只认非领域角色
    expect(ensureDomainRole({ name: "xy", scope: "private", slug: "xy" }).ok).toBe(true);
    expect(findProjectOwner({ ...id("domain-xy", "private"), root: "/repo/domain-xy" }).active).toBeUndefined();
  });
});

describe("主目录不是仓库：按任务描述匹配领域角色", () => {
  function withDomains(answer: (prompt: string) => any) {
    const calls: string[] = [];
    const env = setup({ "/repo/ownward": id("ownward", "private") }, ["work", "private"], async (p) => { calls.push(p); return answer(p); });
    const ops = ensureDomainRole({ name: "业务运营", scope: "work", slug: "biz-ops", description: "周报整理、工单跟进、会议复盘" });
    const dev = ensureDomainRole({ name: "手机设备运维", scope: "work", slug: "device-ops", description: "云客手机与平板" });
    const life = ensureDomainRole({ name: "个人投资与生活", scope: "private", slug: "invest-life" });
    expect(ops.ok && dev.ok && life.ok).toBe(true);
    seedLog(env.vault, "work", "domain-device-ops", "OPPO 重启");
    return { ...env, calls };
  }

  test("没写任务描述：告诉客户端按描述匹配（by=task），不调模型", async () => {
    const { calls } = withDomains(() => ({}));
    const p = await previewRoleForDispatch("/Users/me/workspace", [], "  ");
    expect(p.auto).toMatchObject({ roleId: "", by: "task", needsTask: true });
    expect(calls).toHaveLength(0);
  });

  test("有把握：预览和真派发都由它接；收割记进它的虚拟项目、scope 跟角色走（派发目录判出来是私人也一样）", async () => {
    const { calls } = withDomains(() => ({ roleId: "domain-device-ops", confidence: "high", candidates: [], why: "提到云客手机重启" }));
    const p = await previewRoleForDispatch("/Users/me/workspace", [], "云客手机老是半夜重启，帮我查一下");
    expect(p.auto).toMatchObject({ roleId: "domain-device-ops", name: "手机设备运维", by: "task", why: "提到云客手机重启" });
    expect(calls[0]).toContain("手机设备运维");
    expect(calls[0]).toContain("修了一个坑");          // 近期的活当样例给模型
    const d = await pickRoleForDispatch("auto", "/Users/me/workspace", [], "云客手机老是半夜重启，帮我查一下");
    expect(d).toMatchObject({ project: "domain-device-ops", scope: "work", note: "" });
    expect(d.role?.id).toBe("domain-device-ops");
    expect(calls).toHaveLength(1);                    // 同一段描述：派发复用预览的判断
  });

  test("拿不准：预览给候选让人手选；真派发不替人挑，原因写进 note", async () => {
    withDomains(() => ({ roleId: "domain-biz-ops", confidence: "low", candidates: ["domain-device-ops", "made-up-id"], why: "像是客户手机" }));
    const p = await previewRoleForDispatch("/Users/me/workspace", [], "把客户的手机号整理一下");
    expect(p.auto.roleId).toBe("");
    expect(p.auto.candidates).toEqual([{ id: "domain-biz-ops", name: "业务运营" }, { id: "domain-device-ops", name: "手机设备运维" }]);
    expect(p.auto.reason).toContain("手选");
    const d = await pickRoleForDispatch("auto", "/Users/me/workspace", [], "把客户的手机号整理一下");
    expect(d.role).toBeNull();
    expect(d.note).toContain("拿不准");
    expect(d.note).toContain("「业务运营」");
  });

  test("明显都不像：不带角色也不用问人；模型挂了：如实说，候选给全部，且不缓存（下次还能判）", async () => {
    let mode: "none" | "down" = "none";
    const { calls } = withDomains(() => (mode === "none" ? { roleId: "", confidence: "high", candidates: [], why: "写诗" } : null));
    const p = await previewRoleForDispatch("/Users/me/workspace", [], "帮我写一首诗");
    expect(p.auto).toMatchObject({ roleId: "", by: "task" });
    expect(p.auto.candidates).toBeUndefined();
    expect(p.auto.reason).toContain("不像任何一个");
    expect((await pickRoleForDispatch("auto", "/Users/me/workspace", [], "帮我写一首诗")).note).toBe("");
    mode = "down";
    const q = await previewRoleForDispatch("/Users/me/workspace", [], "另一个任务");
    expect(q.auto.reason).toContain("没判断出");
    expect(q.auto.candidates?.length).toBe(3);
    await previewRoleForDispatch("/Users/me/workspace", [], "另一个任务");
    expect(calls.filter((c) => c.includes("另一个任务"))).toHaveLength(2);
  });

  test("主目录是仓库：照旧按项目 Owner，不调模型；没有领域角色时如实说", async () => {
    const { calls } = withDomains(() => ({}));
    const p = await previewRoleForDispatch("/repo/ownward", [], "随便一个任务");
    expect(p.auto).toMatchObject({ willCreate: true, name: "ownward Owner" });
    expect(p.auto.by).toBeUndefined();
    expect(calls).toHaveLength(0);
    setup({}, ["work", "private"]);
    expect((await previewRoleForDispatch("/Users/me/workspace", [], "x")).auto.reason).toContain("还没有领域角色");
  });

  test("点名领域角色：不管派到哪个目录，日志都记进它的虚拟项目、scope 跟角色", async () => {
    withDomains(() => ({}));
    const d = await pickRoleForDispatch("domain-biz-ops", "/repo/ownward", [], "x");
    expect(d).toMatchObject({ project: "domain-biz-ops", scope: "work" });
  });

  test("parseDomainMatch：编出来的 id 一律丢；没有合法候选就给全部", () => {
    const roles = [{ id: "a", name: "A" }, { id: "b", name: "B" }] as any[];
    expect(parseDomainMatch({ roleId: "ghost", confidence: "high" }, roles)).toMatchObject({ kind: "uncertain", candidates: roles });
    expect(parseDomainMatch({ roleId: "a", confidence: "HIGH" }, roles)).toMatchObject({ kind: "matched", role: roles[0] });
    expect(parseDomainMatch({ roleId: "", confidence: "low", candidates: ["b"] }, roles).candidates).toEqual([roles[1]]);
    expect(parseDomainMatch("not json", roles).kind).toBe("failed");
  });

  test("没有领域角色或没有内容：直接 none，不调模型", async () => {
    setup({});
    expect((await matchDomain("有内容")).kind).toBe("none");
  });
});

describe("曾用名：改名前的老仓库归现在的 Owner", () => {
  test("老仓库（cockpit）由 ownward Owner 接：不给老仓库另建 Owner、不把老仓库登记成工作目录，日志记在老项目名下", async () => {
    const { vault } = setup({ "/repo/internal": id("internal", "private"), "/old/cockpit": id("cockpit", "private") }, ["work", "private"]);
    const owner = ensureOwnerForDir("/repo/internal");
    expect(owner.ok).toBe(true);
    seedLog(vault, "private", "cockpit", "OLD_COCKPIT_LOG");
    expect(createRole({ id: "owner-cockpit", name: "cockpit Owner", scope: "private", type: "project", primaryProject: "cockpit", origin: "auto" }).ok).toBe(true);
    expect(archiveRole("owner-cockpit", true).ok).toBe(true);
    const { updateRole } = await import("./roles.ts");
    expect(updateRole("owner-internal", { history: ["cockpit"] }).ok).toBe(true);

    const d = await pickRoleForDispatch("auto", "/old/cockpit");
    expect(d.role?.id).toBe("owner-internal");
    expect(d).toMatchObject({ project: "cockpit", scope: "private", created: false });
    expect(resolveRole("owner-internal").ok && (resolveRole("owner-internal") as any).role.dirs).toEqual(["/repo/internal"]);
    expect(previewRoleForDirs("/old/cockpit").auto.roleId).toBe("owner-internal");
    // 横跨新老两个仓库：现在的 Owner 就同时管它们，不用另建跨项目角色
    expect(previewRoleForDirs("/repo/internal", ["/old/cockpit"]).cross).toBeNull();
    expect(roleTaskContext((resolveRole("owner-internal") as any).role)).toContain("OLD_COCKPIT_LOG");
  });
});

describe("领域匹配的并发", () => {
  test("同一段描述同时来两次（预览还在等、人已经点了派发）：只问一次模型", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    setup({}, [""], async () => { calls++; await gate; return { roleId: "domain-ops", confidence: "high", candidates: [], why: "" }; });
    expect(ensureDomainRole({ name: "业务运营", scope: "", slug: "ops" }).ok).toBe(true);
    const a = matchDomain("整理周报文档"), b = matchDomain("整理周报文档");
    release();
    expect((await a).kind).toBe("matched");
    expect((await b).role?.id).toBe("domain-ops");
    expect(calls).toBe(1);
  });
});

describe("评审修复：派发不被模型拖住、点名角色记进它的项目、与预览一致", () => {
  test("派发最多等一会儿：模型慢就先不带角色（note 说清楚），那次调用照常跑完进缓存，下一次派发直接命中", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    setup({}, [""], async () => { calls++; await gate; return { roleId: "domain-ops", confidence: "high", candidates: [], why: "" }; });
    useRoleAutoForTest({ identity: () => null, llm: async () => { calls++; await gate; return { roleId: "domain-ops", confidence: "high", candidates: [], why: "" }; }, dispatchWaitMs: 30 });
    expect(ensureDomainRole({ name: "业务运营", scope: "", slug: "ops" }).ok).toBe(true);
    const t0 = Date.now();
    const first = await pickRoleForDispatch("auto", "/Users/me/workspace", [], "整理周报文档");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(first.role).toBeNull();
    expect(first.note).toContain("还在匹配");
    release();
    await new Promise((r) => setTimeout(r, 10));
    const again = await pickRoleForDispatch("auto", "/Users/me/workspace", [], "整理周报文档");
    expect(again.role?.id).toBe("domain-ops");
    expect(calls).toBe(1);
  });

  test("待命开场不是任务描述：不问模型；模型只看前 2000 字，缓存也按这一截算", async () => {
    const prompts: string[] = [];
    setup({}, [""], async (p) => { prompts.push(p); return { roleId: "domain-ops", confidence: "high", candidates: [], why: "" }; });
    expect(ensureDomainRole({ name: "业务运营", scope: "", slug: "ops" }).ok).toBe(true);
    expect((await matchDomain("你是常驻结对助手。本条只是开场，简短确认待命即可，等我下一条消息再开始干活。")).kind).toBe("none");
    expect(prompts).toHaveLength(0);
    const long = "周报文档".repeat(600);
    await matchDomain(long);
    await matchDomain(long + "（附件：/tmp/upload-1.png）");
    expect(prompts).toHaveLength(1);
  });

  test("点名项目角色派到根目录：日志记进它的主项目、scope 跟角色；派到别的 scope 的仓库仍按派发目录记", async () => {
    setup({ "/repo/internal": id("internal", "private"), "/repo/w": id("w", "work") }, ["work", "private"]);
    expect(ensureOwnerForDir("/repo/internal").ok).toBe(true);
    expect(await pickRoleForDispatch("owner-internal", "/Users/me/workspace")).toMatchObject({ project: "internal", scope: "private" });
    const other = await pickRoleForDispatch("owner-internal", "/repo/w");
    expect(other.project).toBe("");
    expect(other.scope).toBeUndefined();
  });

  test("主目录不是仓库、附加目录的仓库正好有角色同时管：预览和派发都落到它（不去猜领域）", async () => {
    let calls = 0;
    setup({ "/repo/a": id("alpha"), "/repo/b": id("beta") }, [""], async () => { calls++; return null; });
    expect(crossRoleForDirs(["/repo/a", "/repo/b"]).ok).toBe(true);
    expect(ensureDomainRole({ name: "业务运营", scope: "", slug: "ops" }).ok).toBe(true);
    const p = await previewRoleForDispatch("/Users/me/workspace", ["/repo/a", "/repo/b"], "改接口");
    const d = await pickRoleForDispatch("auto", "/Users/me/workspace", ["/repo/a", "/repo/b"], "改接口");
    expect(d.role?.id).toBe(p.auto.roleId);
    expect(d.role?.type).toBe("lead");
    expect(calls).toBe(0);
  });
});

describe("预览不等太久", () => {
  test("模型慢：预览先回「还在判断」（pending，可照常派），那次调用跑完进缓存，再预览直接拿到结果", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    setup({}, [""]);
    useRoleAutoForTest({ identity: () => null, llm: async () => { await gate; return { roleId: "domain-ops", confidence: "high", candidates: [], why: "周报文档" }; }, previewWaitMs: 30 });
    expect(ensureDomainRole({ name: "业务运营", scope: "", slug: "ops" }).ok).toBe(true);
    const p = await previewRoleForDispatch("/Users/me/workspace", [], "整理周报文档");
    expect(p.auto).toMatchObject({ roleId: "", by: "task", pending: true });
    expect(p.auto.candidates).toBeUndefined();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect((await previewRoleForDispatch("/Users/me/workspace", [], "整理周报文档")).auto.roleId).toBe("domain-ops");
  });
});
