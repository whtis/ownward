// 对话 × 角色绑定单测。锁死四件事（都属于"看起来能用"但错了没人发现的那类）：
//   1. 旧 chat JSON（没有 roleId/projectIds）照常读、照常发，行为逐字不变；
//   2. 绑定创建时定死，续聊不能改绑、不能补绑、不能改项目范围；
//   3. claude / codex 拿到的 system prompt 逐字相同（少注入一段只能靠"AI 怎么忘了"发现）；
//   4. assistant 消息只能存成 _candidates，正式 markdown 一个字不动。
// 角色侧跑在临时 vault（useVaultForTest 只换根）；全局 memoryPack 读真实 vault，
// 断言一律用临时 vault 里独有的 MARKER，不依赖真实记忆内容。
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  candidateFromMessage,
  chatBinding,
  chatSystemPrompt,
  claudeArgs,
  codexPrompt,
  getChat,
  listChats,
  resolveChatBinding,
  saveChatCandidate,
  type AiChat,
} from "./chat.ts";
import type { Scope } from "./paths.ts";
import { archiveRole, createRole, getRole, roleMemoryPack, updateRole, useVaultForTest } from "./roles.ts";
import type { Fail } from "./roles.ts";
import { DATA } from "./util.ts";

const roots: string[] = [];
const chatFiles: string[] = [];

function freshVault(scopes: Scope[] = [""]): string {
  const root = mkdtempSync(join(tmpdir(), "ownward-chat-test-"));
  roots.push(root);
  useVaultForTest(root, scopes);
  return root;
}

function seedProject(root: string, scope: Scope, slug: string, body: string) {
  const dir = join(scope ? join(root, scope) : root, "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), body);
}

/** 真的落一份 chat JSON 到 data/chats（loadChat 的唯一入口就是它）；测试结束删掉 */
function writeChatFile(raw: Record<string, unknown>): string {
  const dir = join(DATA, "chats");
  mkdirSync(dir, { recursive: true });
  const id = String(raw.id);
  const f = join(dir, `${id}.json`);
  writeFileSync(f, JSON.stringify(raw, null, 2));
  chatFiles.push(f);
  return id;
}

const chat = (over: Partial<AiChat> = {}): AiChat => ({
  id: "c-mem",
  title: "测试对话",
  provider: "claude",
  model: "sonnet",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [],
  ...over,
});

const ok = <T extends { ok: boolean }>(r: T): T => {
  expect((r as any).ok, `期望成功，实际：${(r as any).msg}`).toBe(true);
  return r;
};
const bad = (r: { ok: boolean }): Fail => {
  expect(r.ok).toBe(false);
  return r as Fail;
};

const DEV = { id: "dev", name: "研发", description: "写代码的那个我", icon: "code", color: "#5b8def" };

/** 造一个关联 ownward/desk 的 dev 角色，principles 里放个独有 MARKER */
function seedDevRole(root: string) {
  seedProject(root, "", "ownward", "OWNWARD_README_MARKER");
  seedProject(root, "", "desk", "DESK_README_MARKER");
  seedProject(root, "", "secret", "SECRET_README_MARKER");
  ok(createRole({ ...DEV, instructions: "负责实现与验证", projects: ["ownward", "desk"] }));
  writeFileSync(join(root, "roles", "dev", "principles.md"), "# 原则\n- PRINCIPLE_MARKER");
}

afterEach(() => useVaultForTest(null));
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  for (const f of chatFiles) rmSync(f, { force: true });
});

describe("旧对话 JSON 兼容", () => {
  test("没有 roleId/projectIds 的老会话照常读写，且不带任何角色上下文", async () => {
    freshVault();
    const id = writeChatFile({
      id: `test-legacy-${Math.random().toString(36).slice(2, 8)}`,
      title: "老对话", provider: "claude", model: "sonnet", claudeSessionId: "sess-old",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      messages: [{ role: "user", text: "在吗", ts: "2026-01-01T00:00:00.000Z" }],
    });

    const c = getChat(id)!;
    expect(c.title).toBe("老对话");
    expect(c.roleId).toBeUndefined();
    expect(c.projectIds).toBeUndefined();
    expect(c.claudeSessionId).toBe("sess-old");           // 续聊凭证没被新字段挤掉
    expect(listChats().some((x) => x.id === id)).toBe(true);
    expect(await chatBinding(c)).toBeNull();               // 普通对话没有绑定信息

    const sys = await chatSystemPrompt(c);
    expect(sys).not.toContain("=== 角色记忆（vault");
    expect(sys).not.toContain("OWNWARD_README_MARKER");
  });

  test("老会话不能补绑角色（要绑就另开一个对话）", async () => {
    const root = freshVault();
    seedDevRole(root);
    const old = chat({ roleId: undefined });
    expect(bad(await resolveChatBinding(old, { roleId: "dev" })).msg).toContain("补绑");
    expect(bad(await resolveChatBinding(old, { projectIds: ["ownward"] })).msg).toContain("不可修改");
    // 不传绑定字段 = 就是普通续聊，照常放行
    expect(ok(await resolveChatBinding(old, {}))).toEqual({ ok: true } as any);
    expect(ok(await resolveChatBinding(old, undefined))).toEqual({ ok: true } as any);
  });
});

