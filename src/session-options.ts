export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol" as const;
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];
export type CodexEffort = typeof CODEX_EFFORTS[number];

export const CODEX_MODEL_EFFORTS = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
} as const satisfies Record<string, readonly CodexEffort[]>;

export type CodexModel = keyof typeof CODEX_MODEL_EFFORTS;

export function isCodexEffort(value: unknown): value is CodexEffort {
  return CODEX_EFFORTS.includes(value as CodexEffort);
}

export function codexEffortsForModel(model: string | undefined): readonly CodexEffort[] | undefined {
  return model && Object.hasOwn(CODEX_MODEL_EFFORTS, model)
    ? CODEX_MODEL_EFFORTS[model as CodexModel]
    : undefined;
}

export function isCodexModelEffortPair(model: string | undefined, effort: string | undefined): boolean {
  if (effort === undefined) return true;
  return isCodexEffort(effort) && codexEffortsForModel(model)?.includes(effort) === true;
}
