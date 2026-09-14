// 会议文档取材：把晨会/周会这类「每周一张表、行=人」的飞书文档，按取材窗口和人名抽成纯文本素材。
// 月度复盘要覆盖的不只是本人 vault 里的工作日志，还有同项目同事在晨会/周会里已经整理过的条目——
// 那是经过人手的一手记录，比 commit 日志更接近「产品进展 / 运营动作」的口径，所以排在素材最前面。
import { log, run } from "./util.ts";
import { archiveMeetingSource, contentHash, MAX_MEETING_BYTES, readMeetingArchive, type MeetingSource } from "./meeting-archive.ts";

export interface MeetingRow {
  week: string;        // 周标题原文，如 "08.31-09.04"
  section: string;     // 表格所属的二级标题（周会文档里有「研发复盘」「质量复盘」），晨会没有则为空
  person: string;      // 飞书显示名，如 "Alex 张三"
  cells: { col: string; text: string }[];
  partialWeek?: boolean;
}

/** 拉飞书文档正文（lark-cli docs +fetch，user 身份）。失败抛错，由调用方决定降级。 */
export async function fetchDocContent(docUrl: string): Promise<string> {
  const r = await run(
    ["lark-cli", "docs", "+fetch", "--doc", docUrl, "--as", "user", "--doc-format", "markdown", "--format", "json"],
    { timeoutMs: 90_000, env: { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1" } },
  );
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 200) || r.stdout.slice(0, 200) || `lark-cli exit ${r.code}`);
  const parsed = JSON.parse(r.stdout);
  const content = parsed?.data?.document?.content ?? parsed?.document?.content ?? parsed?.content;
  if (typeof content !== "string") throw new Error("文档内容为空");
  if (Buffer.byteLength(content) > MAX_MEETING_BYTES) throw new Error("会议原文超过 2 MiB 上限");
  return content;
}

/** 周标题 → 日期区间。兼容 "08.31-09.04" / "0831-0904" / "0511 - 0515"；
 *  跨年的周（12.29-01.02）用 year 和 year±1 各试一遍，谁能落到窗口里算谁。 */
export function parseWeekRange(heading: string, year: number): { start: string; end: string }[] {
  const m = heading.replace(/^#+\s*/, "").match(/^(\d{2})\.?(\d{2})\s*[-–~]\s*(\d{2})\.?(\d{2})\b/);
  if (!m) return [];
  const [, sm, sd, em, ed] = m;
  const out: { start: string; end: string }[] = [];
  for (const y of [year, year - 1, year + 1]) {
    const start = `${y}-${sm}-${sd}`;
    let endYear = y;
    if (`${em}${ed}` < `${sm}${sd}`) endYear = y + 1;   // 12.29-01.02
    const end = `${endYear}-${em}-${ed}`;
    if (![start, end].every((s) => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(+d) && d.toISOString().slice(0, 10) === s; })) continue;
    if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 6) continue;
    out.push({ start, end });
  }
  return out;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

