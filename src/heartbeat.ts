// 心跳：定时收集上下文包（日历/GitHub/队列/最近通知），让 LLM 按 prompts/heartbeat.md 判断是否主动提醒。
// daemon 预先收集数据，codex 只做推理——这样 codex 保持 read-only 沙箱，不需要网络。
import { readFileSync } from "fs";
import { join } from "path";
import { llmJson } from "./llm.ts";
import { notify, recentNotifications } from "./notify.ts";
import { appendNotification } from "./obsidian.ts";
import { queueSize } from "./spool.ts";
import { ROOT, cfg, fmt, inQuietHours, loadState, log, run, saveState } from "./util.ts";

export async function runHeartbeat(): Promise<void> {
  if (!cfg.heartbeat?.enabled) return;
  const st = loadState();
  st.lastHeartbeatAt = new Date().toISOString();
  saveState(st);
  if (inQuietHours()) { log("heartbeat: quiet hours, skip"); return; }

  const context = await gatherContext();
  const checklist = readFileSync(join(ROOT, "prompts", "heartbeat.md"), "utf8");

  const prompt = [
    "执行 Heartbeat 任务（规则见系统提示的决策规则）。",
    `当前时间：${fmt(new Date(), "datetime")}（${cfg.timezone}）`,
    "",
    "=== 检查清单 ===",
    checklist,
    "",
    "=== 上下文包 ===",
    context,
  ].join("\n");

  const res = await llmJson(prompt);
  if (res?.message) {
    if (await notify(`💓 ${res.message}`, { source: "heartbeat" })) appendNotification(res.message);
  } else {
    log("heartbeat: OK, nothing to report");
  }
}

async function gatherContext(): Promise<string> {
  const parts: string[] = [];

  const agenda = await run(
    ["lark-cli", "calendar", "+agenda", "--as", "user", "--format", "json"],
    { timeoutMs: 30_000 },
  );
  parts.push(`## 今日日历\n${agenda.code === 0 ? agenda.stdout.slice(0, 4000) : "(获取失败)"}`);

  const gh = await run(["gh", "api", "notifications", "--paginate=false"], { timeoutMs: 30_000 });
  if (gh.code === 0) {
    try {
      const { isPrIgnored } = await import("./github-pr.ts");
      const threads = JSON.parse(gh.stdout || "[]")
        .filter((t: any) => {
          // 已忽略的 PR 不进心跳上下文，否则 LLM 照样催（忽略只挡了工作台和 action，没挡这里）
          const repo = t.repository?.full_name;
          const num = String(t.subject?.url || "").match(/\/pulls\/(\d+)/)?.[1];
          return !(repo && num && isPrIgnored(repo, parseInt(num, 10)));
        })
        .map((t: any) => ({
          reason: t.reason, repo: t.repository?.full_name, title: t.subject?.title, type: t.subject?.type,
        }));
      parts.push(`## GitHub 未读通知\n${JSON.stringify(threads).slice(0, 3000)}`);
    } catch { /* ignore */ }
  }

  // 挂着的行动队列：心跳的催办依据（之前只有通知一次性提醒，搁置的事没人再吭声）
  const { listActions } = await import("./actions.ts");
  const open = listActions(false).map((a) => ({
    kind: a.kind, title: a.title, state: a.state,
    挂了多久: `${Math.round((Date.now() - Date.parse(a.createdAt)) / 360_000) / 10}h`,
  }));
  parts.push(`## 待处理的行动（收件箱挂着的）\n${JSON.stringify(open).slice(0, 2500)}`);

  parts.push(`## 待 triage 队列\n${queueSize()} 个事件`);
  parts.push(`## 最近已发通知（去重用）\n${JSON.stringify(recentNotifications())}`);

  const { memoryPack } = await import("./memory.ts");
  const mem = memoryPack("heartbeat");
  if (mem) parts.push(mem);
  return parts.join("\n\n");
}
