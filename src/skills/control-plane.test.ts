import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SkillAdapterStatus, SkillEngine, SkillScanOptions } from "./contracts.ts";
import { routeSkills } from "./routes.ts";
import { SkillInventoryService } from "./service.ts";
import { analyzeSkillMetadataWithAgent, invokeToolFreeSkillAgent } from "./analysis.ts";
import { cfg } from "../util.ts";
import { scanSkillsRaw } from "./scanner.ts";
import { ApprovalStore } from "../control-plane/approval.ts";

const temps: string[] = [];
const engines: SkillEngine[] = ["claude", "codex", "codebuddy"];
const statuses = (capability: SkillAdapterStatus["capability"] = "read-write"): SkillScanOptions["adapterStatus"] => Object.fromEntries(engines.map((engine) => [engine, { engine, matrixVersion: 1, platform: "darwin", detectedVersion: engine === "codex" ? "0.9.0" : "1.2.3", capability, verification: "disk-only", reason: capability === "read-write" ? null : "test", supportedVersionRange: "test", versionStatus: "supported" }])) as SkillScanOptions["adapterStatus"];
function fixture(platform = "darwin", capability: SkillAdapterStatus["capability"] = "read-write") { const home = mkdtempSync(join(tmpdir(), "ownward-skill-control-")); temps.push(home); return { home, storeRoot: join(home, ".ownward", "skills"), platform, adapterStatus: statuses(capability) } satisfies SkillScanOptions; }
function skill(path: string, name: string, body = "body") { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: safe metadata\n---\n${body}\n`); }
const request = (path: string, value?: unknown, headers: Record<string,string> = {}) => new Request(`http://local${path}`, { method: value === undefined ? "GET" : "POST", ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { "content-type": "application/json", ...headers } }) });
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("只读根的变动不许否决人工批准", () => {
  // 2026-09-01 实撞：点「批准并执行」报 SKILL_INVENTORY_STALE。查下来可写根一处没动，
  // 变的全在 ~/.codex/skills/.system（codex 每启动一次就重刷自带 skill，实测 88 个文件），
  // 而 planner 明确拒绝把只读根当写入目标——计划完全有效，却被无关工具的日常动作拒掉。
  test("只读根改了：全量 revision 变、可写指纹不变", () => {
    const options = fixture();
    skill(join(options.home, ".claude", "skills", "mine"), "mine");
    skill(join(options.home, ".codex", "skills", ".system", "review-agent"), "review-agent");
    const before = scanSkillsRaw(options).inventory;
    skill(join(options.home, ".codex", "skills", ".system", "review-agent"), "review-agent", "codex 重刷了自带 skill");
    const after = scanSkillsRaw(options).inventory;
    expect(after.revision).not.toBe(before.revision);              // 全量指纹确实变了
    expect(after.mutableRevision).toBe(before.mutableRevision);    // 审批门看的这个没变
    skill(join(options.home, ".claude", "skills", "mine"), "mine", "用户自己改了");
    expect(scanSkillsRaw(options).inventory.mutableRevision).not.toBe(before.mutableRevision);   // 可写根变了照样抓得住
  });

  test("批准之后只读根被重刷，apply 仍然执行得下去", async () => {
    const options = fixture(), claude = join(options.home, ".claude", "skills", "shared"), codex = join(options.home, ".agents", "skills", "shared");
    skill(claude, "shared"); skill(codex, "shared");
    skill(join(options.home, ".codex", "skills", ".system", "review-agent"), "review-agent");
    const service = new SkillInventoryService(options), inventory = await service.scan();
    const ids = inventory.catalog.find((x) => x.name === "shared")!.observationIds;
    const plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: ids }] });
    const session = "browser-session-123456789", approval = service.mintApproval(plan.id, plan.digest, session);
    skill(join(options.home, ".codex", "skills", ".system", "review-agent"), "review-agent", "审批之后 codex 又跑了一次");
    const tx = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "readonly-churn-12345", approval: { ...approval, browserSession: session } });
    expect(tx.phase).toBe("committed");
  });

  test("批准之后【可写根】被改，仍然必须拒绝", async () => {
    const options = fixture(), claude = join(options.home, ".claude", "skills", "shared"), codex = join(options.home, ".agents", "skills", "shared");
    skill(claude, "shared"); skill(codex, "shared");
    const service = new SkillInventoryService(options), inventory = await service.scan();
    const ids = inventory.catalog.find((x) => x.name === "shared")!.observationIds;
    const plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: ids }] });
    const session = "browser-session-123456789", approval = service.mintApproval(plan.id, plan.digest, session);
    skill(join(options.home, ".claude", "skills", "unrelated-but-writable"), "unrelated-but-writable");
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "writable-churn-12345", approval: { ...approval, browserSession: session } })).rejects.toThrow("文件系统在审批后发生变化");
  });
});

