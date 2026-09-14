// Provider 能力目录：客户端派任务弹窗 / 会话重配 / 设置页共用的一份「谁有哪些模型、各支持哪些思考深度」。
// 三家的真相来源各不相同，这里统一成一个形状：
//   codex     → CLI 自己缓存的官方模型表（codex-catalog.ts）
//   claude    → 内置别名 + ~/.claude.json 服务端下发的额外型号；档位解析 `claude --help`
//   codebuddy → 型号与档位都解析 `codebuddy --help`（只在 providers.codebuddy.enabled 时探测）
// 每家都带 source 说明来源，探测失败回退内置快照并注明 reason。web/app.js 与安卓/iOS 各带一份同内容的
// 内置表作为离线兜底，服务端这份到达后覆盖。
import { readCodexCatalog, type CodexCatalog } from "./codex-catalog.ts";
import { claudeAdditionalModels, probeCliHelp } from "./cli-catalog.ts";
import { CLAUDE_EFFORTS, CODEBUDDY_EFFORTS, DEFAULT_CODEX_MODEL } from "./session-options.ts";
import { cfg } from "./util.ts";

export interface StaticProviderCapability {
  label: string; models: readonly string[]; efforts: readonly string[];
  defaultModel: string; handoffModel: string; handoffEffort: string;
}
/** 2026-09-05 快照：`claude --model` 认的别名（fable/opus/sonnet/haiku 实测都通） */
export const CLAUDE_CAPABILITY: StaticProviderCapability = Object.freeze({
  label: "Claude Code", models: Object.freeze(["fable", "opus", "sonnet", "haiku"]), efforts: CLAUDE_EFFORTS,
  defaultModel: "", handoffModel: "sonnet", handoffEffort: "medium",
});
/** 2026-09-05 快照：`codebuddy --help` 的 Currently supported 列表与 --effort 档位 */
export const CODEBUDDY_CAPABILITY: StaticProviderCapability = Object.freeze({
  label: "CodeBuddy",
  models: Object.freeze(["hy3", "hy3-x", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3-pay", "minimax-m2.7", "kimi-k3-2", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash"]),
  efforts: CODEBUDDY_EFFORTS, defaultModel: "", handoffModel: "hy3", handoffEffort: "medium",
});

export interface CliProviderCatalog extends StaticProviderCapability {
  source: "cli-help" | "builtin" | "cli-help+account" | "disabled";
  reason?: string;
  /** 型号的展示名/说明（只有能拿到的才有：Claude 的额外型号带 label/description） */
  modelInfo?: Record<string, { displayName: string; description: string }>;
}
export interface ProviderCatalog {
  claude: CliProviderCatalog;
  codebuddy: CliProviderCatalog;
  codex: {
    label: string; source: CodexCatalog["source"]; fetchedAt: string | null; reason?: string;
    defaultModel: string; handoffModel: string; handoffEffort: string;
    models: { slug: string; displayName: string; description: string; efforts: readonly string[]; defaultEffort: string; fast: { name: string; description: string } | null; contextWindow: number | null }[];
  };
}

const providerCommand = (id: "claude-code" | "codebuddy", fallback: string): string[] => {
  const raw = (cfg.providers as Record<string, { command?: unknown }> | undefined)?.[id]?.command;
  return Array.isArray(raw) && raw.length && raw.every((x) => typeof x === "string" && x) ? [...raw] : [fallback];
};
/** Claude 只信 help 里声明的档位（内置五档是快照；将来 CLI 加档位这里自动跟上），型号 = 别名 + 账号额外型号 */
async function claudeCatalog(): Promise<CliProviderCatalog> {
  const probe = await probeCliHelp(providerCommand("claude-code", "claude"));
  const efforts = probe.ok && probe.efforts.length ? probe.efforts : [...CLAUDE_CAPABILITY.efforts];
  const extra = claudeAdditionalModels();
  const models = [...CLAUDE_CAPABILITY.models], modelInfo: Record<string, { displayName: string; description: string }> = {};
  for (const item of extra) {
    // 服务端给的是全名（claude-fable-5-1[1m]）；内置别名已覆盖的（fable）不重复列，其余按全名追加
    const alias = CLAUDE_CAPABILITY.models.find((a) => item.value.startsWith(`claude-${a}-`) || item.value === a);
    if (alias) { modelInfo[alias] = { displayName: item.label, description: item.description }; continue; }
    if (!models.includes(item.value)) { models.push(item.value); modelInfo[item.value] = { displayName: item.label, description: item.description }; }
  }
  return { ...CLAUDE_CAPABILITY, models, efforts, source: probe.ok ? (extra.length ? "cli-help+account" : "cli-help") : "builtin", ...(probe.ok ? {} : { reason: probe.reason }), ...(Object.keys(modelInfo).length ? { modelInfo } : {}) };
}
async function codebuddyCatalog(): Promise<CliProviderCatalog> {
  if (cfg.providers?.codebuddy?.enabled !== true) return { ...CODEBUDDY_CAPABILITY, source: "disabled", reason: "providers.codebuddy.enabled 未开启，未探测 CLI" };
  const probe = await probeCliHelp(providerCommand("codebuddy", "codebuddy"));
  if (!probe.ok) return { ...CODEBUDDY_CAPABILITY, source: "builtin", reason: probe.reason };
  return { ...CODEBUDDY_CAPABILITY, models: probe.models.length ? probe.models : CODEBUDDY_CAPABILITY.models, efforts: probe.efforts.length ? probe.efforts : CODEBUDDY_CAPABILITY.efforts, source: "cli-help" };
}
export async function providerCatalog(): Promise<ProviderCatalog> {
  const codex = readCodexCatalog(), [claude, codebuddy] = await Promise.all([claudeCatalog(), codebuddyCatalog()]);
  return {
    claude,
    codebuddy,
    codex: {
      label: "Codex", source: codex.source, fetchedAt: codex.fetchedAt, ...(codex.reason ? { reason: codex.reason } : {}),
      defaultModel: DEFAULT_CODEX_MODEL, handoffModel: DEFAULT_CODEX_MODEL, handoffEffort: "medium",
      models: codex.models.map((m) => ({ slug: m.slug, displayName: m.displayName, description: m.description, efforts: m.efforts, defaultEffort: m.defaultEffort ?? "", fast: m.fast ? { name: m.fast.name, description: m.fast.description } : null, contextWindow: m.contextWindow })),
    },
  };
}
