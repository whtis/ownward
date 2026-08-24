// 今日会议：lark-cli calendar +agenda（user 身份）。列表 5min 缓存；
// daemon 每分钟查一次"10 分钟内要开的会"推提醒（按 event_id 去重，跨重启无所谓——会只提醒当天）。
import { notify } from "./notify.ts";
import { log, run } from "./util.ts";

export interface Meeting {
  id: string;
  title: string;
  start: string;      // ISO
  end: string;
  organizer: string;
  meetingUrl: string; // 视频会议链接，空 = 无线上会
  appLink: string;    // 飞书日程详情
}

let cache: { at: number; items: Meeting[] } | null = null;

export async function todayMeetings(force = false): Promise<Meeting[]> {
  if (!force && cache && Date.now() - cache.at < 300_000) return cache.items;
  const r = await run(["lark-cli", "calendar", "+agenda", "--as", "user", "--format", "json"], { timeoutMs: 30_000 });
  let data: any[] = [];
  try { data = JSON.parse(r.stdout)?.data || []; } catch { /* 保持空 */ }
  const items: Meeting[] = data
    .map((e) => ({
      id: e.event_id || "",
      title: e.summary || "(无标题)",
      start: e.start_time?.datetime || "",
      end: e.end_time?.datetime || "",
      organizer: e.event_organizer?.display_name || "",
      meetingUrl: e.vchat?.meeting_url || "",
      appLink: e.app_link || "",
    }))
    .filter((m) => m.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  cache = { at: Date.now(), items };
  return items;
}

const reminded = new Set<string>();

/** 每分钟由 daemon 调：会前 10 分钟提醒一次 */
export async function sweepMeetingReminders() {
  try {
    const now = Date.now();
    for (const m of await todayMeetings()) {
      const start = Date.parse(m.start);
      const mins = (start - now) / 60_000;
      if (mins > 0 && mins <= 10 && !reminded.has(m.id)) {
        reminded.add(m.id);
        await notify(
          `📅 ${Math.round(mins)} 分钟后开会：${m.title}${m.organizer ? `（${m.organizer}）` : ""}${m.meetingUrl ? `\n入会: ${m.meetingUrl}` : ""}`,
          { source: "lark", link: m.meetingUrl || m.appLink },
        );
      }
    }
  } catch (e) { log(`meeting reminder failed: ${e}`); }
}
