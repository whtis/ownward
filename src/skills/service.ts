import { lstatSync, readFileSync, readdirSync } from "fs";
import { extname, join, relative, resolve } from "path";
import type { PublicSkillTransaction, SkillAnalysisProposal, SkillInventory, SkillPlan, SkillProposalAction, SkillScanOptions } from "./contracts.ts";
import { analyzeSkillMetadataWithAgent, redactSkillMetadataText, type SkillAnalysisInvoke } from "./analysis.ts";
import { consumeSkillApproval, mintSkillApproval } from "./approval.ts";
import { atomicWrite } from "./filesystem.ts";
import type { InternalSkillPlan, RawSkillSnapshot } from "./internal.ts";
import { buildSkillPlan, computeSkillPlanDigest } from "./planner.ts";
import { readRegistry } from "./registry.ts";
import { redactHome, scanSkillsRaw } from "./scanner.ts";
import { SkillTransactionExecutor, type SkillTransactionHooks } from "./transaction.ts";
import { scanSkillsAsync } from "./scan-async.ts";

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const CONTENT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]), CONTENT_FILES = 20, CONTENT_BYTES = 128 * 1024;
function conflictContent(snapshot: RawSkillSnapshot, ids: unknown, includeText: boolean, home: string) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => typeof id !== "string")) fail("SKILL_CONTENT_OPT_IN_INVALID", "冲突内容授权列表无效");
  return (ids as string[]).map((id) => {
    const observation = snapshot.observations.find((item) => item.id === id) || fail("SKILL_OBSERVATION_UNKNOWN", "冲突观察不存在");
    if (!observation.findings.includes("conflict") || !observation.rawRealPath) fail("SKILL_CONTENT_OPT_IN_CONFLICT_ONLY", "只有明确冲突项可以授权正文比较");
    const files: Array<{ pathAlias: string; text?: string; bytes: number }> = []; let bytes = 0, excluded = 0;
    const walk = (path: string) => {
      if (files.length >= CONTENT_FILES || bytes >= CONTENT_BYTES) return;
      const stat = lstatSync(path); if (stat.isSymbolicLink()) { excluded++; return; }
      if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) { if (name === "scripts" || name === "assets" || name.startsWith(".")) { excluded++; continue; } walk(join(path, name)); } return; }
      if (!stat.isFile() || !CONTENT_EXTENSIONS.has(extname(path).toLowerCase())) { excluded++; return; }
      const remaining = CONTENT_BYTES - bytes, raw = readFileSync(path); if (!remaining) return; const chunk = raw.subarray(0, remaining), text = redactSkillMetadataText(chunk.toString("utf8").replaceAll(resolve(home), "~")) || ""; bytes += chunk.length; files.push({ pathAlias: relative(observation.rawRealPath!, path) || "SKILL.md", ...(includeText ? { text } : {}), bytes: chunk.length });
    };
    walk(observation.rawRealPath);
    return { observationId: id, files, bytes, excluded, truncated: files.length >= CONTENT_FILES || bytes >= CONTENT_BYTES };
  });
}
const allowedActionKeys: Record<string, Set<string>> = { adopt: new Set(["kind", "observationIds", "expose"]), repair: new Set(["kind", "skillId", "engine", "scope", "projectRoot", "targetRootId"]), migrate: new Set(["kind", "skillId", "fromObservationId", "engine", "scope", "projectRoot", "targetRootId", "removeSource"]), delete: new Set(["kind", "observationId"]) };
function validateActions(value: unknown): SkillProposalAction[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) return fail("SKILL_PROPOSAL_INVALID", "Skill proposal actions 无效");
  for (const raw of value as any[]) {
    if (!raw || typeof raw !== "object" || typeof raw.kind !== "string" || !allowedActionKeys[raw.kind] || Object.keys(raw).some((key) => !allowedActionKeys[raw.kind].has(key))) fail("SKILL_PROPOSAL_INVALID", "Skill proposal 包含未知字段或动作");
    if (raw.kind === "adopt" && (!Array.isArray(raw.observationIds) || raw.observationIds.some((x: unknown) => typeof x !== "string"))) fail("SKILL_PROPOSAL_INVALID", "adopt observationIds 无效");
    if (raw.kind === "adopt" && raw.expose !== undefined && (!Array.isArray(raw.expose) || raw.expose.some((x: any) => !x || !["claude", "codex", "codebuddy"].includes(x.engine) || !["user", "project"].includes(x.scope) || (x.projectRoot !== undefined && typeof x.projectRoot !== "string") || (x.targetRootId !== undefined && typeof x.targetRootId !== "string") || Object.keys(x).some((key) => !["engine", "scope", "projectRoot", "targetRootId"].includes(key))))) fail("SKILL_PROPOSAL_INVALID", "adopt expose 无效");
    if (raw.kind === "delete" && typeof raw.observationId !== "string") fail("SKILL_PROPOSAL_INVALID", "delete observationId 无效");
    if ((raw.kind === "repair" || raw.kind === "migrate") && (typeof raw.skillId !== "string" || !["claude", "codex", "codebuddy"].includes(raw.engine) || !["user", "project"].includes(raw.scope) || (raw.targetRootId !== undefined && typeof raw.targetRootId !== "string"))) fail("SKILL_PROPOSAL_INVALID", `${raw.kind} 参数无效`);
  }
  return structuredClone(value) as SkillProposalAction[];
}