describe("Skill control plane safety", () => {
  test("default agent lane has an explicit tool deny and no Codex shell fallback", () => {
    const source = readFileSync(join(import.meta.dir, "analysis.ts"), "utf8");
    expect(source).toContain("--disallowedTools");
    expect(source).toContain('"--tools", ""');
    expect(source).toContain("--strict-mcp-config");
    expect(source).toContain('"hooks":{}');
    expect(source).toContain("invokeToolFreeSkillAgent");
    expect(source).not.toContain("llmJson");
    expect(source).not.toContain("codex exec");
  });
  test("public inventory and metadata proposal never expose raw home paths or skill bodies", async () => {
    const options = fixture(); skill(join(options.home, ".claude", "skills", "secret-skill"), "secret-skill", "DO_NOT_DISCLOSE_BODY_TOKEN");
    writeFileSync(join(options.home, ".claude", "skills", "secret-skill", "SKILL.md"), "---\nname: secret-skill\ndescription: token=sk-supersecret123456\n---\nDO_NOT_DISCLOSE_BODY_TOKEN\n");
    let agentPrompt = ""; const service = new SkillInventoryService(options, { analysisInvoke: async (prompt) => { agentPrompt = prompt; return { proposalVersion: 1, actions: [], notes: [] }; } }), inventory = await service.scan(), proposal = await service.analysis(inventory.mutableRevision, undefined, "agent"), serialized = JSON.stringify({ inventory, proposal });
    expect(serialized).not.toContain(options.home); expect(serialized).not.toContain("DO_NOT_DISCLOSE_BODY_TOKEN"); expect(agentPrompt).not.toContain(options.home); expect(agentPrompt).not.toContain("DO_NOT_DISCLOSE_BODY_TOKEN"); expect(agentPrompt).not.toContain("sk-supersecret123456"); expect(agentPrompt).toContain("rootAlias"); expect(agentPrompt).not.toContain("pathAlias"); expect(inventory.catalog[0].name).toBe("secret-skill"); expect(proposal.source).toBe("agent-metadata");
  });

  test("agent proposal cannot smuggle unknown observation ids: the bad item is dropped, valid items survive", async () => {
    // 以前是一条不合规整份作废：sonnet 三次里就有一次因为某条 note 多了个字段，把九条有效建议一起扔了。
    // 现在逐条校验——坏的丢掉并说明，好的留下；「夹带不存在的 id」这条安全性不变
    const options = fixture(), a = join(options.home, ".claude", "skills", "demo"), b = join(options.home, ".agents", "skills", "demo"); skill(a, "demo"); skill(b, "demo");
    const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 1, actions: [{ kind: "delete", observationId: "not-current" }, { kind: "adopt", observationIds: ids }], notes: [{ severity: "error", code: "x", message: "bad severity", observationIds: [] }] }) });
    const inventory = await service.scan(), ids = inventory.catalog.find((x) => x.name === "demo")!.observationIds, proposal = await service.analysis(inventory.mutableRevision, undefined, "agent");
    expect(proposal.source).toBe("agent-metadata");
    expect(proposal.actions).toEqual([{ kind: "adopt", observationIds: ids }]);                 // 有效的那条活下来
    expect(proposal.notes[0].code).toBe("AGENT_ITEMS_DROPPED"); expect(proposal.notes[0].message).toContain("2 条");   // 坏的两条（错 id + 错 severity）被丢并说明
  });
  test("agent proposal with a broken top-level shape falls back explicitly with the reason", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo");
    const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 2, actions: "nope" }) }), inventory = await service.scan(), proposal = await service.analysis(inventory.mutableRevision, undefined, "agent");
    expect(proposal.source).toBe("deterministic-fallback"); expect(proposal.notes[0].code).toBe("AGENT_ANALYSIS_FALLBACK"); expect(proposal.notes[0].message).toContain("顶层结构"); expect(proposal.actions).toEqual([]);
  });
  test("agent timeout or crash is categorized in the fallback note instead of a generic '不可用'", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo");
    const service = new SkillInventoryService(options, { analysisInvoke: async () => { throw Object.assign(new Error("超时（180s 内没有输出）"), { code: "SKILL_AGENT_UNAVAILABLE" }); } }), inventory = await service.scan(), proposal = await service.analysis(inventory.mutableRevision, undefined, "agent");
    expect(proposal.source).toBe("deterministic-fallback"); expect(proposal.notes[0].message).toContain("超时");
  });
  test("managed multi-engine deployments are not duplicates; only discovered copies are", async () => {
    // 一份 managed skill 链接到 3 个引擎 = 同一内容 3 个观测，那是纳管后的终态，不是待清理项。
    // 摘要喊「107 重复」而整理出 0 条建议，用户就会以为整理坏了（实撞 2026-09-02）
    const options = fixture(), managed = join(options.storeRoot!, "managed", "shared"); skill(managed, "shared");
    for (const dir of [join(options.home, ".claude", "skills"), join(options.home, ".agents", "skills")]) { mkdirSync(dir, { recursive: true }); symlinkSync(managed, join(dir, "shared")); }
    const all = scanSkillsRaw(options).inventory;
    expect(all.observations.filter((x) => x.name === "shared").every((x) => x.ownership === "managed" && !x.findings.includes("duplicate"))).toBeTrue();
    expect(all.summary.duplicates).toBe(0);
    skill(join(options.home, ".codebuddy", "skills", "shared"), "shared");     // 又冒出一份没纳管的副本：这才是重复
    const mixed = scanSkillsRaw(options).inventory;
    expect(mixed.observations.filter((x) => x.name === "shared").every((x) => x.findings.includes("duplicate"))).toBeTrue();
  });

  test("conflict text is per-item opt-in, bounded and redacted before agent analysis", async () => {
    const options = fixture(), one = join(options.home, ".claude", "skills", "conflict"), two = join(options.home, ".codebuddy", "skills", "conflict");
    skill(one, "conflict", `password=hunter2\npath=${options.home}\nversion one`); skill(two, "conflict", "version two");
    let prompt = ""; const service = new SkillInventoryService(options, { analysisInvoke: async (value) => { prompt = value; return { proposalVersion: 1, actions: [], notes: [] }; } });
    const inventory = await service.scan(), id = inventory.observations.find((item) => item.engine === "claude")!.id;
    const preview = service.contentPreview(inventory.mutableRevision, [id]); expect(preview[0].files.length).toBeGreaterThan(0); expect(preview[0].files[0].text).toBeUndefined();
    await service.analysis(inventory.revision, [id], "agent"); expect(prompt).toContain("explicitlyApprovedConflictText"); expect(prompt).not.toContain("hunter2"); expect(prompt).not.toContain(options.home);
  });

  test("conflict content consent is interactive, session-bound and one-use", async () => {
    const options = fixture(), one = join(options.home, ".claude", "skills", "consent"), two = join(options.home, ".codebuddy", "skills", "consent"); skill(one, "consent", "one"); skill(two, "consent", "two");
    const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 1, actions: [], notes: [] }) }), inventory = await service.scan(), ids = inventory.observations.filter((item) => item.name === "consent").map((item) => item.id), approvals = new ApprovalStore(), session = "browser-content-session";
    const previewUrl = new URL("http://local/api/skills/analysis/preview"), payload = { expectedRevision: inventory.mutableRevision, contentObservationIds: ids };
    const denied = await routeSkills(request(previewUrl.pathname, payload), previewUrl, service); expect(denied?.status).toBe(403);
    const context = { browserSession: { id: session, interactive: true }, confirmUserPresence: async () => true, approvals };
    const preview = await routeSkills(request(previewUrl.pathname, payload), previewUrl, service, context), previewBody = await preview!.json() as any; expect(previewBody.consentId).toBeString();
    const analyzeUrl = new URL("http://local/api/skills/analysis"), analyzePayload = { ...payload, consentId: previewBody.consentId };
    expect((await routeSkills(request(analyzeUrl.pathname, analyzePayload), analyzeUrl, service, context))?.status).toBe(200);
    expect((await routeSkills(request(analyzeUrl.pathname, analyzePayload), analyzeUrl, service, context))?.status).toBe(409);
  });

  test("rejects partial, protected, unknown-capability and non-darwin mutation plans", async () => {
    const partial = fixture(); skill(join(partial.home, ".claude", "skills", "large"), "large", "x".repeat(100)); const partialService = new SkillInventoryService({ ...partial, limits: { maxBytesPerSkill: 8 } }), partialInventory = await partialService.scan();
    expect(() => partialService.plan({ expectedRevision: partialInventory.mutableRevision, actions: [{ kind: "delete", observationId: partialInventory.observations[0].id }] })).toThrow("扫描不完整");
    const protectedOptions = fixture(); skill(join(protectedOptions.home, ".codex", "skills", ".system", "builtin"), "builtin"); const protectedService = new SkillInventoryService(protectedOptions), protectedInventory = await protectedService.scan();
    expect(() => protectedService.plan({ expectedRevision: protectedInventory.mutableRevision, actions: [{ kind: "delete", observationId: protectedInventory.observations[0].id }] })).toThrow("受保护");
    const unknown = fixture("darwin", "unknown"); skill(join(unknown.home, ".claude", "skills", "demo"), "demo"); const unknownService = new SkillInventoryService(unknown), unknownInventory = await unknownService.scan();
    expect(() => unknownService.plan({ expectedRevision: unknownInventory.mutableRevision, actions: [{ kind: "delete", observationId: unknownInventory.observations[0].id }] })).toThrow("拒绝写操作");
    const linux = fixture("linux"); skill(join(linux.home, ".claude", "skills", "demo"), "demo"); const linuxService = new SkillInventoryService(linux), linuxInventory = await linuxService.scan();
    expect(() => linuxService.plan({ expectedRevision: linuxInventory.mutableRevision, actions: [{ kind: "delete", observationId: linuxInventory.observations[0].id }] })).toThrow("仅支持 macOS");
  });

  test("adopt is approval-bound, journaled, idempotent, and conditionally rollbackable", async () => {
    const options = fixture(), claude = join(options.home, ".claude", "skills", "shared"), codex = join(options.home, ".agents", "skills", "shared"); skill(claude, "shared"); skill(codex, "shared");
    const service = new SkillInventoryService(options), inventory = await service.scan(), catalog = inventory.catalog.find((x) => x.name === "shared")!, ids = catalog.observationIds, plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: ids }] });
    expect(ids).toHaveLength(2); expect(plan.effects.filter((x) => x.kind === "replace-with-link" && x.destructive)).toHaveLength(2);
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "adopt-without-approval" })).rejects.toThrow("需要人工审批");
    const session = "browser-session-123456789", approval = service.mintApproval(plan.id, plan.digest, session), idempotencyKey = "adopt-shared-12345";
    const tx = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey, approval: { ...approval, browserSession: session } });
    expect(tx.phase).toBe("committed"); expect(readlinkSync(claude)).toBe(readlinkSync(codex)); const managed = readlinkSync(claude); expect(existsSync(join(managed, "SKILL.md"))).toBeTrue();
    const registry = JSON.parse(readFileSync(join(options.storeRoot!, "registry.json"), "utf8")); expect(registry.skills).toHaveLength(1); expect(registry.skills[0].sources).toHaveLength(2); expect(registry.skills[0].lastVerifiedTransaction).toBe(plan.transactionId); expect(tx.id).toBe(plan.transactionId);
    expect(JSON.stringify(service.publicRegistry())).not.toContain(options.home); const rollbackPreview = service.rollbackPreview(tx.id); expect(rollbackPreview.effects.length).toBeGreaterThan(0); expect(JSON.stringify(rollbackPreview)).not.toContain(options.home);
    const replay = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey, approval: { ...approval, browserSession: session } }); expect(replay.id).toBe(tx.id);
    const fresh = await service.scan(), rollbackApproval = service.mintRollbackApproval(tx.id, fresh.revision, session), rolled = service.rollback({ transactionId: tx.id, expectedRevision: fresh.mutableRevision, approval: { id: rollbackApproval.id, nonce: rollbackApproval.nonce, browserSession: session } });
    expect(rolled.phase).toBe("rolled-back"); expect(readFileSync(join(claude, "SKILL.md"), "utf8")).toContain("name: shared"); expect(readFileSync(join(codex, "SKILL.md"), "utf8")).toContain("name: shared");
  });

  test("stale inode and approval replay fail closed before a second mutation", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] }), session = "browser-session-987654321", approval = service.mintApproval(plan.id, plan.digest, session);
    rmSync(entry, { recursive: true }); skill(entry, "demo");
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "delete-demo-12345", approval: { ...approval, browserSession: session } })).rejects.toThrow("发生变化");
    // Stale rejection did not consume the approval, but a mismatched browser session must consume/fail it exactly once.
    const refreshed = await service.scan(), next = service.plan({ expectedRevision: refreshed.mutableRevision, actions: [{ kind: "delete", observationId: refreshed.observations[0].id }] }), once = service.mintApproval(next.id, next.digest, session);
    await expect(service.apply({ planId: next.id, expectedPlanDigest: next.digest, expectedRevision: refreshed.mutableRevision, idempotencyKey: "delete-demo-67890", approval: { ...once, browserSession: "browser-session-wrong000" } })).rejects.toThrow("不匹配");
    await expect(service.apply({ planId: next.id, expectedPlanDigest: next.digest, expectedRevision: refreshed.mutableRevision, idempotencyKey: "delete-demo-67890", approval: { ...once, browserSession: session } })).rejects.toThrow("已使用");
    expect(existsSync(entry)).toBeTrue();
  });

  test("repair, migrate and delete share the approved deterministic effect executor", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-session-effects12"; skill(entry, "demo"); const service = new SkillInventoryService(options); let inventory = await service.scan();
    const run = async (actions: any[], key: string) => { const plan = service.plan({ expectedRevision: inventory.mutableRevision, actions }), minted = plan.requiresApproval ? service.mintApproval(plan.id, plan.digest, session) : null, tx = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: key, ...(minted ? { approval: { ...minted, browserSession: session } } : {}) }); expect(tx.phase).toBe("committed"); inventory = await service.scan(); return plan; };
    await run([{ kind: "adopt", observationIds: [inventory.observations[0].id] }], "effects-adopt-1234"); const record = service.registry().skills[0], managed = record.managedPath;
    rmSync(entry); inventory = await service.scan(); const repair = await run([{ kind: "repair", skillId: record.id, engine: "claude", scope: "user" }], "effects-repair-123"); expect(repair.requiresApproval).toBeFalse(); expect(readlinkSync(entry)).toBe(managed);
    await run([{ kind: "migrate", skillId: record.id, engine: "codebuddy", scope: "user" }], "effects-migrate-123"); const codebuddy = join(options.home, ".codebuddy", "skills", "demo"); expect(readlinkSync(codebuddy)).toBe(managed);
    const deployed = inventory.observations.find((x) => x.entryPath === "~/.codebuddy/skills/demo")!; await run([{ kind: "delete", observationId: deployed.id }], "effects-delete-1234"); expect(existsSync(codebuddy)).toBeFalse(); expect(existsSync(entry)).toBeTrue();
  });

  test("persisted plans are reloaded and bound by expected digest", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-plan-digest-123"; skill(entry, "demo"); const service = new SkillInventoryService(options), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] });
    expect(() => service.mintApproval(plan.id, "0".repeat(64), session)).toThrow("摘要不匹配");
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: "0".repeat(64), expectedRevision: inventory.mutableRevision, idempotencyKey: "digest-mismatch-apply" })).rejects.toThrow("摘要不匹配");
    const file = join(options.storeRoot!, "plans", `${plan.id}.json`), raw = JSON.parse(readFileSync(file, "utf8")); raw.effects[0].mode = 0o777; writeFileSync(file, JSON.stringify(raw));
    expect(() => service.mintApproval(plan.id, plan.digest, session)).toThrow("验签失败"); expect(existsSync(entry)).toBeTrue();
  });

  test("Codex unknown precedence needs explicit target root and migrate source must belong to record", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), rogue = join(options.home, ".codebuddy", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options); let inventory = await service.scan(), adopt = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: [inventory.observations[0].id] }] }), session = "browser-codex-root-123", approval = service.mintApproval(adopt.id, adopt.digest, session); await service.apply({ planId: adopt.id, expectedPlanDigest: adopt.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "codex-root-adopt", approval: { ...approval, browserSession: session } });
    inventory = await service.scan(); const record = service.registry().skills[0]; expect(() => service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "migrate", skillId: record.id, engine: "codex", scope: "user" }] })).toThrow("显式选择");
    const codexRoot = inventory.roots.find((x) => x.engine === "codex" && x.scope === "user" && x.path === "~/.agents/skills")!; expect(codexRoot.mutationCapability).toBe("explicit-only"); const explicit = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "migrate", skillId: record.id, engine: "codex", scope: "user", targetRootId: codexRoot.id }] }); expect(explicit.effects.some((x) => x.path === "~/.agents/skills/demo")).toBeTrue();
    skill(rogue, "demo"); inventory = await service.scan(); const rogueObservation = inventory.observations.find((x) => x.entryPath === "~/.codebuddy/skills/demo")!; expect(() => service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "migrate", skillId: record.id, engine: "codex", scope: "user", targetRootId: codexRoot.id, removeSource: true, fromObservationId: rogueObservation.id }] })).toThrow("不属于");
  });

  test("project target root uses separator-aware containment", async () => {
    const options = fixture(), app = join(options.home, "workspace", "app"), app2 = join(options.home, "workspace", "app2"), source = join(options.home, ".claude", "skills", "projected"); mkdirSync(app, { recursive: true }); mkdirSync(app2, { recursive: true }); skill(source, "projected");
    const service = new SkillInventoryService({ ...options, projectRoots: [app, app2] }), inventory = await service.scan(), adopt = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: [inventory.observations.find((item) => item.name === "projected")!.id] }] }), session = "browser-project-boundary", approval = service.mintApproval(adopt.id, adopt.digest, session); await service.apply({ planId: adopt.id, expectedPlanDigest: adopt.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "project-adopt-key", approval: { ...approval, browserSession: session } });
    const fresh = await service.scan(), record = service.registry().skills[0], app2Root = fresh.roots.find((root) => root.engine === "claude" && root.scope === "project" && root.path.includes("app2"))!;
    expect(() => service.plan({ expectedRevision: fresh.mutableRevision, actions: [{ kind: "migrate", skillId: record.id, engine: "claude", scope: "project", projectRoot: app, targetRootId: app2Root.id }] })).toThrow("显式选择");
  });

  test("crash after atomic backup rename is recovered from durable subphase", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-crash-rename12"; skill(entry, "demo"); const crash: any = Object.assign(new Error("crash"), { simulateCrash: true, code: "TEST_CRASH" }); const service = new SkillInventoryService(options, { transactionHooks: { beforeEffect: (effect) => { if (effect.kind === "delete-entry") throw crash; } } }), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] }), approval = service.mintApproval(plan.id, plan.digest, session);
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "crash-rename-delete", approval: { ...approval, browserSession: session } })).rejects.toThrow("crash"); expect(existsSync(entry)).toBeFalse(); const journal = JSON.parse(readFileSync(join(options.storeRoot!, "transactions", `${plan.transactionId}.json`), "utf8")); expect(journal.effects[0].subphase).toBe("effect-started"); expect(existsSync(journal.effects[0].backupPath)).toBeTrue();
    const recovered = new SkillInventoryService(options); recovered.recover(); expect(existsSync(entry)).toBeTrue(); expect(recovered.transaction(plan.transactionId).phase).toBe("rolled-back");
  });

  test("partial managed staging is removed by startup recovery", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-crash-copy123"; skill(entry, "demo"); const crash: any = Object.assign(new Error("copy crash"), { simulateCrash: true, code: "TEST_COPY_CRASH" }); const service = new SkillInventoryService(options, { transactionHooks: { duringCopy: (_source, target) => { mkdirSync(target); writeFileSync(join(target, "partial"), "x"); throw crash; } } }), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: [inventory.observations[0].id] }] }), approval = service.mintApproval(plan.id, plan.digest, session);
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.mutableRevision, idempotencyKey: "crash-partial-copy", approval: { ...approval, browserSession: session } })).rejects.toThrow("copy crash"); const managed = join(options.storeRoot!, "managed", service.registry().skills[0]?.id || "missing"); expect(existsSync(entry)).toBeTrue();
    const recovered = new SkillInventoryService(options); recovered.recover(); expect(recovered.transaction(plan.transactionId).phase).toBe("rolled-back"); expect(existsSync(join(options.storeRoot!, "managed"))).toBeFalse(); expect(existsSync(managed)).toBeFalse();
  });

  test("spoofed client headers cannot mint approval; only server-injected browser context can", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] }), session = "browser-session-route1234";
    const spoofed = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest, browserSession: session }, { "x-ownward-interactive-session": session, "x-ownward-human-confirmation": "approve" }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service); expect(spoofed?.status).toBe(403);
    const nonInteractive = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service, { browserSession: { id: session, interactive: false }, confirmUserPresence: async () => true }); expect(nonInteractive?.status).toBe(403);
    const absent = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service, { browserSession: { id: session, interactive: true }, confirmUserPresence: async () => false }); expect(absent?.status).toBe(403);
    const allowed = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service, { browserSession: { id: session, interactive: true }, confirmUserPresence: async (id) => id === session }); expect(allowed?.status).toBe(201);
  });
});