describe("绑定创建时定死、之后不可变", () => {
  const bound = () => chat({ roleId: "dev", projectIds: ["ownward", "desk"] });

  test("续聊传同一份绑定放行，返回已持久化的那份", async () => {
    const r = ok(await resolveChatBinding(bound(), { roleId: "dev", projectIds: ["desk", "Ownward "] })) as any;
    expect(r.roleId).toBe("dev");
    expect(r.projectIds.sort()).toEqual(["desk", "ownward"]);   // 大小写/顺序不算改动
  });

  test("续聊换角色 / 改项目范围一律报错，不静默忽略", async () => {
    expect(bad(await resolveChatBinding(bound(), { roleId: "design" })).msg).toContain("不能中途换成");
    expect(bad(await resolveChatBinding(bound(), { projectIds: ["ownward"] })).msg).toContain("不可修改");
    expect(bad(await resolveChatBinding(bound(), { projectIds: [] })).msg).toContain("不可修改");
    expect(bad(await resolveChatBinding(bound(), { projectIds: "ownward" })).msg).toContain("数组");
  });

  test("不传绑定字段时以已持久化的为准（客户端不带 role_id 也不会掉绑定）", async () => {
    const r = ok(await resolveChatBinding(bound())) as any;
    expect(r).toMatchObject({ roleId: "dev" });
    expect(r.projectIds).toEqual(["ownward", "desk"]);
  });
});

describe("新建对话的绑定校验", () => {
  test("合法：项目缺省=角色全部关联，显式给则只能缩小范围", async () => {
    const root = freshVault();
    seedDevRole(root);
    expect(ok(await resolveChatBinding(null, { roleId: "dev" })) as any).toMatchObject({
      roleId: "dev", projectIds: ["ownward", "desk"],
    });
    expect((ok(await resolveChatBinding(null, { roleId: "dev", projectIds: ["ownward"] })) as any).projectIds)
      .toEqual(["ownward"]);
    expect((ok(await resolveChatBinding(null, { roleId: "dev", projectIds: [] })) as any).projectIds).toEqual([]);
    // 去重 + 大小写归一（项目 slug 恒小写）
    expect((ok(await resolveChatBinding(null, { roleId: "dev", projectIds: ["Ownward", " ownward "] })) as any).projectIds)
      .toEqual(["ownward"]);
  });

  test("非法角色：不存在 / 大小写不符 / 路径穿越都是明确失败", async () => {
    const root = freshVault();
    seedDevRole(root);
    expect(bad(await resolveChatBinding(null, { roleId: "ghost" })).code).toBe("not_found");
    expect(bad(await resolveChatBinding(null, { roleId: "Dev" })).code).toBe("not_found");
    expect(bad(await resolveChatBinding(null, { roleId: "../../etc/passwd" })).code).toBe("not_found");
  });

  test("归档角色不能开新对话（历史对话不受影响）", async () => {
    const root = freshVault();
    seedDevRole(root);
    ok(archiveRole("dev", true));
    expect(bad(await resolveChatBinding(null, { roleId: "dev" })).msg).toContain("已归档");
    // 已经绑好的老对话照样能用：归档只挡新建
    const r = ok(await resolveChatBinding(chat({ roleId: "dev", projectIds: ["ownward"] }))) as any;
    expect(r.roleId).toBe("dev");
    expect(await chatSystemPrompt(chat({ roleId: "dev", projectIds: ["ownward"] }))).toContain("PRINCIPLE_MARKER");
  });

  test("没关联的项目直接拒绝，不悄悄过滤（否则用户以为注入了）", async () => {
    const root = freshVault();
    seedDevRole(root);
    const f = bad(await resolveChatBinding(null, { roleId: "dev", projectIds: ["ownward", "secret"] }));
    expect(f.code).toBe("invalid");
    expect(f.msg).toContain("secret");
    expect(bad(await resolveChatBinding(null, { roleId: "dev", projectIds: ["../../etc"] })).msg).toContain("没关联");
  });

  test("没绑角色就不能指定项目；project_ids 类型也要对", async () => {
    freshVault();
    expect(bad(await resolveChatBinding(null, { projectIds: ["ownward"] })).msg).toContain("没有绑定角色");
    expect(bad(await resolveChatBinding(null, { projectIds: "ownward" })).msg).toContain("数组");
    // 什么都不传 = 普通对话，一个字段都不写进 JSON
    expect(ok(await resolveChatBinding(null, {}))).toEqual({ ok: true } as any);
  });
});

