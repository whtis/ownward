"use strict";
/* 今日 tab：Action 行动队列（一等对象）+ 助理货架 + 领域管家 + 本周目标 + 注意力收件箱 + routine 职责卡 + 今日会议 */

const Today = { actions: [], shelf: [], goals: null, stewards: [], attention: [], routines: [], meetings: [], timer: null, draftCtx: null, loading: true, meetingsLoading: true, errors: {}, multi: false, picked: new Set(), stageOpen: new Set(), stageView: {} };

TABS.today = {
  init(root) {
    root.innerHTML = `
      <div class="today-page">
        <div class="today-page-head">
          <div>
            <div class="eyebrow">TODAY</div>
            <h1>今天，先处理重要的事</h1>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="button secondary sm" id="td-quick-note" title="记一条到今天的 Ownward 流水（与 triage/通知同一份日志；不进日报）">随手记</button>
            <button class="button secondary sm" id="td-refresh">刷新</button>
          </div>
        </div>
        <div class="today-brief" id="td-brief"></div>
        <div class="today-stewards" id="td-stewards" hidden></div>
        <div class="today-grid">
          <section class="today-focus" aria-labelledby="td-focus-title">
            <div class="section-head">
              <div><h2 id="td-focus-title">今日焦点</h2><p>需要你亲自判断或推进</p></div>
              <button class="button ghost sm" id="td-multi" title="批量完成/忽略/暂缓不需要你亲自处理的行动项">多选</button>
            </div>
            <div id="td-actions"></div>
            <div class="today-shelf" id="td-shelf" hidden>
              <div class="section-head compact"><div><h2>💡 助理观察与建议</h2><p>心跳顺手看到的，采纳了才会动手</p></div></div>
              <div id="td-shelf-list"></div>
            </div>
          </section>
          <aside class="today-side">
            <section class="today-goals" id="td-goals" aria-labelledby="td-goals-title" hidden>
              <div class="section-head compact"><div><h2 id="td-goals-title">🎯 本周长效目标 (Active Goals)</h2><p id="td-goals-week"></p></div></div>
              <div class="panel goals-panel" id="td-goals-list"></div>
            </section>
            <section aria-labelledby="td-attention-title">
              <div class="section-head compact"><div><h2 id="td-attention-title">运行关注</h2><p>卡住或等待收尾的会话</p></div></div>
              <div id="td-attention"></div>
            </section>
            <section aria-labelledby="td-meetings-title">
              <div class="section-head compact"><div><h2 id="td-meetings-title">今日会议</h2><p>接下来的时间安排</p></div></div>
              <div class="panel meeting-panel" id="td-meetings"><div class="empty">未接入飞书日历</div></div>
            </section>
          </aside>
          <section class="today-routines" aria-labelledby="td-routines-title">
            <div class="section-head"><div><h2 id="td-routines-title">周期职责</h2><p>按节奏完成的固定交付</p></div><div id="td-routines-head"></div></div>
            <div id="td-routines"></div>
          </section>
        </div>
      </div>
      `;
    $("#td-refresh").addEventListener("click", () => loadToday());
    $("#td-multi").addEventListener("click", tdToggleMulti);
    // 随手记：写今天的 Ownward 流水（vault 的 ownward/<日期>.md），跟当前在看什么无关。
    // 原先摆在笔记编辑器的「保存」旁边，看着像「把这篇笔记追加到今日」——它从来不碰当前文件
    $("#td-quick-note").addEventListener("click", async () => {
      const text = prompt("随手记一条，进今天的 Ownward 流水（不进日报）：");
      if (!text?.trim()) return;
      toast((await post("/api/vault/append-today", { text })).msg || "已记下");
    });
    bindDraftModal();
    loadToday();
  },
  show() {
    loadToday();
    Today.timer = setInterval(loadToday, 60_000);
  },
  hide() { clearInterval(Today.timer); },
};

async function loadToday() {
  Today.loading = true;
  Today.meetingsLoading = true;
  Today.errors = {};
  if ($("#td-actions")) renderToday();
  // 会议走 lark-cli，未配置时会等到超时（30s）——绝不能拖住核心区渲染，单独异步
  getJSON("/api/calendar/today").then((m) => {
    Today.meetings = Array.isArray(m) ? m : [];
    Today.meetingsLoading = false;
    if ($("#td-meetings")) renderToday();
  }).catch(() => {
    Today.meetings = [];
    Today.meetingsLoading = false;
    Today.errors.meetings = true;
    if ($("#td-meetings")) renderToday();
  });
  const [actions, shelf, attention, routines, goals, stewards] = await Promise.all([
    getJSON("/api/actions").catch(() => null),
    getJSON("/api/shelf").catch(() => null),
    getJSON("/api/attention").catch(() => null),
    getJSON("/api/routines").catch(() => null),
    getJSON("/api/goals").catch(() => null),
    getJSON("/api/roles/stewards").catch(() => null),
  ]);
  if (actions) Today.actions = actions; else { Today.actions = []; Today.errors.actions = true; }
  Today.shelf = Array.isArray(shelf) ? shelf : [];   // 货架是锦上添花：取不到就安静地不显示
  // 目标与管家同理：老 daemon 没这两个接口、或还没写目标/建角色，都安静地不画
  Today.goals = goals && Array.isArray(goals.goals) ? goals : null;
  Today.stewards = Array.isArray(stewards?.stewards) ? stewards.stewards : [];
  if (attention) Today.attention = attention; else { Today.attention = []; Today.errors.attention = true; }
  if (routines) Today.routines = routines; else { Today.routines = []; Today.errors.routines = true; }
  Today.loading = false;
  renderToday();
}

