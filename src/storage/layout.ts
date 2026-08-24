import { join } from "path";

/** Phase 6 canonical Kernel store paths. Legacy paths remain read-only fallbacks. */
export function kernelSessionsFile(dataRoot: string): string {
  return join(dataRoot, "kernel", "sessions.json");
}

export function legacySessionsFile(dataRoot: string): string {
  return join(dataRoot, "sessions.json");
}