describe("上下文注入：两个 provider 逐字相同", () => {
  test("角色对话：全局记忆 + 角色记忆，claude 与 codex 同一份", async () => {
    const root = freshVault();
    seedDevRole(root);
    const c = chat({ roleId: "dev", projectIds: ["ownward"] });
    const sys = await chatSystemPrompt(c);

    expect(sys).toContain("角色：研发（dev）");
    expect(sys).toContain("PRINCIPLE_MARKER");
    expect(sys).toContain("OWNWARD_README_MARKER");
    expect(sys).not.toContain("DESK_README_MARKER");     // 本次没选中的关联项目不注入
    expect(sys).not.toContain("SECRET_README_MARKER");   // 没关联的项目更不可能

    // provider 不影响上下文包本身
    expect(await chatSystemPrompt({ ...c, provider: "codex" })).toBe(sys);
    expect(await chatSystemPrompt({ ...c, provider: "codex-alt" })).toBe(sys);

    // claude 走 --append-system-prompt，codex 拼在 prompt 头部——内容必须一模一样
    const args = claudeArgs(c, "问题", sys);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(sys);
    const cp = codexPrompt(c, "问题", sys);
    expect(cp.startsWith(sys)).toBe(true);
    expect(cp).toContain("问题");
  });

  test("角色包是叠加上去的：无角色对话的 system 一个字都没变", async () => {
    const root = freshVault();
    seedDevRole(root);
    const plain = await chatSystemPrompt(chat());
    const withRole = await chatSystemPrompt(chat({ roleId: "dev", projectIds: ["ownward"] }));
    expect(withRole).toBe(plain + roleMemoryPack("dev", ["ownward"]));
    expect(plain).not.toContain("=== 角色记忆（vault");
    expect(plain).not.toContain("PRINCIPLE_MARKER");
  });

  test("无角色对话的 claude 参数没变（工具禁令 / resume 照旧）", async () => {
    freshVault();
    const sys = await chatSystemPrompt(chat());
    const args = claudeArgs(chat(), "你好", sys);
    expect(args.slice(0, 2)).toEqual(["-p", "你好"]);
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch");
    expect(args).toContain("--disallowedTools");
    for (const banned of ["Bash", "Edit", "Write", "Read"]) expect(args).toContain(banned);
    expect(args).not.toContain("--resume");
    expect(claudeArgs(chat({ claudeSessionId: "sess-1" }), "你好", sys).slice(-2)).toEqual(["--resume", "sess-1"]);
  });

  test("绑定的角色被人删了：这轮明确报错，不退化成普通对话（假成功禁令）", async () => {
    const root = freshVault();
    seedDevRole(root);
    rmSync(join(root, "roles", "dev"), { recursive: true, force: true });
    await expect(chatSystemPrompt(chat({ roleId: "dev", projectIds: ["ownward"] }))).rejects.toThrow("读不到了");
    // 展示层同样如实标注，不装作没绑过
    expect(await chatBinding(chat({ roleId: "dev", projectIds: ["ownward"] }))).toMatchObject({
      status: "missing", missing: true, injectedProjects: [],
    });
  });

  test("chatBinding 显示真正会注入的项目（角色改了关联立刻反映）", async () => {
    const root = freshVault();
    seedDevRole(root);
    const info = (await chatBinding(chat({ roleId: "dev", projectIds: ["ownward", "desk"] })))!;
    expect(info).toMatchObject({ roleId: "dev", name: "研发", icon: "code", status: "active" });
    expect(info.injectedProjects).toEqual(["ownward", "desk"]);

    const { updateRole } = await import("./roles.ts");
    ok(updateRole("dev", { projects: ["ownward"] }));   // 角色取消了 desk 关联
    const after = (await chatBinding(chat({ roleId: "dev", projectIds: ["ownward", "desk"] })))!;
    expect(after.projectIds).toEqual(["ownward", "desk"]);   // 绑定是历史事实，不改写
    expect(after.injectedProjects).toEqual(["ownward"]);     // 实际注入以角色当前关联为准
  });
});

describe("跨 scope 同 id 的角色：对话侧同样不许静默命中", () => {
  /** work/private 各一份 dev（只有人工建目录或 vault 同步冲突能造出来） */
  function conflictedDev(): string {
    const root = freshVault(["work", "private"]);
    seedProject(root, "work", "ownward", "OWNWARD_README_MARKER");
    ok(createRole({ ...DEV, scope: "work", projects: ["ownward"] }));
    writeFileSync(join(root, "work", "roles", "dev", "principles.md"), "# 原则\n- PRINCIPLE_MARKER");
    mkdirSync(join(root, "private", "roles", "dev"), { recursive: true });
    writeFileSync(join(root, "private", "roles", "dev", "role.json"), JSON.stringify({
      name: "私人研发", description: "", icon: "star", color: "#5b8def", projects: [],
      instructions: "", status: "active",
      createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
    }));
    return root;
  }

  test("新建对话绑定：明确 conflict，不挑一份凑合", async () => {
    conflictedDev();
    const f = bad(await resolveChatBinding(null, { roleId: "dev" }));
    expect(f.code).toBe("conflict");
    expect(f.msg).toContain("各有一份");
  });

  test("已绑好的老对话：这轮宁可发不出去，也不注入猜的那一份", async () => {
    conflictedDev();
    const c = chat({ roleId: "dev", projectIds: ["ownward"] });
    await expect(chatSystemPrompt(c)).rejects.toThrow("读不到了");

    // 展示层如实标 conflict（修法是改名，跟"角色被删了"不是一回事）
    const info = (await chatBinding(c))!;
    expect(info).toMatchObject({ roleId: "dev", status: "conflict", missing: true, injectedProjects: [] });
    expect(info.msg).toContain("各有一份");
  });
});

