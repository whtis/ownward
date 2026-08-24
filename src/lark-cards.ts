// 飞书互动卡片：把最常见的两类决策搬到飞书，离开电脑也能点——
//   ① agent 高危操作审批（批准/拒绝）+ 提问（选项按钮）；② routine 草稿 写入/跳过。
// 发卡走 bot 身份的 interactive 消息；点按钮的回调走 card.action.trigger 事件
// （daemon 的 lark 消费循环把这个 key 分流到 handleCardAction）。
// 需在飞书开发者后台「事件与回调 → 回调配置」启用 card.action.trigger，否则收不到点击。
import { DATA, cfg, log, run } from "./util.ts";

/** 发一张互动卡片给你本人（bot 身份 DM）。返回 message_id（回写卡片用）或 null。 */
async function sendCard(card: object): Promise<string | null> {
  if (cfg.notify.lark === false || !cfg.notify.larkUserId) return null;
  const r = await run([
    "lark-cli", "im", "+messages-send", "--as", "bot",
    "--user-id", cfg.notify.larkUserId, "--msg-type", "interactive",
    "--content", JSON.stringify(card), "--format", "json",
  ], { timeoutMs: 30_000 });
  if (r.code !== 0) { log(`lark card send failed: ${r.stderr.slice(0, 150)}`); return null; }
  try { const d = JSON.parse(r.stdout); return d.data?.message_id || d.message_id || null; } catch { return null; }
}

type BtnType = "default" | "primary" | "danger";
function button(text: string, value: object, type: BtnType = "default") {
  return { tag: "button", text: { tag: "plain_text", content: text.slice(0, 18) }, type, value };
}

/** Card 1.0：标题栏 + 一段 markdown + 一行按钮 */
function card(title: string, template: string, bodyMd: string, actions: object[]) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: bodyMd.slice(0, 1500) } },
      { tag: "action", actions },
    ],
  };
}

// ---- 发卡（各决策点调用）----

/** 高危操作审批卡（二元批准） */
export function sendPermCard(taskId: string, requestId: string, brief: string): Promise<string | null> {
  return sendCard(card("🔐 等待审批", "orange", `任务 \`${taskId}\`\n${brief}`, [
    button("批准", { t: "perm", taskId, requestId, allow: true }, "primary"),
    button("拒绝", { t: "perm", taskId, requestId, allow: false }, "danger"),
  ]));
}

/** 任务提问卡（AskUserQuestion，选项各一个按钮 + 跳过） */
export function sendQuestionCard(taskId: string, requestId: string, question: string, options: string[]): Promise<string | null> {
  const btns = options.slice(0, 4).map((o) => button(o, { t: "perm", taskId, requestId, answer: o }));
  btns.push(button("跳过", { t: "perm", taskId, requestId, answer: "" }));
  return sendCard(card("❓ 任务提问", "blue", question, btns));
}

/** 自测卡：点一下验证「发卡 → 点击 → 回调 → 回写卡片」整条链路是否通（尤其后台回调是否已在飞书启用） */
export function sendPingCard(): Promise<string | null> {
  return sendCard(card("🧪 Ownward 卡片自测", "grey", "点下面的按钮：能变成「链路正常」就说明飞书回调已启用、审批/routine 卡片可用。", [
    button("测试回调", { t: "ping" }, "primary"),
  ]));
}

/** routine 草稿 写入/跳过卡 */
export function sendRoutineCard(id: string, date: string, name: string, time: string, draftPreview: string): Promise<string | null> {
  const body = `**${time} 截止**\n\n${draftPreview}`;
  return sendCard(card(`📋 ${name}`, "green", body, [
    button("写入文档", { t: "routine", id, date, act: "write" }, "primary"),
    button("跳过", { t: "routine", id, date, act: "skip" }),
  ]));
}

// ---- 回调分发（daemon lark 消费循环遇到 card.action.trigger 调这里）----

export async function handleCardAction(payload: any): Promise<void> {
  // 正向断言操作者是本人（安全评审 MED#4）：原来是「有 operator_id 且不等才拒」，operator_id 缺失时
  // 反而绕过校验、opId 还退化成本人 id——伪造/中继一个空 operator_id 的事件就能替你批准危险审批。
  // 改为「必须明确等于本人，否则拒」。
  if (!payload.operator_id || !cfg.notify.larkUserId || payload.operator_id !== cfg.notify.larkUserId) {
    log(`lark card: rejected action (operator=${payload.operator_id || "missing"})`);
    return;
  }
  let v: any;
  try { v = JSON.parse(payload.action_value || "{}"); } catch { return; }
  const token: string = payload.token || "";
  const opId: string = payload.operator_id;
  try {
    if (v.t === "ping") {
      await updateCard(token, opId, "✅ 卡片回调链路正常——审批 / routine 都能在飞书点了");
    } else if (v.t === "perm") {
      const isAnswer = v.answer !== undefined;            // 提问：答案走 deny+message 通道
      const { SessionRepository } = await import("./sessions/repository.ts");
      const session = new SessionRepository(DATA).getByTaskId(v.taskId);
      if (!session) throw Object.assign(new Error("Session 不存在"), { code: "SESSION_NOT_FOUND" });
      const service = (await import("./session-service.ts")).createSessionService(v.taskId, [session.cwd, ...(session.extraDirs ?? [])]);
      await service.respondApproval(v.taskId, v.requestId, { allow: isAnswer ? false : !!v.allow, ...(isAnswer ? { message: v.answer } : {}) });
      const label = isAnswer ? `已回答：${v.answer || "跳过"}` : (v.allow ? "✅ 已批准" : "⛔ 已拒绝");
      await updateCard(token, opId, label);
    } else if (v.t === "routine") {
      const { occState, writeRoutine, skipRoutine } = await import("./routines.ts");
      if (v.act === "write") {
        const s = occState(v.id, v.date);
        if (s?.status === "writing" || s?.status === "written") {
          await updateCard(token, opId, s.status === "written" ? "已写入" : "✍️ 已在写入");  // 防重复点两次派两个任务
        } else {
          await writeRoutine(v.id, v.date);
          await updateCard(token, opId, "✍️ 已派发写入（任务页可旁观）");
        }
      } else {
        skipRoutine(v.id, v.date);
        await updateCard(token, opId, "已跳过");
      }
    }
  } catch (e) {
    await updateCard(token, opId, `处理失败：${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
  }
}

/** 回写卡片：把整张卡换成一行结果文字（token 有效 30min、最多 2 次）。
 *  Card 1.0 更新必须带 open_ids（否则 code 300090）。失败只记日志，不影响决策已生效。 */
async function updateCard(token: string, operatorId: string, result: string): Promise<void> {
  if (!token || token === "[REDACTED]") return;
  const newCard = {
    config: { wide_screen_mode: true },
    open_ids: [operatorId],
    elements: [{ tag: "div", text: { tag: "lark_md", content: result } }],
  };
  const r = await run([
    "lark-cli", "api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
    "--data", JSON.stringify({ token, card: newCard }),
  ], { timeoutMs: 20_000 });
  if (r.code !== 0) log(`lark card update failed: ${r.stderr.slice(0, 120)}`);
}