/** 一行状态简报：问候是低权重前缀，主体是可点击的结论（只说异常和下一步） */
function renderBrief(open) {
  const el = $("#td-brief"); if (!el) return;
  const now = new Date();
  const hour = now.getHours();
  const hello = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const date = now.toLocaleDateString(globalThis.I18N?.locale || "zh-CN", { month: "long", day: "numeric", weekday: "short" });
  const overdue = Today.routines.filter((r) => r.overdue).length;
  const dueToday = Today.routines.filter((r) => (r.isToday || r.status === "failed") && ["pending", "draft", "failed"].includes(r.status)).length;
  const stuck = Today.attention.filter((x) => x.kind === "stuck").length;
  const hm = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const t = (s) => (s || "").length > 15 ? s.slice(11, 16) : (s || "");
  const next = Today.meetings.filter((m) => t(m.start) > hm).sort((a, b) => t(a.start) < t(b.start) ? -1 : 1)[0];
  const parts = [];
  if (open.length) parts.push(`<a onclick="tdJump('td-actions')">${open.length} 件待行动</a>`);
  if (Today.attention.length) parts.push(`<a onclick="tdJump('td-attention')">${stuck ? `${stuck} 个会话卡住` : `${Today.attention.length} 个会话待收尾`}</a>`);
  if (overdue) parts.push(`<a onclick="tdJump('td-routines')">${overdue} 项职责逾期</a>`);
  else if (dueToday) parts.push(`<a onclick="tdJump('td-routines')">${dueToday} 项职责今天截止</a>`);
  if (next) parts.push(`下场会议 ${esc(t(next.start))}`);
  el.innerHTML = `<span class="quiet">${globalThis.I18N?.t(hello) ?? hello}${globalThis.I18N?.lang === "en" ? ", " : "，"}${date} ·&nbsp;</span>` +  // 问候和日期同一文本节点，词典整串匹配不到，这里直接翻
    (parts.length ? parts.join(`<span class="quiet">&nbsp;·&nbsp;</span>`) : `<span class="quiet">目前没有需要你处理的事 ☕</span>`);
}
function tdJump(id) { document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }

/** 今日焦点里「还要你处理」的那些——多选的全集与计数都以它为准 */
function tdOpenActions() { return Today.actions.filter((a) => a.state === "open" || a.state === "snoozed"); }

function tdPickBarHtml() {
  if (!Today.multi) return "";
  const total = tdOpenActions().length, n = Today.picked.size, off = n ? "" : "disabled";
  return `<div class="proposal-bar" id="td-pickbar">
    <span class="count">已选 ${n} / 共 ${total}</span>
    <button class="button ghost sm" onclick="tdSelectAll()" ${total ? "" : "disabled"}>全选</button>
    <button class="button ghost sm" onclick="tdClearPick()" ${off}>清空</button>
    <span style="flex:1"></span>
    <button class="button primary sm" onclick="tdBatch('resolved')" ${off}>完成</button>
    <button class="button secondary sm" onclick="tdBatch('dismissed')" ${off}>忽略</button>
    <button class="button ghost sm" onclick="tdBatch('snoozed')" ${off}>暂缓 2h</button>
  </div>`;
}
/** 勾选只刷批处理条：整段重渲会把用户刚点的复选框连同滚动位置一起推倒重来 */
function tdRenderPickBar() { const bar = $("#td-pickbar"); if (bar) bar.outerHTML = tdPickBarHtml(); }
function tdToggleMulti() { Today.multi = !Today.multi; Today.picked.clear(); renderToday(); }
function tdPick(id, on) { if (on) Today.picked.add(id); else Today.picked.delete(id); tdRenderPickBar(); }
function tdSelectAll() {
  for (const a of tdOpenActions()) Today.picked.add(a.id);
  for (const el of document.querySelectorAll("#td-actions .td-pick")) el.checked = true;
  tdRenderPickBar();
}
function tdClearPick() {
  Today.picked.clear();
  for (const el of document.querySelectorAll("#td-actions .td-pick")) el.checked = false;
  tdRenderPickBar();
}
async function tdBatch(state) {
  const ids = [...Today.picked];
  if (!ids.length) return;
  if (state === "dismissed" && !confirm(`忽略选中的 ${ids.length} 件？忽略后它们不再出现在今天`)) return;
  const res = await post("/api/actions/state", { ids, state, snoozeMin: 120 });
  toast(res.msg || "OK");
  Today.picked.clear();
  await loadToday();
}