describe("assistant 消息存为角色候选（只进 _candidates）", () => {
  const withReply = (over: Partial<AiChat> = {}) => chat({
    id: "c-reply", roleId: "dev", projectIds: ["ownward"],
    messages: [
      { role: "user", text: "要不要先定契约", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", text: "接口先定契约再写实现", ts: "2026-01-01T00:00:01.000Z" },
    ],
    ...over,
  });

  test("写候选文件 + 带来源，正式 markdown 纹丝不动", async () => {
    const root = freshVault();
    seedDevRole(root);
    const before = ["principles", "decisions", "backlog"].map((f) =>
      readFileSync(join(root, "roles", "dev", `${f}.md`), "utf8"));

    const r = ok(await candidateFromMessage(withReply(), 1)) as any;
    const raw = readFileSync(join(root, "roles", "dev", "_candidates", `${r.candidate.id}.md`), "utf8");
    expect(raw).toContain("role: dev");
    expect(raw).toContain("source_chat: c-reply");
    expect(raw).toContain("status: pending");
    expect(raw).toContain("接口先定契约再写实现");

    // 人工晋升门：候选写完，三份正式文件一个字都不能变
    expect(["principles", "decisions", "backlog"].map((f) =>
      readFileSync(join(root, "roles", "dev", `${f}.md`), "utf8"))).toEqual(before);
    expect(readdirSync(join(root, "roles", "dev", "_candidates"))).toHaveLength(1);
  });

  test("人可以改写成一句话，原文留作证据", async () => {
    const root = freshVault();
    seedDevRole(root);
    const r = ok(await candidateFromMessage(withReply(), 1, "  接口先定契约  ")) as any;
    expect(r.candidate.text).toBe("接口先定契约");
    expect(r.candidate.evidence).toBe("接口先定契约再写实现");
  });

  test("没绑角色 / 不是 assistant 消息 / 序号越界都明确拒绝", async () => {
    const root = freshVault();
    seedDevRole(root);
    expect(bad(await candidateFromMessage(withReply({ roleId: undefined }), 1)).msg).toContain("没有绑定角色");
    expect(bad(await candidateFromMessage(withReply(), 0)).msg).toContain("只能保存 AI 的回复");
    for (const i of [2, -1, 1.5, NaN, undefined, "x"]) {
      expect(bad(await candidateFromMessage(withReply(), i)).code).toBe("invalid");
    }
    expect(bad(await candidateFromMessage(withReply({
      messages: [{ role: "assistant", text: "   ", ts: "2026-01-01T00:00:00.000Z" }],
    }), 0)).msg).toContain("为空");
    expect(existsSync(join(root, "roles", "dev", "_candidates"))
      && readdirSync(join(root, "roles", "dev", "_candidates")).length).toBeFalsy();
  });

  test("超长回复不截断：明确让人先摘一句（截断=悄悄改写结论）", async () => {
    const root = freshVault();
    seedDevRole(root);
    const f = bad(await candidateFromMessage(withReply({
      messages: [{ role: "assistant", text: "长".repeat(1001), ts: "2026-01-01T00:00:00.000Z" }],
    }), 0));
    expect(f.code).toBe("invalid");
    expect(f.msg).toContain("1000");
  });

  test("saveChatCandidate 走文件：对话不存在是 404，存在则落候选", async () => {
    const root = freshVault();
    seedDevRole(root);
    expect(bad(await saveChatCandidate("no-such-chat", 1)).code).toBe("not_found");

    const id = writeChatFile({
      id: `test-bound-${Math.random().toString(36).slice(2, 8)}`,
      title: "角色对话", provider: "codex", model: "default",
      roleId: "dev", projectIds: ["ownward"],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", text: "怎么做", ts: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "先写测试再改实现", ts: "2026-01-01T00:00:01.000Z" },
      ],
    });
    const persisted = getChat(id)!;
    expect(persisted.roleId).toBe("dev");                 // 新字段能落盘也能读回
    expect(persisted.projectIds).toEqual(["ownward"]);

    const r = ok(await saveChatCandidate(id, 1)) as any;
    expect(r.candidate.text).toBe("先写测试再改实现");
    expect(r.candidate.sourceChat).toBe(id);
    expect(r.candidate.status).toBe("pending");           // 只有人点晋升才会进正式 markdown
  });
});

// ==================== Role V2：项目专家对话 ====================
// 主项目"取消不掉"必须在后端成立：前端锁 chip 只是体验，手改 chat JSON / 直接打 API 也得挡住。

