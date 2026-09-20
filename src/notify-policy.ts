// 通知路由策略（纯函数，便于单测）：决定一条通知走哪些通道。
//
// 三条规则，按「人当下在哪」排的：
//  1. 工作台窗口正聚焦 → 人就在看 feed，横幅和飞书都是重复打扰，一律降级成 feed-only。
//  2. 飞书只接「需要你动手」的（level=act）。任务跑完、草稿生成这类 FYI 不进飞书——
//     2026-09-20 实测一周 462 条飞书推送里 388 条是任务结束播报，重到没人看，真需要处理的反而被埋掉。
//  3. 同一件事（key）在冷却窗口内只推一次。多轮接力会话每轮结束都会 reap 出一次，
//     同一个任务曾经一周推了 54 条「编码任务结束」。
import { inQuietHours } from "./util.ts";

/** act=需要你决定或动手（进飞书）；fyi=知道就行（横幅+feed）；silent=只留档 feed。 */
export type NotifyLevel = "act" | "fyi" | "silent";

export interface PolicyInput {
  level: NotifyLevel;
  source: string;
  /** 去重键；同 key 在冷却窗口内不重复推送（不影响 feed 留档）。 */
  key?: string;
  /** 工作台窗口当前是否聚焦（见 presence.ts）。 */
  active: boolean;
  /** 飞书跳过的来源（默认 ["lark"]：人就在飞书里，回发等于左手通知右手）。 */
  larkSkipSources: string[];
  macosEnabled: boolean;
  larkEnabled: boolean;
  /** 同 key 上次推送时刻 epoch ms（没推过传 undefined）。 */
  lastSentAt?: number;
  now: number;
  cooldownMs: number;
  /** 静默时段（深夜）：只压推送，不压 feed。act 也压——半夜叫醒不如早上一起看。 */
  quiet?: boolean;
  /** 时效性提醒（开会、止损）：错过这一次就没有下一次，静默时段照推。 */
  quietExempt?: boolean;
  /** 手动触发的自测：人正按着按钮，前台/静默/冷却都不该把它吞掉。 */
  force?: boolean;
}

export interface PolicyDecision {
  macos: boolean;
  lark: boolean;
  /** 只为日志/排查：说明这条为什么没推。 */
  reason: string;
}

export const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export function decideChannels(input: PolicyInput): PolicyDecision {
  const no = (reason: string): PolicyDecision => ({ macos: false, lark: false, reason });
  if (input.level === "silent") return no("silent：只留档 feed");
  if (!input.force) {
    if (input.active) return no("工作台在前台，降级为 feed");
    if (!input.quietExempt && (input.quiet ?? inQuietHours(new Date(input.now)))) return no("静默时段，降级为 feed");
  }
  if (!input.force && input.key && input.lastSentAt !== undefined && input.now - input.lastSentAt < input.cooldownMs)
    return no(`同一事件 ${Math.round((input.now - input.lastSentAt) / 60_000)}min 内已推过`);
  const macos = input.macosEnabled;
  const lark = input.larkEnabled && input.level === "act" && !input.larkSkipSources.includes(input.source);
  return { macos, lark, reason: lark ? "act：横幅+飞书" : macos ? "fyi：只横幅" : "通道都关着" };
}
