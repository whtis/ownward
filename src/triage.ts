// 事件分流：批量取队列 → codex 决策 → 执行 notify / log 动作。
import { llmJson } from "./llm.ts";
import { appendFeed } from "./feed.ts";
import { notify, recentNotifications } from "./notify.ts";
import { appendDaily, appendNotification } from "./obsidian.ts";
import { dropReactedLark } from "./sources/lark.ts";
import { ackBatch, claimBatch, releaseBatch, type QueueClaim } from "./spool.ts";
import { markClaimCompleted, pendingClaimEvents } from "./triage-checkpoint.ts";
import { cfg, fmt, inQuietHours, loadState, log, saveState } from "./util.ts";

let running = false;
export function excludeDomainOnlyEvents(events:readonly import("./spool.ts").OwnwardEvent[]){return events.filter(e=>{const key=String(e.key||"");if(e.source==="lark")return key!=="daily"&&!key.endsWith(".daily")&&key!=="card.action.trigger"&&!key.endsWith(".card.action.trigger");if(e.source==="github")return key!=="snapshot"&&!key.endsWith(".snapshot");return true;});}

export async function runTriage(): Promise<void> {
  if (running) return;
  running = true;
  let claim: QueueClaim | null = null;
  try {
    const st = loadState();
    st.lastTriageAt = new Date().toISOString();
    saveState(st);
    claim = claimBatch(cfg.triage.maxBatch || 50);
    if (!claim) return;
    const pending = pendingClaimEvents(claim);
    if (!pending.length) {
      ackBatch(claim); // 上轮副作用已完成，只是崩在 checkpoint 与 ack 之间
      claim = null;
      return;
    }
    // 飞书消息我已回过表情的 = 已处理，喂 LLM 前出队（回表情多发生在消息进队后的 triage 窗口内）
    const events = await dropReactedLark(excludeDomainOnlyEvents(pending));
    if (!events.length) {
      markClaimCompleted(claim);
      ackBatch(claim); // 已回表情是确定性过滤，明确消费
      claim = null;
      return;
    }
    log(`triage: ${events.length} event(s)`);

    const { memoryPack } = await import("./memory.ts");
    const prompt = [
      "执行 Triage 任务（规则见系统提示的决策规则）。",
      `当前时间：${fmt(new Date(), "datetime")}（${cfg.timezone}）`,
      `最近已发通知（用于去重）：${JSON.stringify(recentNotifications())}`,
      memoryPack("triage"),
      "",
      "事件（每行一个 JSON）：",
      ...events.map((e) => JSON.stringify(e)),
    ].join("\n");

    const res = await llmJson(prompt);
    if (!res) {
      releaseBatch(claim); // 决策失败，原始行放回下一轮重试
      claim = null;
      log("triage: codex failed, events requeued");
      return;
    }

    const quiet = inQuietHours();
    for (const n of res.notifications || []) {
      if (!n?.text) continue;
      if (quiet) {
        // 静默时段降级为日志，早上心跳会补提醒
        appendDaily("静默时段拦截的通知", [{ source: "triage", summary: n.text }]);
        appendFeed({ ts: new Date().toISOString(), kind: "log", source: n.source || "system", text: `(静默拦截) ${n.text}` });
      } else {
        if (await notify(n.text, { source: n.source, link: n.link, chatId: n.chat_id, mailId: n.mail_id })) {
          appendNotification(n.text);
        }
      }
    }
    if (res.log?.length) {
      appendDaily("triage", res.log);
      for (const l of res.log) {
        appendFeed({
          ts: new Date().toISOString(), kind: "log", source: l.source || "system",
          text: l.summary, detail: l.detail, link: l.link, chat_id: l.chat_id, mail_id: l.mail_id,
        });
      }
    }
    // 外部通知与本地副作用都完成后先落 checkpoint，再 ack processing。
    // 只消除 checkpoint→ack 窗口的重复；副作用中途崩溃仍可能重复——不是 exactly-once。
    markClaimCompleted(claim);
    ackBatch(claim);
    claim = null;
  } catch (e) {
    log(`triage error: ${e}`);
  } finally {
    if (claim) {
      try { releaseBatch(claim); }
      catch (e) { log(`triage release failed (claim remains recoverable ${claim.id}): ${e}`); }
    }
    running = false;
  }
}
