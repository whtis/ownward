import { lstatSync, readFileSync, readdirSync } from "fs";
import { extname, join, relative, resolve } from "path";
import type { PublicSkillTransaction, SkillAnalysisProposal, SkillInventory, SkillPlan, SkillProposalAction, SkillScanOptions } from "./contracts.ts";
import { analyzeSkillMetadata, analyzeSkillMetadataWithAgent, redactSkillMetadataText, type SkillAnalysisInvoke } from "./analysis.ts";
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
  /** 正在进行的 Agent 分析（null = 没在跑）。UI 每秒轮询，没有它用户只能盯着灰按钮猜。 */
  private analysisProgress: import("./contracts.ts").SkillAnalysisProgress | null = null;
  analysisStatus(): { running: boolean; progress: import("./contracts.ts").SkillAnalysisProgress | null; elapsedMs: number } { const p = this.analysisProgress; return { running: !!p, progress: p, elapsedMs: p ? Date.now() - Date.parse(p.startedAt) : 0 }; }
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
  /** 冲突两侧的逐文件差异，给本机用户在浏览器里看自己的文件、决定以哪一版为准。
   *  只允许明确冲突项、恰好两个；正文经 conflictContent 同一套裁剪与脱敏。 */
  conflictDiff(expectedRevision: string, ids: unknown) {
    const snapshot = this.raw(); if (expectedRevision !== snapshot.inventory.mutableRevision) fail("SKILL_INVENTORY_STALE", "Skill inventory 已变化");
    if (!Array.isArray(ids) || ids.length !== 2) fail("SKILL_CONTENT_OPT_IN_INVALID", "差异比较需要恰好两个冲突项");
    const [a, b] = conflictContent(snapshot, ids, true, this.options.home);
    const byPath = (side: typeof a) => new Map(side.files.map((f) => [f.pathAlias, f.text ?? ""]));
    const left = byPath(a), right = byPath(b), paths = [...new Set([...left.keys(), ...right.keys()])].sort();
    const files = paths.map((path) => {
      const l = left.get(path), r = right.get(path);
      if (l === undefined) return { path, status: "only-right" as const };
      if (r === undefined) return { path, status: "only-left" as const };
      if (l === r) return { path, status: "same" as const };
      // 最小行级差异：只列两边不同的行（限 40 行），够看清「只是路径不同」这类情况
      const ll = l.split("\n"), rl = r.split("\n"), lines: Array<{ n: number; left?: string; right?: string }> = [];
      for (let i = 0; i < Math.max(ll.length, rl.length) && lines.length < 40; i++) if (ll[i] !== rl[i]) lines.push({ n: i + 1, left: ll[i], right: rl[i] });
      return { path, status: "different" as const, lines, truncated: lines.length >= 40 };
    });
    return { left: { observationId: a.observationId, bytes: a.bytes, files: a.files.length }, right: { observationId: b.observationId, bytes: b.bytes, files: b.files.length }, files };
  }
  contentPreview(expectedRevision: string, ids: unknown) { const snapshot = this.raw(); if (expectedRevision !== snapshot.inventory.mutableRevision) fail("SKILL_INVENTORY_STALE", "Skill inventory 已变化"); return conflictContent(snapshot, ids, false, this.options.home); }
  async analysis(expectedRevision?: string, contentObservationIds?: unknown, mode: "rules" | "agent" = "rules"): Promise<SkillAnalysisProposal> { const snapshot = this.raw(), inventory = snapshot.inventory; if (expectedRevision && expectedRevision !== inventory.mutableRevision) fail("SKILL_INVENTORY_STALE", "Skill inventory 已变化");
    // 默认走确定性规则，不经过模型。Agent 只在用户显式选择时才用——它是唯一会提出错误建议的来源
    // （2026-09-02：把 6 个不同 Skill 打成一组、对技能包提 delete），而这台机器上可去重的组本就为 0。
    if (mode !== "agent") return analyzeSkillMetadata(inventory);
    const approved = conflictContent(snapshot, contentObservationIds, true, this.options.home).map((item) => ({ observationId: item.observationId, files: item.files.map(({ pathAlias, text }) => ({ pathAlias, text: text || "" })) })); if (this.analysisProgress) fail("SKILL_ANALYSIS_BUSY", "上一次 Agent 分析还在进行中"); try { return await analyzeSkillMetadataWithAgent(inventory, this.analysisInvoke, approved, (progress) => { this.analysisProgress = progress; }); } finally { this.analysisProgress = null; } }
  private planFile(id: string) { return join(this.options.storeRoot!, "plans", `${id}.json`); }
  private persistPlan(plan: InternalSkillPlan) { atomicWrite(this.planFile(plan.public.id), JSON.stringify(plan, null, 2) + "\n"); }
  private internalPlan(id: string): InternalSkillPlan { if (!/^[0-9a-f-]{36}$/i.test(id)) fail("SKILL_PLAN_NOT_FOUND", "Skill 计划不存在"); let plan: InternalSkillPlan; try { plan = JSON.parse(readFileSync(this.planFile(id), "utf8")); } catch { return fail("SKILL_PLAN_NOT_FOUND", "Skill 计划不存在或不可读取"); } if (plan.public?.id !== id || !/^[0-9a-f-]{36}$/i.test(plan.public?.transactionId || "") || !Array.isArray(plan.effects) || plan.effects.some((x, index) => x.index !== index) || computeSkillPlanDigest(plan) !== plan.public.digest || plan.registryAfter?.revision !== plan.public.registryRevision) fail("SKILL_PLAN_INVALID", "Skill 计划验签失败"); if (Date.parse(plan.public.expiresAt) <= Date.now()) fail("SKILL_PLAN_EXPIRED", "Skill 计划已过期，请重新扫描"); return plan; }
  plan(input: { expectedRevision: string; actions: unknown }): SkillPlan { const plan = buildSkillPlan(this.options, this.raw(), validateActions(input.actions), input.expectedRevision); this.persistPlan(plan); return plan.public; }
  mintApproval(planId: string, expectedPlanDigest: string, browserSession: string) { const plan = this.internalPlan(planId); if (plan.public.digest !== expectedPlanDigest) fail("SKILL_PLAN_DIGEST_MISMATCH", "计划摘要不匹配"); return mintSkillApproval(this.options.storeRoot!, { planId, planDigest: plan.public.digest, inventoryRevision: plan.public.inventoryRevision, browserSession }); }
  async apply(input: { planId: string; expectedPlanDigest: string; expectedRevision: string; idempotencyKey: string; approval?: { id: string; nonce: string; browserSession: string } }): Promise<PublicSkillTransaction> {
    const plan = this.internalPlan(input.planId); if (plan.public.digest !== input.expectedPlanDigest) fail("SKILL_PLAN_DIGEST_MISMATCH", "计划摘要不匹配"); if (plan.public.inventoryRevision !== input.expectedRevision) fail("SKILL_INVENTORY_STALE", "计划 revision 与请求不一致");
    return this.executor.apply(plan, input.idempotencyKey, () => { const next = scanSkillsRaw(this.options); this.snapshot = next; return next; }, () => { const fresh = scanSkillsRaw(this.options);
      // 只比可写根：只读根（~/.codex/skills/.system、plugins/cache）由 codex 自己维护，每启动
      // 一次就重刷一遍，而 planner 拒绝把只读根当写入目标——拿全量 revision 当门，等于让无关工具
      // 的日常动作否决用户刚点下的批准（2026-09-01 实撞：51/323 个观测在只读根里，批准直接被拒，
      // 而当时可写根一处没动，计划完全有效）。
      if (fresh.inventory.mutableRevision !== plan.mutableRevision || fresh.inventory.completeness !== "complete") fail("SKILL_INVENTORY_STALE", "文件系统在审批后发生变化"); this.snapshot = fresh; if (plan.public.requiresApproval) { if (!input.approval) fail("SKILL_APPROVAL_REQUIRED", "此 Skill 计划需要人工审批"); consumeSkillApproval(this.options.storeRoot!, { ...input.approval, planId: plan.public.id, planDigest: plan.public.digest, inventoryRevision: plan.public.inventoryRevision }); } });
  }
  transaction(id: string) { return this.executor.get(id); }
  transactions() { return this.executor.list(); }
  rollbackPreview(id: string) { return this.executor.rollbackPreview(id); }
  mintRollbackApproval(transactionId: string, expectedRevision: string, browserSession: string) { const tx = this.executor.get(transactionId), planId = `rollback:${transactionId}`, digest = `rollback:${transactionId}:${tx.updatedAt}:${expectedRevision}`; return { ...mintSkillApproval(this.options.storeRoot!, { planId, planDigest: digest, inventoryRevision: expectedRevision, browserSession }), planId, digest }; }
  rollback(input: { transactionId: string; expectedRevision: string; approval: { id: string; nonce: string; browserSession: string } }): PublicSkillTransaction { const current = this.raw();
    // 必须比 mutableRevision 而不是 revision：revision 覆盖只读根，codex 每次运行都重写
    // ~/.codex/skills/.system/** 里的 88 个文件，实测几分钟内变了两次；拿它当门，恢复这条路
    // 结构上就走不通（2026-09-03：用户点了恢复、原生弹窗也过了，审批铸出却永远消费不掉）。
    // 与 apply 的审批门口径一致：只有可写根变了才该拦。
    if (current.inventory.mutableRevision !== input.expectedRevision) fail("SKILL_INVENTORY_STALE", "回滚前 inventory 已变化"); const tx = this.executor.get(input.transactionId), planId = `rollback:${input.transactionId}`, digest = `rollback:${input.transactionId}:${tx.updatedAt}:${input.expectedRevision}`; consumeSkillApproval(this.options.storeRoot!, { ...input.approval, planId, planDigest: digest, inventoryRevision: input.expectedRevision }); const result = this.executor.rollbackCommitted(input.transactionId); this.snapshot = scanSkillsRaw(this.options); return result; }
  recover(): void { this.executor.recover(() => { const next = scanSkillsRaw(this.options); this.snapshot = next; return next; }); }
}