export class SkillInventoryService {
  private snapshot: RawSkillSnapshot | null = null;
  private scanning: Promise<SkillInventory> | null = null;
  private executor: SkillTransactionExecutor;
  private analysisInvoke?: SkillAnalysisInvoke;
  readonly options: SkillScanOptions;
  constructor(options: SkillScanOptions, deps: { analysisInvoke?: SkillAnalysisInvoke; transactionHooks?: SkillTransactionHooks } = {}) { this.options = { ...options, storeRoot: resolve(options.storeRoot || join(options.home, ".ownward", "skills")) }; this.executor = new SkillTransactionExecutor(this.options, deps.transactionHooks); this.analysisInvoke = deps.analysisInvoke; }
  current() { return this.snapshot?.inventory || null; }
  private raw(): RawSkillSnapshot { return this.snapshot || fail("SKILL_SCAN_REQUIRED", "尚未扫描 skill"); }
  scan(): Promise<SkillInventory> {
    if (this.scanning) return this.scanning;
    this.scanning = scanSkillsAsync(this.options).then((result) => { this.snapshot = result; return result.inventory; }).finally(() => { this.scanning = null; });
    return this.scanning;
  }
  registry() { return readRegistry(this.options.storeRoot!); }
  publicRegistry() { const registry = this.registry(); return { ...registry, skills: registry.skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, digest: skill.digest, lastVerifiedTransaction: skill.lastVerifiedTransaction, sources: skill.sources.map((source) => ({ ...source, path: redactHome(source.path, this.options.home) })), deployments: skill.deployments.map((deployment) => ({ ...deployment, path: redactHome(deployment.path, this.options.home) })) })) }; }
  contentPreview(expectedRevision: string, ids: unknown) { const snapshot = this.raw(); if (expectedRevision !== snapshot.inventory.revision) fail("SKILL_INVENTORY_STALE", "Skill inventory 已变化"); return conflictContent(snapshot, ids, false, this.options.home); }
  async analysis(expectedRevision?: string, contentObservationIds?: unknown): Promise<SkillAnalysisProposal> { const snapshot = this.raw(), inventory = snapshot.inventory; if (expectedRevision && expectedRevision !== inventory.revision) fail("SKILL_INVENTORY_STALE", "Skill inventory 已变化"); const approved = conflictContent(snapshot, contentObservationIds, true, this.options.home).map((item) => ({ observationId: item.observationId, files: item.files.map(({ pathAlias, text }) => ({ pathAlias, text: text || "" })) })); return analyzeSkillMetadataWithAgent(inventory, this.analysisInvoke, approved); }
  private planFile(id: string) { return join(this.options.storeRoot!, "plans", `${id}.json`); }
  private persistPlan(plan: InternalSkillPlan) { atomicWrite(this.planFile(plan.public.id), JSON.stringify(plan, null, 2) + "\n"); }
  private internalPlan(id: string): InternalSkillPlan { if (!/^[0-9a-f-]{36}$/i.test(id)) fail("SKILL_PLAN_NOT_FOUND", "Skill 计划不存在"); let plan: InternalSkillPlan; try { plan = JSON.parse(readFileSync(this.planFile(id), "utf8")); } catch { return fail("SKILL_PLAN_NOT_FOUND", "Skill 计划不存在或不可读取"); } if (plan.public?.id !== id || !/^[0-9a-f-]{36}$/i.test(plan.public?.transactionId || "") || !Array.isArray(plan.effects) || plan.effects.some((x, index) => x.index !== index) || computeSkillPlanDigest(plan) !== plan.public.digest || plan.registryAfter?.revision !== plan.public.registryRevision) fail("SKILL_PLAN_INVALID", "Skill 计划验签失败"); if (Date.parse(plan.public.expiresAt) <= Date.now()) fail("SKILL_PLAN_EXPIRED", "Skill 计划已过期，请重新扫描"); return plan; }
  plan(input: { expectedRevision: string; actions: unknown }): SkillPlan { const plan = buildSkillPlan(this.options, this.raw(), validateActions(input.actions), input.expectedRevision); this.persistPlan(plan); return plan.public; }
  mintApproval(planId: string, expectedPlanDigest: string, browserSession: string) { const plan = this.internalPlan(planId); if (plan.public.digest !== expectedPlanDigest) fail("SKILL_PLAN_DIGEST_MISMATCH", "计划摘要不匹配"); return mintSkillApproval(this.options.storeRoot!, { planId, planDigest: plan.public.digest, inventoryRevision: plan.public.inventoryRevision, browserSession }); }
  async apply(input: { planId: string; expectedPlanDigest: string; expectedRevision: string; idempotencyKey: string; approval?: { id: string; nonce: string; browserSession: string } }): Promise<PublicSkillTransaction> {
    const plan = this.internalPlan(input.planId); if (plan.public.digest !== input.expectedPlanDigest) fail("SKILL_PLAN_DIGEST_MISMATCH", "计划摘要不匹配"); if (plan.public.inventoryRevision !== input.expectedRevision) fail("SKILL_INVENTORY_STALE", "计划 revision 与请求不一致");
    return this.executor.apply(plan, input.idempotencyKey, () => { const next = scanSkillsRaw(this.options); this.snapshot = next; return next; }, () => { const fresh = scanSkillsRaw(this.options); if (fresh.inventory.revision !== plan.public.inventoryRevision || fresh.inventory.completeness !== "complete") fail("SKILL_INVENTORY_STALE", "文件系统在审批后发生变化"); this.snapshot = fresh; if (plan.public.requiresApproval) { if (!input.approval) fail("SKILL_APPROVAL_REQUIRED", "此 Skill 计划需要人工审批"); consumeSkillApproval(this.options.storeRoot!, { ...input.approval, planId: plan.public.id, planDigest: plan.public.digest, inventoryRevision: plan.public.inventoryRevision }); } });
  }
  transaction(id: string) { return this.executor.get(id); }
  transactions() { return this.executor.list(); }
  rollbackPreview(id: string) { return this.executor.rollbackPreview(id); }
  mintRollbackApproval(transactionId: string, expectedRevision: string, browserSession: string) { const tx = this.executor.get(transactionId), planId = `rollback:${transactionId}`, digest = `rollback:${transactionId}:${tx.updatedAt}:${expectedRevision}`; return { ...mintSkillApproval(this.options.storeRoot!, { planId, planDigest: digest, inventoryRevision: expectedRevision, browserSession }), planId, digest }; }
  rollback(input: { transactionId: string; expectedRevision: string; approval: { id: string; nonce: string; browserSession: string } }): PublicSkillTransaction { const current = this.raw(); if (current.inventory.revision !== input.expectedRevision) fail("SKILL_INVENTORY_STALE", "回滚前 inventory 已变化"); const tx = this.executor.get(input.transactionId), planId = `rollback:${input.transactionId}`, digest = `rollback:${input.transactionId}:${tx.updatedAt}:${input.expectedRevision}`; consumeSkillApproval(this.options.storeRoot!, { ...input.approval, planId, planDigest: digest, inventoryRevision: input.expectedRevision }); const result = this.executor.rollbackCommitted(input.transactionId); this.snapshot = scanSkillsRaw(this.options); return result; }
  recover(): void { this.executor.recover(() => { const next = scanSkillsRaw(this.options); this.snapshot = next; return next; }); }
}