// 分析期间界面只有一个灰掉的「Agent 分析中…」，用户不知道是不是卡死了（实撞 2026-09-02）。
// 后端要有阶段 + 已送/已收字节 + 用时/上限的信号，结束后要留一行诊断。
describe("Agent 分析要有进度和诊断", () => {
  test("阶段按序上报，结束后 diagnostics 挂在结果上", async () => {
    const options = fixture(), a = join(options.home, ".claude", "skills", "demo"), b = join(options.home, ".agents", "skills", "demo"); skill(a, "demo"); skill(b, "demo");
    const inventory = scanSkillsRaw(options).inventory, ids = inventory.observations.filter((x) => x.name === "demo").map((x) => x.id), phases: string[] = [];
    const proposal = await analyzeSkillMetadataWithAgent(inventory, async (_prompt, onProgress) => { onProgress?.({ bytes: 120 }); onProgress?.({ bytes: 480 }); return { proposalVersion: 1, actions: [{ kind: "adopt", observationIds: ids }], notes: [] }; }, undefined, (p) => phases.push(p ? `${p.phase}:${p.receivedBytes}` : "done"));
    expect(phases).toEqual(["waiting-model:0", "receiving:120", "receiving:480", "validating:480", "done"]);
    expect(proposal.diagnostics).toMatchObject({ outcome: "agent", observationsSent: 2, observationsActionable: 2, receivedBytes: 480, dropped: 0, timeoutMs: 180_000, model: "haiku" });   // 单独的 llm.skillAnalysisModel，默认 haiku，不跟决策模型走
    expect(proposal.diagnostics!.promptBytes).toBeGreaterThan(200);
  });
  test("超时 / 异常退出 / 坏 JSON 在 diagnostics 里分类，不再是一句「不可用」", async () => {
    const options = fixture(); skill(join(options.home, ".claude", "skills", "demo"), "demo"); const inventory = scanSkillsRaw(options).inventory;
    for (const [code, outcome] of [["SKILL_AGENT_TIMEOUT", "timeout"], ["SKILL_AGENT_UNAVAILABLE", "exit"], ["SKILL_AGENT_MALFORMED", "malformed"]] as const) {
      const proposal = await analyzeSkillMetadataWithAgent(inventory, async () => { throw Object.assign(new Error("x"), { code }); });
      expect(proposal.source).toBe("deterministic-fallback"); expect(proposal.diagnostics?.outcome).toBe(outcome);
    }
  });
  test("状态接口：闲时 running=false；跑着时能看到阶段；并发第二次被拒", async () => {
    const options = fixture(); skill(join(options.home, ".claude", "skills", "demo"), "demo");
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const service = new SkillInventoryService(options, { analysisInvoke: async (_p, onProgress) => { onProgress?.({ bytes: 42 }); await gate; return { proposalVersion: 1, actions: [], notes: [] }; } });
    const inventory = await service.scan();
    expect(service.analysisStatus()).toMatchObject({ running: false, progress: null });
    const idle = await routeSkills(request("/api/skills/analysis/status"), new URL("http://local/api/skills/analysis/status"), service); expect(await idle!.json()).toMatchObject({ running: false });
    const running = service.analysis(inventory.mutableRevision, undefined, "agent");
    await new Promise((r) => setTimeout(r, 10));
    expect(service.analysisStatus()).toMatchObject({ running: true, progress: { phase: "receiving", receivedBytes: 42, observationsSent: 1 } });
    await expect(service.analysis(inventory.mutableRevision, undefined, "agent")).rejects.toMatchObject({ code: "SKILL_ANALYSIS_BUSY" });
    release(); await running;
    expect(service.analysisStatus().running).toBeFalse();
  });
  test("真实 invoker 走 stream-json：边收边报字节数，从 result 帧取正文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ownward-fake-claude-")); temps.push(dir); const fake = join(dir, "claude");
    writeFileSync(fake, `#!/usr/bin/env bun\nconst w=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");\nw({type:"system",subtype:"init"});await Bun.sleep(30);\nw({type:"assistant",message:{content:[{type:"text",text:"partial"}]}});await Bun.sleep(30);\nw({type:"result",result:"\`\`\`json\\n{\\"proposalVersion\\":1,\\"actions\\":[],\\"notes\\":[]}\\n\`\`\`"});\n`);
    const { chmodSync } = await import("fs"); chmodSync(fake, 0o755);
    const oldBin = cfg.llm?.claudeBin; (cfg as any).llm.claudeBin = fake;
    try {
      const seen: number[] = []; const raw = await invokeToolFreeSkillAgent("ignored", ({ bytes }) => seen.push(bytes));
      expect(raw).toEqual({ proposalVersion: 1, actions: [], notes: [] });
      expect(seen.length).toBeGreaterThanOrEqual(2); expect(seen.at(-1)!).toBeGreaterThan(seen[0]);      // 字节数随帧递增
    } finally { (cfg as any).llm.claudeBin = oldBin; }
  });
});


