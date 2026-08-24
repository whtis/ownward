// 通知路由：feed（dashboard 数据源）→ macOS 原生通知 → 飞书 DM。
// 规则：飞书来源的事件不回发飞书 DM（人就在飞书里，回发是左手通知右手）。
import { appendFeed } from "./feed.ts";
import { cfg, loadState, log, run, saveState } from "./util.ts";

export interface NotifyOptions {
  source?: string;   // lark | github | gmail | stock | dispatch | heartbeat | system
  detail?: string;
  link?: string;
  chatId?: string;
  mailId?: string;
  noLark?: boolean;  // 低打扰：只走横幅+feed，不发飞书（草稿就绪这类 FYI）
}

export async function notify(text: string, opts: NotifyOptions = {}): Promise<boolean> {
  const source = opts.source || "system";
  const channels: string[] = [];

  // 1. macOS 原生通知（dashboard 常开时的主提醒面）
  if (process.platform === "darwin" && cfg.notify.macos !== false) {
    const r = await run(["osascript", "-e",
      `display notification ${JSON.stringify(text.slice(0, 200))} with title "Ownward" subtitle ${JSON.stringify(source)} sound name "Glass"`,
    ], { timeoutMs: 10_000 });
    if (r.code === 0) channels.push("macos");
    else log(`macos notify failed: ${r.stderr.slice(0, 150)}`);
  }

  // 2. 飞书 DM：跳过 lark 来源；作为离开电脑时的兜底通道
  const skipLark = opts.noLark || (cfg.notify.larkSkipSources || ["lark"]).includes(source);
  if (cfg.notify.lark !== false && !skipLark) {
    const r = await run(
      ["lark-cli", "im", "+messages-send", "--as", "bot",
       "--user-id", cfg.notify.larkUserId, "--text", text],
      { timeoutMs: 30_000 },
    );
    if (r.code === 0) channels.push("lark");
    else log(`lark notify failed (${r.code}): ${r.stderr.slice(0, 200)}`);
  }

  // 3. feed 永远记录（即使所有推送通道都失败，dashboard 上也能看到）
  appendFeed({
    ts: new Date().toISOString(), kind: "notify", source, text, detail: opts.detail, channels,
    link: opts.link, chat_id: opts.chatId, mail_id: opts.mailId,
  });

  const state = loadState();
  state.notified = [...(state.notified || []), { ts: new Date().toISOString(), text }].slice(-30);
  saveState(state);
  log(`notified [${source} → ${channels.join("+") || "feed-only"}]: ${text.split("\n")[0].slice(0, 60)}`);
  return channels.length > 0;
}

/** 兼容旧调用点：强制走飞书（test-notify 等显式场景） */
export async function notifyLark(text: string): Promise<boolean> {
  return notify(text, { source: "system" });
}

export function recentNotifications(): { ts: string; text: string }[] {
  return (loadState().notified || []).slice(-10);
}
