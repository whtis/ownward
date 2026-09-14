import { CODEX_EFFORTS, codexCatalogModel, isCodexEffort, type CodexEffort } from "./codex-catalog.ts";

export { CODEX_EFFORTS, isCodexEffort, type CodexEffort } from "./codex-catalog.ts";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol" as const;
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** CodeBuddy 复用 Claude 协议但多一档 minimal（`codebuddy --help` 2026-09-05：minimal/low/medium/high/xhigh/max） */
export const CODEBUDDY_EFFORTS = ["minimal", ...CLAUDE_EFFORTS] as const;
/** 走 Claude 协议的两家 CLI 合起来认的档位（协议层放行；哪家不认哪档由 adapter 按 providerId 再拒） */
export const CLAUDE_PROTOCOL_EFFORTS = CODEBUDDY_EFFORTS;
export type ClaudeEffort = typeof CLAUDE_PROTOCOL_EFFORTS[number];
export function effortsForProvider(providerId: "claude" | "codebuddy"): readonly ClaudeEffort[] { return providerId === "codebuddy" ? CODEBUDDY_EFFORTS : CLAUDE_EFFORTS; }

/** Codex 各型号支持的思考深度：真相在官方缓存（codex-catalog.ts），这里只是同一张表的查询入口。
 *  未知型号返回 undefined——调用方必须拒绝而不是猜一档：CLI 不认识的档位下发出去就是 400。 */
export function codexEffortsForModel(model: string | undefined): readonly CodexEffort[] | undefined {
  return codexCatalogModel(model)?.efforts;
}
export function codexDefaultEffortForModel(model: string | undefined): CodexEffort | undefined {
  return codexCatalogModel(model)?.defaultEffort;
}
export function isCodexModelEffortPair(model: string | undefined, effort: string | undefined): boolean {
  if (effort === undefined) return true;
  return isCodexEffort(effort) && codexEffortsForModel(model)?.includes(effort) === true;
}
/** Provider 侧统一校验（Kernel 与 Runner consumer 共用，两边不许各写一份）：非法直接抛 Error */
export function assertProviderOptions(providerId: "claude" | "codex" | "codebuddy", model?: string, effort?: string): void {
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error("model 非法");
  if (providerId === "codex") {
    if (effort !== undefined && !isCodexEffort(effort)) throw new Error("codex effort 非法");
    if (!isCodexModelEffortPair(model, effort)) throw new Error("codex model/effort 组合非法");
    return;
  }
  if (effort !== undefined && !effortsForProvider(providerId).includes(effort as ClaudeEffort)) throw new Error(`${providerId} effort 非法`);
}

/** 兼容旧引用：内置快照的「型号 → 深度」表（只反映兜底快照，不反映官方缓存；新代码请走 codexEffortsForModel） */
import { BUILTIN_CODEX_CATALOG } from "./codex-catalog.ts";
export const CODEX_MODEL_EFFORTS: Readonly<Record<string, readonly CodexEffort[]>> = Object.freeze(
  Object.fromEntries(BUILTIN_CODEX_CATALOG.map((m) => [m.slug, m.efforts])),
);
