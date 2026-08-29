// 一日总结：每日 12:30（midday 统一任务）聚合前一日的 inbox 收割 / 任务 / 已完成 Action → AI 写日报 →
// 落 vault 的 daily/ + 推送。涉及需求的编码工作按需求（git 分支/单号）维度分组。
// 每天只成功一次（state.lastDigestDate 去重）；AI 失败不占坑，改为 state.digestRetry 有界重试：
// 每小时一次，最多 DIGEST_MAX_ATTEMPTS 次且不晚于 DIGEST_RETRY_UNTIL。
import { writeFileSync } from "fs";
import { join } from "path";
import { listActions } from "./actions.ts";
import { loadTasks } from "./dispatch.ts";
import { llmJson } from "./llm.ts";
import { notify } from "./notify.ts";
import { dailyDir, inboxDir } from "./paths.ts";
import { ensureDir, fmt, loadState, log, updateState } from "./util.ts";

export const DIGEST_MAX_ATTEMPTS = 8;
export const DIGEST_RETRY_UNTIL = "18:00";   // 本地时间；12:30 首跑失败后每小时重试，过了这点还没成就放弃，等手动 POST /api/digest/run?date=

export interface DigestRetry { date: string; attempts: number; lastAt: string; gaveUp?: boolean }

/** 纯决策：今天（firedOn）是否该再试一次。返回 "run" | "wait" | "give-up" | "done"。 */
export function digestRetryDecision(state: { lastDigestDate?: string; digestRetry?: DigestRetry }, firedOn: string, nowTime: string, nowMs: number): "run" | "wait" | "give-up" | "done" {
  if (state.lastDigestDate === firedOn) return "done";
  const r = state.digestRetry;
  if (!r || r.date !== firedOn) return "run";            // 今天还没试过
  if (r.gaveUp) return "done";
  if (r.attempts >= DIGEST_MAX_ATTEMPTS || nowTime > DIGEST_RETRY_UNTIL) return "give-up";
  if (nowMs - Date.parse(r.lastAt) < 55 * 60_000) return "wait";   // 一小时一次，别对着限额狂撞
  return "run";
}

