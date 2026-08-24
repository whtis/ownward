// 飞书会话元数据：最近一条消息 / 时间 / ownward 本地未读数。
// 由 user 轮询和 bot 事件喂入；「点开会话即已读」——飞书真实已读态拿不到，用本地语义近似。
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { fsyncSync } from "./fs-durable.ts";
import { dirname, join } from "path";
import { DATA, ensureDir } from "./util.ts";

export interface ChatMeta {
  last_text: string;
  last_ts: number;       // epoch ms
  last_sender: string;
  unread: number;
  hidden_ts?: number;    // 「清除」时的 last_ts：之后没有新消息就不再出现在列表
  deleted?: boolean;     // 「删除」：只要没未读就一直隐藏；来新未读浮现一次，读完自动再消失
  read_ts?: number;      // 点开会话的时刻：轮询滞后扫到的更早消息不再回填未读（防清零后角标复活）
  seen_event_ids?: string[];
}

const FILE = join(DATA, "lark-chats.json");
let cache: Record<string, ChatMeta> | null = null;

function load(): Record<string, ChatMeta> {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = {}; }
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  const temp=FILE+`.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(temp, JSON.stringify(cache, null, 2));const fd=openSync(temp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,FILE);const dfd=openSync(dirname(FILE),"r");try{fsyncSync(dfd);}finally{closeSync(dfd);}
}

/** 飞书时间字段两种形态："1784188263201"（ms）或 "2026-07-16 18:19:31" */
export function parseLarkTs(v: unknown): number {
  const s = String(v ?? "");
  if (/^\d{13}$/.test(s)) return parseInt(s, 10);
  if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
  const t = Date.parse(s.replace(" ", "T") + "+08:00");
  return Number.isFinite(t) ? t : Date.now();
}

export function touchChat(chatId: string, opts: {
  text: string; ts: unknown; sender: string; incrementUnread: boolean;eventId?:string;
}) {
  if (!chatId) return;
  const meta = load();
  const cur = meta[chatId];
  if(opts.eventId&&cur?.seen_event_ids?.includes(opts.eventId))return;
  const ts = parseLarkTs(opts.ts);
  // 用户点开会话之前发出的消息不算新未读——轮询最多滞后几分钟，
  // 没有这道闸，「读完清零 → 轮询扫到刚才那条 → 未读+1」角标会复活
  const inc = opts.incrementUnread && ts > (cur?.read_ts ?? 0);
  if (cur && ts < cur.last_ts) {
    // 旧消息（回填时乱序）只可能补空缺，不覆盖更新的
    if (inc) { cur.unread += 1; save(); }
    return;
  }
  meta[chatId] = {
    ...cur,
    last_text: opts.text.slice(0, 120),
    last_ts: ts,
    last_sender: opts.sender,
    unread: (inc ? (cur?.unread || 0) + 1 : cur?.unread || 0),
    seen_event_ids:opts.eventId?[...(cur?.seen_event_ids||[]),opts.eventId].slice(-200):cur?.seen_event_ids,
  };
  save();
}

export function markRead(chatId: string) {
  const meta = load();
  const cur = meta[chatId] || { last_text: "", last_ts: 0, last_sender: "", unread: 0 };
  cur.unread = 0;
  cur.read_ts = Date.now();
  meta[chatId] = cur;
  save();
}

/** 一键清除已处理：把当前所有无未读的会话按其 last_ts 打 hidden 标；来新消息自动浮回 */
export function hideReadChats(): number {
  const meta = load();
  let n = 0;
  for (const m of Object.values(meta)) {
    if (m.unread === 0 && (m.hidden_ts ?? 0) < m.last_ts) { m.hidden_ts = m.last_ts; n++; }
  }
  if (n) save();
  return n;
}

export function isChatHidden(m: ChatMeta | undefined): boolean {
  if (!m) return false;
  if (m.deleted && m.unread === 0) return true;
  return (m.hidden_ts ?? 0) >= m.last_ts && m.unread === 0;
}

/** 删除/恢复会话：删除是持久的（区别于「清除」的来消息即浮回） */
export function setChatDeleted(chatId: string, deleted: boolean) {
  const meta = load();
  const cur = meta[chatId] || { last_text: "", last_ts: 0, last_sender: "", unread: 0 };
  cur.deleted = deleted || undefined;
  meta[chatId] = cur;
  save();
}

export function chatMeta(): Record<string, ChatMeta> {
  return load();
}

/** 消息 content → 列表预览文本（兼容 JSON {"text"} 和 lark-cli 渲染文本） */
export function previewText(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    try {
      const p = JSON.parse(content);
      text = p?.text ? String(p.text) : content;
    } catch { text = content; }
  } else {
    text = String(content ?? "");
  }
  return text
    .replace(/!\[Image\]\([^)]*\)/g, "[图片]")
    .replace(/\(img_key:[^)]*\)/g, "")
    .replace(/<card title="([^"]*)"[^>]*>/g, "【卡片】$1 ")
    .replace(/<\/?[a-z][^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
