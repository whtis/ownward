import { realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, parse, resolve } from "path";

export type TaskRootSource = { projectDir?: unknown; cwd?: unknown };

export function computeSafeAllowedRoots(repoRoot: string, tasks: readonly TaskRootSource[]): string[] {
  const repo = realpathSync(resolve(repoRoot)), parent = dirname(repo);
  const unsafe = new Set([realpathSync(homedir()), parse(repo).root]);
  const roots: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate.trim()) return;
    try { const actual = realpathSync(resolve(candidate)); if (!unsafe.has(actual) && statSync(actual).isDirectory() && !roots.includes(actual)) roots.push(actual); } catch {}
  };
  if (!unsafe.has(parent)) add(parent); else add(repo);
  for (const task of tasks) { add(task.projectDir); add(task.cwd); }
  return roots;
}

export function effectiveAllowedRoots(rawConfig: any, repoRoot: string, tasks: readonly TaskRootSource[]): string[] {
  if (rawConfig?.architecture && Object.prototype.hasOwnProperty.call(rawConfig.architecture, "allowedRoots")) return Array.isArray(rawConfig.architecture.allowedRoots) ? rawConfig.architecture.allowedRoots : [];
  return [];
}