/** 一个 lead + 一个 ownward 项目专家（附加项目 desk） */
function seedExpert(root: string) {
  seedProject(root, "", "ownward", "OWNWARD_README_MARKER");
  seedProject(root, "", "desk", "DESK_README_MARKER");
  seedProject(root, "", "secret", "SECRET_README_MARKER");
  ok(createRole({ id: "rd", name: "研发 LD", icon: "code" }));
  ok(createRole({
    id: "ownward-dev", name: "ownward 专家", icon: "code",
    type: "project", primaryProject: "ownward", projects: ["ownward", "desk"], parentRoleId: "rd",
  }));
  writeFileSync(join(root, "roles", "ownward-dev", "principles.md"), "# 原则\n- EXPERT_MARKER");
}

describe("项目专家新对话：主项目强制且取消不掉", () => {
  test("不给项目 = 全部关联；显式缩小时主项目仍被补回来", async () => {
    const root = freshVault();
    seedExpert(root);
    const all = ok(await resolveChatBinding(null, { roleId: "ownward-dev" })) as any;
    expect(all.projectIds).toEqual(["ownward", "desk"]);

    // 前端/脚本把主项目摘掉 → 后端补回来（补的结果原样回传，客户端看得见）
    const narrowed = ok(await resolveChatBinding(null, { roleId: "ownward-dev", projectIds: ["desk"] })) as any;
    expect(narrowed.projectIds).toEqual(["ownward", "desk"]);
    const empty = ok(await resolveChatBinding(null, { roleId: "ownward-dev", projectIds: [] })) as any;
    expect(empty.projectIds).toEqual(["ownward"]);
    // 没关联的项目照样拒（补主项目 ≠ 放宽范围）
    expect(bad(await resolveChatBinding(null, { roleId: "ownward-dev", projectIds: ["secret"] })).msg).toContain("secret");
  });

  test("注入必带主项目 README：连手改过的 chat JSON 也绕不过去", async () => {
    const root = freshVault();
    seedExpert(root);
    // 手工造一个"项目范围被清空"的对话（API 建不出来），但绑定快照还在
    const c = chat({ roleId: "ownward-dev", projectIds: [], roleTypeAtBind: "project", primaryProjectAtBind: "ownward" });
    const sys = await chatSystemPrompt(c);
    expect(sys).toContain("项目专家");
    expect(sys).toContain("主项目：ownward");
    expect(sys).toContain("上级：研发 LD（rd）");
    expect(sys).toContain("OWNWARD_README_MARKER");
    expect(sys).toContain("EXPERT_MARKER");
    expect(sys).not.toContain("DESK_README_MARKER");     // 附加项目仍可缩小
    expect(sys).not.toContain("SECRET_README_MARKER");

    // 试图用"别的项目"顶掉主项目也没用
    const forged = await chatSystemPrompt(chat({
      roleId: "ownward-dev", projectIds: ["../../secret"], roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
    }));
    expect(forged).toContain("OWNWARD_README_MARKER");
    expect(forged).not.toContain("SECRET_README_MARKER");

    // 两个 provider 同一份（parity 由 chatSystemPrompt 这一个入口锁死）
    expect(await chatSystemPrompt({ ...c, provider: "codex" })).toBe(sys);
    const args = claudeArgs(c, "问题", sys);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(sys);
    expect(codexPrompt(c, "问题", sys).startsWith(sys)).toBe(true);
  });

  test("绑定详情标出类型/主项目/上级，注入清单里主项目排头", async () => {
    const root = freshVault();
    seedExpert(root);
    const info = (await chatBinding(chat({
      roleId: "ownward-dev", projectIds: ["desk"], roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
    })))!;
    expect(info).toMatchObject({ type: "project", primaryProject: "ownward", parentRoleId: "rd", parentName: "研发 LD" });
    expect(info.legacy).toBeUndefined();
    expect(info.injectedProjects).toEqual(["ownward", "desk"]);
  });

  test("职能负责人对话不受影响（V1 行为逐字不变）", async () => {
    const root = freshVault();
    seedExpert(root);
    expect(ok(await resolveChatBinding(null, { roleId: "rd" })) as any).toMatchObject({ roleTypeAtBind: "lead" });
    const lead = chat({ roleId: "rd", projectIds: [], roleTypeAtBind: "lead" });
    const info = (await chatBinding(lead))!;
    expect(info).toMatchObject({ type: "lead", primaryProject: "", parentRoleId: "" });
    expect(info.injectedProjects).toEqual([]);
    const sys = await chatSystemPrompt(lead);
    expect(sys).toContain("职能负责人");
    expect(sys).not.toContain("OWNWARD_README_MARKER");
  });

  test("V1 角色的老对话：没有 type 的 role.json 照旧按负责人注入", async () => {
    const root = freshVault();
    seedDevRole(root);
    // 把 manifest 退回 V1 的样子（三个新键都删掉）
    const f = join(root, "roles", "dev", "role.json");
    const m = JSON.parse(readFileSync(f, "utf8"));
    delete m.type; delete m.parentRoleId; delete m.primaryProject;
    writeFileSync(f, JSON.stringify(m, null, 2));

    const sys = await chatSystemPrompt(chat({ roleId: "dev", projectIds: ["ownward"] }));
    expect(sys).toContain("职能负责人");
    expect(sys).toContain("OWNWARD_README_MARKER");
    // 老对话没有绑定快照：类型如实报空（不编一个"lead"），并标 legacy
    const info = (await chatBinding(chat({ roleId: "dev", projectIds: ["ownward"] })))!;
    expect(info.type).toBe("");
    expect(info.legacy).toBe(true);
  });
});

