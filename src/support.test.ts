import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Role } from "./roles.ts";
import { normalizeLarkPayload } from "./sources/lark.ts";
import {
  getCase, handleSupportCardAction, handleSupportIntake, investigatorPlan, isSupportMessage, listCases, messageText,
  parseInvestigatorOutput, parseRoute, resultBody, routePrompt, senderOpenId, settleSupportForTest, spawnClean, stripTrigger, useSupportForTest,
  type SupportCase, type SupportDeps,
} from "./support.ts";
import { cfg } from "./util.ts";

const OWNER = "ou_owner000000000000000000000000";
const role = (over: Partial<Role> & { id: string }): Role => ({
  name: `${over.id.replace(/^owner-/, "")} Owner`, description: "", scope: "work", type: "project", origin: "auto", status: "active",
  primaryProject: over.id.replace(/^owner-/, ""), projects: [over.id.replace(/^owner-/, "")], dirs: [], instructions: "",
  parentRoleId: "", createdAt: "", updatedAt: "", ...over,
} as unknown as Role);
const ACCOUNT = role({ id: "owner-acme-account", description: "用户账号与登录", dirs: ["/repo/acme-account"] });
const APP = role({ id: "owner-acme-app", description: "订单与支付", dirs: ["/repo/acme-app"] });
const BIZ = role({ id: "domain-biz-ops", name: "业务运营", origin: "domain", primaryProject: "domain-biz-ops", dirs: ["/Users/x/workspace"] } as any);
const PRIV = role({ id: "owner-private-thing", scope: "private" } as any);
const ROLES: Record<string, Role> = Object.fromEntries([ACCOUNT, APP, BIZ, PRIV].map((r) => [r.id, r]));

const msg = (text: string, over: Record<string, unknown> = {}) =>
  ({ message_id: `om_${Math.random().toString(36).slice(2, 10)}`, chat_id: "oc_dm", chat_type: "p2p", content: text, sender_open_id: OWNER, ...over });
const okRun = (so: Record<string, unknown>) => ({
  code: 0, stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: so, total_cost_usd: 0.12, duration_ms: 42_000, num_turns: 7, permission_denials: [] }),
});
const RESULT = {
  in_scope: true, conclusion: "是账号问题：账号被暂停", root_cause: "account.state=suspended", confidence: "high",
  evidence: ["acme-cli user 张三 → SUSPENDED"], checks_run: ["acme-cli user 张三"], suggested_action: "找管理员恢复账号", reply_draft: "你的账号被暂停了，找管理员处理",
};

let dataDir = "", saved: { support: unknown; owner: unknown; ownerName: unknown };
let cards: { title: string; template: string; body: string; buttons: any[] }[] = [];
let llmReplies: any[] = [], spawns: { argv: string[]; cwd: string; input: string }[] = [], spawnReply: any = okRun(RESULT);
let logs: { role: string; entry: string; key: string }[] = [], candidates: { role: string; text: string; evidence: string }[] = [], reacted: string[] = [];
let now = new Date("2026-10-16T08:00:00Z");