/** 格子 HTML → 可读文本：列表变缩进的 "- "，文档/人员引用变标题/姓名，其余标签丢掉。 */
export function cellToText(html: string): string {
  let depth = 0;
  let out = "";
  const re = /<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    const tag = m[0];
    const name = tag.match(/^<\/?([a-zA-Z0-9]+)/)?.[1]?.toLowerCase() || "";
    const closing = tag.startsWith("</");
    if (name === "cite") {
      const title = tag.match(/\btitle="([^"]*)"/)?.[1];
      const user = tag.match(/\buser-name="([^"]*)"/)?.[1];
      if (user) out += user;
      else if (title) out += `「文档：${unescapeHtml(title)}」`;
    } else if (name === "ol" || name === "ul") {
      if (closing) { depth = Math.max(0, depth - 1); out += "\n"; } else depth++;
    } else if (name === "li") {
      if (!closing) out += `\n${"  ".repeat(Math.max(0, depth - 1))}- `;
    } else if (name === "hr" || name === "br" || (closing && (name === "p" || name === "div" || name === "tr"))) {
      out += "\n";
    }
  }
  out += html.slice(last);
  return unescapeHtml(out)
    .split("\n").map((l) => l.replace(/\s+$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 从文档正文里抽出「窗口内的周 × 指定人」的行。
 *  days 是取材窗口覆盖的 YYYY-MM-DD 列表；people 是显示名子串（"张三"能匹配 "Alex 张三"）。 */
export function extractMeetingRows(content: string, days: string[], people: string[], diagnostics: string[] = []): MeetingRow[] {
  if (!days.length || !people.length) return [];
  const sorted = [...days].sort();
  const [winStart, winEnd] = [sorted[0], sorted[sorted.length - 1]];
  const year = Number(winStart.slice(0, 4));
  const rows: MeetingRow[] = [];
  // 一级标题切周；周会文档在周下还有二级标题（研发复盘/质量复盘），表格归属最近的二级标题
  const sections = content.split(/^(?=# )/m);
  for (const sec of sections) {
    const heading = sec.split("\n", 1)[0];
    const ranges = parseWeekRange(heading, year);
    const range = ranges.find((r) => r.start <= winEnd && r.end >= winStart);
    if (!range) continue;
    const week = heading.replace(/^#+\s*/, "").trim();
    // 按二级标题再切，表格跟着它前面的 ## 走
    const subs = sec.split(/^(?=## )/m);
    for (const sub of subs) {
      const subHeading = sub.startsWith("## ") ? cellToText(sub.split("\n", 1)[0].replace(/^##\s*/, "")).trim() : "";
      // 标签都按「可带属性」匹配（<td style=…>），lark-cli 目前吐的是裸标签，但少一个属性容忍整张表就静默丢光
      for (const table of sub.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || []) {
        if (/\b(?:rowspan|colspan)\s*=\s*["']?(?!1(?:["'\s>]))\d+/i.test(table)) { diagnostics.push(`${week} ${subHeading}：合并单元格暂不支持，已跳过此表，请人工核对原文`); continue; }
        const trs = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
        const cellHtml = (tr: string) => (tr.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => c.replace(/^<t[dh]\b[^>]*>/i, "").replace(/<\/t[dh]>$/i, ""));
        const headers = cellHtml(trs[0] || "").map(cellToText);
        if (!headers.length || !/人员|姓名|成员/.test(headers[0])) continue;
        for (const tr of trs.slice(1)) {
          const tds = cellHtml(tr);
          if (!tds.length) continue;
          const person = tds[0].match(/\buser-name="([^"]*)"/)?.[1] || cellToText(tds[0]);
          const normalizedPerson = person.trim().replace(/\s+/g, " ");
          if (!people.some((p) => {
            const want = p.trim().replace(/\s+/g, " ");
            return !!want && (normalizedPerson === want || normalizedPerson.split(/[\s·|,，、]+/).includes(want));
          })) continue;
          if (tds.length !== headers.length) { diagnostics.push(`${week} ${person}：列数与表头不符，已跳过此行`); continue; }
          const cells = tds.slice(1).map((c, i) => ({ col: headers[i + 1], text: cellToText(c) }))
            .filter((c) => {
              const dateLabel = c.col.match(/^(\d{1,2})[./-](\d{1,2})$/);
              if (dateLabel) {
                const day = `${year}-${String(Number(dateLabel[1])).padStart(2, "0")}-${String(Number(dateLabel[2])).padStart(2, "0")}`;
                if (day < winStart || day > winEnd || day < range.start || day > range.end) return false;
              }
              const weekday = c.col.match(/(?:周|星期)([一二三四五六日天])/);
              if (weekday) {
                const start = new Date(`${range.start}T00:00:00Z`);
                const targetDow = weekday[1] === "天" ? 0 : ("日一二三四五六".indexOf(weekday[1]));
                start.setUTCDate(start.getUTCDate() + (targetDow - start.getUTCDay() + 7) % 7);
                const day = start.toISOString().slice(0, 10);
                if (day < winStart || day > winEnd || day > range.end) return false;
              }
              return c.text && !/^计划：结果：$/.test(c.text.replace(/\s+/g, ""));
            });
          if (cells.length) rows.push({ week, section: subHeading, person, cells, ...(range.start < winStart || range.end > winEnd ? { partialWeek: true } : {}) });
        }
      }
    }
  }
  return rows;
}

/** 渲染成 prompt 素材段。按周 → 人 排，格子按列名标出。 */
export function renderMeetingRows(label: string, rows: MeetingRow[]): string {
  if (!rows.length) return "";
  const parts: string[] = [];
  for (const r of rows) {
    const head = [label, r.week, r.section, r.person].filter(Boolean).join(" · ");
    const body = r.cells.map((c) => `[${c.col}]\n${c.text}`).join("\n");
    parts.push(`----- ${head} -----\n${r.partialWeek ? "[跨月周：每日列仅取窗口内；目标、达成情况、下周计划等非日期列是整周背景，不可当作本月已完成事实]\n" : ""}${body}`);
  }
  return parts.join("\n\n");
}

/** 一步到位：拉文档 → 抽行 → 渲染。拉取失败不抛，返回一段说明让草稿照常生成（prompt 能看到缺了什么）。 */
export async function meetingNotesMaterial(label: string, docUrl: string, days: string[], people: string[], cap = 30_000, opts: {
  dryRun?: boolean; root?: string; fetch?: typeof fetchDocContent; sources?: MeetingSource[]; warnings?: string[]; archive?: boolean; allowMissingSources?: boolean;
} = {}): Promise<string> {
  try {
    let content: string, source: MeetingSource, stale = "";
    if (opts.archive === false) {
      const archived = await readMeetingArchive(docUrl, opts.root);
      if (!archived) throw new Error("会议材料尚未归档，请先刷新会议归档");
      content = archived.content;
      source = { url: archived.url, hash: archived.hash, fetchedAt: archived.fetchedAt };
    } else {
    try {
      content = await (opts.fetch || fetchDocContent)(docUrl);
      if (Buffer.byteLength(content) > MAX_MEETING_BYTES) throw new Error("会议原文超过 2 MiB 上限");
    } catch (e) {
      const archived = await readMeetingArchive(docUrl, opts.root);
      if (!archived) throw e;
      content = archived.content;
      stale = `\n[离线旧快照：拉取失败；使用 ${archived.fetchedAt} 归档，内容可能过期，请审核原文]`;
      opts.warnings?.push(`${label}：离线旧快照，抓取于 ${archived.fetchedAt}`);
      source = { url: archived.url, hash: archived.hash, fetchedAt: archived.fetchedAt };
    }
    if (!stale) source = opts.dryRun ? { url: docUrl, hash: contentHash(content), fetchedAt: new Date().toISOString() } : await archiveMeetingSource(docUrl, content, opts.root);
    }
    opts.sources?.push(source!);
    const diagnostics: string[] = [];
    const rows = extractMeetingRows(content, days, people, diagnostics);
    opts.warnings?.push(...diagnostics);
    const provenance = `来源：${docUrl}\n指纹：${source!.hash}；抓取：${source!.fetchedAt}${stale}`;
    const warnings = diagnostics.length ? `\n[取材诊断]\n${diagnostics.join("\n")}` : "";
    if (!rows.length) {
      if (opts.archive === false && !opts.allowMissingSources) throw new Error("归档中没有该期间和人员的可用条目，请检查来源、人员和月份");
      return `===== ${label}记录 =====\n${provenance}${warnings}\n(窗口内没有${people.length ? ` ${people.join("、")} ` : "指定人员"}的可用条目)`;
    }
    const text = renderMeetingRows(label, rows);
    if (text.length > cap) opts.warnings?.push(`${label}：会议素材已截断，请结合归档原文审核`);
    return `===== ${label}记录（${people.join("、")}，共 ${rows.length} 行）=====\n${provenance}${warnings}\n${text.slice(0, cap)}${text.length > cap ? "\n[会议素材已截断；请结合归档原文审核]" : ""}`;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (opts.archive === false && !opts.allowMissingSources) throw new Error(`${label}：${msg}；可在设置页刷新会议归档`);
    log(`meeting notes fetch failed [${label}]: ${msg}`);
    opts.warnings?.push(`${label}：取材失败，无可用归档，请补充材料`);
    return `===== ${label}记录 =====\n(拉取失败：${msg.slice(0, 120)}；本次只能依据工作日志)`;
  }
}
