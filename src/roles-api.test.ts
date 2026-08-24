// Role HTTP 路由层单测：直接调 handleWorkbench（不起 server，Host/Origin 那层在 server.ts，另算）。
// 这里锁的是"入参没到落盘层之前就该被拦下"的部分——尤其是破坏性动作的 body 校验：
// 归档接口以前 `b?.archived !== false` 会把空 body / 坏 JSON 当成"归档吧"，
// 用户是从列表里少了个角色才发现的，属于典型的"猜了一个方向还报成功"。
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRole, getRole, useVaultForTest } from "./roles.ts";
import { handleWorkbench } from "./workbench.ts";

const roots: string[] = [];

function freshVault(): string {
  const root = mkdtempSync(join(tmpdir(), "ownward-roles-api-test-"));
  roots.push(root);
  useVaultForTest(root, [""]);
  return root;
}

function seedProject(root: string, slug: string) {
  mkdirSync(join(root, "projects", slug), { recursive: true });
  writeFileSync(join(root, "projects", slug, "README.md"), `# ${slug}`);
}

/** 走真实路由：返回 {status, body}（body 已解析成对象） */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(`http://127.0.0.1:4517${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await handleWorkbench(new Request(url.toString(), init), url);
  expect(res, `路由没接住 ${method} ${path}`).toBeTruthy();
  return { status: res!.status, body: await res!.json().catch(() => null) };
}

afterEach(() => useVaultForTest(null));
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("POST /api/roles/:id/archive 的 body 校验", () => {
  beforeEach(() => {
    freshVault();
    createRole({ id: "dev", name: "研发" });
  });

  test("空 body / 坏 JSON / 缺 archived / 非布尔值一律 400，且角色状态没被动过", async () => {
    for (const [label, payload] of [
      ["没有 body", undefined],
      ["坏 JSON", "{ not json"],
      ["空对象", {}],
      ["archived 是字符串 false", { archived: "false" }],
      ["archived 是字符串 true", { archived: "true" }],
      ["archived 是 null", { archived: null }],
      ["archived 是数字", { archived: 1 }],
    ] as [string, unknown][]) {
      const r = await call("POST", "/api/roles/dev/archive", payload);
      expect(r.status, label).toBe(400);
      expect(r.body.msg, label).toContain("archived");
      expect(getRole("dev")!.status, label).toBe("active");   // 没被猜着归档掉
    }
  });

  test("显式 true 归档、显式 false 恢复", async () => {
    const a = await call("POST", "/api/roles/dev/archive", { archived: true });
    expect(a.status).toBe(200);
    expect(a.body.msg).toBe("已归档");
    expect(getRole("dev")!.status).toBe("archived");

    const b = await call("POST", "/api/roles/dev/archive", { archived: false });
    expect(b.status).toBe(200);
    expect(b.body.msg).toBe("已恢复");
    expect(getRole("dev")!.status).toBe("active");
  });

  test("不存在的角色仍是 404（body 合法时才轮到落盘层说话）", async () => {
    const r = await call("POST", "/api/roles/ghost/archive", { archived: true });
    expect(r.status).toBe(404);
  });
});

describe("Role 路由的状态码映射", () => {
  test("创建/冲突/组织约束各归各的码", async () => {
    const root = freshVault();
    seedProject(root, "ownward");

    expect((await call("POST", "/api/roles", { id: "rd", name: "研发 LD" })).status).toBe(200);
    expect((await call("POST", "/api/roles", { id: "rd", name: "重名" })).status).toBe(409);
    expect((await call("POST", "/api/roles", { id: "坏 id", name: "x" })).status).toBe(400);
    expect((await call("POST", "/api/roles", "{ not json")).status).toBe(400);

    const mk = { id: "ownward-dev", name: "ownward 专家", type: "project", primaryProject: "ownward", parentRoleId: "rd" };
    expect((await call("POST", "/api/roles", mk)).status).toBe(200);
    // 同一个主项目的第二个在岗专家 → 409
    const dup = await call("POST", "/api/roles", { ...mk, id: "ownward-dev2", name: "第二个" });
    expect(dup.status).toBe(409);
    expect(dup.body.msg).toContain("在岗专家");
    // 名下有在岗专家的 LD 不许归档 → 409
    const arch = await call("POST", "/api/roles/rd/archive", { archived: true });
    expect(arch.status).toBe(409);
    expect(arch.body.msg).toContain("ownward-dev");
  });

  test("项目候选接口：职能负责人 400、未知子路径 404、slug 由角色推导（客户端给的被忽略）", async () => {
    const root = freshVault();
    seedProject(root, "ownward");
    seedProject(root, "secret");
    await call("POST", "/api/roles", { id: "rd", name: "研发 LD" });
    await call("POST", "/api/roles", { id: "ownward-dev", name: "专家", type: "project", primaryProject: "ownward" });

    const lead = await call("GET", "/api/roles/rd/project-candidates");
    expect(lead.status).toBe(400);
    expect(lead.body.msg).toContain("没有主项目");

    // 客户端塞 project/scope 想改写落点：一律无视，落在角色的主项目上
    const made = await call("POST", "/api/roles/ownward-dev/project-candidates", {
      text: "只对 ownward 成立的事", project: "secret", scope: "private",
    });
    expect(made.status).toBe(200);
    expect(made.body.candidate.project).toBe("ownward");
    expect(made.body.candidate.sourceRole).toBe("ownward-dev");

    // 候选 id 里的穿越连路由都匹配不上 → 404（不是静默 no-op）
    const evil = await call("POST", "/api/roles/ownward-dev/project-candidates/..%2F..%2Fevil/dismiss", {});
    expect(evil.status).toBe(404);
    expect(evil.body.msg).toContain("未知的角色接口");

    const bad = await call("POST", `/api/roles/ownward-dev/project-candidates/${made.body.candidate.id}/promote`, { target: "role.json" });
    expect(bad.status).toBe(400);
    const okp = await call("POST", `/api/roles/ownward-dev/project-candidates/${made.body.candidate.id}/promote`, { target: "decisions" });
    expect(okp.status).toBe(200);
    expect(okp.body.msg).toContain("ownward/decisions.md");
  });
});