function install(over: Partial<SupportDeps> = {}) {
  useSupportForTest({
    dataDir, now: () => now,
    llm: async () => llmReplies.shift() ?? null,
    spawn: async (argv, o) => { spawns.push({ argv, cwd: o.cwd, input: o.input }); return spawnReply; },
    sendCard: async (title, template, body, buttons) => { cards.push({ title, template, body, buttons }); return "om_card"; },
    react: async (id) => { reacted.push(id); },
    resolveRole: (id) => ROLES[id] ?? null,
    memoryPack: (id) => `### 角色：${id}`,
    recentTitles: () => ["排查登录接口超时"],
    vaultProjectDir: (r) => `/vault/projects/${r.primaryProject}`,
    isGitRoot: (d) => d.startsWith("/repo/"),
    appendKnowledge: (r, entry, key) => { logs.push({ role: r.id, entry, key }); },
    createCandidate: (r, text, evidence) => { candidates.push({ role: r.id, text, evidence }); return { ok: true, id: "20261016-cand01" }; },
    ...over,
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ownward-support-test-"));
  saved = { support: cfg.support, owner: cfg.notify.larkUserId, ownerName: cfg.owner?.name };
  cfg.owner = { ...(cfg.owner || {}), name: "Alice" };
  cfg.support = {
    enabled: true, trigger: "排查", correctionTrigger: "纠正",
    roles: ["owner-acme-account", "owner-acme-app", "domain-biz-ops", "owner-private-thing", "owner-missing"],
    excluded: [{ project: "model-proxy", desc: "模型代理 API" }],
    routeModel: "sonnet", investigateModel: "sonnet", dailyCap: 3, maxConcurrent: 2, maxTurns: 30, investigateTimeoutMs: 600_000,
    allowedCommands: ["acme-cli"], denyRead: ["**/.env", "**/config_*.yaml"],
  };
  cfg.notify.larkUserId = OWNER;
  cards = []; llmReplies = []; spawns = []; spawnReply = okRun(RESULT); logs = []; candidates = []; reacted = [];
  now = new Date("2026-10-16T08:00:00Z");
  install();
});
afterEach(() => {
  useSupportForTest(null);
  cfg.support = saved.support; cfg.notify.larkUserId = saved.owner; cfg.owner = { ...(cfg.owner || {}), name: saved.ownerName };
  rmSync(dataDir, { recursive: true, force: true });
});

describe("准入（确定性规则）", () => {
  test("正文：拍平的纯文本 / 原生 {text} 串都认", () => {
    expect(messageText("  排查 张三  ")).toBe("排查 张三");
    expect(messageText(JSON.stringify({ text: "排查 李四" }))).toBe("排查 李四");
    expect(messageText(undefined)).toBe("");
  });
  test("触发词：冒号/空格变体；只有触发词 = 空串；别的开头 = null", () => {
    expect(stripTrigger("排查：张三登不上", "排查")).toBe("张三登不上");
    expect(stripTrigger("排查: 张三", "排查")).toBe("张三");
    expect(stripTrigger("排查", "排查")).toBe("");
    expect(stripTrigger("帮我排查张三", "排查")).toBeNull();
  });
  test("发送者：拍平的顶层 sender_id 字符串、原生信封、规范化后的 sender_open_id 都能取到", () => {
    expect(senderOpenId({ sender_id: OWNER })).toBe(OWNER);
    expect(senderOpenId({ sender: { sender_id: { open_id: OWNER } } })).toBe(OWNER);
    expect(senderOpenId({ sender_open_id: OWNER })).toBe(OWNER);
  });
  test("规范化保留发送者：lark-cli 拍平事件原来会把 sender_id 丢掉", () => {
    const flat = normalizeLarkPayload("im.message.receive_v1", { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", content: "排查 x", sender_id: OWNER });
    expect(flat.sender_open_id).toBe(OWNER);
    const native = normalizeLarkPayload("im.message.receive_v1", { header: { event_id: "e1" }, event: { sender: { sender_id: { open_id: OWNER }, sender_type: "user" }, message: { message_id: "om_2", chat_id: "oc_1", chat_type: "p2p", content: "{\"text\":\"排查 y\"}" } } });
    expect(native.sender_open_id).toBe(OWNER);
    expect(isSupportMessage(native)).toBe(true);
  });
  test("规范化可重复调用：consumeLarkLine → enqueueLark → ingress 重放各跑一遍，发送者不能被冲掉", () => {
    const once = normalizeLarkPayload("im.message.receive_v1", { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", content: "排查 x", sender_id: OWNER });
    const thrice = normalizeLarkPayload("im.message.receive_v1", normalizeLarkPayload("im.message.receive_v1", once));
    expect(thrice.sender_open_id).toBe(OWNER);
    expect(isSupportMessage(thrice)).toBe(true);
    const native = normalizeLarkPayload("im.message.receive_v1", { event: { sender: { sender_id: { open_id: OWNER } }, message: { message_id: "om_2", chat_id: "oc_1", chat_type: "p2p", content: "{\"text\":\"排查 y\"}" } } });
    expect(normalizeLarkPayload("im.message.receive_v1", native).sender_open_id).toBe(OWNER);
  });
  test("只认你本人的私聊 + 触发词；没开 support 一律不认", () => {
    expect(isSupportMessage(msg("排查 张三"))).toBe(true);
    expect(isSupportMessage(msg("纠正 其实是用户名带空格"))).toBe(true);
    expect(isSupportMessage(msg("你好"))).toBe(false);
    expect(isSupportMessage(msg("排查 张三", { sender_open_id: "ou_someone_else" }))).toBe(false);
    expect(isSupportMessage(msg("排查 张三", { chat_type: "group" }))).toBe(false);
    cfg.support.enabled = false;
    expect(isSupportMessage(msg("排查 张三"))).toBe(false);
  });
});

describe("路由", () => {
  test("有把握且 id 在候选池里 → matched；编出来的 id 丢掉", () => {
    expect(parseRoute({ roleId: "owner-acme-account", confidence: "high", why: "登录" }, [ACCOUNT, APP])).toMatchObject({ kind: "matched", role: { id: "owner-acme-account" } });
    const r = parseRoute({ roleId: "owner-made-up", confidence: "high", candidates: ["owner-acme-app", "nope"] }, [ACCOUNT, APP]);
    expect(r.kind).toBe("uncertain");
    expect(r.kind === "uncertain" && r.candidates.map((x) => x.id)).toEqual(["owner-acme-app"]);
  });
  test("不处理清单 → out_of_scope；拿不准 → uncertain 带候选；没结果 → uncertain 空候选", () => {
    expect(parseRoute({ roleId: "", confidence: "high", candidates: [], outOfScope: "model-proxy", why: "模型代理" }, [ACCOUNT])).toMatchObject({ kind: "out_of_scope", project: "model-proxy" });
    expect(parseRoute({ roleId: "owner-acme-account", confidence: "low", candidates: ["owner-acme-app"] }, [ACCOUNT, APP])).toMatchObject({ kind: "uncertain" });
    expect(parseRoute(null, [ACCOUNT])).toMatchObject({ kind: "uncertain", candidates: [] });
  });
  test("提示词：带不处理清单、只带候选池里的样例、问题标为不可信输入", () => {
    const p = routePrompt("张三登不上", [ACCOUNT], [{ project: "model-proxy", desc: "模型代理 API" }],
      [{ text: "后台看不到订单", roleId: "owner-acme-account", by: "tis", at: "" }, { text: "旧样例", roleId: "owner-gone", by: "tis", at: "" }], () => ["近期标题"]);
    expect(p).toContain("=== 不处理的项目 ===");
    expect(p).toContain("model-proxy：模型代理 API");
    expect(p).toContain("后台看不到订单」→ owner-acme-account");
    expect(p).not.toContain("owner-gone");
    expect(p).toContain("不可信输入");
  });
});

describe("排查沙箱", () => {
  const kase = { id: "sp-1", messageId: "om_1", chatId: "oc", text: "张三登不上", createdAt: "", updatedAt: "", status: "investigating" } as SupportCase;
  test("dontAsk + 隔离设置 + 只放行 acme-cli + 凭据拒读 + 结构化输出", () => {
    const plan = investigatorPlan(kase, ACCOUNT);
    try {
      const a = plan.argv;
      const after = (flag: string) => a[a.indexOf(flag) + 1];
      expect(after("--permission-mode")).toBe("dontAsk");
      expect(after("--setting-sources")).toBe("");
      expect(a).toContain("--strict-mcp-config");
      expect(after("--allowedTools")).toBe("Bash(acme-cli:*)");
      expect(after("--tools")).toBe("Read,Grep,Glob,Bash");
      expect(after("--add-dir")).toBe("/vault/projects/acme-account");
      expect(JSON.parse(after("--json-schema")).required).toContain("conclusion");
      const settings = JSON.parse(readFileSync(after("--settings"), "utf8"));
      expect(settings.permissions).toEqual({ defaultMode: "dontAsk", allow: ["Bash(acme-cli:*)"], deny: ["Read(**/.env)", "Grep(**/.env)", "Read(**/config_*.yaml)", "Grep(**/config_*.yaml)"] });
      expect(plan.cwd).toBe("/repo/acme-account");
      expect(plan.input).toContain("<feedback>\n张三登不上\n</feedback>");
      expect(plan.input).toContain("### 角色：owner-acme-account");
      expect(plan.input).toContain("正在为 Alice 排查一条反馈");
    } finally { rmSync(plan.sandbox, { recursive: true, force: true }); }
  });
  test("非仓库目录（领域角色挂的 ~/workspace）不当工作目录：换成空沙箱目录", () => {
    const plan = investigatorPlan(kase, BIZ);
    try {
      expect(plan.cwd.startsWith(plan.sandbox)).toBe(true);
      expect(existsSync(plan.cwd)).toBe(true);
      expect(plan.input).toContain("这个角色没有代码仓库");
    } finally { rmSync(plan.sandbox, { recursive: true, force: true }); }
  });
  test("没配可放行命令时连 Bash 工具都不给", () => {
    cfg.support.allowedCommands = [];
    const plan = investigatorPlan(kase, ACCOUNT);
    try {
      expect(plan.argv[plan.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(plan.argv).not.toContain("--allowedTools");
    } finally { rmSync(plan.sandbox, { recursive: true, force: true }); }
  });
  test("输出解析：structured_output 优先，result 串兜底；超时 / 轮数用完 / 非 JSON 都报错", () => {
    expect(parseInvestigatorOutput(okRun(RESULT)).result.conclusion).toBe("是账号问题：账号被暂停");
    const viaResult = { code: 0, stderr: "", stdout: JSON.stringify({ subtype: "success", result: JSON.stringify(RESULT), num_turns: 3 }) };
    expect(parseInvestigatorOutput(viaResult).stats.turns).toBe(3);
    expect(() => parseInvestigatorOutput({ code: 124, stdout: "", stderr: "" })).toThrow("超时");
    expect(() => parseInvestigatorOutput({ code: 1, stdout: JSON.stringify({ subtype: "error_max_turns" }), stderr: "" })).toThrow("轮数");
    expect(() => parseInvestigatorOutput({ code: 1, stdout: "boom", stderr: "x" })).toThrow("不是 JSON");
  });
});

describe("立案到结论（端到端，全部依赖注入）", () => {
  test("有把握 → 直接派给角色 → 结论卡 + 写工作日志；同一条消息重放不重复立案", async () => {
    llmReplies = [{ roleId: "owner-acme-account", confidence: "high", candidates: [], outOfScope: "", why: "登录" }];
    const m = msg("排查 张三登录提示账号已被暂停");
    expect(await handleSupportIntake(m)).toBe(true);
    await settleSupportForTest();
    expect(reacted).toEqual([m.message_id]);
    const [c] = listCases();
    expect(c).toMatchObject({ status: "done", roleId: "owner-acme-account", text: "张三登录提示账号已被暂停", route: { by: "auto" } });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].cwd).toBe("/repo/acme-account");
    expect(cards.at(-1)?.title).toBe("🔍 排查结论 · acme-account");
    expect(cards.at(-1)?.buttons.map((b) => b.value.v)).toEqual(["correct", "wrong"]);
    expect(logs).toHaveLength(1);
    expect(logs[0].key).toBe(`\`${c.id}\``);
    expect(logs[0].entry).toContain("**Verdict**: 待 Alice 确认");
    expect(await handleSupportIntake(m)).toBe(true);   // durable ingress 重放
    await settleSupportForTest();
    expect(listCases()).toHaveLength(1);
  });
  test("不是你本人发的、不是触发词：不接管，也不落盘", async () => {
    expect(await handleSupportIntake(msg("排查 张三", { sender_open_id: "ou_other" }))).toBe(false);
    expect(await handleSupportIntake(msg("今天吃什么"))).toBe(false);
    expect(listCases()).toHaveLength(0);
  });
  test("只有触发词 → 提示用法；每日额度只算进了排查流程的 case，超范围的不占名额", async () => {
    await handleSupportIntake(msg("排查"));
    expect(cards.at(-1)?.title).toContain("缺少问题描述");
    llmReplies = Array(2).fill({ roleId: "", confidence: "high", candidates: [], outOfScope: "model-proxy", why: "" });
    for (let i = 0; i < 2; i++) { await handleSupportIntake(msg(`排查 超范围${i}`)); await settleSupportForTest(); }
    llmReplies = Array(4).fill({ roleId: "owner-acme-account", confidence: "high" });
    for (let i = 0; i < 4; i++) { await handleSupportIntake(msg(`排查 问题${i}`)); await settleSupportForTest(); }
    expect(listCases().filter((c) => c.status === "done")).toHaveLength(3);
    expect(listCases().filter((c) => c.status === "out_of_scope")).toHaveLength(2);
    expect(cards.some((x) => x.title.includes("额度用完"))).toBe(true);
  });
  test("超出范围 → 通知你，不派人", async () => {
    llmReplies = [{ roleId: "", confidence: "high", candidates: [], outOfScope: "model-proxy", why: "模型代理报 401" }];
    await handleSupportIntake(msg("排查 模型代理 API key 报 401"));
    await settleSupportForTest();
    expect(listCases()[0].status).toBe("out_of_scope");
    expect(cards.at(-1)?.title).toBe("🔍 排查：不在处理范围");
    expect(spawns).toHaveLength(0);
  });
  test("拿不准 → 选角色卡（私人角色、不存在的角色不进候选）→ 你点了才派，并记成路由样例", async () => {
    llmReplies = [null];
    await handleSupportIntake(msg("排查 页面白屏"));
    await settleSupportForTest();
    const routeCard = cards.at(-1)!;
    expect(routeCard.title).toBe("🔍 排查：选一个角色");
    const roleIds = routeCard.buttons.map((b) => b.value.role);
    expect(roleIds).toEqual(["owner-acme-account", "owner-acme-app", "domain-biz-ops", ""]);
    const c = listCases()[0];
    expect(c.status).toBe("awaiting_route");
    const view = await handleSupportCardAction({ t: "support", op: "route", id: c.id, role: "owner-acme-app" });
    expect(view.title).toBe("🔍 排查：已派给 acme-app");
    await settleSupportForTest();
    expect(getCase(c.id)).toMatchObject({ status: "done", roleId: "owner-acme-app", route: { by: "tis" } });
    expect(spawns[0].cwd).toBe("/repo/acme-app");
    expect((await handleSupportCardAction({ t: "support", op: "route", id: c.id, role: "owner-acme-app" })).body).toContain("已经处理过");
    llmReplies = [null];
    await handleSupportIntake(msg("排查 又一个白屏"));
    await settleSupportForTest();
    const second = listCases()[0];
    expect((await handleSupportCardAction({ t: "support", op: "route", id: second.id, role: "" })).title).toBe("🔍 排查：不处理");
    expect(getCase(second.id)?.status).toBe("dropped");
  });
  test("判对：记判定、覆盖同一条日志、记成路由样例；重复点不再记", async () => {
    llmReplies = [{ roleId: "owner-acme-account", confidence: "high" }];
    await handleSupportIntake(msg("排查 张三登不上"));
    await settleSupportForTest();
    const c = listCases()[0];
    const view = await handleSupportCardAction({ t: "support", op: "verdict", id: c.id, v: "correct" });
    expect(view.template).toBe("green");
    expect(view.body).toContain("**结论**：是账号问题");
    expect(getCase(c.id)?.verdict).toBe("correct");
    expect(logs.at(-1)?.entry).toContain("✅ Alice 判断对");
    expect(logs.at(-1)?.key).toBe(logs[0].key);
    expect((await handleSupportCardAction({ t: "support", op: "verdict", id: c.id, v: "wrong" })).body).toContain("已记录过判定");
    expect(getCase(c.id)?.verdict).toBe("correct");
  });
  test("判错 → 「纠正 …」存成角色主项目的候选，日志带上纠正", async () => {
    llmReplies = [{ roleId: "owner-acme-account", confidence: "high" }];
    await handleSupportIntake(msg("排查 张三登不上"));
    await settleSupportForTest();
    const c = listCases()[0];
    await handleSupportCardAction({ t: "support", op: "verdict", id: c.id, v: "wrong" });
    await handleSupportIntake(msg("纠正 其实是用户名带了前导空格，登录找不到原账号"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ role: "owner-acme-account" });
    expect(candidates[0].text).toContain("用户名带了前导空格");
    expect(candidates[0].evidence).toContain(c.id);
    expect(getCase(c.id)).toMatchObject({ correction: "其实是用户名带了前导空格，登录找不到原账号", candidateId: "20261016-cand01" });
    expect(logs.at(-1)?.entry).toContain("纠正：其实是用户名带了前导空格");
    expect(cards.at(-1)?.title).toBe("✅ 纠正已存成候选");
  });
  test("排查失败（轮数用完）→ case 标失败并通知", async () => {
    llmReplies = [{ roleId: "owner-acme-account", confidence: "high" }];
    spawnReply = { code: 1, stdout: JSON.stringify({ subtype: "error_max_turns" }), stderr: "" };
    await handleSupportIntake(msg("排查 张三登不上"));
    await settleSupportForTest();
    expect(listCases()[0]).toMatchObject({ status: "failed" });
    expect(cards.at(-1)?.title).toBe("🔍 排查失败");
  });
  test("daemon 重启留下的半截 case：下次立案时标失败并通知", async () => {
    llmReplies = [null];
    await handleSupportIntake(msg("排查 第一条"));
    await settleSupportForTest();
    const first = listCases()[0];
    await handleSupportCardAction({ t: "support", op: "route", id: first.id, role: "owner-acme-account" });
    let release!: () => void;
    install({ spawn: () => new Promise((r) => { release = () => r(okRun(RESULT)); }) });   // 卡在排查中
    llmReplies = [null];
    await handleSupportIntake(msg("排查 第二条"));
    await settleSupportForTest();
    const second = listCases()[0];
    await handleSupportCardAction({ t: "support", op: "route", id: second.id, role: "owner-acme-account" });
    await Bun.sleep(10);
    expect(getCase(second.id)?.status).toBe("investigating");
    now = new Date(now.getTime() + 20 * 60_000);
    llmReplies = [{ roleId: "", confidence: "high", outOfScope: "model-proxy" }];
    await handleSupportIntake(msg("排查 第三条"));
    expect(getCase(second.id)).toMatchObject({ status: "failed", error: "中断（daemon 重启或超时）" });
    release();
    await settleSupportForTest();
    expect(cards.some((x) => x.title === "🔍 排查中断")).toBe(true);
  });
});

test("存储放在 data/support/state.json", async () => {
  llmReplies = [{ roleId: "", confidence: "high", outOfScope: "model-proxy" }];
  await handleSupportIntake(msg("排查 x"));
  await settleSupportForTest();
  expect(existsSync(join(dataDir, "support", "state.json"))).toBe(true);
  mkdirSync(join(dataDir, "unrelated"), { recursive: true });
});

test("结论卡正文超长：主体截断，统计行和判定结果始终保留在 1500 字内", () => {
  const long = "很长的说明".repeat(200);
  const c = { id: "sp-long", messageId: "om_x", chatId: "oc", text: long, createdAt: "", updatedAt: "", status: "done",
    result: { ...RESULT, conclusion: long, root_cause: long, evidence: Array(12).fill(long), suggested_action: long, reply_draft: long },
    stats: { turns: 9, durationMs: 61_000, costUsd: 0.5 } } as SupportCase;
  const body = resultBody(c, ACCOUNT, "**判定**：✅ 判断对");
  expect(body.length).toBeLessThanOrEqual(1500);
  expect(body).toContain("sp-long</font>");
  expect(body.endsWith("**判定**：✅ 判断对")).toBe(true);
});

test("排查子进程忽略 SIGTERM：宽限期后 SIGKILL 并按超时返回，不会一直占着并发名额", async () => {
  const t0 = Date.now();
  const r = await spawnClean(["bash", "-c", "trap '' TERM; sleep 30"], { cwd: tmpdir(), input: "", timeoutMs: 200, graceMs: 300 });
  expect(r.code).toBe(124);
  expect(Date.now() - t0).toBeLessThan(5_000);
});