describe("候选归属：角色候选 / 项目候选", () => {
  const withReply = (over: Partial<AiChat> = {}) => chat({
    id: "c-expert", roleId: "ownward-dev", projectIds: ["ownward"],
    roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
    messages: [
      { role: "user", text: "重启怎么做", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", text: "用 launchctl kickstart -k，不要 nohup", ts: "2026-01-01T00:00:01.000Z" },
    ],
    ...over,
  });

  test("缺省仍是角色候选（旧客户端不传 target 时行为不变）", async () => {
    const root = freshVault();
    seedExpert(root);
    const r = ok(await candidateFromMessage(withReply(), 1)) as any;
    expect(r.saved).toMatchObject({ target: "role", owner: "ownward-dev" });
    expect(readdirSync(join(root, "roles", "ownward-dev", "_candidates"))).toHaveLength(1);
    expect(existsSync(join(root, "projects", "ownward", "_candidates"))).toBe(false);
  });

  test("target=project 写进主项目候选，项目正式文件与角色记忆都不动", async () => {
    const root = freshVault();
    seedExpert(root);
    const readmeBefore = readFileSync(join(root, "projects", "ownward", "README.md"), "utf8");
    const roleDocsBefore = ["principles", "decisions", "backlog"].map((f) =>
      readFileSync(join(root, "roles", "ownward-dev", `${f}.md`), "utf8"));

    const r = ok(await candidateFromMessage(withReply(), 1, "重启走 launchctl kickstart", "project")) as any;
    expect(r.saved).toMatchObject({ target: "project", owner: "ownward" });
    const raw = readFileSync(join(root, "projects", "ownward", "_candidates", `${r.candidate.id}.md`), "utf8");
    expect(raw).toContain("project: ownward");
    expect(raw).toContain("source_chat: c-expert");
    expect(raw).toContain("source_role: ownward-dev");
    expect(raw).toContain("status: pending");
    expect(raw).toContain("重启走 launchctl kickstart");
    expect(raw).toContain("证据：用 launchctl kickstart -k，不要 nohup");   // 改写过 → 原文留证据

    expect(readFileSync(join(root, "projects", "ownward", "README.md"), "utf8")).toBe(readmeBefore);
    expect(["principles", "decisions", "backlog"].map((f) =>
      readFileSync(join(root, "roles", "ownward-dev", `${f}.md`), "utf8"))).toEqual(roleDocsBefore);
    expect(existsSync(join(root, "roles", "ownward-dev", "_candidates"))
      && readdirSync(join(root, "roles", "ownward-dev", "_candidates")).length).toBeFalsy();
  });

  test("负责人对话不能存项目候选（没有主项目，别猜一个）", async () => {
    const root = freshVault();
    seedExpert(root);
    const f = bad(await candidateFromMessage(
      withReply({ roleId: "rd", roleTypeAtBind: "lead", primaryProjectAtBind: undefined }), 1, "", "project"));
    expect(f.code).toBe("invalid");
    expect(f.msg).toContain("没有主项目");
  });

  test("非法 target / 无绑定 / 非 assistant 消息都明确拒绝", async () => {
    const root = freshVault();
    seedExpert(root);
    expect(bad(await candidateFromMessage(withReply(), 1, "", "vault")).msg).toContain("role / project");
    expect(bad(await candidateFromMessage(withReply({ roleId: undefined }), 1, "", "project")).msg).toContain("没有绑定角色");
    expect(bad(await candidateFromMessage(withReply(), 0, "", "project")).msg).toContain("只能保存 AI 的回复");
    expect(existsSync(join(root, "projects", "ownward", "_candidates"))).toBe(false);
  });

  test("saveChatCandidate 走文件：项目候选也能从落盘的对话存出来", async () => {
    const root = freshVault();
    seedExpert(root);
    const id = writeChatFile({
      id: `test-expert-${Math.random().toString(36).slice(2, 8)}`,
      title: "专家对话", provider: "claude", model: "sonnet",
      roleId: "ownward-dev", projectIds: ["ownward"],
      roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", text: "端口是多少", ts: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "4517，客户端写死了", ts: "2026-01-01T00:00:01.000Z" },
      ],
    });
    const r = ok(await saveChatCandidate(id, 1, "", "project")) as any;
    expect(r.candidate.project).toBe("ownward");
    expect(r.candidate.status).toBe("pending");   // 只有人点晋升才进项目正式记忆
    expect(r.msg).toContain("ownward");
  });
});

