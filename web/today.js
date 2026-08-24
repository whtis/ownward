"use strict";
/* 今日 tab：Action 行动队列（一等对象）+ 注意力收件箱 + routine 职责卡 + 今日会议 */

const Today = { actions: [], attention: [], routines: [], meetings: [], timer: null, draftCtx: null, loading: true, meetingsLoading: true, errors: {} };

TABS.today = {
  init(root) {
    root.innerHTML = `
      <div class="today-page">
        <div class="today-page-head">
          <div>
            <div class="eyebrow">TODAY</div>
            <h1>今天，先处理重要的事</h1>
          </div>
          <button class="button secondary sm" id="td-refresh">刷新</button>
        </div>
        <div class="today-brief" id="td-brief"></div>
        <div class="today-grid">
          <section class="today-focus" aria-labelledby="td-focus-title">
            <div class="section-head">
              <div><h2 id="td-focus-title">今日焦点</h2><p>需要你亲自判断或推进</p></div>
            </div>
            <div id="td-actions"></div>
          </section>
          <aside class="today-side">
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
            <div class="section-head"><div><h2 id="td-routines-title">周期职责</h2><p>按节奏完成的固定交付</p></div></div>
            <div id="td-routines"></div>
          </section>
        </div>
      </div>
      `;
    $("#td-refresh").addEventListener("click", () => loadToday());
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
  const [actions, attention, routines] = await Promise.all([
    getJSON("/api/actions").catch(() => null),
    getJSON("/api/attention").catch(() => null),
    getJSON("/api/routines").catch(() => null),
  ]);
  if (actions) Today.actions = actions; else { Today.actions = []; Today.errors.actions = true; }
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
  const date = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
  const overdue = Today.routines.filter((r) => r.overdue).length;
  const dueToday = Today.routines.filter((r) => r.isToday && ["pending", "draft"].includes(r.status)).length;
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
  el.innerHTML = `<span class="quiet">${hello}，${date} ·&nbsp;</span>` +
    (parts.length ? parts.join(`<span class="quiet">&nbsp;·&nbsp;</span>`) : `<span class="quiet">目前没有需要你处理的事 ☕</span>`);
}
function tdJump(id) { document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }

function renderToday() {
  const open = Today.actions.filter((a) => a.state === "open" || a.state === "snoozed");
  $(".today-grid")?.setAttribute("data-focus-empty", String(!Today.loading && !Today.errors.actions && open.length === 0));
  $("#b-today").textContent = Today.errors.actions ? "" : (open.length || "");
  $("#b-today").dataset.warn = open.length > 5;
  if (Today.loading) $("#td-brief").innerHTML = `<span class="quiet">正在整理今天的工作台…</span>`;
  else renderBrief(open);

  // Action 卡
  const KIND = { reply: "回复", review: "Review", approve: "审批", follow_up: "跟进", decide: "决定" };
  $("#td-actions").innerHTML = Today.loading ? stateBox("正在整理今日焦点…", "loading") : Today.errors.actions ? stateBox("行动项加载失败，请稍后刷新", "error") : open.length ? open.map((a) => {
    const refBtns = [];
    // routine 草稿行动：id 形如 routine:<id>:<date>，直接在卡上给「审草稿」入口，不用去周期职责区找
    const rm = a.id.match(/^routine:(.+):(\d{4}-\d{2}-\d{2})$/);
    if (rm) refBtns.push(`<button class="button sm primary" onclick="openRoutineDraft('${jsq(rm[1])}','${jsq(rm[2])}')">审草稿</button>`);
    if (safeUrl(a.ref?.url)) refBtns.push(`<a class="button sm secondary" style="text-decoration:none" target="_blank" rel="noopener" href="${esc(safeUrl(a.ref.url))}">打开链接</a>`);
    if (a.ref?.task_id) refBtns.push(`<button class="button sm secondary" onclick="jumpTask('${jsq(a.ref.task_id)}')">查看任务</button>`);
    if (a.ref?.note) refBtns.push(`<button class="button sm secondary" onclick="jumpNote('${jsq(a.ref.note)}')">打开笔记</button>`);
    const approve = a.id.startsWith("evolve:") && a.kind === "approve"
      ? `<button class="button sm primary" onclick="applyEvolveAction('${jsq(a.ref?.task_id || "")}', '${jsq(a.id)}')">批准上线</button>` : "";
    return `<div class="card" ${a.kind === "approve" ? `data-tone="warn"` : ""}>
      <div class="top"><span class="tag" data-tone="accent">${KIND[a.kind] || a.kind}</span>
        <span class="title">${esc(a.title)}</span>
        <span class="right">${esc(a.source)} · ${ageText(a.createdAt)}${a.state === "snoozed" ? " · ⏰ 已暂缓" : ""}</span></div>
      <div class="body">${esc(a.reason)}</div>
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
  $("#td-routines").innerHTML = Today.loading ? stateBox("正在读取周期职责…", "loading") : Today.errors.routines ? stateBox("周期职责加载失败", "error") : cards.length ? cards.map((r) => {
    const stLabel = r.overdue ? `逾期·${r.date.slice(5)}` :
      { pending: "待生成", draft: "草稿待审", writing: "写入中", written: "已写入 ✓", skipped: "已跳过", upcoming: `下次 ${r.nextLabel}` }[r.status] || r.status;
    const tone = r.overdue ? "bad" : r.status === "draft" ? "warn" : r.status === "written" ? "ok" : "";
    const act = (r.isToday || r.overdue) ? (
      r.status === "pending" ? `<button class="button sm secondary" onclick="genRoutine('${jsq(r.id)}')">生成草稿</button>` :
      r.status === "draft" ? `<button class="button sm primary" onclick="openDraft('${jsq(r.id)}','${jsq(r.date)}','${jsq(r.name)}')">审草稿</button>` :
      r.status === "writing" && r.taskId ? `<button class="button sm secondary" onclick="jumpTask('${jsq(r.taskId)}')">查看写入任务</button>` : ""
    ) : "";
    return `<div class="card" ${tone ? `data-tone="${tone}"` : ""}>
      <div class="top"><span class="title">${esc(r.name)}</span>
        ${r.stale ? `<span class="tag" data-tone="warn" title="草稿生成后工作记录又更新了，审阅时留意">素材已更新</span>` : ""}
        <span class="right">${esc(r.time)} 截止 · ${esc(stLabel)}</span></div>
      <div class="foot">${act}${safeUrl(r.docUrl) ? `<a class="button sm ghost" style="text-decoration:none" target="_blank" rel="noopener" href="${esc(safeUrl(r.docUrl))}">打开文档</a>` : ""}</div>
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

/* ---- routine 草稿 modal ---- */
function bindDraftModal() {
  const ov = $("#draft-overlay");
  $("#d-cancel").addEventListener("click", () => (ov.dataset.open = "false"));
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.dataset.open = "false"; });
  $("#d-save").addEventListener("click", async () => {
    const { id, date } = Today.draftCtx;
    const res = await post("/api/routines/draft", { id, date, content: $("#d-text").value });
    toast(res.ok ? "草稿已保存" : res.msg);
  });
  $("#d-write").addEventListener("click", async () => {
    const { id, date } = Today.draftCtx;
    await post("/api/routines/draft", { id, date, content: $("#d-text").value });  // 先存再写
    const res = await post("/api/routines/write", { id, date });
    toast(res.msg || (res.ok ? "已派写入任务" : "失败"));
    ov.dataset.open = "false";
    loadToday();
  });
  $("#d-skip").addEventListener("click", async () => {
    const { id, date } = Today.draftCtx;
    const res = await post("/api/routines/skip", { id, date });
    toast(res.msg || "已跳过");
    ov.dataset.open = "false";
    loadToday();
  });
}
async function genRoutine(id) {
  toast("生成中（要跑一次 AI，约 30s）…");
  const res = await post("/api/routines/generate", { id });
  toast(res.ok ? "草稿已生成" : (res.msg || "生成失败"));
  loadToday();
}
function openRoutineDraft(id, date) {
  const r = Today.routines.find((x) => x.id === id);
  openDraft(id, date, r?.name || id);
}
async function openDraft(id, date, name) {
  const res = await getJSON(`/api/routines/draft?id=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}`).catch(() => null);
  if (!res?.draft) { toast("没有草稿"); return; }
  Today.draftCtx = { id, date };
  $("#d-title").textContent = `${name} · ${date}${res.stale ? "（⚠ 素材已更新，可重新生成）" : ""}`;
  $("#d-regen").style.display = res.stale ? "" : "none";
  $("#d-text").value = res.draft;
  $("#draft-overlay").dataset.open = "true";
}
async function regenDraft() {
  const { id, date } = Today.draftCtx;
  $("#draft-overlay").dataset.open = "false";
  await genRoutine(id);
  const r = Today.routines.find((x) => x.id === id);
  openDraft(id, date, r?.name || id);
}
