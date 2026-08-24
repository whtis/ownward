// 通知/日志统一 feed：dashboard 的数据源，data/feed.jsonl 一行一条。
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "fs";
import { join } from "path";
import { DATA, ensureDir } from "./util.ts";

export interface FeedEntry {
  ts: string;
  kind: "notify" | "log";
  source: string;          // lark | github | gmail | stock | dispatch | heartbeat | system
  text: string;
  detail?: string;
  channels?: string[];     // 实际送达的通道: macos / lark
  link?: string;           // 可点开的 URL（github PR 等）
  chat_id?: string;        // lark 会话引用
  mail_id?: string;        // gmail 邮件引用
}

const FEED = join(DATA, "feed.jsonl");

export function appendFeed(entry: FeedEntry) {
  ensureDir(DATA);
  appendFileSync(FEED, JSON.stringify(entry) + "\n");
}

export function readFeed(limit = 100): FeedEntry[] {
  if (!existsSync(FEED)) return [];
  // 从文件尾反向按块读，直到凑够 limit 行或到 2MB 上限——固定窗口会悄悄少给
  const size = statSync(FEED).size;
  const fd = openSync(FEED, "r");
  try {
    let text = "";
    let pos = size;
    const CHUNK = 256 * 1024;
    while (pos > 0 && text.length < 2 * 1024 * 1024) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos);
      text = buf.toString("utf8") + text;
      if ((text.match(/\n/g) || []).length > limit) break;
    }
    if (pos > 0) text = text.slice(text.indexOf("\n") + 1); // 丢弃可能被截断的首行
    const lines = text.split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean) as FeedEntry[];
  } finally {
    closeSync(fd);
  }
}

export const FEED_FILE = FEED;
