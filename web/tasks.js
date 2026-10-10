"use strict";
/* 任务 tab：任务列表 + 引擎会话（追问/审批/中断/接管）/ 日志视图 / CC 会话旁观与接管 */

const FEED_PAGE = 200;    // 会话流每页铺多少项（折叠后）
const MSG_PAGE = 1000;    // 每次向服务端多要多少条消息（/api/dev/messages?tail=）

const Tasks = {
  sel: null,               // 选中任务 id 或 cc 会话 id
  dev: null,               // 引擎会话最近一次 DevSessionRes
  usage: null,             // /api/usage：各家订阅额度（跟慢数据一起 60s 刷一轮，头部徽标就地更新）
  ccMsgs: [], ccOffset: 0, // 旁观增量
  ccList: [],              // 本机全部 agent 会话（去重后混进项目组；含 ownward 之外开的 claude/codex）
  recent: [], rq: "",      // 最近会话分区：ownward 原生引擎对话 + 筛选词
  archivedList: [], showArchived: false,   // 已归档会话（/api/dev/recent?archived=1）与「正在看归档」视图开关
  rqHits: null, rqTimer: null,   // 筛选词的全文命中（/api/search）：{ q, byTask: Map<taskId, {snippet, hit}> }
  pinned: [],              // 置顶会话（daemon 持久化）
  dismissed: {},           // 隐藏的项目组 {project: epochMs}
  openTools: new Set(),    // 工具帧展开状态（重渲染保持）
  feedLimit: 200,          // 会话流只铺最后这么多项（feedWindow），「显示更早」每次加一页；换会话复位
  msgTail: 1000,           // 向服务端要最后这么多条；铺的窗口快用完且服务端还省着（omitted）时再多要一页
  feedHidden: 0,           // 上次渲染窗口外、已在手里但没铺的项数
  feedRuns: new Map(),     // 折叠组 key → 组数据：收起的组不铺明细，展开时按 key 现填
  devSig: "",              // Tasks.dev 的序列化快照：轮询只序列化新响应一次来比对，不再每轮把旧的也重算一遍
  images: [],              // 粘贴待发的图片 [{media_type, data(base64), size}]
  repoOpen: false, repo: null,  // repo 验收面板
  timer: null, auxTick: 0, busy: false, recentBusy: false, auxLoaded: false, auxError: "", tasksError: "",
  selKind: "task",         // task | cc：选中的是任务还是旁观会话（分组里两种混排，靠它路由详情）
  tabs: JSON.parse(localStorage.getItem("ownward-session-tabs") || "[]"),  // 打开过的会话工作集（桌面版的 tab 页习惯）
  select(id) { stashTaskComposer(); Tasks.selKind = "task"; Tasks.sel = id; Tasks.resetSession(); tabUpsert("task", id); tkOpenDetail("task", id); renderTaskList(); pollDetail(true); },
  resetSession() {
    Tasks.dev = null; Tasks.devSig = ""; Tasks.ccMsgs = []; Tasks.ccOffset = 0; Tasks.openTools = new Set(); Tasks.feedLimit = FEED_PAGE; Tasks.msgTail = MSG_PAGE; Tasks.feedHidden = 0; Tasks.feedRuns = new Map();
    Tasks.images = ComposerDrafts.getAttachments(Tasks.selKind === "task" && Tasks.sel ? `task:${Tasks.sel}` : ""); Tasks.repoOpen = false; Tasks.repo = null;
  },
};
// 项目组展开状态（localStorage 持久化，同 mac 端 AppStorage 的习惯）
const tkExpanded = new Set(JSON.parse(localStorage.getItem("ownward-tasks-expanded") || "[]"));
function tkToggle(p) {
  tkExpanded.has(p) ? tkExpanded.delete(p) : tkExpanded.add(p);
  localStorage.setItem("ownward-tasks-expanded", JSON.stringify([...tkExpanded]));
  renderTaskList();
}
const tkNorm = (s) => String(s || "").trim().replace(/\s+/g, " ").slice(0, 60);

TABS.tasks = {
  init(root) {
    root.innerHTML = `
      <div class="col tasks-list-col">
        <div class="tasks-list-head">
          <div><div class="eyebrow">WORKSPACE</div><h1>任务与会话</h1><p>跟进运行中的工作，或回到最近上下文</p></div>
          <button class="button ghost sm" id="tk-refresh">刷新</button>
        </div>
        <div class="tasks-view-switch" aria-label="任务视图">
          <button class="chip" id="tk-v-all">全部工作</button>
          <button class="chip" id="tk-v-recent">最近会话</button>
        </div>
        <div class="col-scroll tasks-list-scroll" id="tk-list">${stateBox("正在载入任务…", "loading")}</div>
      </div>
      <div class="col tasks-detail-col">
        <div class="tasks-detail-context">
          <button class="button ghost sm tasks-back" onclick="tkBackToList()" aria-label="返回任务列表">← 返回</button>
          <div><span class="tasks-detail-kicker">当前上下文</span><strong id="tk-context-title">选择一个任务</strong></div>
        </div>
        <div class="session-tabs" id="tk-tabs" style="display:none"></div>
        <div class="panel session-pane" id="tk-detail">${stateBox("从左侧选择任务或会话，查看进展并继续工作")}</div>
      </div>`;
    $("#tk-refresh").addEventListener("click", async () => {
      await Promise.all([loadTasksAux(), refreshTasks()]);
      renderTaskList();
    });
    $("#tk-v-all").addEventListener("click", () => tkSetView("all"));
    $("#tk-v-recent").addEventListener("click", () => tkSetView("recent"));
    tkSetView(tkView);
    loadTasksAux().then(renderTaskList);
    renderSessionTabs();
    // 恢复上次工作会话（刷新/重开页面后 tab 工作集不丢）
    const act = localStorage.getItem("ownward-session-tab-active");
    const tb = Tasks.tabs.find((x) => x.id === act);
    if (tb && !Tasks.sel) (tb.kind === "cc" ? selectCc : Tasks.select)(tb.id);
  },
  show() {
    loadTasksAux().then(renderTaskList);
    Tasks.timer = setInterval(() => {
      pollDetail(false);
      // 会话列表/置顶/隐藏是慢数据：每 60s 跟一轮就够（6 × 10s）
      if (++Tasks.auxTick % 6 === 0) loadTasksAux().then(renderTaskList);
    }, 10000);
  },
  hide() { clearInterval(Tasks.timer); },
};

function tkOpenDetail(kind, id) {
  $("#tasks-root")?.setAttribute("data-mobile-view", "detail");
  const meta = tabMeta(kind, id);
  tkSetContext(meta.project, meta.title || "正在载入…");
  const detail = $("#tk-detail");
  if (detail) detail.innerHTML = `<div class="session-head"><button class="button ghost sm tasks-back" onclick="tkBackToList()">← 返回</button><span class="title">正在载入会话</span></div>${stateBox("正在载入详情…", "loading")}`;
}
function tkBackToList() {
  $("#tasks-root")?.setAttribute("data-mobile-view", "list");
}
function tkSetContext(project, title) {
  const el = $("#tk-context-title");
  if (el) el.textContent = [project, title].filter(Boolean).join(" · ") || "会话详情";
}

/** 分组视图的辅助数据：全部会话 + 置顶 + 隐藏项目（任务本体走 SSE/轮询） */
async function loadTasksAux() {
  Tasks.auxError = "";
  const [cc, pin, dis, rc, us, ar] = await Promise.all([
    getJSON("/api/cc/sessions").catch(() => (Tasks.auxError = "部分会话暂时无法载入", null)),
    getJSON("/api/sessions/pinned").catch(() => (Tasks.auxError = "部分会话暂时无法载入", null)),
    getJSON("/api/projects/dismissed").catch(() => (Tasks.auxError = "部分会话暂时无法载入", null)),
    getJSON("/api/dev/recent").catch(() => (Tasks.auxError = "部分会话暂时无法载入", null)),
    getJSON("/api/usage").catch(() => null),   // 额度拿不到不算错：徽标不画就是了
    // 归档列表：与「最近」共用服务端 3s 快照，多这一次不会多算一遍
    getJSON("/api/dev/recent?archived=1").catch(() => null),
  ]);
  if (cc) Tasks.ccList = cc;
  if (pin?.pinned) Tasks.pinned = pin.pinned;
  if (dis?.dismissed) Tasks.dismissed = dis.dismissed;
  if (rc) Tasks.recent = rc;
  if (ar) Tasks.archivedList = ar;
  if (us && JSON.stringify(us) !== JSON.stringify(Tasks.usage)) { Tasks.usage = us; renderUsagePill(); }
  Tasks.auxLoaded = true;
  if (Tasks.selKind === "cc" && Tasks.sel) void pollCcObserve(Tasks.sel, Tasks.selKind, true);
}
TABS._onTasks = () => { if (S.tab === "tasks") renderTaskList(); };

/* ---- 左列 ---- */
function pinKey(kind, ref) { return `${kind}:${ref}`; }
function isPinnedKey(k) { return Tasks.pinned.some((p) => pinKey(p.kind, p.ref) === k); }
async function togglePin(kind, ref, project, title, cwd) {
  const res = await post("/api/sessions/pin", { kind, ref, project, title, cwd, pin: !isPinnedKey(pinKey(kind, ref)) });
  toast(res.msg || "OK");
  await loadTasksAux();
  renderTaskList();
}
async function dismissProject(project) {
  if (!confirm(`隐藏项目「${project}」的历史组？会话保留，有新活动会自动回来`)) return;
  await post("/api/projects/dismiss", { project });
  await loadTasksAux();
  renderTaskList();
}

function pinBtnHtml(kind, ref, project, title, cwd) {
  const on = isPinnedKey(pinKey(kind, ref));
  return `<button class="button sm ghost pin-button" title="${on ? "取消置顶" : "置顶"}" aria-label="${on ? "取消置顶" : "置顶"}" style="${on ? "color:var(--accent)" : ""}"
    onclick="event.stopPropagation();togglePin('${jsq(kind)}','${jsq(ref)}','${jsq(project)}','${jsq((title || "").slice(0, 60))}','${jsq(cwd || "")}')"><svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 3 6 1-.8 4 2.3 2.3-4.1.9-1.7 5.7-1.2-5-3.8-2.2L6 7.8z"/></svg></button>`;
}

function taskCardHtml(t) {
  const running = t.status === "running";
  const failed = !running && t.status !== "done" && t.exitCode !== 0;
  // 色条只标「值得看一眼」的状态：运行中/失败；成功完成保持安静
  const tone = running ? "accent" : failed ? "bad" : "";
  const st = running ? `<span class="dot ok breathe" style="background:var(--accent)"></span>运行中`
    : failed ? `<span class="dot bad"></span>失败 ${t.exitCode ?? ""}`
    : t.kind === "adopted" && t.status === "done" ? `<span class="dot"></span>接管`
    : t.kind === "forked" && !t.endedAt ? `<span class="dot"></span>分叉`
    : `<span class="dot ok"></span>${t.status === "done" ? "完成" : "成功"}`;
  const evolve = t.kind === "evolve" ? `<span class="tag" data-tone="${t.verify === "pass" ? "ok" : t.verify === "fail" ? "bad" : "warn"}">演进 ${esc(t.verify || "")}</span>` : "";
  const provider = Tasks.sel === t.id && Tasks.dev ? (Tasks.dev.backend || Tasks.dev.providerId) : (t.backend || t.providerId || t.mode);
  return `<div class="card clickable" ${tone ? `data-tone="${tone}"` : ""} data-selected="${Tasks.sel === t.id}" onclick="Tasks.select('${jsq(t.id)}')"
    title="${esc(provider)}${t.branch ? ` · ${esc(t.branch)}` : ""}">
    <div class="top task-card-meta">${st}<span class="task-project">${esc(t.project)}</span>${evolve}
      <span class="right mono">${fmtDur(t)}</span></div>
    <div class="body task-card-title">${esc(t.title || t.task)}</div>
    <div class="foot"><span class="mono" style="font-size:11.5px;color:var(--text-tertiary)">${hhmm(t.startedAt)}</span>
      <span style="flex:1"></span>${pinBtnHtml("task", t.id, t.project, t.title || t.task, t.projectDir)}</div>
  </div>`;
}
function ccRowHtml(s) {
  return `<div class="card clickable" data-selected="${Tasks.sel === s.id}" ${s.active ? `data-tone="accent"` : ""} onclick="selectCc('${jsq(s.id)}')">
    <div class="top">${s.active ? `<span class="dot ok breathe"></span>` : ""}
      <span class="tag">旁观${s.kind === "codex" ? "·codex" : ""}</span>
      <span class="task-project">${esc(s.project)}</span>
      <span class="right">${ageText(new Date(s.mtime).toISOString())}</span></div>
    <div class="body task-card-title">${esc(s.title)}</div>
    <div class="foot"><span style="flex:1"></span>${pinBtnHtml("cc", s.id, s.project, s.title, s.cwd)}</div>
  </div>`;
}