// 采纳把**一份**内容复制进受管目录、再把选中的每个位置换成指向它的链接，内容不一致就会悄悄
// 改掉别的 Skill。planner 一直有这道守卫，但只在 plan 阶段抛 SKILL_ADOPT_CONFLICT，用户看到的是
// 一句没有出路的报错（2026-09-02 实测：haiku 把 6 个不同名的 xhs-* symlink 打成了一组）。
describe("采纳组内容不一致", () => {
  test("分析阶段就丢掉，不让它走到 plan 才炸", async () => {
    const options = fixture(), a = join(options.home, ".claude", "skills", "alpha"), b = join(options.home, ".agents", "skills", "beta");
    skill(a, "alpha", "内容一"); skill(b, "beta", "内容二");            // 名字和内容都不同
    let sent: string[] = [];
    const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 1, actions: [{ kind: "adopt", observationIds: sent }], notes: [] }) });
    const inventory = await service.scan();
    sent = inventory.observations.filter((o) => ["alpha", "beta"].includes(o.name)).map((o) => o.id);
    expect(sent.length).toBe(2);
    const proposal = await service.analysis(inventory.mutableRevision, undefined, "agent");
    expect(proposal.actions).toEqual([]);                                  // 这条不合规建议被丢掉
    expect(proposal.notes.some((n) => n.code === "AGENT_ITEMS_DROPPED" && n.message.includes("内容不一致"))).toBe(true);
  });

  test("真到了 plan，报错要点名并给出路", async () => {
    const options = fixture(), a = join(options.home, ".claude", "skills", "alpha"), b = join(options.home, ".agents", "skills", "beta");
    skill(a, "alpha", "内容一"); skill(b, "beta", "内容二");
    const service = new SkillInventoryService(options);
    const inventory = await service.scan();
    const ids = inventory.observations.filter((o) => ["alpha", "beta"].includes(o.name)).map((o) => o.id);
    try {
      service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "adopt", observationIds: ids }] });
      throw new Error("应该抛 SKILL_ADOPT_CONFLICT");
    } catch (e: any) {
      expect(e.code).toBe("SKILL_ADOPT_CONFLICT");
      expect(e.message).toContain("alpha");                                // 点名是哪些不一致
      expect(e.message).toMatch(/逐个采纳|只勾选其中一个/);                 // 给出路，不是死胡同
    }
  });
});

