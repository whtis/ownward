import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import type { PublicSkillEffect, SkillAdapterStatus, SkillEngine, SkillPlan, SkillProposalAction, SkillScanOptions } from "./contracts.ts";
import { redactHome } from "./scanner.ts";
import { snapshotPath } from "./filesystem.ts";
import type { InternalSkillEffect, InternalSkillPlan, RawSkillObservation, RawSkillSnapshot } from "./internal.ts";
import { normalizeRegistry, readRegistry, registryPath, type ManagedSkillRecord, type SkillRegistry } from "./registry.ts";
import { isWithin } from "../path-within.ts";

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : fail("SKILL_NAME_INVALID", "Skill 名称不能安全映射为目录");
const statusFor = (snapshot: RawSkillSnapshot, engine: SkillEngine): SkillAdapterStatus => snapshot.inventory.adapters.find((x) => x.engine === engine) || fail("SKILL_CAPABILITY_UNKNOWN", "引擎能力未知");
function requireWritable(snapshot: RawSkillSnapshot, engine: SkillEngine) { const status = statusFor(snapshot, engine); if (status.capability !== "read-write") fail("SKILL_ENGINE_READ_ONLY", `${engine} 当前为 ${status.capability}，拒绝写操作`); }
function observation(snapshot: RawSkillSnapshot, id: string): RawSkillObservation { return snapshot.observations.find((x) => x.id === id) || fail("SKILL_OBSERVATION_UNKNOWN", "Skill 观察记录不存在"); }
function requireMutable(item: RawSkillObservation) {
  if (item.ownership === "protected" || item.scope === "plugin" || item.scope === "system") fail("SKILL_PROTECTED", "受保护 Skill 不允许修改");
  if (["bounded", "unreadable", "malformed"].includes(item.state)) fail("SKILL_OBSERVATION_INCOMPLETE", "Skill 观察不完整，拒绝修改");
}
function deploymentRoot(options: SkillScanOptions, snapshot: RawSkillSnapshot, engine: SkillEngine, scope: "user" | "project", projectRoot?: string, targetRootId?: string): string {
  requireWritable(snapshot, engine);
  if (scope === "project") {
    const canonical = resolve(projectRoot || "");
    if (!(options.projectRoots || []).map((path) => resolve(path)).includes(canonical)) fail("SKILL_PROJECT_NOT_ALLOWED", "项目未注册为可写 Skill 目标");
    const candidates = snapshot.roots.filter((x) => x.engine === engine && x.scope === "project" && isWithin(canonical, x.path));
    const selected = targetRootId ? candidates.find((x) => x.id === targetRootId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected || selected.mutationCapability === "read-only" || (selected.mutationCapability === "explicit-only" && !targetRootId)) fail("SKILL_ROOT_UNKNOWN", "项目 Skill 根不在可写兼容矩阵中或未显式选择"); return selected.path;
  }
  const roots = snapshot.roots.filter((x) => x.engine === engine && x.scope === "user" && !x.protected);
  const selected = targetRootId ? roots.find((x) => x.id === targetRootId) : roots.length === 1 && roots[0].mutationCapability === "read-write" ? roots[0] : undefined;
  if (!selected || selected.mutationCapability === "read-only" || (selected.mutationCapability === "explicit-only" && !targetRootId)) fail("SKILL_ROOT_EXPLICIT_REQUIRED", "该引擎存在多个或优先级未知的 Skill 根，必须显式选择 targetRootId"); return selected.path;
}
function effect(kind: InternalSkillEffect["kind"], path: string, summary: string, destructive: boolean, extra: Partial<InternalSkillEffect> = {}): InternalSkillEffect { return { index: -1, kind, path, destructive, summary, precondition: snapshotPath(path), ...extra }; }
function addMkdirs(effects: InternalSkillEffect[], paths: string[], boundary: string) { for (const path of paths) { const missing: string[] = []; let cursor = resolve(path), stop = resolve(boundary); while (cursor !== stop && !existsSync(cursor)) { missing.push(cursor); const parent = resolve(cursor, ".."); if (parent === cursor) fail("SKILL_ROOT_UNKNOWN", "无法确定 Skill 目录边界"); cursor = parent; } if (cursor !== stop && !existsSync(cursor)) fail("SKILL_ROOT_UNKNOWN", "Skill 目录超出允许边界"); for (const item of missing.reverse()) if (!effects.some((x) => x.kind === "mkdir" && x.path === item)) effects.push(effect("mkdir", item, `创建 ${basename(item)} 目录`, false)); } }
function publicEffect(item: InternalSkillEffect, home: string): PublicSkillEffect { return { index: item.index, kind: item.kind, path: redactHome(item.path, home), ...(item.source ? { source: redactHome(item.source, home) } : {}), ...(item.target ? { target: redactHome(item.target, home) } : {}), destructive: item.destructive, summary: item.summary }; }