// 磁盘旁路落两份同主项目的在岗专家（人工建目录 / vault 同步冲突）：
// 对话侧和角色侧一样，宁可发不出去，也不猜一份注入。
describe("同主项目多个在岗专家：对话侧同样不许静默命中", () => {
  function duplicatedExpert(): string {
    const root = freshVault();
    seedProject(root, "", "ownward", "OWNWARD_README_MARKER");
    const m = {
      name: "ownward 专家", description: "", icon: "code", color: "#5b8def",
      projects: ["ownward"], instructions: "", status: "active",
      type: "project", primaryProject: "ownward", parentRoleId: "",
      createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
    };
    for (const id of ["ownward-dev", "ownward-dev2"]) {
      mkdirSync(join(root, "roles", id), { recursive: true });
      writeFileSync(join(root, "roles", id, "role.json"), JSON.stringify({ ...m, name: `${id} 专家` }));
    }
    writeFileSync(join(root, "roles", "ownward-dev", "principles.md"), "# 原则\n- PRINCIPLE_MARKER");
    return root;
  }

  test("新建对话绑定：明确 conflict，不挑一份凑合", async () => {
    duplicatedExpert();
    const f = bad(await resolveChatBinding(null, { roleId: "ownward-dev" }));
    expect(f.code).toBe("conflict");
    expect(f.msg).toContain("在岗专家");
  });

  test("已绑好的老对话：这轮发不出去，展示层如实标 conflict", async () => {
    duplicatedExpert();
    const c = chat({ roleId: "ownward-dev", projectIds: ["ownward"] });
    await expect(chatSystemPrompt(c)).rejects.toThrow("读不到了");
    const info = (await chatBinding(c))!;
    expect(info).toMatchObject({ status: "conflict", missing: true, injectedProjects: [] });
    expect(info.msg).toContain("在岗专家");
  });

  test("存候选（角色 / 项目两条路）都 conflict，什么都没落盘", async () => {
    const root = duplicatedExpert();
    const c = chat({
      id: "c-dup", roleId: "ownward-dev", projectIds: ["ownward"],
      messages: [
        { role: "user", text: "问", ts: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "答", ts: "2026-01-01T00:00:01.000Z" },
      ],
    });
    expect(bad(await candidateFromMessage(c, 1)).code).toBe("conflict");
    expect(bad(await candidateFromMessage(c, 1, "", "project")).code).toBe("conflict");
    expect(existsSync(join(root, "roles", "ownward-dev", "_candidates"))).toBe(false);
    expect(existsSync(join(root, "projects", "ownward", "_candidates"))).toBe(false);
  });
});