function renderToday() {
  const open = Today.actions.filter((a) => a.state === "open" || a.state === "snoozed");
  // 列表每 60s 自刷：勾完之后被别处收掉的行动项要从选中集合里剔掉，否则计数和实际提交对不上
  if (Today.picked.size) { const live = new Set(open.map((a) => a.id)); for (const id of [...Today.picked]) if (!live.has(id)) Today.picked.delete(id); }
  const multiBtn = $("#td-multi");
  if (multiBtn) { multiBtn.textContent = Today.multi ? "退出多选" : "多选"; multiBtn.disabled = !open.length && !Today.multi; }
  $(".today-grid")?.setAttribute("data-focus-empty", String(!Today.loading && !Today.errors.actions && open.length === 0 && !Today.shelf.length));
  const shelfEl = $("#td-shelf");
  if (shelfEl) { shelfEl.hidden = Today.loading || !Today.shelf.length; $("#td-shelf-list").innerHTML = shelfEl.hidden ? "" : tdShelfHtml(Today.shelf); }
  const stewardsEl = $("#td-stewards");
  if (stewardsEl) { stewardsEl.hidden = Today.loading || !Today.stewards.length; stewardsEl.innerHTML = stewardsEl.hidden ? "" : tdStewardsHtml(Today.stewards); }
  const goalsEl = $("#td-goals");
  if (goalsEl) {
    goalsEl.hidden = Today.loading || !Today.goals?.goals.length;
    $("#td-goals-week").textContent = goalsEl.hidden ? "" : tdGoalsWeek(Today.goals);
    $("#td-goals-list").innerHTML = goalsEl.hidden ? "" : tdGoalsHtml(Today.goals);
  }
  $("#b-today").textContent = Today.errors.actions ? "" : (open.length || "");
  $("#b-today").dataset.warn = open.length > 5;
  if (Today.loading) $("#td-brief").innerHTML = `<span class="quiet">正在整理今天的工作台…</span>`;
  else renderBrief(open);

  // Action 卡
  const KIND = { reply: "回复", review: "Review", approve: "审批", follow_up: "跟进", decide: "决定" };
  // 展开的草稿只留给仍在待办里的卡；正在草稿框里打字时这一轮先不重画，免得 60s 自刷把光标抢走
  if (!Today.loading) for (const id of [...Today.stageOpen]) if (!open.some((a) => a.id === id)) { Today.stageOpen.delete(id); delete Today.stageView[id]; }
  if (!document.activeElement?.matches?.("#td-actions .stage-text")) $("#td-actions").innerHTML = Today.loading ? stateBox("正在整理今日焦点…", "loading") : Today.errors.actions ? stateBox("行动项加载失败，请稍后刷新", "error") : open.length ? tdPickBarHtml() + open.map((a) => {
    const refBtns = [];
    // routine 草稿行动：id 形如 routine:<id>:<date>，直接在卡上给「审草稿」入口，不用去周期职责区找
    const rm = a.id.match(/^routine:(.+):(\d{4}-\d{2}-\d{2})$/);
    if (rm) refBtns.push(`<button class="button sm primary" onclick="openRoutineDraft('${jsq(rm[1])}','${jsq(rm[2])}')">审草稿</button>`);
    if (safeUrl(a.ref?.url)) refBtns.push(`<a class="button sm secondary" style="text-decoration:none" target="_blank" rel="noopener" href="${esc(safeUrl(a.ref.url))}">打开链接</a>`);
    refBtns.push(tdInvestigateBtn(a));
    if (a.ref?.note) refBtns.push(`<button class="button sm secondary" onclick="jumpNote('${jsq(a.ref.note)}')">打开笔记</button>`);
    const approve = a.id.startsWith("evolve:") && a.kind === "approve"
      ? `<button class="button sm primary" onclick="applyEvolveAction('${jsq(a.ref?.task_id || "")}', '${jsq(a.id)}')">批准上线</button>` : "";
    return `<div class="card" ${a.kind === "approve" ? `data-tone="warn"` : ""}>
      <div class="top">${Today.multi ? `<input type="checkbox" class="td-pick" aria-label="选择这件行动项" ${Today.picked.has(a.id) ? "checked" : ""} onchange="tdPick('${jsq(a.id)}', this.checked)">` : ""}<span class="tag" data-tone="accent">${KIND[a.kind] || a.kind}</span>
        <span class="title">${esc(a.title)}</span>${tdStageBadge(a, Today.stageOpen.has(a.id))}
        <span class="right">${esc(a.source)} · ${ageText(a.createdAt)}${a.state === "snoozed" ? " · ⏰ 已暂缓" : ""}</span></div>
      <div class="body">${esc(a.reason)}</div>
      ${Today.stageOpen.has(a.id) ? tdStagePanel(a, Today.stageView[a.id]) : tdStagePreview(a)}
      <div class="foot">${approve}${refBtns.join("")}
        <span style="flex:1"></span>
        <button class="button sm ghost" onclick="actState('${jsq(a.id)}','resolved')">完成</button>
        <details class="more"><summary title="更多" aria-label="更多操作"><svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.35"/><circle cx="10" cy="10" r="1.35"/><circle cx="16" cy="10" r="1.35"/></svg></summary><div class="menu">
          <button onclick="actState('${jsq(a.id)}','snoozed')">暂缓 2 小时</button>
          <button onclick="actState('${jsq(a.id)}','dismissed')">忽略这件事</button>
        </div></details>
      </div></div>`;
  }).join("") : stateBox("现在很安静，没有需要行动的事 ☕");

  // 注意力（agent 卡住/待收尾）
  $("#td-attention").innerHTML = Today.loading ? stateBox("正在检查运行状态…", "loading") : Today.errors.attention ? stateBox("运行状态加载失败", "error") : Today.attention.length ? Today.attention.map((x) => `
    <div class="card clickable" data-tone="${x.kind === "stuck" ? "warn" : "ok"}" onclick="jumpTask('${jsq(x.taskId)}')">
      <div class="top"><span class="tag" data-tone="${x.kind === "stuck" ? "warn" : "ok"}">${x.kind === "stuck" ? "卡住" : "待收尾"}</span>
        <span class="title">${esc(x.project)}</span><span class="right">${Math.round(x.age / 60)} 分钟前</span></div>
      <div class="body">${esc(x.title)}${x.detail ? ` — ${esc(x.detail)}` : ""}</div>
    </div>`).join("") : stateBox("所有会话都好好的");

  // routine 卡
  const cards = Today.routines.filter((r) => r.isToday || r.overdue || r.nextLabel);
  $("#td-routines-head").innerHTML = routinesHeadHtml(Today.loading ? [] : Today.routines);
  $("#td-routines").innerHTML = Today.loading ? stateBox("正在读取周期职责…", "loading") : Today.errors.routines ? stateBox("周期职责加载失败", "error") : cards.length ? cards.map((r) => {
    const stLabel = r.overdue ? `逾期·${r.date.slice(5)}` :
      { pending: "待生成", draft: "草稿待审", writing: "写入中", written: "已写入 ✓", skipped: "已跳过", failed: "生成失败", upcoming: `下次 ${r.nextLabel}` }[r.status] || r.status;
    const tone = r.overdue || r.status === "failed" ? "bad" : r.status === "draft" ? "warn" : r.status === "written" ? "ok" : "";
    const act = (r.isToday || r.overdue || r.status === "failed") ? (
      r.status === "pending" ? `<button class="button sm secondary" onclick="genRoutine('${jsq(r.id)}')">生成草稿</button>` :
      r.status === "failed" ? `<button class="button sm secondary" onclick="genRoutine('${jsq(r.id)}')">重试生成</button>` :
      r.status === "draft" ? `<button class="button sm primary" onclick="openDraft('${jsq(r.id)}','${jsq(r.date)}','${jsq(r.name)}')">审草稿</button>` :
      r.status === "writing" && r.taskId ? `<button class="button sm secondary" onclick="jumpTask('${jsq(r.taskId)}')">查看写入任务</button>` : ""
    ) : "";
    return `<div class="card" ${tone ? `data-tone="${tone}"` : ""}>
      <div class="top"><span class="title">${esc(r.name)}</span>
        ${r.stale ? `<span class="tag" data-tone="warn" title="草稿生成后工作记录又更新了，审阅时留意">素材已更新</span>` : ""}
        <span class="right">${esc(r.time)} 截止 · ${esc(stLabel)}</span></div>
      ${r.error ? `<div class="body">${esc(r.error)}</div>` : ""}
      <div class="foot">${act}${safeUrl(r.docUrl) ? `<a class="button sm ghost" style="text-decoration:none" target="_blank" rel="noopener" href="${esc(safeUrl(r.docUrl))}">打开文档</a>` : ""}${routineExitHtml(r)}</div>
    </div>`;
  }).join("") : stateBox("没有配置 routine（examples/routines.json 有样例）");

  // 会议
  if (Today.meetingsLoading) {
    $("#td-meetings").innerHTML = stateBox("正在读取今日日历…", "loading");
  } else if (Today.errors.meetings) {
    $("#td-meetings").innerHTML = stateBox("日历暂时不可用", "error");
  } else if (Today.meetings.length) {
    $("#td-meetings").innerHTML = Today.meetings.map((m) => {
      const t = (s) => s.length > 15 ? s.slice(11, 16) : s;
      return `<div class="kv"><span>${esc(m.title)}</span>
        <span class="v">${t(m.start)}–${t(m.end)}${safeUrl(m.meetingUrl) ? ` · <a target="_blank" rel="noopener" href="${esc(safeUrl(m.meetingUrl))}">入会</a>` : ""}</span></div>`;
    }).join("");
  } else if (!Today.loading) $("#td-meetings").innerHTML = `<div class="empty">今天没有会议</div>`;
}