// 2026-09-02 实测事故：~/.agents/skills/gstack 顶层自己有 SKILL.md，扫描器只当它是「一个」观测，
// 里面却嵌着 290 个 SKILL.md。模型对这一条提了 delete，UI 显示成一条平平无奇的「删除部署」，
// 执行后 codex 会话里所有 gstack 技能全部消失。连带删除不能靠一条普通建议就发生。
describe("技能包不能被一条 delete 抹掉", () => {
  const bundle = (options: any) => {
    const root = join(options.home, ".agents", "skills", "kit");
    skill(root, "kit");                                    // 顶层自己是个 Skill
    skill(join(root, "inner-a"), "inner-a");               // 里面还嵌着两个
    skill(join(root, "inner-b"), "inner-b");
    return root;
  };

  test("扫描器数得出内含几个嵌套 Skill", async () => {
    const options = fixture(); bundle(options);
    const inventory = await new SkillInventoryService(options).scan();
    const kit = inventory.observations.find((o) => o.name === "kit")!;
    expect(kit.nestedSkills).toBe(2);
    // 关键：嵌套的 Skill 自己**不是**观测——扫描器不进入「自身即 Skill」的目录。
    // 所以 ownward 删这个包时，根本不知道自己连带删了什么；nestedSkills 是唯一的知情来源。
    expect(inventory.observations.some((o) => o.name === "inner-a")).toBe(false);
    skill(join(options.home, ".agents", "skills", "solo"), "solo");
    const again = await new SkillInventoryService(options).scan();
    expect(again.observations.find((o) => o.name === "solo")!.nestedSkills).toBe(0);   // 普通 Skill 为 0
  });

  test("planner 拒绝，并指向纳管", async () => {
    const options = fixture(); bundle(options);
    const service = new SkillInventoryService(options);
    const inventory = await service.scan();
    const kit = inventory.observations.find((o) => o.name === "kit")!;
    try {
      service.plan({ expectedRevision: inventory.mutableRevision, actions: [{ kind: "delete", observationId: kit.id }] });
      throw new Error("应该拒绝");
    } catch (e: any) {
      expect(e.code).toBe("SKILL_DELETE_BUNDLE");
      expect(e.message).toContain("2 个");                 // 说清连带范围
      expect(e.message).toContain("纳管");                  // 给出正确做法
    }
  });

  test("Agent 提的删包建议在分析阶段就被丢掉", async () => {
    const options = fixture(); bundle(options);
    let target = "";
    const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 1, actions: [{ kind: "delete", observationId: target }], notes: [] }) });
    const inventory = await service.scan();
    target = inventory.observations.find((o) => o.name === "kit")!.id;
    const proposal = await service.analysis(inventory.mutableRevision, undefined, "agent");
    expect(proposal.actions).toEqual([]);
    expect(proposal.notes.some((n) => n.code === "AGENT_ITEMS_DROPPED" && n.message.includes("技能包"))).toBe(true);
  });
});

