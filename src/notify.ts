// 通知路由：feed（dashboard 数据源）→ macOS 原生通知 → 飞书 DM。
// 通道由 notify-policy.decideChannels 决定，三条规则见那边；这里只负责执行与留档。
// 飞书发的是卡片而不是裸文本：一条通知必须说清「出了什么事 / 现在什么状态 / 你能做什么」，
// 做不到这三条的就别进飞书（降级 fyi，留在 feed 和横幅里）。
import { appendFeed } from "./feed.ts";
import { isWorkbenchActive } from "./presence.ts";
import { DEFAULT_COOLDOWN_MS, decideChannels, type NotifyLevel } from "./notify-policy.ts";
import { cfg, loadState, log, run, saveState } from "./util.ts";

export type { NotifyLevel } from "./notify-policy.ts";

/** 飞书卡片上的按钮：url=直接跳转（打开工作台/入会/文档），不需要回调。 */
export interface NotifyAction {
  text: string;
  url: string;
  primary?: boolean;
}

export interface NotifyOptions {
  source?: string;   // lark | github | gmail | stock | dispatch | heartbeat | calendar | system
  detail?: string;
  link?: string;
  chatId?: string;
  mailId?: string;
  /** act=需要你动手（进飞书卡片）；fyi=知道就行（横幅+feed，默认）；silent=只留档。 */
  level?: NotifyLevel;
  /** 去重键：同一件事反复发生时（多轮接力任务每轮都 reap），冷却窗口内只推一次。 */
  key?: string;
  /** 飞书卡片正文补充：每行一个「字段: 值」，让人一眼看出发生了什么。 */
  context?: string[];
  /** 飞书卡片按钮。没给但有 link 时，自动生成一个「打开」按钮。 */
  actions?: NotifyAction[];
  /** 时效性提醒（开会、止损）：静默时段照推。 */
  quietExempt?: boolean;
  /** 手动自测：前台/静默/冷却一律绕开，让人看到通道到底通不通。 */
  force?: boolean;
  /** 永不进飞书（横幅+feed）。等价于 level:"fyi"，留着兼容旧调用点。 */
  noLark?: boolean;
}

/** 去重记账：key → 上次真正推送的时刻。进程内即可（daemon 常驻）。 */
const lastSentAt = new Map<string, number>();

export function cooldownMs(): number {
  const min = Number(cfg.notify?.cooldownMin);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : DEFAULT_COOLDOWN_MS;
}

export async function notify(text: string, opts: NotifyOptions = {}): Promise<boolean> {
  const source = opts.source || "system";
  // 默认 fyi 是有意的收紧：飞书只留给显式标了 act 的调用点。
  // 改默认之前，一周 462 条飞书推送里 388 条是任务结束播报，真要处理的反而被埋掉。
  const level: NotifyLevel = opts.level ?? "fyi";
  const now = Date.now();
  const decision = decideChannels({
    level, source, key: opts.key,
    active: isWorkbenchActive(now),
    larkSkipSources: cfg.notify.larkSkipSources || ["lark"],
    macosEnabled: process.platform === "darwin" && cfg.notify.macos !== false,
    larkEnabled: cfg.notify.lark !== false && !opts.noLark,
    lastSentAt: opts.key ? lastSentAt.get(opts.key) : undefined,
    now, cooldownMs: cooldownMs(), quietExempt: opts.quietExempt, force: opts.force,
  });
  const channels: string[] = [];

  // 1. macOS 原生通知（dashboard 没在前台时的主提醒面）
  if (decision.macos) {
    const r = await run(["osascript", "-e",
      `display notification ${JSON.stringify(text.slice(0, 200))} with title "Ownward" subtitle ${JSON.stringify(source)} sound name "Glass"`,
    ], { timeoutMs: 10_000 });
    if (r.code === 0) channels.push("macos");
    else log(`macos notify failed: ${r.stderr.slice(0, 150)}`);
  }

  // 2. 飞书：只接 act 级，且发成带上下文和按钮的卡片（离开电脑也能当场处理）
  if (decision.lark) {
    const { sendNoticeCard } = await import("./lark-cards.ts");
    const id = await sendNoticeCard({
      title: text.split("\n")[0].slice(0, 40),
      body: text.split("\n").slice(1).join("\n"),
      context: opts.context || [],
      actions: opts.actions?.length ? opts.actions : opts.link ? [{ text: "打开", url: opts.link, primary: true }] : [],
      source,
    });
    if (id) channels.push("lark");
  }

  if (channels.length && opts.key) {
    lastSentAt.set(opts.key, now);
    // key 是按任务/会议生成的，daemon 常驻会一直攒：过了冷却窗口的记录已经不影响判断，清掉
    if (lastSentAt.size > 500) for (const [k, ts] of lastSentAt) if (now - ts > cooldownMs()) lastSentAt.delete(k);
  }

  // 3. feed 永远记录（即使所有推送通道都被压住，dashboard 上也能看到）
  appendFeed({
    ts: new Date().toISOString(), kind: "notify", source, text, detail: opts.detail, channels,
    link: opts.link, chat_id: opts.chatId, mail_id: opts.mailId,
  });

  const state = loadState();
  state.notified = [...(state.notified || []), { ts: new Date().toISOString(), text }].slice(-30);
  saveState(state);
  log(`notified [${source}/${level} → ${channels.join("+") || `feed-only（${decision.reason}）`}]: ${text.split("\n")[0].slice(0, 60)}`);
  return channels.length > 0;
}

/** 兼容旧调用点：强制走飞书（test-notify 等显式场景） */
export async function notifyLark(text: string): Promise<boolean> {
  return notify(text, { source: "system", level: "act", force: true });
}

export function recentNotifications(): { ts: string; text: string }[] {
  return (loadState().notified || []).slice(-10);
}

/** 仅供测试：清掉去重记账。 */
export function resetNotifyCooldown(): void {
  lastSentAt.clear();
}
