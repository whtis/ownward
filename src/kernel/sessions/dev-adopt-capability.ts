import { existsSync } from "fs";
import { ccSessionPath, inspectCcSessionFile, type CcSessionMeta } from "../../cc-sessions.ts";
import { findCodexSessionFresh, type CodexMeta } from "../../codex-sessions.ts";
import { DevSessionCandidateAuthority, DevSessionCandidateError, devSessionCandidates } from "./dev-candidates.ts";

type Resolved = { provider: "claude"; meta: CcSessionMeta; path: string } | { provider: "codex"; meta: CodexMeta; path: string };
export type FreshObservationResolver = (stableId: string) => Resolved | null;

export function resolveFreshDevObservation(stableId: string): Resolved | null {
  if (stableId.startsWith("cdx:")) {
    const found = findCodexSessionFresh(stableId);
    return found ? { provider: "codex", ...found } : null;
  }
  try {
    const path = ccSessionPath(stableId), meta = inspectCcSessionFile(path, stableId);
    return { provider: "claude", meta, path };
  } catch { return null; }
}

/** Kernel-side fresh issuance service. Stable observation ids can outlive pages/processes;
 * capabilities cannot, and are minted only after an exact uncached file inspection. */
export class DevAdoptCapabilityService {
  constructor(private readonly authority: DevSessionCandidateAuthority = devSessionCandidates, private readonly resolve: FreshObservationResolver = resolveFreshDevObservation) {}
  issue(stableId: string): { adoptToken: string } {
    const found = typeof stableId === "string" && stableId ? this.resolve(stableId) : null;
    if (!found || found.meta.id !== stableId) throw new DevSessionCandidateError("DEV_SESSION_OBSERVATION_NOT_FOUND", "会话不存在或身份已变化，请刷新后重试");
    if (found.meta.active) throw new DevSessionCandidateError("DEV_SESSION_DISCOVERY_ACTIVE", "会话正被其他端驱动，空闲后再接管");
    if (!found.meta.cwd || !existsSync(found.meta.cwd)) throw new DevSessionCandidateError("DEV_SESSION_CWD_UNAVAILABLE", "会话工作目录不存在，无法接管");
    return { adoptToken: found.provider === "codex" ? this.authority.issueCodex(found.meta, found.path) : this.authority.issueClaude(found.meta, found.path) };
  }
}

export const devAdoptCapabilities = new DevAdoptCapabilityService();