// 2026-09-03 实测：用户点了「恢复」，原生弹窗也通过了（审批确实铸出来了），但审批永远没被消费——
// rollback 的门比的是 revision，而 revision 覆盖只读根，codex 每次运行都重写 ~/.codex/skills/.system/**，
// 实测几分钟内变了两次。页面加载时拿到的 revision 到点击时早就过期，这条恢复路径结构上走不通。
describe("恢复的 inventory 门", () => {
  const churn = () => {
    const options = fixture();
    skill(join(options.home, ".claude", "skills", "mine"), "mine");                       // 可写根
    const service = new SkillInventoryService(options);
    return { options, service };
  };

  test("只读根变化不该影响恢复：revision 抖了，mutableRevision 不动", async () => {
    const { options, service } = churn();
    const before = await service.scan();
    skill(join(options.home, ".codex", "skills", ".system", "builtin2"), "builtin2");     // 只动只读根
    const after = await service.scan();
    expect(after.revision).not.toBe(before.revision);                 // revision 抖了
    expect(after.mutableRevision).toBe(before.mutableRevision);       // 可写部分没变
  });

  test("恢复的门比 mutableRevision，不是 revision", async () => {
    const { options, service } = churn();
    await service.scan();
    skill(join(options.home, ".codex", "skills", ".system", "builtin3"), "builtin3");
    const fresh = await service.scan();
    const approval = { id: "x", nonce: "y", browserSession: "z" };
    const call = (rev: string) => { try { service.rollback({ transactionId: "no-such-tx", expectedRevision: rev, approval }); return ""; } catch (e: any) { return e.code || ""; } };
    // 带上当前 mutableRevision：必须放行过 inventory 这道门（后面才因事务不存在而失败）
    expect(call(fresh.mutableRevision)).not.toBe("SKILL_INVENTORY_STALE");
    // 带上 revision：这正是旧前端会发的值（只读根一变它就和 mutableRevision 分叉），必须被判为不匹配
    expect(fresh.revision).not.toBe(fresh.mutableRevision);
    expect(call(fresh.revision)).toBe("SKILL_INVENTORY_STALE");
  });
});