async function actState(id, state) {
  const res = await post("/api/actions/state", { id, state, snoozeMin: 120 });
  toast(res.msg || "OK");
  loadToday();
}
async function applyEvolveAction(taskId, actionId) {
  if (!taskId) { toast("缺任务 id"); return; }
  if (!confirm("确认上线这次演进？将合并代码并重启 daemon")) return;
  const res = await post("/api/evolve/apply", { id: taskId });
  toast(res.msg);
  if (res.ok) actState(actionId, "resolved");
}
function jumpTask(id) { switchTab("tasks"); Tasks.select(id); }
function jumpNote(path) { switchTab("notes"); Notes.open(path); }
async function tdInvestigate(id, btn) {
  if (btn) btn.disabled = true;
  const res = await post("/api/actions/investigate", { id });
  toast(res?.ok ? "已派排查任务" : (res?.msg || "派发失败"));
  if (res?.ok) loadToday(); else if (btn) btn.disabled = false;
}
async function tdShelfAdopt(id, btn) {
  if (btn) btn.disabled = true;
  const res = await post("/api/shelf/adopt", { id });
  toast(res?.ok ? (res.taskId ? "已派任务" : res.linked ? "这件事已经在待办里了，没另开一条" : "已加进今日焦点") : (res?.msg || "采纳失败"));
  if (res?.ok || res?.gone) loadToday(); else if (btn) btn.disabled = false;
}
async function tdShelfDismiss(id) {
  await post("/api/shelf/dismiss", { id });
  Today.shelf = Today.shelf.filter((x) => x.id !== id);
  renderToday();
}

