// 飞书「夜间收割」存储：每晚 24:00 把当天跟我有关的消息落盘，默认全部纳入当日工作总结
// （daily-digest，AI 自行判相关性）；飞书 tab 取消勾选 = 排除某条。按日期分桶：{ "YYYY-MM-DD": LarkDailyMsg[] }。
import { readFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir, fmt, log } from "./util.ts";
import { writeFileAtomic } from "./fs-durable.ts";

export interface LarkDailyMsg {
  id: string;          // message_id
  chat_id: string;
  chat_type: string;   // p2p | group
  chat_name: string;   // 尽力取到的会话名
  sender: string;
  ts: number;          // epoch ms
  text: string;        // 预览文本
  selected: boolean;   // 是否纳入工作总结（收割时默认 true；用户取消勾选 = 排除）
}

const FILE = join(DATA, "lark-digest.json");
let cache: Record<string, LarkDailyMsg[]> | null = null;

function load(): Record<string, LarkDailyMsg[]> {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(FILE, "utf8")); }
    catch (e) {
      // 文件不存在是正常首次；能读到却解析失败 = 数据损坏，必须可观测（不然下一次 save 会静默覆盖丢光）
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log(`[lark-digest] ${FILE} 解析失败，按空桶重建：${e}`);
      cache = {};
    }
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  writeFileAtomic(FILE, JSON.stringify(cache, null, 2));
}

/** 落盘某天的收割结果：按 message_id 去重合并，保留已有勾选状态；只保留最近 14 天分桶。 */
export function saveLarkDaily(date: string, msgs: LarkDailyMsg[]) {
  const store = load();
  const existing = new Map((store[date] || []).map((m) => [m.id, m]));
  for (const m of msgs) {
    const prev = existing.get(m.id);
    existing.set(m.id, prev ? { ...m, selected: prev.selected } : m);
  }
  store[date] = [...existing.values()].sort((a, b) => a.ts - b.ts);
  // 清理老分桶，避免文件无限增长
  const keep = 14;
  const dates = Object.keys(store).sort().reverse().slice(0, keep);
  cache = Object.fromEntries(dates.map((d) => [d, store[d]]));
  save();
}

export function larkDailyFor(date: string): LarkDailyMsg[] {
  return load()[date] || [];
}

/** 某天是否已收割落盘（空数组也算已结算，区别于「还没跑/失败」）。 */
export function hasLarkDaily(date: string): boolean {
  return !!load()[date];
}

/** 最近有收割记录的日期（默认给飞书 tab 展示最新一天）。 */
export function latestLarkDailyDate(): string {
  const dates = Object.keys(load()).sort();
  return dates[dates.length - 1] || fmt(new Date(), "date");
}

export function toggleLarkMsg(date: string, id: string, selected: boolean): boolean {
  const store = load();
  const list = store[date];
  if (!list) return false;
  const m = list.find((x) => x.id === id);
  if (!m) return false;
  m.selected = selected;
  save();
  return true;
}

export function selectAllLarkMsgs(date: string, selected: boolean): number {
  const store = load();
  const list = store[date] || [];
  for (const m of list) m.selected = selected;
  save();
  return list.length;
}

/** 供 daily-digest 取用：优先今天分桶；今天还没收割（分桶不存在）则回退到昨天，
 *  以兼容「digest 18:30 当天生成」和「24:00/次日重生成」两种时机。返回已勾选的消息。 */
export function selectedLarkForDigest(digestDate: string): LarkDailyMsg[] {
  const store = load();
  const yday = fmt(new Date(new Date(`${digestDate}T00:00:00+08:00`).getTime() - 86400_000), "date");
  const bucketDate = store[digestDate] ? digestDate : (store[yday] ? yday : null);
  if (!bucketDate) return [];
  return (store[bucketDate] || []).filter((m) => m.selected);
}
