import { randomBytes } from "crypto";
import { realpathSync, statSync } from "fs";
import { inspectCcSessionFile, type CcSessionMeta } from "../../cc-sessions.ts";
import { inspectCodexSessionFile, type CodexMeta } from "../../codex-sessions.ts";

export type CandidateProvider = "claude" | "codex" | "codebuddy";
type FileIdentity = { dev: number; ino: number; mtimeMs: number; size: number };
type PrivateCandidate = {
  token: string; provider: CandidateProvider; nativeId: string; path: string; home?: string;
  cwd: string; active: boolean; identity: FileIdentity; issuedAt: number; expiresAt: number; consumed: boolean;
};
export type ConsumedCandidate = Readonly<{ provider: CandidateProvider; nativeId: string; cwd: string; home?: string; project: string; title: string }>;

export class DevSessionCandidateError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const identity = (path: string): FileIdentity => {
  const st = statSync(path);
  if (!st.isFile()) throw new DevSessionCandidateError("DEV_SESSION_DISCOVERY_STALE", "会话文件已变化，请刷新后重试");
  return { dev: Number(st.dev), ino: Number(st.ino), mtimeMs: st.mtimeMs, size: st.size };
};
const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;

/** In-process, server-side capability authority. Tokens are opaque, short-lived and single-use.
 * Raw provider homes, native ids and transcript paths never cross this boundary. */
export class DevSessionCandidateAuthority {
  private readonly entries = new Map<string, PrivateCandidate>();
  constructor(private readonly ttlMs = 120_000, private readonly now = () => Date.now()) {}

  issueClaude(meta: CcSessionMeta, path: string): string { return this.issue("claude", meta.id.split("/").pop() || "", path, undefined, meta); }
  issueCodex(meta: CodexMeta, path: string): string { return this.issue("codex", meta.rolloutId, path, meta.home, meta); }

  private issue(provider: CandidateProvider, nativeId: string, rawPath: string, home: string | undefined, meta: CcSessionMeta): string {
    const path = realpathSync(rawPath), file = identity(path), now = this.now();
    for (const entry of this.entries.values()) {
      if (!entry.consumed && entry.expiresAt > now && entry.provider === provider && entry.nativeId === nativeId && entry.path === path && entry.cwd === meta.cwd && entry.active === meta.active && sameIdentity(entry.identity, file)) return entry.token;
    }
    const token = randomBytes(32).toString("base64url");
    this.entries.set(token, { token, provider, nativeId, path, home, cwd: meta.cwd, active: meta.active, identity: file, issuedAt: now, expiresAt: now + this.ttlMs, consumed: false });
    this.prune(now);
    return token;
  }

  /** Atomically burns the capability before any async adoption work can begin. Validation failure
   * remains burned, preventing concurrent/replayed takeover attempts. */
  consume(token: string): ConsumedCandidate {
    const entry = this.get(token, true);
    entry.consumed = true;
    let before: FileIdentity, after: FileIdentity, fresh: CcSessionMeta;
    try {
      before = identity(entry.path);
      if (!sameIdentity(before, entry.identity)) throw new DevSessionCandidateError("DEV_SESSION_DISCOVERY_STALE", "会话文件已变化，请刷新后重试");
      fresh = entry.provider === "claude" ? inspectCcSessionFile(entry.path, entry.nativeId) : inspectCodexSessionFile(entry.path, entry.home || "");
      after = identity(entry.path);
    } catch (error) {
      if (error instanceof DevSessionCandidateError) throw error;
      throw new DevSessionCandidateError("DEV_SESSION_DISCOVERY_STALE", "会话状态已变化，请刷新后重试");
    }
    if (!sameIdentity(before, after) || !sameIdentity(after, entry.identity) || fresh.cwd !== entry.cwd || fresh.active !== entry.active || fresh.active)
      throw new DevSessionCandidateError("DEV_SESSION_DISCOVERY_STALE", fresh.active ? "会话正被其他端驱动，空闲后再接管" : "会话状态已变化，请刷新后重试");
    const nativeId = entry.provider === "codex" ? (fresh as CodexMeta).rolloutId : fresh.id.split("/").pop() || "";
    if (!nativeId || nativeId !== entry.nativeId) throw new DevSessionCandidateError("DEV_SESSION_DISCOVERY_STALE", "会话身份已变化，请刷新后重试");
    return Object.freeze({ provider: entry.provider, nativeId, cwd: entry.cwd, ...(entry.home ? { home: entry.home } : {}), project: fresh.project, title: fresh.title });
  }

  private get(token: string, consuming: boolean): PrivateCandidate {
    const entry = typeof token === "string" ? this.entries.get(token) : undefined, now = this.now();
    if (!entry) throw new DevSessionCandidateError("DEV_SESSION_CANDIDATE_INVALID", "会话候选无效，请刷新后重试");
    if (entry.expiresAt <= now) throw new DevSessionCandidateError("DEV_SESSION_CANDIDATE_EXPIRED", "会话候选已过期，请刷新后重试");
    if (entry.consumed && consuming) throw new DevSessionCandidateError("DEV_SESSION_CANDIDATE_CONSUMED", "会话候选已使用，请刷新后重试");
    return entry;
  }
  private prune(now: number) { for (const [token, entry] of this.entries) if (entry.expiresAt + this.ttlMs <= now) this.entries.delete(token); }
}

export const devSessionCandidates = new DevSessionCandidateAuthority();