// 全部 inventory 门必须统一比 mutableRevision。revision 还覆盖只读根，codex 每次运行都重写
// ~/.codex/skills/.system/** 的 88 个文件——实测几分钟变两次。哪条门漏用 revision，哪条路
// 就会在用户多看两分钟之后无谓地判「已变化」（恢复那条因窗口最长，结构上根本走不通）。
test("扫描 / 分析 / 计划 / 冲突预览 的门都只看可写根", async () => {
  const options = fixture();
  skill(join(options.home, ".claude", "skills", "mine"), "mine");
  const service = new SkillInventoryService(options);
  const before = await service.scan();
  skill(join(options.home, ".codex", "skills", ".system", "noise"), "noise");   // 只动只读根
  const fresh = await service.scan();
  expect(fresh.revision).not.toBe(before.revision);
  expect(fresh.mutableRevision).toBe(before.mutableRevision);

  const mutable = fresh.mutableRevision, id = fresh.observations.find((o) => o.name === "mine")!.id;
  const code = (fn: () => unknown) => { try { fn(); return ""; } catch (e: any) { return e.code || ""; } };
  // 只读根抖动之后，带着页面上那份 mutableRevision 仍然可以继续操作
  expect(code(() => service.plan({ expectedRevision: mutable, actions: [{ kind: "delete", observationId: id }] }))).toBe("");
  expect(code(() => service.contentPreview(mutable, [id]))).not.toBe("SKILL_INVENTORY_STALE");
  // 而带 revision（旧口径）必须被判过期——这一处**故意**用 revision，别跟着批量改成 mutableRevision
  expect(code(() => service.plan({ expectedRevision: fresh.revision, actions: [{ kind: "delete", observationId: id }] }))).toBe("SKILL_INVENTORY_STALE");
});

// 2026-09-03 做减法：需求是「跨引擎去重合并、不要多份」，这是确定性问题。Agent 分析层是今天
// 所有错误建议的来源（把 6 个不同 Skill 打成一组、对技能包提 delete），而这台机器上可去重的组本就为 0。
// 规则成为默认路径，Agent 退为显式可选。
describe("规则优先的整理", () => {
  test("默认模式不调模型；显式 agent 模式才调", async () => {
    const options = fixture(); skill(join(options.home, ".claude", "skills", "solo"), "solo");
    let invoked = 0;
    const service = new SkillInventoryService(options, { analysisInvoke: async () => { invoked++; return { proposalVersion: 1, actions: [], notes: [] }; } });
    const inv = await service.scan();
    const rules = await service.analysis(inv.mutableRevision);
    expect(rules.source).toBe("deterministic-fallback"); expect(invoked).toBe(0);
    await service.analysis(inv.mutableRevision, undefined, "agent");
    expect(invoked).toBe(1);
  });

  test("规则：技能包只提示不动；真空目录建议清理；一致重复建议纳管", async () => {
    const options = fixture();
    const kit = join(options.home, ".agents", "skills", "kit"); skill(kit, "kit"); skill(join(kit, "inner"), "inner");   // 技能包
    mkdirSync(join(options.home, ".agents", "skills", "husk"), { recursive: true });                                      // 真空目录
    skill(join(options.home, ".claude", "skills", "twin"), "twin", "same"); skill(join(options.home, ".agents", "skills", "twin"), "twin", "same");  // 一致重复
    const service = new SkillInventoryService(options); const inv = await service.scan();
    const p = await service.analysis(inv.mutableRevision);
    const kinds = p.actions.map((a) => a.kind);
    expect(p.notes.some((n) => n.code === "BUNDLE_SKIPPED" && n.message.includes("kit"))).toBe(true);
    expect(p.actions.some((a) => a.kind === "adopt" && (a as any).observationIds.includes(inv.observations.find((o) => o.name === "kit")!.id))).toBe(false);
    const husk = inv.observations.find((o) => o.name === "husk")!;
    expect(p.actions.some((a) => a.kind === "delete" && (a as any).observationId === husk.id)).toBe(true);
    expect(p.actions.filter((a) => a.kind === "adopt").length).toBe(1);                       // twin
    expect(kinds.filter((k) => k === "delete").length).toBe(1);                              // 只有 husk
  });

  test("planner 拒绝整包纳管", async () => {
    const options = fixture(); const kit = join(options.home, ".agents", "skills", "kit"); skill(kit, "kit"); skill(join(kit, "inner"), "inner");
    const service = new SkillInventoryService(options); const inv = await service.scan();
    const id = inv.observations.find((o) => o.name === "kit")!.id;
    try { service.plan({ expectedRevision: inv.mutableRevision, actions: [{ kind: "adopt", observationIds: [id] }] }); throw new Error("应拒绝"); }
    catch (e: any) { expect(e.code).toBe("SKILL_ADOPT_BUNDLE"); expect(e.message).toContain("外部工具"); }
  });

  test("冲突：差异接口逐文件比对；以一版为准 = 纳管它并把另一侧换成链接", async () => {
    const options = fixture();
    skill(join(options.home, ".claude", "skills", "dup"), "dup", "line-a\nline-b");
    skill(join(options.home, ".agents", "skills", "dup"), "dup", "line-a\nline-C");
    const service = new SkillInventoryService(options); const inv = await service.scan();
    const [c, x] = ["claude", "codex"].map((e) => inv.observations.find((o) => o.name === "dup" && o.engine === e)!);
    expect(c.findings).toContain("conflict");
    const d = service.conflictDiff(inv.mutableRevision, [c.id, x.id]);
    const skillMd = d.files.find((f) => f.path.endsWith("SKILL.md"))!;
    expect(skillMd.status).toBe("different");
    expect((skillMd as any).lines.some((l: any) => l.left === "line-b" && l.right === "line-C")).toBe(true);
    // 以 claude 版为准，部署到 codex：codex 那边已存在的目录必须走 replace-with-link（先备份）
    const codexRoot = inv.roots.find((r) => r.engine === "codex" && x.entryPath.startsWith(r.path))!;   // 另一侧所在的根 → 原地换链接
    const plan = service.plan({ expectedRevision: inv.mutableRevision, actions: [{ kind: "adopt", observationIds: [c.id], expose: [{ engine: "codex", scope: "user", targetRootId: codexRoot.id }] }] });
    // 公开计划里的路径已把 home 缩成 ~
    expect(plan.effects.some((e) => e.kind === "replace-with-link" && e.path.endsWith("/.agents/skills/dup"))).toBe(true);
    expect(plan.effects.some((e) => e.kind === "delete-entry" && e.path.endsWith("/.agents/skills/dup"))).toBe(false);   // 不是删，是换链接
  });
});

