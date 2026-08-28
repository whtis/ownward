import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve, sep } from "path";
import type { SkillEngine, SkillScope } from "./contracts.ts";
import { atomicWrite } from "./filesystem.ts";

export interface ManagedSkillRecord {
  id: string;
  name: string;
  description: string | null;
  digest: string;
  managedPath: string;
  sources: Array<{ engine: SkillEngine; scope: SkillScope; path: string; digest: string }>;
  deployments: Array<{ engine: SkillEngine; scope: "user" | "project"; path: string; desired: boolean; transactionId?: string }>;
  lastVerifiedTransaction: string | null;
}
export interface SkillRegistry { schemaVersion: 1; revision: string; updatedAt: string; skills: ManagedSkillRecord[] }

const empty = (): SkillRegistry => ({ schemaVersion: 1, revision: createHash("sha256").update("[]").digest("hex"), updatedAt: new Date(0).toISOString(), skills: [] });
export const registryPath = (storeRoot: string) => join(storeRoot, "registry.json");
export function registryRevision(skills: ManagedSkillRecord[]): string { return createHash("sha256").update(JSON.stringify(skills.map((s) => ({ ...s, sources: [...s.sources].sort((a,b)=>a.path.localeCompare(b.path)), deployments: [...s.deployments].sort((a,b)=>a.path.localeCompare(b.path)) })).sort((a,b)=>a.id.localeCompare(b.id)))).digest("hex"); }
export function normalizeRegistry(registry: SkillRegistry): SkillRegistry { const skills = [...registry.skills].sort((a,b)=>a.id.localeCompare(b.id)); return { schemaVersion: 1, revision: registryRevision(skills), updatedAt: registry.updatedAt, skills }; }
export function readRegistry(storeRoot: string): SkillRegistry {
  const file = registryPath(storeRoot); if (!existsSync(file)) return empty();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.skills) || typeof raw.revision !== "string" || typeof raw.updatedAt !== "string") throw Object.assign(new Error("Skill registry 损坏"), { code: "SKILL_REGISTRY_INVALID" });
  const managedRoot = resolve(storeRoot, "managed");
  for (const item of raw.skills) {
    const managedPath = typeof item?.managedPath === "string" ? resolve(item.managedPath) : "";
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9-]{16,128}$/.test(item.id) || typeof item.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name) || typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest) || managedPath !== join(managedRoot, item.id) || !managedPath.startsWith(managedRoot + sep) || !Array.isArray(item.sources) || !Array.isArray(item.deployments)) throw Object.assign(new Error("Skill registry 条目非法"), { code: "SKILL_REGISTRY_INVALID" });
    for (const source of item.sources) if (!source || !["claude", "codex", "codebuddy"].includes(source.engine) || !["user", "project", "system", "plugin"].includes(source.scope) || typeof source.path !== "string" || !isAbsolute(source.path) || typeof source.digest !== "string") throw Object.assign(new Error("Skill registry source 非法"), { code: "SKILL_REGISTRY_INVALID" });
    for (const deployment of item.deployments) if (!deployment || !["claude", "codex", "codebuddy"].includes(deployment.engine) || !["user", "project"].includes(deployment.scope) || typeof deployment.path !== "string" || !isAbsolute(deployment.path) || typeof deployment.desired !== "boolean") throw Object.assign(new Error("Skill registry deployment 非法"), { code: "SKILL_REGISTRY_INVALID" });
  }
  const normalized = normalizeRegistry(raw); if (normalized.revision !== raw.revision) throw Object.assign(new Error("Skill registry revision 不匹配"), { code: "SKILL_REGISTRY_INVALID" });
  return raw;
}
export function writeRegistry(storeRoot: string, registry: SkillRegistry): SkillRegistry { const normalized = normalizeRegistry({ ...registry, updatedAt: new Date().toISOString() }); atomicWrite(registryPath(storeRoot), JSON.stringify(normalized, null, 2) + "\n"); return normalized; }