export async function runDailyDigest(force = false, dateOverride?: string): Promise<string | null> {
  const now = new Date();
  const firedOn = fmt(now, "date"); // 触发日（去重键）：本地 24:00 跨入的这一天，保证每天只成功一次
  if (!force && loadState().lastDigestDate === firedOn) return null;
  // 成功才占坑（见文件头）；失败记 digestRetry 交给 sweepDigest 有界重试
  const markDone = () => updateState((s) => { s.lastDigestDate = firedOn; delete s.digestRetry; });
  const markFailed = () => updateState((s) => {
    const prev: DigestRetry | undefined = s.digestRetry?.date === firedOn ? s.digestRetry : undefined;
    s.digestRetry = { date: firedOn, attempts: (prev?.attempts || 0) + 1, lastAt: new Date().toISOString() } satisfies DigestRetry;
  });
  // 自动触发总结「刚结束的那一天」= 日历意义上的昨天（触发日 − 1 天）。
  // 手动触发（force，来自 POST /api/digest/run，白天点的）直接总结当天；
  // ?date=YYYY-MM-DD 可补生成指定日（自动日报崩了之后补昨天的用这个）。
  // 用整 24h 回退取昨天（上海无夏令时，减 24h 就是同一钟点的前一天）——
  // 不能用 now−12h：一旦因周末跳过被卡到白天再触发，12h 偏移会漂成「今天」，
  // 结果周一中午冒出一条半天日报（见 sweepDigest 的周末处理）。
  const today = force ? (dateOverride || firedOn) : fmt(new Date(now.getTime() - 24 * 3600_000), "date");

  const { projectScope } = await import("./memory.ts");
  const { personal } = projectScope();
  const isPersonal = (s: string) => personal.some((p) => p && s.toLowerCase().includes(p.toLowerCase()));
  // 日报 = 「我今天做了什么」。素材只用第一人称证据：inbox 的收割记录 + 工作任务 + 完成的行动。
  // feed 是「我观察到什么」（同事的 PR、CI 通知），绝不能混进日报——那不是我干的活。
  const { existsSync, readFileSync } = await import("fs");
  const inboxFile = join(inboxDir(), `${today}.md`);
  const inbox = existsSync(inboxFile) ? readFileSync(inboxFile, "utf8").slice(0, 20_000) : "";
  const tasks = loadTasks().filter((t) => fmt(new Date(t.startedAt), "date") === today && !isPersonal(t.project));
  const doneActions = listActions().filter((a) => a.state === "resolved" && fmt(new Date(a.updatedAt), "date") === today);

  // 飞书块（| lark |）不算「我今天干活了」的证据：光有别人找我，不代表我工作了
  const workBlocks = inbox.split("\n## ").slice(1).filter((b) => !b.includes(" | lark |"));
  const hasWork = workBlocks.length > 0 || tasks.length > 0;
  if (!hasWork) {
    log("digest: 今天没有工作记录（inbox 空、无工作任务），不生成日报");
    if (!force) markDone();   // 没素材不是失败，今天不用再试
    return null;
  }

  const { memoryPack, extractCandidates } = await import("./memory.ts");
  const prompt = [
    "根据下面的活动记录，写今天的工作日报（第一人称「我」视角）。输出严格 JSON（不要代码块）：",
    `【红线】只写公司工作；以下私人项目即使出现在素材里也不能写：${personal.join("、")}。`,
    memoryPack("digest"),
    `{"summary": "<两三句话的当日概览>",`,
    ` "requirements": [{"name": "<需求标识：git 分支或需求单号（如 TPSSO-52744），认不出就用项目名>", "work": "<这个需求下我做了什么，一两句>"}],`,
    ` "other_coding": "<不属于任何明确需求的编码工作，无则空字符串>",`,
    ` "comms": "<协作沟通：处理了什么消息/邮件/PR，无则空字符串>",`,
    ` "pending": "<还挂着的事/明天要跟的，无则空字符串>"}`,
    "",
    "只写「我做的事」；素材不足就少写，禁止把别人的动态或推测写成我的工作。",
    "涉及需求的编码工作按需求维度分组进 requirements（同一分支/单号的工作并成一条）；分不出需求归属的进 other_coding。",
    "inbox 里 | lark | 块是飞书里别人发给我的协作消息（AI 已粗筛），只把与我工作直接相关的往来写进 comms，闲聊不写。",
    `=== 今日工作收割（第一人称证据）===`,
    inbox || "(无)",
    `=== 今日工作任务（${tasks.length}）===`,
    ...tasks.map((t) => `- [${t.project}] ${t.task.slice(0, 100)}${t.branch ? `（分支 ${t.branch}）` : ""} → ${t.status}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ""}`),
    `=== 完成的行动（${doneActions.length}）===`,
    ...doneActions.map((a) => `- ${a.title} (${a.resolution})`),
  ].join("\n");

  const res = await llmJson(prompt);
  if (!res?.summary) {
    if (force) { log("digest: AI 总结失败"); return null; }
    markFailed();
    const attempts = loadState().digestRetry?.attempts || 1;
    log(`digest: AI 总结失败（第 ${attempts}/${DIGEST_MAX_ATTEMPTS} 次，约 1 小时后重试，最晚 ${DIGEST_RETRY_UNTIL}）`);
    return null;
  }

  // 日报是派生结果，落 <scope>/daily
  const dir = dailyDir();
  ensureDir(dir);
  const file = join(dir, `${today}.md`);
  const reqs = (Array.isArray(res.requirements) ? res.requirements : [])
    .filter((r: any) => r?.name && r?.work)
    .map((r: any) => ({ name: String(r.name).slice(0, 60), work: String(r.work) }));
  const md = [
    "---",
    `date: ${today}`,
    "tags: [daily-digest]",
    "---",
    "",
    `# ${today} 日报`,
    "",
    res.summary,
    ...(reqs.length ? ["", "## 需求", ...reqs.flatMap((r) => ["", `### ${r.name}`, r.work])] : []),
    ...(res.other_coding ? ["", "## 其他编码", res.other_coding] : []),
    ...(res.comms ? ["", "## 协作", res.comms] : []),
    ...(res.pending ? ["", "## 待跟进", res.pending] : []),
    "",
    `> Ownward 自动生成 · ${fmt(new Date(), "datetime")}`,
    "",
  ].join("\n");
  writeFileSync(file, md);
  if (!force) markDone();
  await notify(`📋 今日日报已生成\n${String(res.summary).slice(0, 120)}`, { source: "heartbeat" });
  log(`digest → ${file}`);

  // 顺带提取候选记忆（只进 _candidates/，人工确认后合并进正式记忆）
  extractCandidates(prompt).then((f) => {
    if (f) notify("🧠 今日记忆候选已生成，角色 tab → memory/_candidates 确认", { source: "heartbeat", noLark: true });
  }).catch((e) => log(`memory candidates failed: ${e}`));
  return file;
}