// 2026-09-04：规则提了 37 个空目录的删除，用户点「审阅」被 planner 以 SKILL_OBSERVATION_INCOMPLETE 拒掉——
// 扫描器把没有 SKILL.md 的空目录判成 malformed，planner 又拒绝一切 malformed。空目录不是「看不清」，
// 是看清了里面什么都没有；给它独立的 empty 状态：可删、不可纳管。
describe("空目录是 empty 不是 malformed", () => {
  test("扫描判 empty；规则提删除；planner 放行删除、拒绝纳管", async () => {
    const options = fixture();
    mkdirSync(join(options.home, ".agents", "skills", "husk"), { recursive: true });
    const service = new SkillInventoryService(options); const inv = await service.scan();
    const husk = inv.observations.find((o) => o.name === "husk")!;
    expect(husk.state).toBe("empty");
    const p = await service.analysis(inv.mutableRevision);
    expect(p.actions).toContainEqual({ kind: "delete", observationId: husk.id });
    // 这一步昨天就是在这里炸的
    const plan = service.plan({ expectedRevision: inv.mutableRevision, actions: [{ kind: "delete", observationId: husk.id }] });
    expect(plan.effects.some((e) => e.kind === "delete-entry" && e.path.endsWith("/husk"))).toBe(true);
    try { service.plan({ expectedRevision: inv.mutableRevision, actions: [{ kind: "adopt", observationIds: [husk.id] }] }); throw new Error("应拒绝"); }
    catch (e: any) { expect(e.code).toBe("SKILL_ADOPT_EMPTY"); }
  });
  test("缺 SKILL.md 但有其它文件的目录仍是 malformed，仍不许动", async () => {
    const options = fixture();
    const dir = join(options.home, ".agents", "skills", "half"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "notes.txt"), "x");
    const service = new SkillInventoryService(options); const inv = await service.scan();
    const half = inv.observations.find((o) => o.name === "half")!;
    expect(half.state).toBe("malformed");
    try { service.plan({ expectedRevision: inv.mutableRevision, actions: [{ kind: "delete", observationId: half.id }] }); throw new Error("应拒绝"); }
    catch (e: any) { expect(e.code).toBe("SKILL_OBSERVATION_INCOMPLETE"); }
  });
});

// 2026-09-04：gstack 在顶层暴露子技能的方式是「目录里只放一个 SKILL.md → ../gstack/<x>/SKILL.md」。
// 扫描器把这种指针壳判成 healthy，UI 给了「以这一版为准」，执行到 copy-tree 才撞 SKILL_LINK_ESCAPE
// 回滚（三次），用户重试又撞 TRANSACTION_CONFLICT。指针壳不是技能，是指向别人树的链接。
describe("指针壳是 external，不是 healthy", () => {
  const shell = (options: any, name: string, target: string) => {
    const dir = join(options.home, ".claude", "skills", name); mkdirSync(dir, { recursive: true });
    symlinkSync(target, join(dir, "SKILL.md"));
    return dir;
  };
  test("目录里只有指向条目之外的链接 → external；链接指向条目内部 → 仍 healthy", async () => {
    const options = fixture();
    const real = join(options.home, ".claude", "skills", "gstack", "browse"); skill(real, "browse");   // 真身在包里
    shell(options, "browse-shell", join(real, "SKILL.md"));                                           // 指针壳
    const inner = join(options.home, ".claude", "skills", "self"); mkdirSync(join(inner, "real"), { recursive: true });
    writeFileSync(join(inner, "real", "SKILL.md"), "---\nname: self\ndescription: x\n---\nbody\n"); symlinkSync(join(inner, "real", "SKILL.md"), join(inner, "SKILL.md"));
    const inv = await new SkillInventoryService(options).scan();
    expect(inv.observations.find((o) => o.entryPath.endsWith("browse-shell"))!.state).toBe("external");
    expect(inv.observations.find((o) => o.entryPath.endsWith("/self"))!.state).toBe("healthy");
  });
  test("planner 拒绝纳管指针壳，理由说得清；规则对纯外部的冲突不再说「需要人工选择」", async () => {
    const options = fixture();
    // 两个真身同名不同内容（gstack 里的 connect-chrome / open-gstack-browser 就是这种），各有一个指针壳
    const r1 = join(options.home, ".claude", "skills", "gstack", "x1"), r2 = join(options.home, ".claude", "skills", "gstack", "x2");
    skill(r1, "shared", "body-1"); skill(r2, "shared", "body-2");
    shell(options, "shell-a", join(r1, "SKILL.md")); shell(options, "shell-b", join(r2, "SKILL.md"));
    const service = new SkillInventoryService(options); const inv = await service.scan();
    const a = inv.observations.find((o) => o.entryPath.endsWith("shell-a"))!;
    try { service.plan({ expectedRevision: inv.mutableRevision, actions: [{ kind: "adopt", observationIds: [a.id] }] }); throw new Error("应拒绝"); }
    catch (e: any) { expect(e.code).toBe("SKILL_ADOPT_EXTERNAL"); expect(e.message).toContain("链接壳"); }
    const p = await service.analysis(inv.mutableRevision);
    expect(inv.observations.filter((o) => o.name === "shared" && o.state === "external").length).toBe(2);
    expect(p.notes.some((n) => n.code === "CONTENT_CONFLICT" && n.message.includes("shared"))).toBe(false);
    expect(p.notes.some((n) => n.code === "EXTERNAL_CONFLICT" && n.message.includes("shared"))).toBe(true);
  });
});