/* ---- 助理货架 / 一键排查：纯 HTML 生成（src/web-today-shelf.test.ts 切片执行） ---- */
const SHELF_TONE = { suggestion: ["accent", "建议"], risk: ["bad", "风险"], pattern: ["ok", "规律"] };
function tdShelfHtml(items) {
  return items.map((x) => {
    const [tone, label] = SHELF_TONE[x.category] || ["", x.category];
    const s = x.actionSuggestion;
    const adopt = s?.label ? `<button class="button sm primary" onclick="tdShelfAdopt('${jsq(x.id)}', this)">采纳: ${esc(s.label)}</button>` : "";
    return `<div class="card shelf-card">
      <div class="top"><span class="tag" data-tone="${tone}">${esc(label)}</span><span class="title">${esc(x.title)}</span><span class="right">${ageText(x.createdAt)}</span></div>
      ${x.detail ? `<div class="body">${esc(x.detail)}</div>` : ""}
      <div class="foot">${adopt}<span style="flex:1"></span><button class="button sm ghost" onclick="tdShelfDismiss('${jsq(x.id)}')">忽略</button></div>
    </div>`;
  }).join("");
}
/** 像是「出了问题、值得查一下根因」的行动项。与 src/actions.ts 的 isInvestigable 同一条规则（服务端也拦）：
 *  货架开的不算，审核/决定类要人处理、派 agent 查「根因」只会空转 */
function tdInvestigable(a) {
  if (a.source === "assistant") return false;
  const text = `${a.title || ""} ${a.reason || ""}`;
  return a.kind === "follow_up" || /\bCI\b/.test(text) || /失败|crash/i.test(text);
}
/** 一键排查 / 查看排查任务；别的来源挂的 task_id 仍叫「查看任务」 */
function tdInvestigateBtn(a) {
  if (a.ref?.task_id) return `<button class="button sm secondary" onclick="jumpTask('${jsq(a.ref.task_id)}')">${a.ref.investigated_at ? "查看排查任务" : "查看任务"}</button>`;
  return tdInvestigable(a) ? `<button class="button sm secondary" onclick="tdInvestigate('${jsq(a.id)}', this)" title="派一个后台任务查根因并给修复建议">一键排查</button>` : "";
}
/* ---- 助理货架 / 一键排查 end ---- */

async function tdGoalToggle(id, done, box) {
  if (box) box.disabled = true;
  const res = await post("/api/goals/toggle", { id, done });
  if (res?.ok) {
    const g = Today.goals?.goals.find((x) => x.id === id);
    if (g) g.done = done;
    renderToday();
  } else {
    if (box) { box.checked = !done; box.disabled = false; }   // 没写进去就别让勾选状态骗人
    toast(res?.msg || "勾选失败");
    loadToday();
  }
}
/** 点管家 = 派任务给它（派发弹窗点名这个角色）；派发弹窗没就绪时退到角色页看详情 */
function tdStewardOpen(id) {
  if (typeof openWorkForRole === "function") { openWorkForRole(id); return; }
  switchTab("roles");
  if (typeof openRole === "function") openRole(id);
}

/* ---- 本周目标 / 领域管家：纯 HTML 生成（src/web-today-goals.test.ts 切片执行） ---- */
function tdGoalsWeek(s) {
  const done = s.goals.filter((g) => g.done).length;
  return `${s.week ? `${s.week} · ` : ""}已完成 ${done}/${s.goals.length}`;
}
function tdGoalsHtml(s) {
  if (!s?.goals?.length) return "";
  return s.goals.map((g) => `<label class="goal-row" data-done="${g.done}">
      <input type="checkbox" ${g.done ? "checked" : ""} onchange="tdGoalToggle('${jsq(g.id)}', this.checked, this)">
      ${g.project ? `<span class="tag">${esc(g.project)}</span>` : ""}<span class="goal-text">${esc(g.text)}</span>
    </label>`).join("");
}
const STEWARD_PRESENCE = { normal: "在岗", attention: "需关注", busy: "工作中" };
function tdStewardsHtml(list) {
  if (!list?.length) return "";
  const icon = (name) => typeof roleIconSvg === "function" ? roleIconSvg(name) : "";
  return list.map((s) => {
    const presence = STEWARD_PRESENCE[s.presence] ? s.presence : "normal";
    const label = STEWARD_PRESENCE[presence];
    return `<button type="button" class="steward-card" data-presence="${presence}" title="${esc(`${s.name} · ${label}：${s.summary}`)}" onclick="tdStewardOpen('${jsq(s.id)}')">
      <span class="steward-avatar">${icon(s.icon)}<span class="presence-dot" aria-label="${label}"></span></span>
      <span class="steward-meta"><span class="steward-name">${esc(s.name)}</span><span class="steward-summary">${esc(s.summary)}</span></span>
    </button>`;
  }).join("");
}
/* ---- 本周目标 / 领域管家 end ---- */

