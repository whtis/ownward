// Obsidian 分层落地：摘要 + 关键原文进 vault，原始 jsonl 留在 data/events/。
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { ensureDir, fmt } from "./util.ts";
import { OWNWARD_DIR } from "./paths.ts";

const VAULT = OWNWARD_DIR;

function dailyFile(): string {
  ensureDir(VAULT);
  const f = join(VAULT, `${fmt(new Date(), "date")}.md`);
  // wx 独占创建替代 exists+write：午夜前后多个定时任务并发首写时，
  // exists 检查的 TOCTOU 会让第二个 write 截断第一个刚追加的内容
  try {
    writeFileSync(f, `---\ntype: ownward-log\ndate: ${fmt(new Date(), "date")}\n---\n\n# Ownward ${fmt(new Date(), "date")}\n`, { flag: "wx" });
  } catch { /* EEXIST：别人先建好了，直接用 */ }
  return f;
}

export interface LogEntry {
  source: string;
  summary: string;
  detail?: string;
}

/** 追加一个时间戳小节；detail 用 callout 折叠存关键原文 */
export function appendDaily(section: string, entries: LogEntry[]) {
  if (!entries.length) return;
  let md = `\n## ${fmt(new Date(), "time")} ${section}\n\n`;
  for (const e of entries) {
    md += `- **[${e.source}]** ${e.summary}\n`;
    if (e.detail) {
      const quoted = e.detail.trim().split("\n").map((l) => `> ${l}`).join("\n");
      md += `\n> [!quote]- 原文\n${quoted}\n\n`;
    }
  }
  appendFileSync(dailyFile(), md);
}

/** 通知类消息也归档一份，保持 vault 是完整的当日视图 */
export function appendNotification(text: string) {
  appendFileSync(dailyFile(), `\n## ${fmt(new Date(), "time")} 通知\n\n> [!warning] 已推送\n> ${text.split("\n").join("\n> ")}\n`);
}