// ==================== 绑定语义快照 ====================
// 绑定"创建后不可变"必须扛得住角色本身的演化：V1 的 lead 后来改成项目专家、
// 专家后来换主项目——历史对话的注入范围、展示、候选归属都得停在绑定当天。
describe("绑定快照：角色后来怎么改，历史对话都不跟着变", () => {
  /** 一个 lead（dev）+ 两个项目（ownward / desk） */
  function seedLead(root: string) {
    seedProject(root, "", "ownward", "OWNWARD_README_MARKER");
    seedProject(root, "", "desk", "DESK_README_MARKER");
    ok(createRole({ ...DEV, projects: ["ownward"] }));
    writeFileSync(join(root, "roles", "dev", "principles.md"), "# 原则\n- PRINCIPLE_MARKER");
  }

  test("新建对话落快照：项目专家存 project + 主项目，负责人存 lead", async () => {
    const root = freshVault();
    seedLead(root);
    ok(createRole({
      id: "ownward-dev", name: "ownward 专家", icon: "code",
      type: "project", primaryProject: "ownward", projects: ["ownward", "desk"],
    }));

    const expert = ok(await resolveChatBinding(null, { roleId: "ownward-dev", projectIds: ["desk"] })) as any;
    expect(expert).toMatchObject({ roleTypeAtBind: "project", primaryProjectAtBind: "ownward" });
    expect(expert.projectIds).toEqual(["ownward", "desk"]);

    const lead = ok(await resolveChatBinding(null, { roleId: "dev" })) as any;
    expect(lead.roleTypeAtBind).toBe("lead");
    expect(lead.primaryProjectAtBind).toBeUndefined();   // 负责人没有主项目，别写个空串占位
  });

  test("V1 老对话（无快照）+ 角色后来改成项目专家：项目范围一个字不变", async () => {
    const root = freshVault();
    seedLead(root);
    // V1 时代建的对话：只有 roleId/projectIds
    const old = chat({ roleId: "dev", projectIds: ["ownward"] });
    const before = await chatSystemPrompt(old);

    // 角色演化成项目专家，主项目是当初这个对话没选过的 desk
    ok(updateRole("dev", { type: "project", primaryProject: "desk", projects: ["ownward", "desk"] }));

    const after = await chatSystemPrompt(old);
    expect(after).toContain("OWNWARD_README_MARKER");     // 当初选的还在
    expect(after).not.toContain("DESK_README_MARKER");    // 新主项目绝不追加
    expect(after).toContain("项目范围沿用创建时的选择");   // 而且明说了为什么没有主项目
    expect(after).toContain("PRINCIPLE_MARKER");          // 角色自身记忆照常读
    expect(before).toContain("OWNWARD_README_MARKER");

    // 展示层：类型报空 + legacy，并解释清楚（不拿角色现状盖掉历史）
    const info = (await chatBinding(old))!;
    expect(info).toMatchObject({ type: "", primaryProject: "", legacy: true });
    expect(info.injectedProjects).toEqual(["ownward"]);
    expect(info.bindNote).toContain("成为项目专家之前");
  });

  test("V1 老对话（无快照）不许存项目候选，只能存角色候选（避免归属漂移）", async () => {
    const root = freshVault();
    seedLead(root);
    ok(updateRole("dev", { type: "project", primaryProject: "ownward" }));   // 角色现在是专家了
    const old = chat({
      id: "c-legacy", roleId: "dev", projectIds: ["ownward"],
      messages: [
        { role: "user", text: "问", ts: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "答：端口 4517", ts: "2026-01-01T00:00:01.000Z" },
      ],
    });
    const f = bad(await candidateFromMessage(old, 1, "", "project"));
    expect(f.code).toBe("invalid");
    expect(f.msg).toContain("没有绑定快照");
    expect(existsSync(join(root, "projects", "ownward", "_candidates"))).toBe(false);

    // 角色候选照常（这条路没变）
    const r = ok(await candidateFromMessage(old, 1)) as any;
    expect(r.saved).toMatchObject({ target: "role", owner: "dev" });
  });

  test("专家换了主项目：历史对话仍按快照项目注入、展示、存候选", async () => {
    const root = freshVault();
    seedLead(root);
    ok(createRole({
      id: "ownward-dev", name: "ownward 专家", icon: "code",
      type: "project", primaryProject: "ownward", projects: ["ownward"],
    }));
    const bound = chat({
      id: "c-snap", roleId: "ownward-dev", projectIds: ["ownward"],
      roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
      messages: [
        { role: "user", text: "问", ts: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "答：ownward 用 launchd", ts: "2026-01-01T00:00:01.000Z" },
      ],
    });

    // 角色改投 desk，并且不再关联 ownward
    ok(updateRole("ownward-dev", { primaryProject: "desk", projects: ["desk"] }));
    expect(getRole("ownward-dev")!.primaryProject).toBe("desk");

    const sys = await chatSystemPrompt(bound);
    expect(sys).toContain("OWNWARD_README_MARKER");            // 快照项目照注（哪怕已解除关联）
    expect(sys).toContain("### 主项目记忆：ownward");
    expect(sys).not.toContain("DESK_README_MARKER");           // 不拿新主项目顶替
    expect(sys).toContain("角色现在的主项目是 desk");           // 差异说清楚，别让模型自我纠正

    const info = (await chatBinding(bound))!;
    expect(info.primaryProject).toBe("ownward");
    expect(info.injectedProjects).toEqual(["ownward"]);
    expect(info.bindNote).toContain("仍按绑定时的 ownward 注入");

    // 项目候选跟着快照走，不漂到 desk 上
    const r = ok(await candidateFromMessage(bound, 1, "", "project")) as any;
    expect(r.saved).toMatchObject({ target: "project", owner: "ownward" });
    expect(existsSync(join(root, "projects", "ownward", "_candidates", `${r.candidate.id}.md`))).toBe(true);
    expect(existsSync(join(root, "projects", "desk", "_candidates"))).toBe(false);
  });

  test("专家被改回职能负责人：历史专家对话仍注入快照主项目", async () => {
    const root = freshVault();
    seedLead(root);
    ok(createRole({
      id: "ownward-dev", name: "ownward 专家", icon: "code",
      type: "project", primaryProject: "ownward", projects: ["ownward"],
    }));
    const bound = chat({
      roleId: "ownward-dev", projectIds: ["ownward"],
      roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
    });
    ok(updateRole("ownward-dev", { type: "lead", primaryProject: "", parentRoleId: "" }));

    expect(await chatSystemPrompt(bound)).toContain("OWNWARD_README_MARKER");
    const info = (await chatBinding(bound))!;
    expect(info).toMatchObject({ type: "project", primaryProject: "ownward" });   // 快照说了算
    expect(info.bindNote).toContain("角色现在是职能负责人");
  });

  test("角色没了也报得出快照（这段历史的前提不随目录消失）", async () => {
    const root = freshVault();
    seedLead(root);
    ok(createRole({
      id: "ownward-dev", name: "ownward 专家", icon: "code",
      type: "project", primaryProject: "ownward", projects: ["ownward"],
    }));
    rmSync(join(root, "roles", "ownward-dev"), { recursive: true, force: true });
    const info = (await chatBinding(chat({
      roleId: "ownward-dev", projectIds: ["ownward"], roleTypeAtBind: "project", primaryProjectAtBind: "ownward",
    })))!;
    expect(info).toMatchObject({ status: "missing", missing: true, type: "project", primaryProject: "ownward" });
  });
});
