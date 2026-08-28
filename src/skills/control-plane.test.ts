import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SkillAdapterStatus, SkillEngine, SkillScanOptions } from "./contracts.ts";
import { routeSkills } from "./routes.ts";
import { SkillInventoryService } from "./service.ts";
import { ApprovalStore } from "../control-plane/approval.ts";

const temps: string[] = [];
const engines: SkillEngine[] = ["claude", "codex", "codebuddy"];
const statuses = (capability: SkillAdapterStatus["capability"] = "read-write"): SkillScanOptions["adapterStatus"] => Object.fromEntries(engines.map((engine) => [engine, { engine, matrixVersion: 1, platform: "darwin", detectedVersion: engine === "codex" ? "0.9.0" : "1.2.3", capability, verification: "disk-only", reason: capability === "read-write" ? null : "test", supportedVersionRange: "test", versionStatus: "supported" }])) as SkillScanOptions["adapterStatus"];
function fixture(platform = "darwin", capability: SkillAdapterStatus["capability"] = "read-write") { const home = mkdtempSync(join(tmpdir(), "ownward-skill-control-")); temps.push(home); return { home, storeRoot: join(home, ".ownward", "skills"), platform, adapterStatus: statuses(capability) } satisfies SkillScanOptions; }
function skill(path: string, name: string, body = "body") { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: safe metadata\n---\n${body}\n`); }
const request = (path: string, value?: unknown, headers: Record<string,string> = {}) => new Request(`http://local${path}`, { method: value === undefined ? "GET" : "POST", ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { "content-type": "application/json", ...headers } }) });
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

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
    let agentPrompt = ""; const service = new SkillInventoryService(options, { analysisInvoke: async (prompt) => { agentPrompt = prompt; return { proposalVersion: 1, actions: [], notes: [] }; } }), inventory = await service.scan(), proposal = await service.analysis(inventory.revision), serialized = JSON.stringify({ inventory, proposal });
    expect(serialized).not.toContain(options.home); expect(serialized).not.toContain("DO_NOT_DISCLOSE_BODY_TOKEN"); expect(agentPrompt).not.toContain(options.home); expect(agentPrompt).not.toContain("DO_NOT_DISCLOSE_BODY_TOKEN"); expect(agentPrompt).not.toContain("sk-supersecret123456"); expect(agentPrompt).toContain("rootAlias"); expect(agentPrompt).not.toContain("pathAlias"); expect(inventory.catalog[0].name).toBe("secret-skill"); expect(proposal.source).toBe("agent-metadata");
  });

  test("invalid agent proposal falls back explicitly and cannot smuggle unknown observation ids", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 1, actions: [{ kind: "delete", observationId: "not-current" }], notes: [] }) }), inventory = await service.scan(), proposal = await service.analysis(inventory.revision);
    expect(proposal.source).toBe("deterministic-fallback"); expect(proposal.notes[0].code).toBe("AGENT_ANALYSIS_FALLBACK"); expect(proposal.actions).toEqual([]);
  });

  test("conflict text is per-item opt-in, bounded and redacted before agent analysis", async () => {
    const options = fixture(), one = join(options.home, ".claude", "skills", "conflict"), two = join(options.home, ".codebuddy", "skills", "conflict");
    skill(one, "conflict", `password=hunter2\npath=${options.home}\nversion one`); skill(two, "conflict", "version two");
    let prompt = ""; const service = new SkillInventoryService(options, { analysisInvoke: async (value) => { prompt = value; return { proposalVersion: 1, actions: [], notes: [] }; } });
    const inventory = await service.scan(), id = inventory.observations.find((item) => item.engine === "claude")!.id;
    const preview = service.contentPreview(inventory.revision, [id]); expect(preview[0].files.length).toBeGreaterThan(0); expect(preview[0].files[0].text).toBeUndefined();
    await service.analysis(inventory.revision, [id]); expect(prompt).toContain("explicitlyApprovedConflictText"); expect(prompt).not.toContain("hunter2"); expect(prompt).not.toContain(options.home);
  });

  test("conflict content consent is interactive, session-bound and one-use", async () => {
    const options = fixture(), one = join(options.home, ".claude", "skills", "consent"), two = join(options.home, ".codebuddy", "skills", "consent"); skill(one, "consent", "one"); skill(two, "consent", "two");
    const service = new SkillInventoryService(options, { analysisInvoke: async () => ({ proposalVersion: 1, actions: [], notes: [] }) }), inventory = await service.scan(), ids = inventory.observations.filter((item) => item.name === "consent").map((item) => item.id), approvals = new ApprovalStore(), session = "browser-content-session";
    const previewUrl = new URL("http://local/api/skills/analysis/preview"), payload = { expectedRevision: inventory.revision, contentObservationIds: ids };
    const denied = await routeSkills(request(previewUrl.pathname, payload), previewUrl, service); expect(denied?.status).toBe(403);
    const context = { browserSession: { id: session, interactive: true }, confirmUserPresence: async () => true, approvals };
    const preview = await routeSkills(request(previewUrl.pathname, payload), previewUrl, service, context), previewBody = await preview!.json() as any; expect(previewBody.consentId).toBeString();
    const analyzeUrl = new URL("http://local/api/skills/analysis"), analyzePayload = { ...payload, consentId: previewBody.consentId };
    expect((await routeSkills(request(analyzeUrl.pathname, analyzePayload), analyzeUrl, service, context))?.status).toBe(200);
    expect((await routeSkills(request(analyzeUrl.pathname, analyzePayload), analyzeUrl, service, context))?.status).toBe(409);
  });

  test("rejects partial, protected, unknown-capability and non-darwin mutation plans", async () => {
    const partial = fixture(); skill(join(partial.home, ".claude", "skills", "large"), "large", "x".repeat(100)); const partialService = new SkillInventoryService({ ...partial, limits: { maxBytesPerSkill: 8 } }), partialInventory = await partialService.scan();
    expect(() => partialService.plan({ expectedRevision: partialInventory.revision, actions: [{ kind: "delete", observationId: partialInventory.observations[0].id }] })).toThrow("扫描不完整");
    const protectedOptions = fixture(); skill(join(protectedOptions.home, ".codex", "skills", ".system", "builtin"), "builtin"); const protectedService = new SkillInventoryService(protectedOptions), protectedInventory = await protectedService.scan();
    expect(() => protectedService.plan({ expectedRevision: protectedInventory.revision, actions: [{ kind: "delete", observationId: protectedInventory.observations[0].id }] })).toThrow("受保护");
    const unknown = fixture("darwin", "unknown"); skill(join(unknown.home, ".claude", "skills", "demo"), "demo"); const unknownService = new SkillInventoryService(unknown), unknownInventory = await unknownService.scan();
    expect(() => unknownService.plan({ expectedRevision: unknownInventory.revision, actions: [{ kind: "delete", observationId: unknownInventory.observations[0].id }] })).toThrow("拒绝写操作");
    const linux = fixture("linux"); skill(join(linux.home, ".claude", "skills", "demo"), "demo"); const linuxService = new SkillInventoryService(linux), linuxInventory = await linuxService.scan();
    expect(() => linuxService.plan({ expectedRevision: linuxInventory.revision, actions: [{ kind: "delete", observationId: linuxInventory.observations[0].id }] })).toThrow("仅支持 macOS");
  });

  test("adopt is approval-bound, journaled, idempotent, and conditionally rollbackable", async () => {
    const options = fixture(), claude = join(options.home, ".claude", "skills", "shared"), codex = join(options.home, ".agents", "skills", "shared"); skill(claude, "shared"); skill(codex, "shared");
    const service = new SkillInventoryService(options), inventory = await service.scan(), ids = inventory.observations.filter((x) => x.name === "shared").map((x) => x.id), plan = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "adopt", observationIds: ids }] });
    expect(plan.effects.some((x) => x.kind === "replace-with-link" && x.destructive)).toBeTrue();
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey: "adopt-without-approval" })).rejects.toThrow("需要人工审批");
    const session = "browser-session-123456789", approval = service.mintApproval(plan.id, plan.digest, session), idempotencyKey = "adopt-shared-12345";
    const tx = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey, approval: { ...approval, browserSession: session } });
    expect(tx.phase).toBe("committed"); expect(readlinkSync(claude)).toBe(readlinkSync(codex)); const managed = readlinkSync(claude); expect(existsSync(join(managed, "SKILL.md"))).toBeTrue();
    const registry = JSON.parse(readFileSync(join(options.storeRoot!, "registry.json"), "utf8")); expect(registry.skills).toHaveLength(1); expect(registry.skills[0].lastVerifiedTransaction).toBe(plan.transactionId); expect(tx.id).toBe(plan.transactionId);
    expect(JSON.stringify(service.publicRegistry())).not.toContain(options.home); const rollbackPreview = service.rollbackPreview(tx.id); expect(rollbackPreview.effects.length).toBeGreaterThan(0); expect(JSON.stringify(rollbackPreview)).not.toContain(options.home);
    const replay = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey, approval: { ...approval, browserSession: session } }); expect(replay.id).toBe(tx.id);
    const fresh = await service.scan(), rollbackApproval = service.mintRollbackApproval(tx.id, fresh.revision, session), rolled = service.rollback({ transactionId: tx.id, expectedRevision: fresh.revision, approval: { id: rollbackApproval.id, nonce: rollbackApproval.nonce, browserSession: session } });
    expect(rolled.phase).toBe("rolled-back"); expect(readFileSync(join(claude, "SKILL.md"), "utf8")).toContain("name: shared"); expect(readFileSync(join(codex, "SKILL.md"), "utf8")).toContain("name: shared");
  });

  test("stale inode and approval replay fail closed before a second mutation", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] }), session = "browser-session-987654321", approval = service.mintApproval(plan.id, plan.digest, session);
    rmSync(entry, { recursive: true }); skill(entry, "demo");
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey: "delete-demo-12345", approval: { ...approval, browserSession: session } })).rejects.toThrow("发生变化");
    // Stale rejection did not consume the approval, but a mismatched browser session must consume/fail it exactly once.
    const refreshed = await service.scan(), next = service.plan({ expectedRevision: refreshed.revision, actions: [{ kind: "delete", observationId: refreshed.observations[0].id }] }), once = service.mintApproval(next.id, next.digest, session);
    await expect(service.apply({ planId: next.id, expectedPlanDigest: next.digest, expectedRevision: refreshed.revision, idempotencyKey: "delete-demo-67890", approval: { ...once, browserSession: "browser-session-wrong000" } })).rejects.toThrow("不匹配");
    await expect(service.apply({ planId: next.id, expectedPlanDigest: next.digest, expectedRevision: refreshed.revision, idempotencyKey: "delete-demo-67890", approval: { ...once, browserSession: session } })).rejects.toThrow("已使用");
    expect(existsSync(entry)).toBeTrue();
  });

  test("repair, migrate and delete share the approved deterministic effect executor", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-session-effects12"; skill(entry, "demo"); const service = new SkillInventoryService(options); let inventory = await service.scan();
    const run = async (actions: any[], key: string) => { const plan = service.plan({ expectedRevision: inventory.revision, actions }), minted = plan.requiresApproval ? service.mintApproval(plan.id, plan.digest, session) : null, tx = await service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey: key, ...(minted ? { approval: { ...minted, browserSession: session } } : {}) }); expect(tx.phase).toBe("committed"); inventory = await service.scan(); return plan; };
    await run([{ kind: "adopt", observationIds: [inventory.observations[0].id] }], "effects-adopt-1234"); const record = service.registry().skills[0], managed = record.managedPath;
    rmSync(entry); inventory = await service.scan(); const repair = await run([{ kind: "repair", skillId: record.id, engine: "claude", scope: "user" }], "effects-repair-123"); expect(repair.requiresApproval).toBeFalse(); expect(readlinkSync(entry)).toBe(managed);
    await run([{ kind: "migrate", skillId: record.id, engine: "codebuddy", scope: "user" }], "effects-migrate-123"); const codebuddy = join(options.home, ".codebuddy", "skills", "demo"); expect(readlinkSync(codebuddy)).toBe(managed);
    const deployed = inventory.observations.find((x) => x.entryPath === "~/.codebuddy/skills/demo")!; await run([{ kind: "delete", observationId: deployed.id }], "effects-delete-1234"); expect(existsSync(codebuddy)).toBeFalse(); expect(existsSync(entry)).toBeTrue();
  });

  test("persisted plans are reloaded and bound by expected digest", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-plan-digest-123"; skill(entry, "demo"); const service = new SkillInventoryService(options), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] });
    expect(() => service.mintApproval(plan.id, "0".repeat(64), session)).toThrow("摘要不匹配");
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: "0".repeat(64), expectedRevision: inventory.revision, idempotencyKey: "digest-mismatch-apply" })).rejects.toThrow("摘要不匹配");
    const file = join(options.storeRoot!, "plans", `${plan.id}.json`), raw = JSON.parse(readFileSync(file, "utf8")); raw.effects[0].mode = 0o777; writeFileSync(file, JSON.stringify(raw));
    expect(() => service.mintApproval(plan.id, plan.digest, session)).toThrow("验签失败"); expect(existsSync(entry)).toBeTrue();
  });

  test("Codex unknown precedence needs explicit target root and migrate source must belong to record", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), rogue = join(options.home, ".codebuddy", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options); let inventory = await service.scan(), adopt = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "adopt", observationIds: [inventory.observations[0].id] }] }), session = "browser-codex-root-123", approval = service.mintApproval(adopt.id, adopt.digest, session); await service.apply({ planId: adopt.id, expectedPlanDigest: adopt.digest, expectedRevision: inventory.revision, idempotencyKey: "codex-root-adopt", approval: { ...approval, browserSession: session } });
    inventory = await service.scan(); const record = service.registry().skills[0]; expect(() => service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "migrate", skillId: record.id, engine: "codex", scope: "user" }] })).toThrow("显式选择");
    const codexRoot = inventory.roots.find((x) => x.engine === "codex" && x.scope === "user" && x.path === "~/.agents/skills")!; expect(codexRoot.mutationCapability).toBe("explicit-only"); const explicit = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "migrate", skillId: record.id, engine: "codex", scope: "user", targetRootId: codexRoot.id }] }); expect(explicit.effects.some((x) => x.path === "~/.agents/skills/demo")).toBeTrue();
    skill(rogue, "demo"); inventory = await service.scan(); const rogueObservation = inventory.observations.find((x) => x.entryPath === "~/.codebuddy/skills/demo")!; expect(() => service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "migrate", skillId: record.id, engine: "codex", scope: "user", targetRootId: codexRoot.id, removeSource: true, fromObservationId: rogueObservation.id }] })).toThrow("不属于");
  });

  test("project target root uses separator-aware containment", async () => {
    const options = fixture(), app = join(options.home, "workspace", "app"), app2 = join(options.home, "workspace", "app2"), source = join(options.home, ".claude", "skills", "projected"); mkdirSync(app, { recursive: true }); mkdirSync(app2, { recursive: true }); skill(source, "projected");
    const service = new SkillInventoryService({ ...options, projectRoots: [app, app2] }), inventory = await service.scan(), adopt = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "adopt", observationIds: [inventory.observations.find((item) => item.name === "projected")!.id] }] }), session = "browser-project-boundary", approval = service.mintApproval(adopt.id, adopt.digest, session); await service.apply({ planId: adopt.id, expectedPlanDigest: adopt.digest, expectedRevision: inventory.revision, idempotencyKey: "project-adopt-key", approval: { ...approval, browserSession: session } });
    const fresh = await service.scan(), record = service.registry().skills[0], app2Root = fresh.roots.find((root) => root.engine === "claude" && root.scope === "project" && root.path.includes("app2"))!;
    expect(() => service.plan({ expectedRevision: fresh.revision, actions: [{ kind: "migrate", skillId: record.id, engine: "claude", scope: "project", projectRoot: app, targetRootId: app2Root.id }] })).toThrow("显式选择");
  });

  test("crash after atomic backup rename is recovered from durable subphase", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-crash-rename12"; skill(entry, "demo"); const crash: any = Object.assign(new Error("crash"), { simulateCrash: true, code: "TEST_CRASH" }); const service = new SkillInventoryService(options, { transactionHooks: { beforeEffect: (effect) => { if (effect.kind === "delete-entry") throw crash; } } }), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] }), approval = service.mintApproval(plan.id, plan.digest, session);
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey: "crash-rename-delete", approval: { ...approval, browserSession: session } })).rejects.toThrow("crash"); expect(existsSync(entry)).toBeFalse(); const journal = JSON.parse(readFileSync(join(options.storeRoot!, "transactions", `${plan.transactionId}.json`), "utf8")); expect(journal.effects[0].subphase).toBe("effect-started"); expect(existsSync(journal.effects[0].backupPath)).toBeTrue();
    const recovered = new SkillInventoryService(options); recovered.recover(); expect(existsSync(entry)).toBeTrue(); expect(recovered.transaction(plan.transactionId).phase).toBe("rolled-back");
  });

  test("partial managed staging is removed by startup recovery", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"), session = "browser-crash-copy123"; skill(entry, "demo"); const crash: any = Object.assign(new Error("copy crash"), { simulateCrash: true, code: "TEST_COPY_CRASH" }); const service = new SkillInventoryService(options, { transactionHooks: { duringCopy: (_source, target) => { mkdirSync(target); writeFileSync(join(target, "partial"), "x"); throw crash; } } }), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "adopt", observationIds: [inventory.observations[0].id] }] }), approval = service.mintApproval(plan.id, plan.digest, session);
    await expect(service.apply({ planId: plan.id, expectedPlanDigest: plan.digest, expectedRevision: inventory.revision, idempotencyKey: "crash-partial-copy", approval: { ...approval, browserSession: session } })).rejects.toThrow("copy crash"); const managed = join(options.storeRoot!, "managed", service.registry().skills[0]?.id || "missing"); expect(existsSync(entry)).toBeTrue();
    const recovered = new SkillInventoryService(options); recovered.recover(); expect(recovered.transaction(plan.transactionId).phase).toBe("rolled-back"); expect(existsSync(join(options.storeRoot!, "managed"))).toBeFalse(); expect(existsSync(managed)).toBeFalse();
  });

  test("spoofed client headers cannot mint approval; only server-injected browser context can", async () => {
    const options = fixture(), entry = join(options.home, ".claude", "skills", "demo"); skill(entry, "demo"); const service = new SkillInventoryService(options), inventory = await service.scan(), plan = service.plan({ expectedRevision: inventory.revision, actions: [{ kind: "delete", observationId: inventory.observations[0].id }] }), session = "browser-session-route1234";
    const spoofed = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest, browserSession: session }, { "x-ownward-interactive-session": session, "x-ownward-human-confirmation": "approve" }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service); expect(spoofed?.status).toBe(403);
    const nonInteractive = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service, { browserSession: { id: session, interactive: false }, confirmUserPresence: async () => true }); expect(nonInteractive?.status).toBe(403);
    const absent = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service, { browserSession: { id: session, interactive: true }, confirmUserPresence: async () => false }); expect(absent?.status).toBe(403);
    const allowed = await routeSkills(request(`/api/skills/plans/${plan.id}/approval`, { expectedPlanDigest: plan.digest }), new URL(`http://local/api/skills/plans/${plan.id}/approval`), service, { browserSession: { id: session, interactive: true }, confirmUserPresence: async (id) => id === session }); expect(allowed?.status).toBe(201);
  });
});