/** 去掉「其实就是 ownward 任务」的外部会话：terminal 已认领的 + 首条 user 消息与任务原文同头的 */
function externalSessions() {
  const claimed = new Set(S.tasks.map((t) => t.ccSessionId).filter(Boolean));
  const taskHeads = new Set(S.tasks.map((t) => tkNorm(t.task)));
  const seen = new Set();
  return Tasks.ccList.filter((s) => {
    const last = s.id.split("/").pop() || s.id;
    if (claimed.has(last) || claimed.has(s.id)) return false;
    if (s.firstUser && taskHeads.has(tkNorm(s.firstUser))) return false;
    if (seen.has(s.id)) return false;   // 重复 id 会把布局打炸
    seen.add(s.id);
    return true;
  });
}

/* ---- 最近会话视图：ownward 原生对话索引（非代笔/非旁观），表头 chip 切换 ---- */
let tkView = localStorage.getItem("ownward-tasks-view") || "all";
function tkSetView(v) {
  tkView = v;
  localStorage.setItem("ownward-tasks-view", v);
  const a = $("#tk-v-all"), r = $("#tk-v-recent");
  if (a) a.dataset.on = String(v === "all");
  if (r) r.dataset.on = String(v === "recent");
  renderTaskList();
}
/** 引擎标签：优先当前 provider（接力后会变），派发时的 mode 只做兜底——与 iOS engineLabel 同口径 */
function engineTag(mode, backend, providerId) {
  return backend || providerId || (mode === "codex-bg" ? "codex" : mode === "codebuddy-bg" ? "codebuddy" : "claude");
}
function rcCardHtml(s) {
  const state = sessionState("task", s), hit = rcHits()?.get(s.id);
  return `<div class="card clickable" ${state.tone ? `data-tone="${state.tone}"` : ""} data-selected="${Tasks.sel === s.id}" onclick="Tasks.select('${jsq(s.id)}')">
    <div class="top">${sessionStateHtml(state)}
      <span class="task-project">${esc(s.project)}</span>
      <span class="tag">${esc(engineTag(s.mode, s.backend, s.providerId))}</span>
      <span class="right mono">${ageText(new Date(s.lastAt).toISOString())}</span></div>
    <div class="body task-card-title">${esc(s.title)}</div>
    ${s.last ? `<div class="body" style="color:var(--text-tertiary);-webkit-line-clamp:1;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">${esc(s.last)}</div>` : ""}
    ${hit ? `<div class="body" style="color:var(--text-secondary);-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">🔍 ${esc(hit.snippet)}</div>` : ""}
    <div class="foot"><span class="mono" style="font-size:11px;color:var(--text-tertiary)">💬 ${s.msgs}${s.userMsgs > 1 ? ` · 追问 ${s.userMsgs - 1}` : ""}</span>
      <span style="flex:1"></span>${rcArchiveBtnHtml(s.id)}${pinBtnHtml("task", s.id, s.project, s.title, "")}</div>
  </div>`;
}
/** 归档 / 恢复：卡片整体是「打开会话」，按钮必须自己吞掉点击 */
function rcArchiveBtnHtml(id) {
  return Tasks.showArchived
    ? `<button class="button sm ghost" title="恢复到最近会话" aria-label="恢复" onclick="event.stopPropagation();rcArchive('${jsq(id)}',true)">恢复</button>`
    : `<button class="button sm ghost" title="归档：从最近会话隐藏。会话与记录一字不动，之后再有新活动会自动回来" aria-label="归档" onclick="event.stopPropagation();rcArchive('${jsq(id)}',false)">归档</button>`;
}
async function rcArchive(id, restore) {
  const res = await post("/api/sessions/archive", { id, restore: !!restore });
  toast(res.msg || "OK");
  await loadTasksAux();
  renderTaskList();
}
function rcToggleArchived() {
  Tasks.showArchived = !Tasks.showArchived;
  renderTaskList();
}
/** 当前列表的数据源：「最近」或「已归档」 */
function rcSource() { return Tasks.showArchived ? Tasks.archivedList : Tasks.recent; }
/** 计数条右侧的归档入口（一条都没归档过就不占地方） */
function rcArchivedToggleHtml() {
  if (!Tasks.showArchived && !Tasks.archivedList.length) return "";
  return `<button class="button ghost sm" onclick="rcToggleArchived()">${Tasks.showArchived ? "← 返回最近" : `已归档 ${Tasks.archivedList.length}`}</button>`;
}
/** 当前筛选词对应的全文命中（没查到或词已变就是 null） */
function rcHits() { const q = Tasks.rq.trim().toLowerCase(); return q && Tasks.rqHits?.q === q ? Tasks.rqHits.byTask : null; }
function rcFiltered() {
  const q = Tasks.rq.trim().toLowerCase(), hits = rcHits(), src = rcSource();
  return q ? src.filter((s) => `${s.project}\n${s.title}\n${s.last}`.toLowerCase().includes(q) || !!hits?.has(s.id)) : src;
}
/** 全文命中但已经滚出「最近」列表（归档 / 更早）的会话：单独列成简卡，点了照样能打开 */
function rcExtraHitsHtml() {
  const hits = rcHits(); if (!hits || Tasks.showArchived) return "";
  const known = new Set(Tasks.recent.map((s) => s.id));
  // 归档会话照样搜得到（归档只改列表可见性，不碰索引）——但简卡上要说清它为什么不在列表里，
  // 否则看着像「搜得到却找不到」。顺手给个就地恢复，不用先切到归档视图。
  const archived = new Set(Tasks.archivedList.map((s) => s.id));
  return [...hits.entries()].filter(([id]) => !known.has(id)).map(([id, h]) => `
    <div class="card clickable" data-selected="${Tasks.sel === id}" onclick="Tasks.select('${jsq(id)}')">
      <div class="top"><span class="task-project">${esc(h.project || "?")}</span><span class="tag">${esc(engineTag(h.mode, h.providerId, ""))}</span>${archived.has(id) ? `<span class="tag" data-tone="warn" title="已归档：不在最近列表里，但搜索照样能找到">已归档</span>` : ""}<span class="right mono">${h.lastAt ? ageText(new Date(h.lastAt).toISOString()) : "更早"}</span></div>
      <div class="body task-card-title">${esc(h.title || id)}</div>
      <div class="body" style="color:var(--text-tertiary);-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">🔍 ${esc(h.snippet)}</div>
      ${archived.has(id) ? `<div class="foot"><span style="flex:1"></span><button class="button sm ghost" onclick="event.stopPropagation();rcArchive('${jsq(id)}',true)">恢复</button></div>` : ""}
    </div>`).join("");
}
function rcCardsHtml() {
  const list = rcFiltered(), extra = rcExtraHitsHtml();
  return (list.map(rcCardHtml).join("") + extra)
    || stateBox(Tasks.rq.trim() ? "没有匹配的会话" : Tasks.showArchived ? "没有已归档的会话" : "还没有 Ownward 会话，点右上「派新任务」开始");
}
/** 全文搜索：≥2 字就问派生索引（读库，不打开会话）；回来后按命中刷卡片 */
function rcSearch(q) {
  clearTimeout(Tasks.rqTimer);
  Tasks.rqTimer = setTimeout(async () => {
    const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}&limit=100`).catch(() => null);
    if (Tasks.rq.trim().toLowerCase() !== q) return;
    const byTask = new Map();
    for (const h of r?.hits || []) if (!byTask.has(h.taskId)) byTask.set(h.taskId, { snippet: String(h.snippet || "").replace(/\s+/g, " "), project: h.project, title: h.title, mode: h.mode, lastAt: h.lastAt });
    Tasks.rqHits = { q, byTask };
    rcFilter(Tasks.rq);
  }, 200);
}
/** 筛选输入只更新卡片容器，不整列重渲——中文输入法组字不被打断 */
function rcFilter(v) {
  Tasks.rq = v;
  const q = v.trim().toLowerCase();
  if (q.length >= 2 && Tasks.rqHits?.q !== q) rcSearch(q);
  const box = $("#tk-rc-cards"); if (box) box.innerHTML = rcCardsHtml();
  const meta = $("#tk-rc-meta"); if (meta) meta.textContent = `${rcFiltered().length} / ${rcSource().length}`;
}

function renderTaskList() {
  const el = $("#tk-list"); if (!el) return;
  renderSessionTabs();   // 顺路刷 tab 栏（高亮/迟到的标签）
  if (composingEl && el.contains(composingEl)) return;   // 筛选框组字中：跳过这轮，SSE/定时器下轮会补
  // 重渲染会吃掉筛选框的焦点/光标——先存后还
  const rqHadFocus = document.activeElement === $("#tk-rq");
  if (!Tasks.auxLoaded && S.tasks.length === 0 && !Tasks.tasksError) { el.innerHTML = stateBox("正在载入任务…", "loading"); return; }
  if (tkView === "recent") {
    el.innerHTML = `
      ${Tasks.tasksError ? `<div class="tasks-inline-state">${stateBox(Tasks.tasksError, "error")}</div>` : ""}
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <input type="text" id="tk-rq" placeholder="${Tasks.showArchived ? "在已归档里筛选…" : "筛选：项目 / 标题 / 内容…"}" value="${esc(Tasks.rq)}" oninput="rcFilter(this.value)" style="flex:1;font-size:12px">
        <span class="mono" id="tk-rc-meta" style="font-size:11px;color:var(--text-tertiary)">${rcFiltered().length} / ${rcSource().length}</span>
        ${rcArchivedToggleHtml()}
      </div>
      <div id="tk-rc-cards" class="glist">${rcCardsHtml()}</div>`;
    if (rqHadFocus) { const ni = $("#tk-rq"); ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
    return;
  }
  const pinnedKeys = new Set(Tasks.pinned.map((p) => pinKey(p.kind, p.ref)));
  const tasks = S.tasks.filter((t) => t.kind !== "routine");
  const routine = S.tasks.filter((t) => t.kind === "routine");
  const running = tasks.filter((t) => t.status === "running" && !pinnedKeys.has(pinKey("task", t.id)));
  const external = externalSessions();
  const activeCc = external.filter((s) => s.active && !pinnedKeys.has(pinKey("cc", s.id)));

  // 置顶区：daemon 持久化的长期会话，永远最顶
  const byId = new Map(S.tasks.map((t) => [t.id, t]));
  const ccById = new Map(Tasks.ccList.map((s) => [s.id, s]));
  const pinnedHtml = Tasks.pinned.map((p) => {
    if (p.kind === "task") {
      const t = byId.get(p.ref);
      if (t) return taskCardHtml(t);
      // 任务掉出最近 30 条窗口：详情页会按 id 单查，仍能点开
      return `<div class="card clickable" onclick="Tasks.select('${jsq(p.ref)}')">
        <div class="top"><span class="title">${esc(p.project || "任务")}</span></div>
        <div class="body">${esc(p.title || p.ref)}</div>
        <div class="foot"><span style="flex:1"></span>${pinBtnHtml("task", p.ref, p.project, p.title, p.cwd)}</div></div>`;
    }
    const s = ccById.get(p.ref);
    if (s) return ccRowHtml(s);
    // 会话掉出列表窗口：还能点开旁观（增量读不依赖列表）
    return `<div class="card clickable" onclick="selectCc('${jsq(p.ref)}')">
      <div class="top"><span class="tag">旁观</span><span class="title">${esc(p.project || "会话")}</span></div>
      <div class="body">${esc(p.title || p.ref)}</div>
      <div class="foot"><span style="flex:1"></span>${pinBtnHtml(p.kind, p.ref, p.project, p.title, p.cwd)}</div></div>`;
  }).join("");

  // 项目分组：历史任务 + 空闲旁观会话混排（时间倒序），隐藏的项目有新活动自动重现
  const byProject = new Map();
  const push = (project, row) => {
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push(row);
  };
  for (const t of tasks) {
    if (t.status === "running" || pinnedKeys.has(pinKey("task", t.id))) continue;
    push(t.project, { type: "task", t, time: +new Date(t.startedAt), dir: t.projectDir });
  }
  for (const s of external) {
    if (s.active || pinnedKeys.has(pinKey("cc", s.id))) continue;
    push(s.project, { type: "cc", s, time: s.mtime, dir: s.cwd });
  }
  const groups = [...byProject.entries()]
    .map(([project, rows]) => ({ project, rows: rows.sort((a, b) => b.time - a.time) }))
    .filter((g) => {
      const at = Tasks.dismissed[g.project];
      return !at || (g.rows[0]?.time || 0) > at;
    })
    .sort((a, b) => (b.rows[0]?.time || 0) - (a.rows[0]?.time || 0));

  const groupsHtml = groups.map((g) => {
    const open = tkExpanded.has(g.project);
    const dir = g.rows.find((r) => r.dir)?.dir || "";
    const head = `<div class="group-head" onclick="tkToggle('${jsq(g.project)}')">
      <span class="chev">${open ? "▾" : "▸"}</span>
      <span class="gname"><svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 5.5h5l1.5 1.7h7.9v8.3H2.8z"/><path d="M2.8 7.2V4.5h4.5l1.4 1.6"/></svg>${esc(g.project)}</span>
      <span class="gmeta mono">${ageText(new Date(g.rows[0].time).toISOString())} · ${g.rows.length}</span>
      ${dir ? `<button class="button sm ghost" title="在此项目建任务" onclick="event.stopPropagation();openWork('${jsq(dir)}')">＋</button>` : ""}
      <button class="button sm ghost" title="隐藏项目（会话保留，有新活动自动回来）" onclick="event.stopPropagation();dismissProject('${jsq(g.project)}')">✕</button>
    </div>`;
    const rows = open ? `<div class="glist">${g.rows.slice(0, 14).map((r) => r.type === "task" ? taskCardHtml(r.t) : ccRowHtml(r.s)).join("")}</div>` : "";
    return head + rows;
  }).join("");

  // 例行任务折叠组（routine 代笔，不占人派任务的视野）
  const autoOpen = tkExpanded.has("__auto__");
  const autoRunning = routine.filter((t) => t.status === "running").length;
  const autoHtml = routine.length ? `<div class="group-head" onclick="tkToggle('__auto__')">
      <span class="chev">${autoOpen ? "▾" : "▸"}</span>
      <span class="gname">⚙ 例行任务（routine 代笔）</span>
      <span class="gmeta mono">${autoRunning ? `${autoRunning} 运行中 · ` : ""}${routine.length}</span>
    </div>` + (autoOpen ? `<div class="glist">${routine.slice(0, 10).map(taskCardHtml).join("")}</div>` : "") : "";

  el.innerHTML =
    (Tasks.tasksError ? `<div class="tasks-inline-state">${stateBox(Tasks.tasksError, "error")}</div>` : "") +
    (Tasks.auxError ? `<div class="tasks-inline-state">${stateBox(Tasks.auxError, "error")}</div>` : "") +
    (S.tasks.length === 0 && Tasks.ccList.length === 0
      ? stateBox("还没有任务或会话，点右上「派新任务」开始") : "") +
    (pinnedHtml ? `<div class="section-title"><svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 3 6 1-.8 4 2.3 2.3-4.1.9-1.7 5.7-1.2-5-3.8-2.2L6 7.8z"/></svg>置顶</div><div class="glist">${pinnedHtml}</div>` : "") +
    (running.length || activeCc.length
      ? `<div class="section-title">正在进行</div><div class="glist">${running.map(taskCardHtml).join("")}${activeCc.map(ccRowHtml).join("")}</div>` : "") +
    (groups.length ? `<div class="section-title">项目</div>` : "") +
    groupsHtml +
    autoHtml;
}
function selectCc(id) { stashTaskComposer(); Tasks.selKind = "cc"; Tasks.sel = id; Tasks.resetSession(); tabUpsert("cc", id); tkOpenDetail("cc", id); renderTaskList(); pollDetail(true); }

function stashTaskComposer() {
  if (!Tasks.sel || Tasks.selKind !== "task") return;
  const key = `task:${Tasks.sel}`, input = $("#tk-input");
  if (input) ComposerDrafts.setText(key, input.value);
  ComposerDrafts.setAttachments(key, Tasks.images);
}

/* ---- 会话 tab 栏：点开的会话常驻成 tab（去重/可关/持久化），切换不用回列表翻 ---- */
function tabMeta(kind, id) {
  if (kind === "task") {
    const t = S.tasks.find((x) => x.id === id) || Tasks.recent.find((x) => x.id === id);
    return { project: t?.project || "任务", title: String(t?.title || t?.task || "").slice(0, 40) };
  }
  const s = Tasks.ccList.find((x) => x.id === id);
  return { project: s?.project || "会话", title: String(s?.title || "").slice(0, 40) };
}
function sessionState(kind, item) {
  if (kind === "cc") return item?.active
    ? { key: "running", label: "运行中", tone: "accent", dot: "ok breathe", symbol: "●" }
    : null;
  if (!item) return null;
  const live = Tasks.selKind === "task" && Tasks.sel === item.id ? Tasks.dev : null;
  const pending = live?.pending ?? item?.runnerState?.pending ?? item?.pending ?? [];
  if (pending.length) {
    const question = pending.some((p) => p.toolName === "AskUserQuestion");
    return { key: "pending", label: question ? "待答复" : "待批准", tone: "warn", dot: "warn", symbol: "!" };
  }
  if (item.uncertain || (item.status === "exited" && item.exitCode == null)) return { key: "uncertain", label: "状态待确认", tone: "warn", dot: "warn", symbol: "?" };
  if (live?.turn === "running" || item?.runnerState?.turn === "running" || item?.status === "running")
    return { key: "running", label: "运行中", tone: "accent", dot: "ok breathe", symbol: "●" };
  if (item.status === "exited" && item.exitCode !== 0)
    return { key: "failed", label: "失败", tone: "bad", dot: "bad", symbol: "×" };
  if (item.status === "done" || (item.status === "exited" && item.exitCode === 0))
    return { key: "done", label: "完成", tone: "", dot: "ok", symbol: "✓" };
  return null;
}
function sessionStateHtml(state, compact = false) {
  if (!state) return "";
  return `<span class="session-state" data-state="${state.key}" title="${state.label}">${compact ? `<span class="session-state-symbol">${state.symbol}</span>` : `<span class="dot ${state.dot}"></span>${state.label}`}</span>`;
}

function handoffState(dev) {
  if (!dev) return { disabled: true, reason: "会话尚未载入" };
  if (dev.turn === "running") return { disabled: true, reason: "本轮运行中，请先等待结束或中断" };
  if ((dev.pending || []).length) return { disabled: true, reason: "请先处理待答复或待批准事项" };
  if ((dev.queued || []).length) return { disabled: true, reason: "请先发送或撤回排队消息" };
  if ((dev.control ?? "ownward") !== "ownward") return { disabled: true, reason: "输入权不在 Ownward，请先接管输入" };
  return { disabled: false, reason: "" };
}
function handoffErrorCode(result) { return String(result?.errorCode || result?.code || ""); }
function sessionConfigValues() {
  return {
    providerId: $("#session-config-provider")?.value || "",
    model: $("#session-config-model")?.value || "",
    effort: $("#session-config-effort")?.value || "",
  };
}
function sessionConfigIsNoop(values = sessionConfigValues()) {
  const dialog = $("#session-config-dialog");
  return values.providerId === dialog?.dataset.currentProvider
    && values.model === (dialog?.dataset.currentModel || "")
    && values.effort === (dialog?.dataset.currentEffort || "");
}
function sessionConfigStatus(message, state = "") {
  const status = $("#session-config-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}
function updateSessionConfigSubmit(clearError = true) {
  const dialog = $("#session-config-dialog"), submit = $("#session-config-submit");
  if (!dialog || !submit || dialog.dataset.busy === "true") return;
  const values = sessionConfigValues(), noop = sessionConfigIsNoop(values), sameProvider = values.providerId === dialog.dataset.currentProvider;
  const capability = workProviderCapability(values.providerId);
  const modelValid = sameProvider && !values.model || capability.models.includes(values.model);
  const effortValid = sameProvider && !values.effort || workProviderEfforts(values.providerId, values.model).includes(values.effort);
  const validPair = modelValid && effortValid;
  submit.disabled = noop || !values.providerId || !validPair;
  if (clearError || $("#session-config-status")?.dataset.state !== "error") {
    // 同 Provider 只换模型/深度是就地改（CLI 原生支持带新参数续聊，原生上下文一字不丢）；跨 Provider 才需要接力
    sessionConfigStatus(noop ? "当前配置没有变化" : sameProvider ? "将就地切换模型/思考深度，沿用当前会话（不接力，下一轮生效）" : "将创建目标 Provider 的新会话并沿用有界历史", noop ? "muted" : "ready");
  }
}
function fillSessionConfigEfforts(requestedEffort = "", preserveLegacy = false, allowOmitted = false) {
  const dialog = $("#session-config-dialog"), providerId = $("#session-config-provider")?.value || "";
  const model = $("#session-config-model")?.value || "", effortSelect = $("#session-config-effort");
  if (!dialog || !effortSelect) return;
  const efforts = workProviderEfforts(providerId, model);
  const legacyEffort = preserveLegacy && requestedEffort && !efforts.includes(requestedEffort) ? requestedEffort : "";
  const legacyDefault = allowOmitted && !requestedEffort;
  effortSelect.innerHTML = `${legacyDefault ? '<option value="">Provider 默认（当前）</option>' : ""}${legacyEffort ? `<option value="${esc(legacyEffort)}" disabled>${esc(legacyEffort)}（当前值不受所选模型支持）</option>` : ""}${efforts.map((item) => `<option value="${esc(item)}">${esc(WORK_EFFORT_LABELS[item] || item)}</option>`).join("")}`;
  effortSelect.value = legacyDefault || legacyEffort ? requestedEffort : efforts.includes(requestedEffort) ? requestedEffort : workProviderDefaultEffort(providerId, model);
  updateSessionConfigSubmit();
}
function fillSessionConfigOptions(providerId) {
  const dialog = $("#session-config-dialog"), modelSelect = $("#session-config-model"), effortSelect = $("#session-config-effort");
  if (!dialog || !modelSelect || !effortSelect) return;
  const capability = workProviderCapability(providerId), sameProvider = providerId === dialog.dataset.currentProvider;
  const currentModel = dialog.dataset.currentModel || "", currentEffort = dialog.dataset.currentEffort || "";
  const model = sameProvider ? currentModel : capability.handoffModel;
  const effort = sameProvider ? currentEffort : capability.handoffEffort;
  const customModel = sameProvider && currentModel && !capability.models.includes(currentModel) ? [currentModel] : [];
  // API 把空字符串视为“未传”，无法清除已经持久化的显式值。只有原值本来就缺失的
  // legacy 会话才显示空选项，避免画出一个实际不会生效的“重置为 Provider 默认”。
  modelSelect.innerHTML = `${sameProvider && !currentModel ? '<option value="">Provider 默认（当前）</option>' : ""}${[...customModel, ...capability.models].map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join("")}`;
  modelSelect.value = model;
  fillSessionConfigEfforts(effort, sameProvider, sameProvider);
}
function openSessionConfig(id) {
  const dev = Tasks.dev, state = handoffState(dev);
  if (state.disabled) { toast(state.reason); return; }
  const dialog = $("#session-config-dialog"), body = $("#session-config-body");
  if (!dialog || !body) return;
  const currentProvider = dev.backend || dev.providerId || "claude";
  dialog.dataset.taskId = id;
  dialog.dataset.currentProvider = currentProvider;
  dialog.dataset.currentModel = dev.model || "";
  dialog.dataset.currentEffort = dev.effort || "";
  dialog.dataset.busy = "false";
  body.innerHTML = `<div class="dialog-head"><div><div class="eyebrow">SESSION CONFIG</div><h2 id="session-config-title">切换或调整会话</h2></div><button class="button ghost" id="session-config-close" type="button">关闭</button></div>
    <div class="session-config-current" aria-label="当前会话配置"><span><b>Provider</b>${esc(currentProvider)}</span><span><b>模型</b>${esc(dev.model || "Provider 默认")}</span><span><b>思考深度</b>${esc(dev.effort || "Provider 默认")}</span></div>
    <div class="session-config-grid">
      <label>Provider<select id="session-config-provider">${Object.entries(WORK_PROVIDER_CAPABILITIES).map(([providerId, capability]) => `<option value="${providerId}" ${providerId === currentProvider ? "selected" : ""}>${esc(capability.label)}</option>`).join("")}</select></label>
      <label>模型<select id="session-config-model"></select></label>
      <label>思考深度<select id="session-config-effort"></select></label>
    </div>
    <div class="session-config-status" id="session-config-status" role="status" aria-live="polite"></div>
    <div class="dialog-actions"><button class="button ghost" id="session-config-cancel" type="button">取消</button><button class="button primary" id="session-config-submit" type="button">应用配置</button></div>`;
  $("#session-config-close").addEventListener("click", () => dialog.close());
  $("#session-config-cancel").addEventListener("click", () => dialog.close());
  $("#session-config-provider").addEventListener("change", (event) => fillSessionConfigOptions(event.target.value));
  $("#session-config-model").addEventListener("change", () => fillSessionConfigEfforts($("#session-config-effort").value, false, $("#session-config-provider").value === dialog.dataset.currentProvider));
  $("#session-config-effort").addEventListener("change", () => updateSessionConfigSubmit());
  $("#session-config-submit").addEventListener("click", submitSessionConfig);
  fillSessionConfigOptions(currentProvider);
  dialog.showModal();
}
async function submitSessionConfig() {
  const dialog = $("#session-config-dialog"), submit = $("#session-config-submit");
  if (!dialog || !submit || dialog.dataset.busy === "true") return;
  const { providerId, model, effort } = sessionConfigValues(), id = dialog.dataset.taskId;
  if (sessionConfigIsNoop({ providerId, model, effort })) { updateSessionConfigSubmit(); return; }
  dialog.dataset.busy = "true";
  $$('button,select', $("#session-config-body")).forEach((control) => { control.disabled = true; });
  submit.textContent = "应用中…";
  const sameProvider = providerId === dialog.dataset.currentProvider;
  sessionConfigStatus(sameProvider ? "正在就地切换配置…" : "正在创建接力会话并应用配置…", "busy");
  let applied = false;
  try {
    const payload = { id, providerId, model: model || undefined, effort: effort || undefined, reason: sameProvider ? "manual-reconfigure" : "manual-handoff" };
    let res = sameProvider ? await post("/api/dev/reconfigure", { id, model: payload.model, effort: payload.effort }) : await post("/api/dev/handoff", payload);
    if (handoffErrorCode(res) === "SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED") {
      const proceed = confirm("旧会话存在结果未知的操作，可能已经产生副作用。\n\n系统不会重放旧命令；继续只会创建新的 Session 接力。确认仍要继续？");
      if (!proceed) { sessionConfigStatus("已取消：请先确认旧会话的实际结果", "error"); return; }
      res = await post("/api/dev/handoff", { ...payload, confirmUnknownOutcome: true });
    }
    if (!res?.ok) throw new Error(res?.msg || "会话配置失败");
    applied = true;
    sessionConfigStatus(res.msg || "配置已应用，正在刷新会话…", "success");
    await refreshTasks();
    await pollDetail(true);
    dialog.close();
    toast(res.msg || "会话配置已更新");
  } catch (error) {
    sessionConfigStatus(`${applied ? "配置已应用，但刷新失败" : "应用失败"}：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    dialog.dataset.busy = "false";
    if (dialog.open) {
      $$('button,select', $("#session-config-body")).forEach((control) => { control.disabled = false; });
      if (applied) {
        [$("#session-config-provider"), $("#session-config-model"), $("#session-config-effort"), submit].forEach((control) => { control.disabled = true; });
        submit.textContent = "已应用";
      } else {
        submit.textContent = "应用配置";
        updateSessionConfigSubmit(false);
      }
    }
  }
}
/** 会话谱系：接力/换 ref 后，之前那个引擎的会话 ID 和恢复命令要能查到——但日常几乎不用，所以收在头部
 *  「谱系」按钮后面按需弹窗，不再常驻输入框上方（原先那块 <details> 每次重绘都带 open，等于每轮自己弹开）。
 *  每行：引擎 · 模型 · 深度 · 时间 · 原生会话 ID · 复制恢复命令。
 *  没有 nativeRef 的行（还没跑过一轮 / 归档）如实写「尚无原生会话 ID」，不编一个命令出来。 */
function lineageRows(lineage) {
  if (!Array.isArray(lineage) || !lineage.length) return [];
  const when = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? new Date(t).toLocaleString(globalThis.I18N?.locale || "zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""; };
  const row = (entry, label, ref, resume, extra = "") => `<div class="lineage-row" data-current="${!!entry.current}">
      <span class="mode-tag" data-m="${esc(entry.providerId)}">${esc(entry.providerId)}</span>
      <span class="lineage-meta">${esc(label)}${extra ? ` · ${esc(extra)}` : ""} · 模型 ${esc(entry.model || "默认")} · 深度 ${esc(entry.effort || "默认")}${entry.reason ? ` · ${esc(entry.reason)}` : ""}</span>
      ${ref ? `<code title="原生会话 ID">${esc(ref)}</code>` : `<span class="lineage-meta muted">尚无原生会话 ID</span>`}
      ${resume?.cmd ? `<button class="button sm secondary" onclick="copyResumeCmd('${jsq(resume.cmd)}')" title="${esc(resume.cmd)}">复制恢复命令</button>` : ""}
    </div>`;
  return lineage.flatMap((entry) => [
    ...(entry.previousRefs || []).map((prev) => row(entry, `${when(entry.createdAt)} 起`, prev.nativeRef, prev.resume, "已被 /new 换掉")),
    row(entry, entry.current ? `当前 · ${when(entry.createdAt)} 起` : `${when(entry.createdAt)} → ${when(entry.handedOffAt)} 已接力`, entry.nativeRef, entry.resume),
  ]);
}
function openLineage() {
  const dialog = $("#lineage-dialog"), body = $("#lineage-body"), rows = lineageRows(Tasks.dev?.lineage);
  if (!dialog || !body) return;
  if (!rows.length) { toast("这个会话还没有谱系记录"); return; }
  body.innerHTML = `<div class="dialog-head"><div><div class="eyebrow">SESSION LINEAGE</div><h2 id="lineage-title">会话谱系与恢复命令</h2></div><button class="button ghost" id="lineage-close" type="button">关闭</button></div>
    <p class="lineage-note"><span>接力链上每个引擎各一条：原生会话 ID，以及可直接粘贴到终端的恢复命令。</span><span class="lineage-count">${rows.length} 个原生会话</span></p>
    <div class="lineage-list">${rows.join("")}</div>`;
  $("#lineage-close").addEventListener("click", () => dialog.close());
  dialog.showModal();
}
/** 额度徽标：按会话引擎取对应家的窗口（Claude 5h/周，Codex 按套餐返回的主/次窗口），写法对齐 statusline 的
 *  5h:46%(3h10m)——百分比后括号里是距重置的时间。最高的那个窗口过 70%/90% 变色；拿不到就不画，空着比错数字好。 */
function usageEta(iso) {
  const ms = Date.parse(iso || "") - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d${h ? `${h}h` : ""}` : h ? `${h}h${mm ? `${mm}m` : ""}` : `${mm}m`;
}
function usagePillHtml(backend) {
  const u = Tasks.usage?.[backend];
  if (!u?.windows?.length) return "";
  const worst = Math.max(...u.windows.map((w) => Number(w.percent) || 0));
  const tone = worst >= 90 ? "bad" : worst >= 70 ? "warn" : "";
  const text = u.windows.map((w) => { const eta = usageEta(w.resetsAt); return `${w.label} ${Math.round(w.percent)}%${eta ? `(${eta})` : ""}`; }).join(" · ");
  const title = `${backend} 订阅额度${u.plan ? `（${u.plan}）` : ""}：` + u.windows.map((w) =>
    `${w.label} 窗口已用 ${Math.round(w.percent)}%${w.resetsAt ? `，${new Date(w.resetsAt).toLocaleString(globalThis.I18N?.locale || "zh-CN", { hour12: false })} 重置` : ""}`).join("；");
  return `<span class="tag mono"${tone ? ` data-tone="${tone}"` : ""} title="${esc(title)}">额度 ${esc(text)}</span>`;
}
/** 额度独立于会话数据 60s 刷一次：就地换徽标内容，不为它整块重渲会话 */
function renderUsagePill() {
  const el = $("#tk-usage");
  if (el) el.innerHTML = usagePillHtml(el.dataset.backend);
}
function tabsSave() { localStorage.setItem("ownward-session-tabs", JSON.stringify(Tasks.tabs)); }
function tabUpsert(kind, id) {
  const meta = tabMeta(kind, id);
  const ex = Tasks.tabs.find((x) => x.id === id);
  if (ex) { if (meta.title) Object.assign(ex, meta); }
  else {
    Tasks.tabs.push({ kind, id, ...meta });
    if (Tasks.tabs.length > 10) {
      const i = Tasks.tabs.findIndex((x) => x.id !== id);   // 满了踢最老的非当前
      if (i >= 0) Tasks.tabs.splice(i, 1);
    }
  }
  localStorage.setItem("ownward-session-tab-active", id);
  tabsSave();
  renderSessionTabs();
}
function renderSessionTabs() {
  const el = $("#tk-tabs"); if (!el) return;
  el.style.display = Tasks.tabs.length ? "" : "none";
  // 标签自愈：打开时缓存没到位的，等列表数据来了补上
  for (const tb of Tasks.tabs) if (!tb.title) { const m = tabMeta(tb.kind, tb.id); if (m.title) Object.assign(tb, m); }
  el.innerHTML = Tasks.tabs.map((tb) => {
    const recent = Tasks.recent.find((x) => x.id === tb.id);
    const current = S.tasks.find((x) => x.id === tb.id);
    const item = tb.kind === "cc" ? Tasks.ccList.find((x) => x.id === tb.id) : recent && current ? { ...recent, ...current, runnerState: recent.runnerState } : current || recent;
    const state = sessionState(tb.kind, item);
    return `
    <div class="stab" data-on="${Tasks.sel === tb.id}" title="${esc(tb.title || tb.project)}"
      onclick="${tb.kind === "cc" ? `selectCc('${jsq(tb.id)}')` : `Tasks.select('${jsq(tb.id)}')`}">
      ${sessionStateHtml(state, true)}
      <span class="lbl">${esc(tb.project)}${tb.title ? `<span class="sub"> · ${esc(tb.title.slice(0, 15))}</span>` : ""}</span>
      <button class="x" title="关闭" onclick="event.stopPropagation();closeSessionTab('${jsq(tb.id)}')">✕</button>
    </div>`; }).join("");
  const on = el.querySelector('.stab[data-on="true"]');
  on?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function closeSessionTab(id) {
  const i = Tasks.tabs.findIndex((x) => x.id === id);
  if (i < 0) return;
  Tasks.tabs.splice(i, 1);
  tabsSave();
  if (Tasks.sel === id) {
    stashTaskComposer();
    const nb = Tasks.tabs[Math.min(i, Tasks.tabs.length - 1)];
    if (nb) { (nb.kind === "cc" ? selectCc : Tasks.select)(nb.id); return; }
    Tasks.sel = null;
    localStorage.removeItem("ownward-session-tab-active");
    $("#tk-detail").innerHTML = stateBox("从列表选择任务或会话，查看进展并继续工作");
    tkSetContext("", "选择一个任务");
    tkBackToList();
    renderTaskList();
  }
  renderSessionTabs();
}

/* ---- 详情轮询 ---- */
async function pollDetail(force) {
  if (S.tab !== "tasks" || !Tasks.sel) return;
  if (Tasks.busy) { if (force) setTimeout(() => pollDetail(true), 300); return; }  // 强制刷新别被在飞的轮询吞掉
  const sel = Tasks.sel, kind = Tasks.selKind;
  // 后台轮询只跟"运行中"的进度；任务已结束就不再每轮刷详情（点开/切换走 force 强制刷一次）
  if (!force && kind !== "cc" && !String(sel).startsWith("cdx:")) {
    const snap = S.tasks.find((x) => x.id === sel);
    if (snap && snap.status !== "running") return;
  }
  Tasks.busy = true;
  const stale = () => Tasks.sel !== sel || Tasks.selKind !== kind;
  try {
    if (kind === "cc" || String(sel).startsWith("cdx:")) { await pollCcObserve(sel, kind); return; }
    const t = S.tasks.find((x) => x.id === sel) || await getJSON(`/api/tasks/${sel}`).catch(() => null);
    if (stale()) return;
    if (!t) { $("#tk-detail").innerHTML = stateBox("任务不存在或已移除", "error"); tkSetContext("", "任务不可用"); return; }
    tkSetContext(t.project, t.title || t.task);
    if (t.engine) {
      const dev = await getJSON(`/api/dev/messages?id=${encodeURIComponent(t.id)}&tail=${Tasks.msgTail}`).catch(() => null);
      if (stale()) return;
      if (!dev) {
        $("#tk-detail").innerHTML = detailHead(t) + stateBox("会话详情暂时无法载入，正在重试", "error");
        return;
      }
      // 长会话的响应有好几 MB：只序列化新响应一次，跟上一轮存下的串比
      const sig = JSON.stringify(dev), changed = force || sig !== Tasks.devSig;
      Tasks.dev = dev; Tasks.devSig = sig;
      if (changed) { renderSessionTabs(); renderSession(t, dev); }
    } else if (t.mode === "terminal") {
      await renderTerminal(t, force, sel, kind);
      if (stale()) return;
    } else {
      const lg = await getJSON(`/api/tasks/${t.id}/log`).catch(() => null);
      if (stale()) return;
      if (!lg) {
        $("#tk-detail").innerHTML = detailHead(t) + stateBox("任务日志暂时无法载入，正在重试", "error");
        return;
      }
      renderLogDetail(t, lg.text || "(无日志)", force);
    }
  } finally { Tasks.busy = false; }
}

/* ---- 详情头 ---- */
/* 头部只放身份（项目 / 引擎 / 运行状态）和高频动作；ctx、额度、模型、深度、token、分支、目录这些读数
 * 全下沉到输入框底下的信息条（sessionMetaHtml）——一行横着挤十来个徽标谁也读不清，而且它们本来就是
 * "写指令时顺手瞄一眼"的东西，贴着输入框比贴着标题有用。 */
function detailHead(t, extra) {
  const dev = Tasks.dev;
  const inSession = !!(t.engine && dev);   // 会话视图：读数交给信息条，这里不重复画
  const btns = [];
  if (t.engine && dev) {
    // 沙箱开关：仅 codex 会话（claude 权限派发时定死）；解除态高亮警示
    if (dev.backend === "codex") {
      const on = !!dev.fullAccess;
      btns.push(`<button class="button sm ${on ? "danger" : "ghost"}" title="${on ? "已解除沙箱：可写全盘。点击恢复" : "解除沙箱：codex 可写全盘（下一轮生效）"}" onclick="devSetAccess('${esc(t.id)}',${!on})">${on ? "🔓 无沙箱" : "🔒 沙箱"}</button>`);
    }
    // 分叉：原会话要有自己的原生会话（跑完过一轮）才分得出来；本轮在跑也能点，后端会等它这一轮结束；归档会话由后端拒绝
    if (dev.resume && (dev.providerId === "claude" || dev.providerId === "codex")) {
      btns.push(`<button class="button sm ghost" title="分叉：带着完整上下文新开一个会话，原会话照常可用。两个会话共用同一工作目录，注意别同时改同一处" onclick="forkSession('${esc(t.id)}')">分叉</button>`);
    }
    if (dev.control === "observing") btns.push(`<button class="button sm secondary" onclick="devControl('${esc(t.id)}','take')">接管输入</button>`);
    else if (dev.control === "ownward") btns.push(`<button class="button sm ghost" onclick="devControl('${esc(t.id)}','release')">释放输入权</button>`);
  }
  if (t.mode === "terminal") {
    if (t.status === "running") btns.push(`<button class="button sm secondary" onclick="taskDone('${esc(t.id)}')">结束并收割</button>`);
    btns.push(`<button class="button sm secondary" onclick="adoptTerminal('${esc(t.id)}')">接管到引擎</button>`);
  }
  if (t.kind === "evolve" && t.verify === "pass" && !t.applied) btns.push(`<button class="button sm primary" onclick="applyEvolveAction('${esc(t.id)}','evolve:${esc(t.id)}')">批准上线</button>`);
  if (t.flightState === "written") btns.push(`<button class="button sm ghost" onclick="post('/api/flight/open',{id:'${esc(t.id)}'}).then(r=>toast(r.msg))">飞行记录</button>`);
  btns.push(`<button class="button sm ${Tasks.repoOpen ? "secondary" : "ghost"}" onclick="toggleRepo('${esc(t.id)}')">仓库</button>`);
  // 非会话视图（terminal / 日志）没有信息条，分支和用量还是留在头部
  const tok = dev?.tokens?.total || ((dev?.tokens?.input || 0) + (dev?.tokens?.output || 0));
  const pills = [
    `<span class="mode-tag" data-m="${esc(dev?.backend || dev?.providerId || t.mode)}">${esc(dev?.backend || dev?.providerId || t.mode)}</span>`,
    !inSession && t.branch ? `<span class="tag mono">${esc(t.branch)}</span>` : "",
    !inSession && tok ? `<span class="tag mono" title="token 用量">${(tok / 1000).toFixed(1)}k tok</span>` : "",
  ].filter(Boolean).join("");
  return `<div class="session-head">
    <button class="button ghost sm tasks-back" onclick="tkBackToList()" aria-label="返回任务列表">← 返回</button>
    <span class="dot ${t.status === "running" ? "ok breathe" : t.exitCode === 0 || t.status === "done" ? "ok" : "bad"}"></span>
    <span class="title">${esc(t.project)}</span>${pills}
    <div class="right">${btns.join("")}${extra || ""}</div>
  </div>` + repoPanelHtml(t);
}

/** ctx 窗口：优先用 provider 回报的 ctxWindow（CC result 帧 modelUsage.contextWindow）；没有时按模型名估——
 *  2026 起 claude 主力型号（fable / opus / sonnet 4.6+）默认都是 1M 窗口，只有 haiku 还是 200k。
 *  以前一律按 200k 算，1M 会话动辄显示 300%+（2026-09-13 实测 amt2：670k 占用被算成 335%）。 */
function ctxWindowOf(dev) {
  if (dev.ctxWindow > 0) return dev.ctxWindow;
  return /haiku/i.test(dev.model || "") ? 200_000 : 1_000_000;
}
/** ctx 展示按后端区分（主仓 d8ce572 语义）：claude 按窗口换算 %，70%/90% 变色提醒该 /compact 了；
 *  codex 窗口不可知，只显原始占用不换算 */
function ctxPillHtml(dev) {
  if (!dev?.ctxTokens) return "";
  const kb = `ctx ${(dev.ctxTokens / 1000).toFixed(0)}k`;
  if (dev.backend !== "claude") return `<span class="meta-item mono" title="上下文占用（codex 窗口不换算）">${kb}</span>`;
  const win = ctxWindowOf(dev), measured = dev.ctxWindow > 0;
  const pct = Math.round((dev.ctxTokens / win) * 100);
  const tone = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
  return `<span class="meta-item mono"${tone ? ` data-tone="${tone}"` : ""} title="上下文占用（窗口 ${win / 1000}k${measured ? "" : "，按模型估算"}，超阈值会自动压缩）">${kb} · ${pct}%</span>`;
}

/** 会话信息条：贴在输入框下面的一行小字，左右分家——
 *  左边 .meta-read 全是只读读数（ctx / 额度 / token / 分支 / 目录），放不下自己横滚；
 *  右边 .meta-act 全是能点的（模型·深度 → 引擎/模型面板、＋目录、谱系），固定靠右不滚。
 *  以前读数和按钮穿插在一行里，眼睛得逐个分辨哪个能点；现在看左边、改右边。 */
function sessionMetaHtml(t, dev) {
  if (!dev) return "";
  const handoff = handoffState(dev);
  const tok = dev.tokens?.total || ((dev.tokens?.input || 0) + (dev.tokens?.output || 0));
  const extraDirs = dev.extraDirs || [];
  const base = (dir) => dir.split("/").filter(Boolean).at(-1) || dir;
  const reads = [
    ctxPillHtml(dev),
    // 额度独立 60s 刷：保留 #tk-usage 让 renderUsagePill 就地换内容
    `<span class="usage-pill" id="tk-usage" data-backend="${esc(dev.backend || dev.providerId || "")}">${usagePillHtml(dev.backend || dev.providerId)}</span>`,
    tok ? `<span class="meta-item mono" title="token 用量">${(tok / 1000).toFixed(1)}k tok</span>` : "",
    t.branch ? `<span class="meta-item mono" title="任务分支">${esc(t.branch)}</span>` : "",
    dev.cwd ? `<span class="meta-item" title="${esc([`主目录 ${dev.cwd}`, ...extraDirs.map((d) => `附加 ${d}`)].join("\n"))}"><b>目录</b> ${esc(base(dev.cwd))}${extraDirs.length ? ` +${extraDirs.length}` : ""}</span>` : "",
  ].filter(Boolean);
  const acts = [
    // 模型·深度既是读数也是入口：点它就是原来的「引擎 / 模型…」
    `<button class="meta-chip session-config-trigger" type="button" title="${esc(handoff.reason || "切换 Provider，或调整当前会话的模型与思考深度")}" onclick="openSessionConfig('${jsq(t.id)}')" ${handoff.disabled ? "disabled" : ""}>${esc(dev.model || "默认")} · ${esc(dev.effort || "默认")}</button>`,
    t.engine ? `<button class="meta-chip" type="button" title="给会话追加可写目录（codex 下一轮生效，claude 立即生效）" onclick="devAddDir('${jsq(t.id)}')">＋目录</button>` : "",
    dev.lineage?.length ? `<button class="meta-chip" type="button" title="接力链上每个引擎的原生会话 ID 与恢复命令" onclick="openLineage()">谱系</button>` : "",
  ].filter(Boolean);
  return `<div class="session-meta" aria-label="会话状态"><div class="meta-read">${reads.join("")}</div><div class="meta-act">${acts.join("")}</div></div>`;
}

/* ---- Repo 验收面板（状态/diff/commit/push/PR/清 worktree，全在任务 cwd 执行） ---- */
function repoPanelHtml(t) {
  if (!Tasks.repoOpen) return "";
  const r = Tasks.repo;
  if (!r) return `<div class="rail-section" style="border-bottom:1px solid var(--border-subtle)"><span style="color:var(--text-tertiary);font-size:12px">仓库状态加载中…</span></div>`;
  if (r.error) return `<div class="rail-section" style="border-bottom:1px solid var(--border-subtle)"><span style="color:var(--danger);font-size:12px">${esc(r.error)}</span></div>`;
  return `<div class="rail-section" style="border-bottom:1px solid var(--border-subtle)">
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      <span class="tag mono" data-tone="accent">${esc(r.branch)}</span>
      ${r.isWorktree ? `<span class="tag">worktree</span>` : ""}
      <span class="tag" ${r.dirty ? 'data-tone="warn"' : ""}>${r.dirty} 未提交</span>
      <span class="tag">↑${r.ahead} ↓${r.behind}</span>
      <span style="flex:1"></span>
      <button class="button sm secondary" onclick="repoDiffShow('${esc(t.id)}')">完整 diff</button>
      <button class="button sm ghost" onclick="post('/api/dev/repo/open',{id:'${esc(t.id)}'}).then(r=>toast(r.msg))">VSCode</button>
      <button class="button sm secondary" onclick="repoDo('${esc(t.id)}','commit')">Commit…</button>
      <button class="button sm secondary" onclick="repoDo('${esc(t.id)}','push')">Push</button>
      <button class="button sm ghost" onclick="repoDo('${esc(t.id)}','pr')">开 PR</button>
      ${r.isWorktree ? `<button class="button sm danger" onclick="repoDo('${esc(t.id)}','clean')">清 worktree</button>` : ""}
    </div>
    ${r.statusShort.trim() ? `<pre class="log-view panel" style="max-height:120px;overflow:auto;margin:0 0 6px">${esc(r.statusShort)}</pre>` : ""}
    ${r.diffStat ? `<div style="font-size:11px;color:var(--text-tertiary)" class="mono">${esc(r.diffStat)}</div>` : ""}
    ${r.recentLog.trim() ? `<pre class="log-view" style="padding:6px 0 0;margin:0;max-height:90px;overflow:auto">${esc(r.recentLog.trim())}</pre>` : ""}
  </div>`;
}
async function toggleRepo(id) {
  Tasks.repoOpen = !Tasks.repoOpen;
  if (Tasks.repoOpen) { Tasks.repo = null; refreshRepo(id); }
  pollDetail(true);
}
async function refreshRepo(id) {
  const r = await getJSON(`/api/dev/repo?id=${encodeURIComponent(id)}`).catch((e) => ({ ok: false, msg: String(e) }));
  Tasks.repo = r.branch !== undefined ? r : { error: r.msg || "仓库状态获取失败" };
  pollDetail(true);
}
async function repoDiffShow(id) {
  toast("拉取 diff…");
  const r = await getJSON(`/api/dev/repo/diff?id=${encodeURIComponent(id)}`).catch(() => null);
  if (r?.ok) showText("任务全量改动", r.text || "(无改动)");
  else toast(r?.msg || "diff 获取失败");
}
async function repoDo(id, action) {
  let msg;
  if (action === "commit") {
    msg = prompt("commit message：");
    if (!msg?.trim()) return;
  }
  if (action === "clean" && !confirm("清理 worktree？（有未提交改动会被拒绝）")) return;
  const res = await post("/api/dev/repo/act", { id, action, msg });
  toast(res.msg || (res.ok ? "完成" : "失败"));
  refreshRepo(id);
  if (action === "clean" && res.ok) refreshTasks();
}

/* ---- 引擎会话渲染 ---- */

// 分组规则（foldToolRuns / isToolError / toolRunSubtitle）在 web/feed.js——那边不碰 DOM，
// 能直接跑 src/web-feed.test.ts；和安卓 ui/Feed.kt 是同一套规则，两边测试用同一份预期。

/**
 * 折叠起来的一段工具调用：收起时只说「跑到第几步、有没有出错」，展开才是原来那一条条的明细。
 * 出错条数必须留在收起态的标题上——折叠省的是过程不是结果，把失败一起藏了就是假成功。
 */
function toolRunHtml(item, live) {
  const key = `g${item.index}`;
  const errors = item.msgs.filter(isToolError).length;
  // 收起时不铺明细：长会话几千条工具帧（每条一个 <pre>）即使收着也全在 DOM 里，是节点数的大头
  const open = Tasks.openTools.has(key);
  Tasks.feedRuns.set(key, item);
  const head = live ? `⚙ 正在执行 · 第 ${item.msgs.length} 步` : `⚙ 执行了 ${item.msgs.length} 步`;
  return `<div class="msg" data-role="tool"><details class="tool-run" ${open ? "open" : ""}
    ontoggle="toolRunToggle(this,'${key}')">
    <summary><span class="run-head">${esc(head)}</span>${errors ? `<span class="run-err">· ${errors} 处出错</span>` : ""}<span class="run-sub">${esc(toolRunSubtitle(item.msgs, live))}</span></summary>
    <div class="run-body">${open ? toolRunBodyHtml(item) : ""}</div></details></div>`;
}
const toolRunBodyHtml = (item) => item.msgs.map((m, k) => toolFrameHtml(m, item.index + k)).join("");
function toolRunToggle(el, key) {
  if (!el.open) { Tasks.openTools.delete(key); return; }
  Tasks.openTools.add(key);
  const body = el.querySelector(".run-body"), item = Tasks.feedRuns.get(key);
  if (body && item && !body.childElementCount) body.innerHTML = toolRunBodyHtml(item);
}

/** 会话流：连续工具调用折成一组。live = 本轮还在跑（只有末尾那组显示「正在执行」） */
function feedHtml(msgs, live = false, omitted = 0) {
  // omitted = 服务端没下发的更早条数；下标加上它还原成全量里的绝对位置，窗口往后滑时展开态 key 不变
  const feed = foldToolRuns(msgs || []).map((it) => ({ ...it, index: it.index + omitted }));
  const { hidden, items } = feedWindow(feed, Tasks.feedLimit);
  Tasks.feedRuns = new Map(); Tasks.feedHidden = hidden;
  const earlier = omitted + feed.slice(0, hidden).reduce((n, it) => n + (it.msgs ? it.msgs.length : 1), 0);
  const more = earlier ? `<div class="feed-more"><button class="button sm ghost" onclick="feedShowEarlier()">显示更早的 ${earlier} 条</button></div>` : "";
  return more + items.map((it, n) => (it.msgs
    ? toolRunHtml(it, live && n === items.length - 1)
    : msgHtml(it.msg, it.index))).join("");
}

/** 往前多铺一页；保持离底部的距离不变，正在看的那条不跳走。
 *  跟轮询抢同一把 Tasks.busy：旁观会话的增量拉取并发跑两份会把同一段消息追加两遍 */
async function feedShowEarlier() {
  while (Tasks.busy) await new Promise((r) => setTimeout(r, 100));
  const sc = $("#tk-scroll"), fromBottom = sc ? sc.scrollHeight - sc.scrollTop : 0;
  Tasks.feedLimit += FEED_PAGE;
  // 手里没铺的不够一页、服务端还省着：多要一页消息，走正常拉取渲染
  const fetchMore = Tasks.selKind === "task" && Tasks.feedHidden < FEED_PAGE && (Tasks.dev?.omitted || 0) > 0;
  if (fetchMore) Tasks.msgTail += MSG_PAGE;
  Tasks.busy = true;
  let rendered = false;
  try {
    if (fetchMore) { /* 交给下面的 pollDetail(true) */ }
    else if (Tasks.selKind === "cc" || String(Tasks.sel).startsWith("cdx:")) { await pollCcObserve(Tasks.sel, Tasks.selKind, true); rendered = true; }
    else if (Tasks.dev) { const t = S.tasks.find((x) => x.id === Tasks.sel); if (t) { renderSession(t, Tasks.dev); rendered = true; } }
  } finally { Tasks.busy = false; }
  if (!rendered) await pollDetail(true);
  const sc2 = $("#tk-scroll");
  if (sc2) sc2.scrollTop = sc2.scrollHeight - fromBottom;
}

/** 单条工具帧（不带 .msg 外壳）：折叠组展开后直接铺这个，和没折叠时长得一模一样 */
function toolFrameHtml(m, i) {
  const first = (m.text || "").split("\n")[0].slice(0, 120);
  return `<details class="tool-frame" data-i="${i}" ${Tasks.openTools.has(i) ? "open" : ""}
    ontoggle="this.open?Tasks.openTools.add(${i}):Tasks.openTools.delete(${i})">
    <summary>⚙ ${esc(m.name || "tool")} · ${esc(first)}</summary><pre>${esc(m.text)}</pre>${devImgsHtml(m)}</details>`;
}

/** 会话里的图片（用户上传/agent 截图）：只放行 daemon 自己的两个只读图片仓。 */
function devImgsHtml(m) {
  return imageThumbsHtml(m.images, safeTaskImageUrl, "任务图片");
}

function msgHtml(m, i) {
  const imgs = devImgsHtml(m);
  if (m.role === "system" && m.name === "fork") {
    return `<div class="handoff-divider"><span>${esc(m.text || "已从原会话分叉")}</span></div>`;
  }
  if (m.role === "system" && m.name === "handoff") {
    return `<div class="handoff-divider"><span>${esc(m.text || "已切换引擎，旧会话历史保留")}</span></div>`;
  }
  if (m.role === "tool") {
    if (m.name === "image" && imgs) return `<div class="msg" data-role="tool">${imgs}</div>`;
    return `<div class="msg" data-role="tool">${toolFrameHtml(m, i)}</div>`;
  }
  const who = m.role === "user" ? "我" : m.role === "assistant" ? "agent" : m.role === "thinking" ? "思考" : "系统";
  return `<div class="msg" data-role="${esc(m.role)}"><div class="who">${who} · ${m.ts ? hhmm(m.ts) : ""}</div>
    <div class="bubble">${m.role === "assistant" ? mdHtml(m.text) : esc(m.text)}</div>${imgs}</div>`;
}

function renderSession(t, dev) {
  const el = $("#tk-detail");
  // 追问框组字中不动 DOM；置空 dev 让下轮轮询必然重渲（否则 changed 比对会漏掉这帧）
  if (composingEl && el.contains(composingEl)) { Tasks.dev = null; Tasks.devSig = ""; return; }
  const sc = $("#tk-scroll", el);
  const nearBottom = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const prevTop = sc ? sc.scrollTop : 0;   // 用户上翻阅读时，重渲染后要回到原位而不是顶部
  // 整块重渲染会吃掉正在输入的文字——先存后还（含焦点）
  const oldInput = $("#tk-input");
  const draftKey = `task:${t.id}`;
  const draft = oldInput?.value ?? ComposerDrafts.getText(draftKey);
  const hadFocus = document.activeElement === oldInput;

  const plan = dev.plan?.length ? `<div class="plan-box">${dev.plan.map((p) =>
    `<div class="row" data-st="${esc(p.status)}"><span>${p.status === "completed" ? "☑" : p.status === "in_progress" ? "▶" : "☐"}</span><span>${esc(p.text)}</span></div>`).join("")}</div>` : "";

  const perms = (dev.pending || []).map((p) => {
    const isQ = p.toolName === "AskUserQuestion";
    if (!isQ) {
      return `<div class="perm-card">
        <div class="name">🔐 权限请求 · ${esc(p.toolName)}</div>
        <div class="brief">${esc(p.brief || "")}</div>
        <div class="foot">
          <button class="button sm primary" onclick="devDecide('${esc(t.id)}','${esc(p.requestId)}',true)">批准</button>
          <button class="button sm secondary" onclick="devDecide('${esc(t.id)}','${esc(p.requestId)}',true,null,'session')">总是（本会话）</button>
          <button class="button sm secondary" onclick="devDecide('${esc(t.id)}','${esc(p.requestId)}',true,null,'global')">总是（全局）</button>
          <button class="button sm danger" onclick="devDecide('${esc(t.id)}','${esc(p.requestId)}',false)">拒绝</button>
        </div></div>`;
    }
    // AskUserQuestion：真选项按钮（VS Code 式）——单选点即答，多选打勾再确认；自定义答复兜底
    const q = p.input?.questions?.[0] || {};
    const opts = (q.options || []).slice(0, 6);
    const multi = !!q.multiSelect;
    const rid = esc(p.requestId);
    return `<div class="perm-card">
      <div class="name">❓ agent 提问</div>
      <div class="brief">${esc(q.question || p.brief || "")}</div>
      ${opts.length ? `<div class="q-opts" id="qo-${rid}" data-multi="${multi}">
        ${opts.map((o) => `<button class="q-opt" data-label="${esc(o.label || "")}" onclick="qPick(this,'${jsq(t.id)}','${jsq(p.requestId)}')">
          <span class="l">${esc(o.label || "")}</span>${o.description ? `<span class="d">${esc(o.description)}</span>` : ""}
        </button>`).join("")}
      </div>` : ""}
      ${multi ? `<div class="foot"><button class="button sm primary" onclick="qConfirmMulti('${jsq(t.id)}','${jsq(p.requestId)}')">确认所选</button></div>` : ""}
      <div class="foot" style="gap:6px">
        <input type="text" id="q-${rid}" placeholder="${opts.length ? "或自定义答复…（Enter 发送）" : "答复内容…（Enter 发送）"}" style="flex:1;margin:0"
          onkeydown="if(event.key==='Enter'&&!event.isComposing&&this.value.trim()){devDecide('${jsq(t.id)}','${jsq(p.requestId)}',false,this.value)}">
        ${opts.length ? "" : `<button class="button sm primary" onclick="devDecide('${jsq(t.id)}','${jsq(p.requestId)}',false,$('#q-${rid}').value)">答复</button>`}
      </div></div>`;
  }).join("");

  // 撤回按 q.id 走，绝不按下标——这里的队列是轮询快照，下标随时会错位。
  // 没带 id 的（老 daemon）就不画 ✕：撤不了就别摆按钮。
  const queue = dev.queued?.length ? `<div class="queue-strip">排队中：${dev.queued.map((q) =>
    `<span class="q">${esc((q.text || "").slice(0, 40))}${q.id
      ? `<button title="撤回这条" onclick="devQueueRemove('${jsq(t.id)}','${jsq(q.id)}')">✕</button>` : ""}</span>`).join("")}</div>` : "";

  const resume = dev.control === "observing"
    ? dev.resume?.cmd
      ? `<div class="resume-strip">
          <span>已释放输入权。在其他终端继续：</span>
          <code>${esc(dev.resume.cmd)}</code>
          <button class="button sm secondary" onclick="copyResumeCmd('${jsq(dev.resume.cmd)}')">复制命令</button>
        </div>`
      : `<div class="resume-strip" data-state="waiting">已释放输入权；会话 ID 尚未就绪，稍后再试。</div>`
    : "";

  const partial = dev.partial ? `<div class="msg" data-role="assistant"><div class="who">agent</div><div class="bubble partial">${mdHtml(dev.partial)}</div></div>` : "";
  const canInput = (dev.control ?? "ownward") === "ownward";
  const running = dev.turn === "running";

  el.innerHTML = detailHead(t) + `
    <div class="session-scroll" id="tk-scroll">
      ${plan}
      ${feedHtml(dev.messages, running, dev.omitted || 0)}
      ${partial}${perms}
      ${dev.turn === "running" && !dev.partial ? `<div class="msg" data-role="system"><div class="bubble">agent 正在工作…</div></div>` : ""}
    </div>
    ${queue}${resume}
    <div class="composer">
      <div class="composer-box" data-disabled="${!canInput}">
        <div class="composer-imgs" id="tk-imgs"></div>
        <div class="composer-files" id="tk-files"></div>
        <textarea id="tk-input" rows="1" placeholder="${!canInput ? "只旁观（输入权在其他端，点「接管输入」）"
          : running ? "agent 正在工作…输入会排队，本轮结束自动发出" : "追问 / 指示（Enter 发送，Shift+Enter 换行；输入 / 看命令，↑ 翻历史）"}" ${canInput ? "" : "disabled"}></textarea>
        <div class="composer-bar">
          <button class="icon-btn" id="tk-attach" title="添加图片" ${canInput ? "" : "disabled"}>🖼</button>
          <button class="icon-btn" id="tk-attach-file" title="添加文件（任意类型）" ${canInput ? "" : "disabled"}>📎</button>
          <span class="hint">${running ? "Enter 排队追问 · ■ 中断本轮" : "Enter 发送 · ↑ 历史 · / 命令 · 可粘贴图片或文件"}</span>
          <span class="spacer"></span>
          ${running
            ? `<button class="button stop" id="tk-stop" title="中断本轮（正在生成的这轮停下，会话不结束）">■</button>`
            : ""}
          <button class="button primary" id="tk-send" ${canInput ? "" : "disabled"}>发送</button>
        </div>
      </div>
      ${sessionMetaHtml(t, dev)}
      <input type="file" id="tk-file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" multiple hidden>
      <input type="file" id="tk-file-any" multiple hidden>
    </div>`;

  const input = $("#tk-input");
  if (input) {
    input.value = draft;
    autoGrow(input);
    if (hadFocus) { input.focus(); input.setSelectionRange(draft.length, draft.length); }
    input.addEventListener("input", () => { autoGrow(input); ComposerDrafts.setText(draftKey, input.value); });
    // Enter 发送 / ↑↓ 翻本会话输入历史 / 输入 "/" 弹命令补全（命令表来自 CC init 帧回报）
    bindComposer(input, { key: `task:${t.id}`, send: () => devSend(t.id), commands: dev.backend === "claude" ? (dev.commands || []) : [] /* codex/codebuddy 没有 CLI 命令表，但 /new /model /effort 这些 Ownward 自己的命令照样要能补全 */ });
    input.addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const imgs = items.filter((it) => it.type.startsWith("image/"));
      // 非图片文件（Finder 里 ⌘C 一个 pdf）也收：纯文本粘贴 kind 是 "string"，不受影响
      const files = items.filter((it) => it.kind === "file" && !it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
      if (!imgs.length && !files.length) return;
      e.preventDefault();
      imgs.forEach((it) => addImage(it.getAsFile()));
      if (files.length) void ComposerFiles.add(`task:${t.id}`, files, renderTaskFiles);
    });
    // 拖入：图片走图片流水线，其余当文件传（两者互斥，别让同一张图两条路都走）
    const box = input.closest(".composer-box");
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.style.borderColor = "var(--accent)"; });
    box.addEventListener("dragleave", () => { box.style.borderColor = ""; });
    box.addEventListener("drop", (e) => {
      e.preventDefault(); box.style.borderColor = "";
      const all = [...(e.dataTransfer?.files || [])];
      const imgs = all.filter((f) => f.type.startsWith("image/"));
      imgs.forEach((f) => addImage(f));
      const rest = all.filter((f) => !imgs.includes(f));
      if (rest.length) void ComposerFiles.add(`task:${t.id}`, rest, renderTaskFiles);
    });
  }
  $("#tk-attach")?.addEventListener("click", () => $("#tk-file").click());
  $("#tk-file")?.addEventListener("change", (e) => { [...e.target.files].forEach(addImage); e.target.value = ""; });
  // 文件附件每条消息一个草稿 scope（发送时服务端搬进 uploads/<taskId>/ 并授权给 agent）。
  // 文件在服务端盘上，所以每次进会话都从服务端重拉一次——刷新页面、切走再回来都不该丢。
  renderTaskFiles();
  void ComposerFiles.refresh(`task:${t.id}`, () => { if (Tasks.sel === t.id) renderTaskFiles(); });
  $("#tk-attach-file")?.addEventListener("click", () => $("#tk-file-any").click());
  $("#tk-file-any")?.addEventListener("change", async (e) => { const files = [...e.target.files]; e.target.value = ""; await ComposerFiles.add(`task:${t.id}`, files, renderTaskFiles); });
  $("#tk-send")?.addEventListener("click", () => devSend(t.id));
  $("#tk-stop")?.addEventListener("click", () => devInterrupt(t.id));
  renderThumbs();
  const sc2 = $("#tk-scroll");
  sc2.scrollTop = nearBottom ? sc2.scrollHeight : prevTop;
}

function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; }

/** 挑一张图 → 共用流水线收（类型判 / HEIC 转码 / 超限压缩）→ 进 Tasks.images，重渲缩略图。
 *  压缩这一步不能省：截图原样发出去会撞 Runner 8MiB blob 上限，白等一次上传才被拒。 */
async function addImage(f) {
  const key = Tasks.sel ? `task:${Tasks.sel}` : "";
  if (ComposerDrafts.getAttachments(key).length >= COMPOSER_IMG_MAX) { toast(`一条消息最多 ${COMPOSER_IMG_MAX} 张图`); return; }
  const image = await prepareComposerImage(f);
  if (!image) return;
  // 列表在 await 之后才读写：同时粘几张时每张都看得到前一张的结果（并发下不会互相覆盖/越界）
  const images = ComposerDrafts.getAttachments(key);
  if (!composerImageFits(images, image.size)) return;
  images.push({ media_type: image.media_type, data: image.data, size: image.size });
  ComposerDrafts.setAttachments(key, images);
  if (Tasks.sel && `task:${Tasks.sel}` === key) { Tasks.images = images; renderThumbs(); }
}

/** 文件附件（任意类型）：与图片分开渲染——它们走的不是同一条链路，
 *  图片在本地内存里等发送，文件一上传就在服务端盘上（刷新页面也还在）。 */
function renderTaskFiles() {
  const box = $("#tk-files"); if (!box) return;
  const key = `task:${Tasks.sel}`;
  box.innerHTML = ComposerFiles.chipsHtml(key);
  bindComposerFileChips(box, key, renderTaskFiles);
}

function renderThumbs() {
  const box = $("#tk-imgs"); if (!box) return;
  box.innerHTML = Tasks.images.map((im, i) =>
    `<div class="thumb" title="${Math.round(im.size / 1024)}KB">
      <img src="data:${esc(im.media_type)};base64,${im.data}" alt="">
      <button title="移除" onclick="Tasks.images.splice(${i},1);ComposerDrafts.setAttachments('task:'+Tasks.sel,Tasks.images);renderThumbs()">✕</button>
    </div>`).join("");
}

async function devSend(id) {
  const input = $("#tk-input");
  const draftSnapshot = input.value;
  const text = draftSnapshot.trim();
  const key = `task:${id}`;
  if (!text && !Tasks.images.length && !ComposerFiles.has(key)) return;
  // /model <名> 与 /effort <档>：Ownward 自己的命令，同引擎就地切换（不接力）。两家 CLI 的 headless 通道都没有这两条，
  // 所以在这里拦下来打 reconfigure，不发给 agent。只打命令名不带参数 = 看当前值和可选项。
  const local = text.match(/^\/(model|effort)(?:\s+(\S+))?$/);
  if (local && !Tasks.images.length && !ComposerFiles.has(key)) {
    const field = local[1], value = local[2] || "", dev = Tasks.dev || {}, providerId = dev.backend || dev.providerId || "claude";
    const options = field === "model" ? workProviderCapability(providerId).models : workProviderEfforts(providerId, dev.model || "");
    if (!value) { toast(`${field === "model" ? "当前模型" : "当前思考深度"}：${(field === "model" ? dev.model : dev.effort) || "Provider 默认"}；可选：${options.join(" / ")}`); return; }
    input.value = ""; autoGrow(input);
    const r = await post("/api/dev/reconfigure", { id, [field]: value });
    if (r.ok) { ComposerDrafts.clearText(key, draftSnapshot); composerSent(key, text); toast(r.msg || "已切换"); }
    else { input.value = draftSnapshot; autoGrow(input); toast(r.msg || "切换失败"); }
    pollDetail(true);
    return;
  }
  input.value = "";
  autoGrow(input);
  const pics = Tasks.images;
  const images = pics.map(({ media_type, data }) => ({ media_type, data }));
  Tasks.images = [];
  ComposerDrafts.setAttachments(key, []);
  renderThumbs();
  const uploadScope = ComposerFiles.payloadScope(key);
  if (uploadScope) { ComposerFiles.clear(key); renderTaskFiles(); }   // 乐观清空：失败下面会把 scope 还回去
  const res = await post("/api/dev/send", { id, text, images: images.length ? images : undefined, ...(uploadScope ? { uploadScope } : {}), clientMutationId: crypto.randomUUID() });
  if (!res.ok) {
    if (!ComposerDrafts.getText(key)) ComposerDrafts.setText(key, draftSnapshot);
    ComposerDrafts.setAttachments(key, [...pics, ...ComposerDrafts.getAttachments(key)]);
    // 发送失败时服务端没落定草稿目录，文件还在——把 scope 还回去，别让用户重传一遍
    if (uploadScope) { try { localStorage.setItem(`ownward-upload-scope:${key}`, uploadScope); } catch { /* 存不住就只能重传 */ } void ComposerFiles.refresh(key, () => { if (Tasks.sel === id) renderTaskFiles(); }); }
    if (Tasks.sel === id) {
      const liveInput = $("#tk-input");
      if (liveInput && !liveInput.value) { liveInput.value = ComposerDrafts.getText(key); autoGrow(liveInput); }
      Tasks.images = ComposerDrafts.getAttachments(key); renderThumbs();
    }
    toast(res.msg);
  } else {
    composerSent(key, text); ComposerDrafts.clearText(key, draftSnapshot);
    if (res.queued) toast("agent 忙，已入队（本轮结束自动发出）");
  }
  pollDetail(true);
}
async function devAddDir(id) {
  window.openAddDirPicker(id);
}
async function devSetAccess(id, full) {
  if (full && !confirm("解除沙箱后 codex 可写整个磁盘（含系统路径），确认？")) return;
  const r = await post("/api/dev/set-access", { id, full });
  toast(r.msg || (r.ok ? "已切换" : "失败"));
  pollDetail(true);
}
async function devInterrupt(id) { toast((await post("/api/dev/interrupt", { id })).msg); }
async function devControl(id, action) {
  const res = await post("/api/dev/control", { id, action });
  await pollDetail(true);
  toast(res.ok && action === "release" ? "已释放输入权，恢复命令显示在会话下方" : res.msg);
}
async function copyResumeCmd(cmd) {
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    const el = document.createElement("textarea");
    el.value = cmd;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { /* 下面统一提示手动复制 */ }
    finally { el.remove(); }
    if (!copied) { toast("复制失败，请手动选择上面的命令"); return; }
  }
  toast("恢复命令已复制");
}
/** 选项点击：单选立即作答；多选切换选中态，等「确认所选」 */
function qPick(btn, taskId, requestId) {
  const box = btn.closest(".q-opts");
  if (box?.dataset.multi === "true") { btn.dataset.on = btn.dataset.on === "true" ? "false" : "true"; return; }
  devDecide(taskId, requestId, false, btn.dataset.label);
}
function qConfirmMulti(taskId, requestId) {
  const sel = $$(`#qo-${CSS.escape(requestId)} .q-opt[data-on="true"]`).map((b) => b.dataset.label);
  if (!sel.length) { toast("先选至少一项"); return; }
  devDecide(taskId, requestId, false, sel.join("、"));
}
async function devDecide(id, requestId, allow, message, remember) {
  const res = await post("/api/dev/decision", { id, requestId, allow, message: message || undefined, remember: remember || null });
  toast(res.ok ? (allow ? "已批准" : message ? "已答复" : "已拒绝") : res.msg);
  pollDetail(true);
}
/** 撤回一条还没发出的排队消息。撤不到会回 409（本轮刚结束、这条已经合并发出了），照实说 */
async function devQueueRemove(id, queueId) {
  const res = await post("/api/dev/queue", { id, action: "remove", queueId });
  toast(res.ok ? "已撤回" : (res.msg || "撤回失败"));
  pollDetail(true);
}
async function taskDone(id) {
  if (!confirm("结束这个 terminal 任务并收割？（不会杀 Terminal 里的进程）")) return;
  toast((await post("/api/task/done", { id })).msg);
  refreshTasks();
}
/** 分叉成功就跳到新会话：输入框按任务 id 存草稿，新会话天然是空的 */
async function forkSession(id) {
  const res = await post("/api/dev/fork", { id });
  toast(res.msg);
  if (res.ok && res.task) { await refreshTasks(); Tasks.select(res.task.id); }
}

async function adoptTerminal(id) {
  const res = await post("/api/task/adopt-terminal", { id });
  toast(res.msg);
  if (res.ok && res.task) { await refreshTasks(); Tasks.select(res.task.id); }
}

/* ---- terminal / 日志 / CC 旁观 ---- */
/** 拉一轮增量并并进 ccMsgs。返回 {grew, err}：
 *  截断/重建（后端把 offset 从 0 重读、size < 上次 offset）时清空累积再并，避免旧史上叠新内容。 */
async function fetchCcInc(sessionId, selected = () => true) {
  const sent = Tasks.ccOffset;
  let r;
  try { r = await getJSON(`/api/cc/session?id=${encodeURIComponent(sessionId)}&after=${sent}`); }
  catch (e) { return { err: String(e) }; }
  if (!selected()) return { stale: true };
  if (!r?.messages) return { err: r?.msg || "会话读取失败" };
  if (sent === 0 || r.offset < sent) Tasks.ccMsgs = [];  // 首帧 or 文件缩小=截断重建
  Tasks.ccMsgs.push(...r.messages);
  Tasks.ccOffset = r.offset;
  return { grew: r.messages.length > 0, truncated: r.truncated };
}

async function renderTerminal(t, force, sel = Tasks.sel, kind = Tasks.selKind) {
  const selected = () => Tasks.sel === sel && Tasks.selKind === kind;
  let ccId = t.ccSessionId;
  if (!ccId) {
    const r = await getJSON(`/api/tasks/${t.id}/cc-session`).catch(() => null);
    if (!selected()) return;
    if (r?.ok) ccId = r.sessionId;
  }
  if (ccId) {
    const inc = await fetchCcInc(ccId, selected);
    if (inc.stale || !selected()) return;
    if (inc.err) { if (force) $("#tk-detail").innerHTML = detailHead(t) + `<div class="empty">会话读取失败：${esc(inc.err)}（稍后重试）</div>`; return; }
    if (force || inc.grew) renderObserve(t, `${esc(t.project)} · terminal（旁观底层 Claude 会话）`);
    return;
  }
  if (force) {
    $("#tk-detail").innerHTML = detailHead(t) + `<div class="empty">terminal 任务在 Terminal 窗口里跑。<br>
      还没认领到底层 Claude 会话（稍等或刷新）；结束后可「结束并收割」。</div>`;
  }
}
async function pollCcObserve(id = Tasks.sel, kind = Tasks.selKind, forceHeader = false) {
  const selected = () => Tasks.sel === id && Tasks.selKind === kind;
  const inc = await fetchCcInc(id, selected);
  if (inc.stale || !selected()) return;
  if (inc.err) {
    if (!$("#tk-scroll")) $("#tk-detail").innerHTML = `<div class="empty">会话读取失败：${esc(inc.err)}</div>`;
    return;
  }
  if (!inc.grew && $("#tk-scroll") && !forceHeader) return;
  const meta = Tasks.ccList.find((x) => x.id === id);
  tkSetContext(meta?.project || "会话", meta?.title || "旁观会话");
  const el = $("#tk-detail");
  const sc = $("#tk-scroll", el);
  const nearBottom = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const prevTop = sc ? sc.scrollTop : 0;
  el.innerHTML = `<div class="session-head">
      <button class="button ghost sm tasks-back" onclick="tkBackToList()" aria-label="返回任务列表">← 返回</button>
      <span class="dot ${meta?.active ? "ok breathe" : "hollow"}"></span>
      <span class="title">${esc(meta?.project || "会话")}</span>
      <span class="tag">${meta?.kind === "codex" ? "codex" : "claude"} · 旁观</span>
      <div class="right">
        <button class="button sm secondary" ${meta?.adoptToken ? "disabled" : ""} onclick="adoptCc('${jsq(id)}')">${meta?.adoptToken ? "正在接管…" : "接管续聊"}</button>
        ${meta?.kind !== "codex" ? `<button class="button sm ghost" onclick="harvestCc('${jsq(id)}')">收割成日志</button>` : ""}
      </div></div>
    <div class="session-scroll" id="tk-scroll">${inc.truncated ? `<div class="msg" data-role="system"><div class="bubble">（长会话已截断前文）</div></div>` : ""}
      ${feedHtml(Tasks.ccMsgs)}</div>`;
  const sc2 = $("#tk-scroll");
  sc2.scrollTop = nearBottom ? sc2.scrollHeight : prevTop;
}
function renderObserve(t, title) {
  const el = $("#tk-detail");
  const sc = $("#tk-scroll", el);
  const nearBottom = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const prevTop = sc ? sc.scrollTop : 0;
  el.innerHTML = detailHead(t) + `
    <div class="session-scroll" id="tk-scroll">${feedHtml(Tasks.ccMsgs)}</div>`;
  const sc2 = $("#tk-scroll");
  sc2.scrollTop = nearBottom ? sc2.scrollHeight : prevTop;
}
async function adoptCc(id) {
  const capability = await post("/api/cc/adopt-capability", { id });
  if (!capability.ok || !capability.adoptToken) { toast(capability.msg || "无法签发接管凭证"); return; }
  const adoptToken = capability.adoptToken;
  const meta = Tasks.ccList.find((x) => x.id === id);
  if (meta) meta.adoptToken = adoptToken;
  await pollCcObserve(id, Tasks.selKind, true);
  let res;
  try { res = await post("/api/cc/adopt", { id, adoptToken }); }
  finally { if (meta) delete meta.adoptToken; await pollCcObserve(id, Tasks.selKind, true); }
  toast(res.msg);
  if (res.ok && res.task) { await refreshTasks(); Tasks.select(res.task.id); }
}
async function harvestCc(id) { toast((await post("/api/cc/harvest", { id })).msg); }
function renderLogDetail(t, text, force) {
  const el = $("#tk-detail");
  const pre = $("#tk-log", el);
  if (pre && !force) {
    if (pre.textContent !== text) {
      const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
      pre.textContent = text;
      if (near) pre.scrollTop = pre.scrollHeight;
    }
    return;
  }
  el.innerHTML = detailHead(t) + `<pre class="log-view" id="tk-log" style="flex:1;overflow-y:auto;margin:0">${esc(text)}</pre>`;
  const p2 = $("#tk-log");
  p2.scrollTop = p2.scrollHeight;
}