/* ---- Staged Actions：卡片徽标 / 预览 / 详情面板（纯 HTML 生成，src/web-today-stage.test.ts 切片执行） ---- */
const STAGE_ERR = { llm_unavailable: "模型暂时不可用", context_unavailable: "取不到上下文", parse: "模型输出解析失败", budget: "今日预制额度已用完" };
const tdStageErr = (code) => STAGE_ERR[code] || code || "未知原因";
/** 草稿就绪/已更新可点开；其余状态只是提示 */
function tdStageBadge(a, expanded) {
  const st = a?.stage;
  if (!st?.status) return "";
  const toggle = (tone, text, title) => `<span class="tag stage-tag" data-tone="${tone}" role="button" tabindex="0" aria-expanded="${!!expanded}" title="${esc(title)}" onclick="toggleStage('${jsq(a.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleStage('${jsq(a.id)}')}">${text}</span>`;
  switch (st.status) {
    case "ready": return toggle("accent", "✨ 草稿就绪", expanded ? "收起草稿" : "展开草稿");
    case "stale": return toggle("warn", "⚠️ 草稿已更新", "草稿生成后又有新消息，发送前留意；可重新生成");
    case "running": return `<span class="tag stage-tag">⏳ 预制中…</span>`;
    case "queued": return `<span class="tag stage-tag"${st.error ? ` title="${esc(tdStageErr(st.error))}"` : ""}>⏱️ 待预制</span>`;
    case "failed": return `<span class="tag stage-tag" data-tone="bad" title="${esc(`预制失败：${tdStageErr(st.error)}`)}">预制失败</span>`;
    default: return "";
  }
}
function tdStagePreview(a) {
  const st = a?.stage;
  if (!st?.preview || (st.status !== "ready" && st.status !== "stale")) return "";
  return `<div class="stage-preview">${esc(st.preview)}</div>`;
}
/** 展开后的面板。view = { loading } | { error } | { art, text, busy } */
function tdStagePanel(a, view) {
  const id = jsq(a.id);
  const regen = `<button class="button sm secondary" onclick="tdStageRegen('${id}')">重新生成</button>`;
  if (!view || view.loading) return `<div class="stage-panel"><span class="quiet">正在读取草稿…</span></div>`;
  if (view.error || !view.art) return `<div class="stage-panel"><div class="quiet">${esc(view.error || "草稿不可用")}</div><div class="foot">${regen}</div></div>`;
  const { art } = view, review = (art.kind || a.stage?.kind) === "review_brief";
  const basis = Array.isArray(art.basis) && art.basis.length
    ? `<div class="stage-basis">基于：${art.basis.map((b) => esc(b.label) + (b.at ? ` <span class="quiet">(${esc(b.at)})</span>` : "")).join("；")}</div>` : "";
  const caveats = Array.isArray(art.caveats) && art.caveats.length
    ? `<div class="stage-caveats">⚠️ 注意事项：<ul>${art.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : "";
  const stale = a.stage?.status === "stale" ? `<div class="stage-caveats">⚠️ 草稿生成后又有新动态，建议重新生成或核对后再用</div>` : "";
  const dis = view.busy ? " disabled" : "";
  const mail = a.source === "gmail";
  const canSend = mail ? !!tdMailRef(a) : !!a.ref?.chat_id;
  const primary = review
    ? `<button class="button sm primary" onclick="tdStageCopy('${id}')"${dis}>复制意见</button>${safeUrl(a.ref?.url) ? `<a class="button sm secondary" style="text-decoration:none" target="_blank" rel="noopener" href="${esc(safeUrl(a.ref.url))}">打开 PR</a>` : ""}`
    : `<button class="button sm primary" onclick="tdStageSend('${id}')"${canSend ? dis : ` disabled title="${mail ? "缺邮件 id" : "缺会话 id"}，无法直接发送"`}>${mail ? "发送邮件回复" : "发送回复"}</button>`;
  return `<div class="stage-panel">${stale}${basis}${caveats}
    <textarea class="stage-text" rows="5" aria-label="${review ? "Review 意见草稿" : "回复草稿"}" oninput="tdStageInput('${id}', this.value)">${esc(view.text ?? art.body ?? "")}</textarea>
    <div class="foot">${primary}${regen}<span style="flex:1"></span><button class="button sm ghost" onclick="tdStageDiscard('${id}')"${dis}>放弃草稿</button></div>
  </div>`;
}
/** 邮件引用：mail_id 可写成 `<账号邮箱>:<id>`（与 src/staging.ts parseMailRef 同一约定；url/note 兜底只用于取上下文，发送只认 mail_id） */
function tdMailRef(a) {
  const s = String(a?.ref?.mail_id || "").trim(), i = s.lastIndexOf(":");
  if (!s) return null;
  return i > 0 ? { id: s.slice(i + 1), account: s.slice(0, i) } : { id: s };
}
/** 与原稿一致算「原样采用」，否则算「改过」——这是预制质量的反馈信号 */
function tdStageOutcome(view) { return String(view?.text ?? "").trim() === String(view?.art?.body ?? "").trim() ? "sent_as_is" : "edited"; }
/* ---- Staged Actions 交互 ---- */

async function toggleStage(id) {
  if (Today.stageOpen.has(id)) { Today.stageOpen.delete(id); delete Today.stageView[id]; renderToday(); return; }
  Today.stageOpen.add(id);
  await tdLoadStage(id);
}
async function tdLoadStage(id) {
  Today.stageView[id] = { loading: true }; renderToday();
  try {
    const art = await getJSON(`/api/actions/stage?id=${encodeURIComponent(id)}`);
    Today.stageView[id] = { art, text: art.body ?? "" };
  } catch { Today.stageView[id] = { error: "草稿读取失败，可以重新生成" }; }
  if (Today.stageOpen.has(id)) renderToday();
}
function tdStageInput(id, value) { const v = Today.stageView[id]; if (v) v.text = value; }
function tdStageClose(id) { Today.stageOpen.delete(id); delete Today.stageView[id]; }
/** 同一张卡上的发送/复制/放弃互斥，防双击重复发 */
async function tdStageBusy(id, fn) {
  const v = Today.stageView[id];
  if (!v?.art || v.busy) return;
  // Safari 点按钮不抢焦点：草稿框还聚焦着的话 renderToday 会一直跳过整块重画
  document.activeElement?.blur?.();
  v.busy = true; renderToday();
  try { await fn(v); } finally { if (Today.stageView[id] === v) { v.busy = false; renderToday(); } }
}
function tdStageSend(id) {
  return tdStageBusy(id, async (v) => {
    const a = Today.actions.find((x) => x.id === id), text = String(v.text ?? "").trim();
    const mail = a?.source === "gmail" ? tdMailRef(a) : null;
    if (a?.source === "gmail" ? !mail : !a?.ref?.chat_id) { toast(a?.source === "gmail" ? "缺邮件 id，无法发送" : "缺会话 id，无法发送"); return; }
    if (!text) { toast("回复内容为空"); return; }
    const res = mail
      ? await post("/api/gmail/reply", { id: mail.id, text, ...(mail.account ? { account: mail.account } : {}) })
      : await post("/api/lark/send", { chat_id: a.ref.chat_id, text });
    if (!res?.ok) { toast(res?.msg || "发送失败"); return; }
    await post("/api/actions/stage/feedback", { id, outcome: tdStageOutcome(v) });
    // /api/lark/send 只收 lark:<chat_id>；Gmail 回复不碰 Action——别的 id 形态这里补一刀
    if (mail || id !== `lark:${a.ref.chat_id}`) await post("/api/actions/state", { id, state: "resolved" });
    tdStageClose(id);
    toast(res.msg || "已发送");
    loadToday();
  });
}
function tdStageCopy(id) {
  return tdStageBusy(id, async (v) => {
    const text = String(v.text ?? "").trim();
    if (!text) { toast("意见内容为空"); return; }
    try { await navigator.clipboard.writeText(text); } catch { toast("复制失败：浏览器拒绝访问剪贴板"); return; }
    await post("/api/actions/stage/feedback", { id, outcome: tdStageOutcome(v) });
    toast("已复制 Review 意见");
  });
}
function tdStageDiscard(id) {
  return tdStageBusy(id, async () => {
    await post("/api/actions/stage/feedback", { id, outcome: "discarded" });
    tdStageClose(id);
    renderToday();
    toast("已放弃草稿");
  });
}
async function tdStageRegen(id) {
  if (Today.stageView[id]?.busy) return;
  document.activeElement?.blur?.();
  Today.stageView[id] = { loading: true }; renderToday();
  toast("正在重新生成草稿…");
  const res = await post("/api/actions/stage/run", { id });
  toast(res?.ok ? "草稿已重新生成" : (res?.msg || "重新生成失败"));
  if (res?.ok && Today.stageOpen.has(id)) await tdLoadStage(id);
  else if (Today.stageOpen.has(id)) { Today.stageView[id] = { error: res?.msg || "重新生成失败" }; renderToday(); }
  loadToday();
}

/* ---- routine 草稿 modal ---- */
// 草稿是人审的半成品，关掉弹窗不该等于丢稿：以前「关闭」、点遮罩、Esc 三条路都只是把
// data-open 拨成 false，textarea 里改了一半的内容一个字都不存（误触遮罩就白写）。
// 现在停手 1.2s 自动存一次，任何一条关闭路径关之前都先把没存的刷出去。
let draftTimer = null, draftSavedText = "";
function draftStamp(text, bad) { const el = $("#d-autosave"); if (!el) return; el.textContent = text; el.style.color = bad ? "var(--danger)" : "var(--text-tertiary)"; }
async function saveDraftNow(manual) {
  if (!Today.draftCtx) return;
  const content = $("#d-text")?.value; if (content === undefined) return;
  if (!manual && content === draftSavedText) return;               // 没改就不写，别拿无谓的写覆盖文件
  clearTimeout(draftTimer); draftTimer = null;
  const { id, date } = Today.draftCtx;
  try {
    const res = await post("/api/routines/draft", { id, date, content });
    if (res?.ok) { draftSavedText = content; draftStamp(`已自动保存 ${new Date().toTimeString().slice(0, 5)}`); return true; }
    draftStamp(res?.msg || "自动保存失败", true); return false;      // 失败要看得见，不许假装存上了
  } catch { draftStamp("自动保存失败（网络）", true); return false; }
}
/** 关弹窗前先把没存的刷出去；刷不动也照常关，但状态位会留着「保存失败」 */
async function closeDraft(ov) { await saveDraftNow(false); clearTimeout(draftTimer); draftTimer = null; Today.draftCtx = null; ov.dataset.open = "false"; }
function bindDraftModal() {
  const ov = $("#draft-overlay");
  $("#d-cancel").addEventListener("click", () => closeDraft(ov));
  ov.addEventListener("click", (e) => { if (e.target === ov) closeDraft(ov); });
  $("#d-text").addEventListener("input", () => { draftStamp("未保存…"); clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraftNow(false), 1_200); });
  $("#d-text").addEventListener("blur", () => saveDraftNow(false));
  // Esc 走的是 app.js 里「一把关掉所有 overlay」的全局处理，抢在它前面把稿子刷出去
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ov.dataset.open === "true") saveDraftNow(false); }, true);
  window.addEventListener("beforeunload", () => { if (ov.dataset.open === "true") saveDraftNow(false); });
  $("#d-save").addEventListener("click", async () => {
    const ok = await saveDraftNow(true);
    toast(ok ? "草稿已保存" : "保存失败");
  });
  $("#d-write").addEventListener("click", async () => {
    const { id, date } = Today.draftCtx;
    const saved = await post("/api/routines/draft", { id, date, content: $("#d-text").value });
    if (!saved?.ok) { toast(saved?.msg || "草稿保存失败，尚未派发写入"); return; }
    const res = await post("/api/routines/write", { id, date });
    toast(res.msg || (res.ok ? "已派写入任务" : "失败"));
    clearTimeout(draftTimer); draftTimer = null; Today.draftCtx = null; ov.dataset.open = "false";
    loadToday();
  });
  $("#d-skip").addEventListener("click", async () => {
    const { id, date } = Today.draftCtx;
    const res = await post("/api/routines/skip", { id, date });
    toast(res.msg || "已跳过");
    clearTimeout(draftTimer); draftTimer = null; Today.draftCtx = null; ov.dataset.open = "false";
    loadToday();
  });
}
/* ---- routine 退出：逾期/失败/待审的卡直接在卡上跳过或标已填写，不必先进草稿弹窗（失败的连草稿都打不开） ---- */
// 与后端 isRoutineExitable 同口径：写入中的不算，任务还在跑
const routineOverdueCount = (list) => list.filter((r) => (r.overdue || r.status === "failed") && r.status !== "writing").length;
function routinesHeadHtml(list) {
  const n = routineOverdueCount(list);
  return n ? `<button class="button sm ghost" onclick="skipAllOverdueRoutines()">跳过全部逾期 (${n})</button>` : "";
}
function routineExitHtml(r) {
  if (!(r.overdue || r.status === "failed" || r.status === "draft") || r.status === "writing") return "";
  const args = `'${jsq(r.id)}','${jsq(r.date)}'`;
  return `<span style="flex:1"></span>
        <button class="button sm ghost" onclick="skipRoutineOcc(${args})">跳过</button>
        <details class="more"><summary title="更多" aria-label="更多操作"><svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.35"/><circle cx="10" cy="10" r="1.35"/><circle cx="16" cy="10" r="1.35"/></svg></summary><div class="menu">
          <button onclick="skipRoutineOcc(${args})">跳过本次交付</button>
          <button onclick="markRoutineWrittenOcc(${args})">标为已手动填写</button>
        </div></details>`;
}
async function skipRoutineOcc(id, date) {
  const res = await post("/api/routines/skip", { id, date });
  toast(res.msg || (res.ok ? "已跳过" : "跳过失败"));
  loadToday();
}
async function markRoutineWrittenOcc(id, date) {
  const res = await post("/api/routines/written", { id, date });
  toast(res.msg || (res.ok ? "已标记为已填写" : "标记失败"));
  loadToday();
}
async function skipAllOverdueRoutines() {
  const res = await post("/api/routines/skip-overdue", {});
  toast(res.msg || (res.ok ? "已跳过逾期职责" : "跳过失败"));
  loadToday();
}
async function genRoutine(id) {
  toast("正在整理材料并生成草稿，月度复盘可能需要几分钟…");
  const res = await post("/api/routines/generate", { id });
  toast(res.ok ? "草稿已生成" : (res.msg || "生成失败"));
  loadToday();
}
function openRoutineDraft(id, date) {
  const r = Today.routines.find((x) => x.id === id);
  openDraft(id, date, r?.name || id);
}
function routineSourceSummary(view) {
  const days = Array.isArray(view.materialDays) ? view.materialDays : [];
  const lines = days.length ? [`取材日期：${days[0]} 至 ${days[days.length - 1]}`] : [];
  if (Array.isArray(view.materialPeople) && view.materialPeople.length) lines.push(`覆盖人员：${view.materialPeople.join("、")}`);
  for (const source of Array.isArray(view.sources) ? view.sources : []) {
    lines.push(`来源：${source.url || "未知"}\n版本：${String(source.hash || "未知").slice(0, 12)} · 获取时间：${source.fetchedAt || "未知"}`);
  }
  for (const warning of Array.isArray(view.warnings) ? view.warnings : []) lines.push(`⚠ ${warning}`);
  return lines.join("\n\n");
}
async function openDraft(id, date, name) {
  const res = await getJSON(`/api/routines/draft?id=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}`).catch(() => null);
  if (!res?.draft) { toast("没有草稿"); return; }
  Today.draftCtx = { id, date };
  $("#d-title").textContent = `${name} · ${date}${res.stale ? "（⚠ 素材已更新，可重新生成）" : ""}`;
  let provenance = $("#d-sources");
  if (!provenance) {
    provenance = document.createElement("details");
    provenance.id = "d-sources";
    const heading = document.createElement("summary"); heading.textContent = "取材依据";
    const body = document.createElement("pre"); body.style.whiteSpace = "pre-wrap"; body.style.overflowWrap = "anywhere";
    provenance.append(heading, body);
    $("#d-text").before(provenance);
  }
  const sourceSummary = routineSourceSummary(res);
  provenance.hidden = !sourceSummary;
  provenance.querySelector("pre").textContent = sourceSummary;
  provenance.open = !!res.warnings?.length;
  $("#d-regen").style.display = res.stale ? "" : "none";
  $("#d-text").value = res.draft;
  draftSavedText = res.draft; clearTimeout(draftTimer); draftTimer = null; draftStamp("");
  $("#draft-overlay").dataset.open = "true";
}
async function regenDraft() {
  const { id, date } = Today.draftCtx;
  // 重新生成会把服务端的草稿整篇换掉：这里必须先掐掉待触发的自动保存，
  // 否则它带着旧文本晚一步落地，把刚生成的新稿覆盖回去
  clearTimeout(draftTimer); draftTimer = null; Today.draftCtx = null;
  $("#draft-overlay").dataset.open = "false";
  await genRoutine(id);
  const r = Today.routines.find((x) => x.id === id);
  openDraft(id, date, r?.name || id);
}
