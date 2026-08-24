// 一日总结：本地 24:00（次日 00:00）聚合刚结束这天的 feed / 任务 / 已完成 Action / 会议 → AI 写日报 →
// 落 vault 的 daily/ + 推送。每天只成功一次（state.lastDigestDate 去重）；AI 失败（02:00 撞上限额是常态）
// 不占坑，改为 state.digestRetry 有界重试：每小时一次，最多 DIGEST_MAX_ATTEMPTS 次且不晚于 DIGEST_RETRY_UNTIL。
import { writeFileSync } from "fs";
import { join } from "path";
import { listActions } from "./actions.ts";
import { loadTasks } from "./dispatch.ts";
import { readFeed } from "./feed.ts";
import { hasLarkDaily, larkDailyFor, selectedLarkForDigest } from "./lark-digest.ts";
import { llmJson } from "./llm.ts";
import { notify } from "./notify.ts";
import { dailyDir, inboxDir } from "./paths.ts";
import { cfg, ensureDir, fmt, loadState, log, updateState } from "./util.ts";
import { connectorEnabled } from "./connector-config.ts";

export const DIGEST_MAX_ATTEMPTS = 8;
export const DIGEST_RETRY_UNTIL = "10:00";   // 本地时间；过了这点还没成就放弃，等手动 POST /api/digest/run?date=

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
  // 飞书夜间收割的当天消息（默认全纳入，AI 判相关；用户取消勾选的已排除）。
  // 手动触发时目标日是「今天」，桶要到明晚才结算——先即时收割一把今天的，别回退去拿昨天的旧料。
  if (force && today === firedOn && connectorEnabled(cfg, "lark") && !larkDailyFor(today).length) {
    try {
      const { pullDailyLark } = await import("./sources/lark.ts");
      await pullDailyLark({ today: true });
    } catch (e) { log(`digest: 即时收割飞书失败，继续无飞书素材生成: ${e}`); }
  }
  const larkPicks = selectedLarkForDigest(today);

  // 别把 larkPicks 算进「今天干活了」的判据：现在默认全纳入，光有别人发来的消息不代表我工作了
  const hasWork = inbox.split("\n## ").length > 1 || tasks.length > 0;
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
    ` "coding": "<编码工作：做了什么项目/任务，1-3 条，无则空字符串>",`,
    ` "comms": "<协作沟通：处理了什么消息/邮件/PR，无则空字符串>",`,
    ` "pending": "<还挂着的事/明天要跟的，无则空字符串>"}`,
    "",
    "只写「我做的事」；素材不足就少写，禁止把别人的动态或推测写成我的工作。",
    `=== 今日工作收割（第一人称证据）===`,
    inbox || "(无)",
    `=== 今日工作任务（${tasks.length}）===`,
    ...tasks.map((t) => `- [${t.project}] ${t.task.slice(0, 100)} → ${t.status}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ""}`),
    `=== 完成的行动（${doneActions.length}）===`,
    ...doneActions.map((a) => `- ${a.title} (${a.resolution})`),
    `=== 当天飞书消息（${larkPicks.length}，别人发给我的，自动收割）===`,
    "从中挑与我工作直接相关的协作往来写进 comms（谁找我对齐/评审/求助了什么）；闲聊、通知、与我无关的群消息一律忽略。",
    // (m.text || "")：脏桶（缺 text 的历史数据）只降级成空预览，别让一条坏消息炸掉全天日报——
    // 日报入口先占坑防重试，崩一次当天就没了
    ...larkPicks.map((m) => `- [${m.chat_name}] ${m.sender}: ${(m.text || "").slice(0, 120)}`),
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
  const md = [
    "---",
    `date: ${today}`,
    "tags: [daily-digest]",
    "---",
    "",
    `# ${today} 日报`,
    "",
    res.summary,
    ...(res.coding ? ["", "## 编码", res.coding] : []),
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
    if (f) notify("🧠 今日记忆候选已生成，笔记 tab → memory/_candidates 确认", { source: "heartbeat", noLark: true });
  }).catch((e) => log(`memory candidates failed: ${e}`));
  return file;
}

/** daemon 每分钟调：本地 24:00（次日 00:00）后自动生成「刚结束昨天」的日报；昨天是周末不打工不写日报 */
export function sweepDigest() {
  if (!cfg.digest?.enabled) return; // 自动日报默认关（要烧一次 AI）；手动 POST /api/digest/run 不受此限
  const at = cfg.digest?.time || "00:00"; // 触发时点：默认本地 24:00（= 00:00），到点后靠 lastDigestDate 保证当天只成功一次
  if (fmt(new Date(), "time") < at) return;
  const firedOn = fmt(new Date(), "date");
  const decision = digestRetryDecision(loadState(), firedOn, fmt(new Date(), "time"), Date.now());
  if (decision === "done" || decision === "wait") return; // 今天已成功 / 上次失败不到一小时（也防等桶的日志刷屏）
  if (decision === "give-up") {
    log(`digest: 今天重试已用尽（${DIGEST_MAX_ATTEMPTS} 次或过了 ${DIGEST_RETRY_UNTIL}），放弃；可手动 POST /api/digest/run?date=<昨天>`);
    updateState((s) => { if (s.digestRetry?.date === firedOn) s.digestRetry.gaveUp = true; });
    return;
  }
  // 要总结的是刚结束的「昨天」（与 runDailyDigest 一致，用日历昨天 = 触发日 − 1 天，不用会漂的 12h 偏移）；
  // 昨天落在周末（周六/周日）就不打工、不写日报。周一全天「昨天=周日」→ 一直跳过，不再中午冒；
  // 周一的日报顺延到周二 00:00 用整天素材正常发。
  const day = fmt(new Date(Date.now() - 24 * 3600_000), "date");
  const dow = new Date(`${day}T00:00:00`).getDay();
  if (dow === 0 || dow === 6) return;
  // 飞书收割（sweepLarkDaily）和日报同在 00:00 的分钟循环里赛跑，桶没落盘就取材会扑空——
  // 昨天的桶还没结算就先等，最多 15 分钟；超时照常生成（lark 挂了不能永远堵住日报）。
  if (connectorEnabled(cfg, "lark") && !hasLarkDaily(day)) {
    const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
    if (toMin(fmt(new Date(), "time")) - toMin(at) < 15) return;
    log("digest: 等飞书收割落盘超时（15 分钟），无飞书素材生成");
  }
  runDailyDigest().catch((e) => log(`digest failed: ${e}`));
}