export function buildSkillPlan(options: SkillScanOptions, snapshot: RawSkillSnapshot, actions: SkillProposalAction[], expectedRevision: string): InternalSkillPlan {
  if ((options.platform || process.platform) !== "darwin") fail("SKILL_MUTATION_PLATFORM_UNSUPPORTED", "Skill 写操作 v1 仅支持 macOS");
  if (snapshot.inventory.completeness !== "complete") fail("SKILL_INVENTORY_PARTIAL", "扫描不完整，拒绝生成写计划");
  if (snapshot.inventory.revision !== expectedRevision) fail("SKILL_INVENTORY_STALE", "Skill inventory 已变化");
  if (!Array.isArray(actions) || actions.length === 0) fail("SKILL_PLAN_EMPTY", "整理方案没有操作");
  const storeRoot = resolve(options.storeRoot || join(options.home, ".ownward", "skills")), managedRoot = join(storeRoot, "managed");
  let registry: SkillRegistry = structuredClone(readRegistry(storeRoot)); const effects: InternalSkillEffect[] = [], transactionId = randomUUID();
  for (const action of actions) {
    if (action.kind === "adopt") {
      // `plans/` persistence creates the private store root before apply. Never put
      // the transaction journal's own ancestor in the rollback effect list.
      addMkdirs(effects, [managedRoot], storeRoot);
      if (!action.observationIds.length) fail("SKILL_ACTION_INVALID", "采纳必须选择 Skill");
      const selected = action.observationIds.map((id) => observation(snapshot, id)); selected.forEach((item) => { requireMutable(item); requireWritable(snapshot, item.engine); });
      const digest = selected[0].targetTreeDigest || selected[0].treeDigest; if (!digest || selected.some((item) => (item.targetTreeDigest || item.treeDigest) !== digest)) fail("SKILL_ADOPT_CONFLICT", "只能同时采纳内容完全一致的 Skill");
      const source = selected[0].rawRealPath; if (!source) fail("SKILL_SOURCE_MISSING", "采纳源不可读取");
      const id = randomUUID(), name = safeName(selected[0].name), managedPath = join(managedRoot, id);
      effects.push(effect("copy-tree", managedPath, `复制 ${name} 到 Ownward 受管目录`, false, { source, sourcePrecondition: snapshotPath(source) }));
      const deployments: ManagedSkillRecord["deployments"] = [];
      for (const item of selected) { effects.push(effect("replace-with-link", item.rawEntryPath, `将 ${item.engine}/${item.scope} 的 ${name} 切换为受管链接`, true, { target: managedPath })); deployments.push({ engine: item.engine, scope: item.scope as "user" | "project", path: item.rawEntryPath, desired: true }); }
      for (const exposure of action.expose || []) { const root = deploymentRoot(options, snapshot, exposure.engine, exposure.scope, exposure.projectRoot, exposure.targetRootId), path = join(root, name); addMkdirs(effects, [root], exposure.scope === "project" ? resolve(exposure.projectRoot!) : resolve(options.home)); if (!deployments.some((x) => x.path === path)) { const pre = snapshotPath(path); effects.push(effect(pre.exists ? "replace-with-link" : "create-link", path, `部署 ${name} 到 ${exposure.engine}/${exposure.scope}`, pre.exists, { target: managedPath })); deployments.push({ engine: exposure.engine, scope: exposure.scope, path, desired: true }); } }
      registry.skills.push({ id, name, description: selected[0].description, digest, managedPath, sources: selected.map((item) => ({ engine: item.engine, scope: item.scope, path: item.rawEntryPath, digest })), deployments, lastVerifiedTransaction: transactionId });
    } else if (action.kind === "repair" || action.kind === "migrate") {
      const record = registry.skills.find((x) => x.id === action.skillId) || fail("SKILL_MANAGED_NOT_FOUND", "受管 Skill 不存在");
      const root = deploymentRoot(options, snapshot, action.engine, action.scope, action.projectRoot, action.targetRootId), path = join(root, safeName(record.name)); addMkdirs(effects, [root], action.scope === "project" ? resolve(action.projectRoot!) : resolve(options.home));
      const current = snapshotPath(path), existing = record.deployments.find((x) => x.path === path);
      if (action.kind === "repair" && !existing) fail("SKILL_REPAIR_NOT_MANAGED", "只能修复已登记的 Ownward 受管部署");
      effects.push(effect(current.exists ? "replace-with-link" : "create-link", path, `${action.kind === "repair" ? "修复" : "迁移"} ${record.name} 到 ${action.engine}/${action.scope}`, current.exists, { target: record.managedPath }));
      if (!existing) record.deployments.push({ engine: action.engine, scope: action.scope, path, desired: true });
      if (action.kind === "migrate" && action.removeSource && action.fromObservationId) { const source = observation(snapshot, action.fromObservationId), sourceDigest = source.targetTreeDigest || source.treeDigest; requireMutable(source); const belongs = record.sources.some((x) => x.path === source.rawEntryPath) || record.deployments.some((x) => x.path === source.rawEntryPath); if (!belongs || source.name !== record.name || sourceDigest !== record.digest) fail("SKILL_MIGRATE_SOURCE_MISMATCH", "迁移源不属于该受管 Skill 或内容已变化"); if (source.rawEntryPath === path) fail("SKILL_ACTION_CONFLICT", "迁移源与目标不能是同一路径"); effects.push(effect("delete-entry", source.rawEntryPath, `删除迁移后的旧部署 ${record.name}`, true)); record.deployments = record.deployments.filter((x) => x.path !== source.rawEntryPath); }
      record.lastVerifiedTransaction = transactionId;
    } else if (action.kind === "delete") {
      const item = observation(snapshot, action.observationId); requireMutable(item); requireWritable(snapshot, item.engine); effects.push(effect("delete-entry", item.rawEntryPath, `删除 ${item.name} 的 ${item.engine}/${item.scope} 部署`, true));
      for (const record of registry.skills) { const before = record.deployments.length; record.deployments = record.deployments.filter((x) => x.path !== item.rawEntryPath); if (record.deployments.length !== before) record.lastVerifiedTransaction = transactionId; }
    } else fail("SKILL_ACTION_INVALID", "未知 Skill 操作");
  }
  const duplicatePath = effects.find((item, index) => item.kind !== "mkdir" && effects.some((other, otherIndex) => otherIndex !== index && other.kind !== "mkdir" && other.path === item.path)); if (duplicatePath) fail("SKILL_ACTION_CONFLICT", `多个 effect 试图修改同一路径 ${basename(duplicatePath.path)}`);
  registry = normalizeRegistry({ ...registry, updatedAt: new Date().toISOString() });
  const registryFile = registryPath(storeRoot); effects.push(effect("write-registry", registryFile, "更新 Skill Registry", false, { content: JSON.stringify(registry, null, 2) + "\n", mode: 0o600 }));
  effects.forEach((item, index) => item.index = index);
  const createdAt = new Date(), id = randomUUID(), publicPlan: SkillPlan = { id, transactionId, version: 1, inventoryRevision: expectedRevision, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(), digest: "", requiresApproval: actions.some((x) => x.kind !== "repair") || effects.some((x) => x.destructive || !["mkdir", "create-link", "write-registry"].includes(x.kind)), effects: effects.map((x) => publicEffect(x, options.home)), registryRevision: registry.revision };
  const plan = { public: publicPlan, effects, registryAfter: registry }; publicPlan.digest = computeSkillPlanDigest(plan); return plan;
}

export function computeSkillPlanDigest(plan: InternalSkillPlan): string {
  const { digest: _digest, ...publicWithoutDigest } = plan.public;
  return createHash("sha256").update(JSON.stringify({ public: publicWithoutDigest, effects: plan.effects, registryAfter: plan.registryAfter })).digest("hex");
}
