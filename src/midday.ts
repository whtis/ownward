// 每日 12:30 统一任务（daemon 60s tick，到点当天只跑一次）：
//   ① 前一日日报（daily-digest，按需求分组；AI 失败每小时重试到 18:00，复用 digestRetry 机制）
//   ② daemon 决策 transcript 清理（原 6h 独立定时器并入）
// ①有 feature 开关（digest，系统设置页可配，默认开）；②是零成本本地清理，常开。
// 邮件精选已迁至 external vertical corp-outlook（公司 vertical 仓），不在此编排。
import { digestRetryDecision, DIGEST_MAX_ATTEMPTS, DIGEST_RETRY_UNTIL, runDailyDigest } from "./daily-digest.ts";
import { featureEnabled } from "./features.ts";
import { sweepDaemonTranscripts } from "./session-cleanup.ts";
import { fmt, loadState, log, updateState } from "./util.ts";

export const MIDDAY_TIME = "12:30";   // 本地触发时点：上午的收割都已落盘，午休前出前一日日报

export function sweepMidday() {
  if (fmt(new Date(), "time") < MIDDAY_TIME) return;
  const firedOn = fmt(new Date(), "date");
  if (featureEnabled("digest")) runDigestPart(firedOn);
  runCleanupPart(firedOn);
}

/** ① 日报：昨天是周末不写（与旧 sweepDigest 一致：周一的顺延到周二用整天素材）；重试决策复用 digestRetryDecision */
function runDigestPart(firedOn: string) {
  const decision = digestRetryDecision(loadState(), firedOn, fmt(new Date(), "time"), Date.now());
  if (decision === "done" || decision === "wait") return;   // 今天已成功 / 上次失败不到一小时
  if (decision === "give-up") {
    log(`digest: 今天重试已用尽（${DIGEST_MAX_ATTEMPTS} 次或过了 ${DIGEST_RETRY_UNTIL}），放弃；可手动 POST /api/digest/run?date=<昨天>`);
    updateState((s) => { if (s.digestRetry?.date === firedOn) s.digestRetry.gaveUp = true; });
    return;
  }
  const day = fmt(new Date(Date.now() - 24 * 3600_000), "date");
  const dow = new Date(`${day}T00:00:00`).getDay();
  if (dow === 0 || dow === 6) return;
  runDailyDigest().catch((e) => log(`digest failed: ${e}`));
}

/** ② daemon 决策 transcript 清理：同步快扫，一天一次 */
function runCleanupPart(firedOn: string) {
  if (loadState().lastTranscriptCleanup === firedOn) return;
  try {
    sweepDaemonTranscripts();
    updateState((s) => { s.lastTranscriptCleanup = firedOn; });
  } catch (e) { log(`session cleanup: ${e}`); }
}
