"use strict";
/* 系统 tab：事件源健康 / 节奏 / 订阅额度 / 定时任务 / 审批规则 / 演进 / daemon 日志 */

const Sys = { timer: null, autoLog: false };

TABS.system = {
  init(root) {
    root.innerHTML = `
      <div class="col system-summary-col">
        <div class="page-head compact"><div><div class="eyebrow">CONTROL</div><h1>系统</h1><p>连接健康、运行节奏与快捷操作</p></div></div>
        <div class="col-scroll">
          <div class="panel">
            <div class="rail-section"><h3>事件源</h3><div id="sy-health"></div></div>
            <div class="rail-section"><h3>节奏</h3><div id="sy-rhythm"></div></div>
            <div class="rail-section"><h3>Claude 订阅</h3><div id="sy-usage" class="kv"><span>加载中…</span></div></div>
            <div class="rail-section rail-actions" style="display:flex;flex-direction:column;gap:6px">
              <h3>快捷动作</h3>
              <button class="button ghost" data-action="heartbeat" style="justify-content:flex-start">立即心跳</button>
              <button class="button ghost" data-action="test-notify" style="justify-content:flex-start">发测试通知</button>
              <button class="button ghost" id="sy-digest" style="justify-content:flex-start">生成今日日报</button>
              <button class="button ghost" data-action="open-vault" style="justify-content:flex-start">在 Obsidian 打开今日</button>
              <a class="button ghost" href="/strategy" style="justify-content:flex-start;text-decoration:none">策略页（strategy 开启时）</a>
              <button class="button ghost danger" id="sy-restart" style="justify-content:flex-start">重启 daemon（后端改动生效）</button>
            </div>
            <div class="rail-section"><h3>界面</h3>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px"><input type="checkbox" id="sy-tab-feed"> 显示通知流 tab</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="checkbox" id="sy-tab-chat"> 显示对话 tab</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="checkbox" id="sy-tab-roles"> 显示角色 tab</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="checkbox" id="sy-tab-lark"> 显示飞书 tab</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="checkbox" id="sy-tab-notes"> 显示笔记 tab</label>
              <div style="margin-top:8px;font-size:11px;color:var(--text-tertiary)">邮件 tab 显示哪些源：</div>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:4px"><input type="checkbox" id="sy-mail-gmail"> Gmail</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="checkbox" id="sy-mail-outlook"> Outlook（本地库）</label>
              <div style="margin-top:8px;font-size:11px;color:var(--text-tertiary)">后台功能：</div>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:4px"><input type="checkbox" id="sy-feat-capture"> 自动收割（会话/任务/飞书，2h 一轮）</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="checkbox" id="sy-feat-digest"> 每日日报（12:30 生成前一日）</label>
            </div>
            <div class="rail-section"><h3>Git 提供商（PR/MR 工作台）</h3>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px"><input type="radio" name="sy-git-provider" id="sy-git-github" value="github"> GitHub（gh CLI）</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:2px"><input type="radio" name="sy-git-provider" id="sy-git-gitlab" value="gitlab"> GitLab（glab CLI）</label>
              <input type="text" id="sy-git-host" placeholder="GitLab 实例 host，如 git.example.com" style="width:100%;box-sizing:border-box;margin-top:6px;font-size:12px;display:none">
              <button class="button secondary sm" id="sy-git-save" style="margin-top:6px">保存</button>
            </div>
            <div class="rail-section"><h3>扩展 Vertical</h3><div id="sy-verticals"><span style="font-size:12px;color:var(--text-tertiary)">加载中…</span></div></div>
            <div class="rail-section">
              <h3>自演进（改 Ownward 自己）</h3>
              <textarea id="sy-evolve" placeholder="需求描述，如：给通知流加导出按钮" style="width:100%;min-height:56px"></textarea>
              <button class="button secondary sm" id="sy-evolve-go" style="margin-top:6px">派发演进任务</button>
            </div>
          </div>
        </div>
      </div>
      <div class="col system-detail-col">
        <div class="section-head system-detail-head"><div><h2>运行细节</h2><p>调度、审批规则与 daemon 输出</p></div>
          <div class="tools">
            <label style="font-size:11px;color:var(--text-tertiary);display:flex;align-items:center;gap:4px">
              <input type="checkbox" id="sy-autolog"> 日志自动刷新</label>
            <button class="button ghost sm" id="sy-refresh">刷新</button>
          </div>
        </div>
        <div class="col-scroll">
          <div class="section-title">运行状态</div>
          <div class="panel" id="sy-schedules" style="padding:6px"></div>
          <details class="sys-advanced"><summary>高级诊断 · 全部后台任务（含系统/第三方，只读）</summary><div class="panel" style="overflow-x:auto;margin-top:6px"><table class="table" id="sy-schedules-all"></table></div></details>
          <div class="section-title">股票自选（watchlist）</div>
          <div class="panel" id="sy-stock" style="padding:10px 12px"></div>
          <div class="section-title">自动批准规则（「总是批准」的记忆）</div>
          <div class="panel" id="sy-approvals" style="padding:4px 0"></div>
          <div class="section-title">daemon 日志</div>
          <div class="panel"><pre class="log-view" id="sy-log" style="max-height:420px;overflow-y:auto;margin:0"></pre></div>
        </div>
      </div>`;
    // data-action 按钮是动态插入的，这里单独绑（app.js 只绑了初始 DOM）
    $$("#system-root [data-action]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      toast((await post("/api/action", { action: b.dataset.action })).msg || "已触发");
      setTimeout(() => (b.disabled = false), 1200);
    }));
    $("#sy-digest").addEventListener("click", async () => {
      toast("日报生成中（要跑一次 AI）…");
      toast((await post("/api/digest/run", {})).msg);
    });
    $("#sy-evolve-go").addEventListener("click", async () => {
      const requirement = $("#sy-evolve").value.trim();
      if (!requirement) { toast("先写需求"); return; }
      if (!confirm("派发演进任务？agent 会在隔离 worktree 里改 Ownward 代码，过 verify 后等你审批")) return;
      const res = await post("/api/evolve", { requirement });
      toast(res.msg);
      if (res.ok) { $("#sy-evolve").value = ""; switchTab("tasks"); }
    });
    $("#sy-restart").addEventListener("click", restartDaemon);
    $("#sy-refresh").addEventListener("click", loadSystem);
    $("#sy-autolog").addEventListener("change", (e) => (Sys.autoLog = e.target.checked));
    // 高级诊断（全机任务）只在展开时按需拉一次，避免默认就糊一脸
    root.querySelector(".sys-advanced")?.addEventListener("toggle", function () { if (this.open && !Sys.allLoaded) { Sys.allLoaded = true; loadAllSchedules(); } });
    // tab 显隐开关（偏好存 localStorage，逻辑在 app.js 的 tabHidden/setTabHidden）：勾选 = 显示，这里也是唯一恢复入口
    for (const [id, tab, label] of [["sy-tab-feed", "feed", "通知流"], ["sy-tab-chat", "chat", "对话"], ["sy-tab-roles", "roles", "角色"], ["sy-tab-lark", "lark", "飞书"], ["sy-tab-notes", "notes", "笔记"]]) {
      const el = $(`#${id}`);
      el.checked = !tabHidden(tab);
      el.addEventListener("change", () => { setTabHidden(tab, !el.checked); toast(el.checked ? `${label}已显示` : `${label}已隐藏`); location.reload(); });
    }
    // 邮件源显隐开关（localStorage 持久化，mail.js 消费）：勾选 = 显示
    for (const [id, src, label] of [["sy-mail-gmail", "gmail", "Gmail"], ["sy-mail-outlook", "outlook", "Outlook"]]) {
      const el = $(`#${id}`);
      el.checked = mailSourceVisible(src);
      el.addEventListener("change", () => {
        setMailSourceVisible(src, el.checked);
        toast(el.checked ? `${label} 源已显示` : `${label} 源已隐藏`);
        syncMailSourceVisibility(); // mail tab 若在后台已挂载，立即生效
      });
    }
    // 功能开关（服务端 data/features.json 持久化，默认全开；daemon 各 sweep 入口读它）
    getJSON("/api/features").then((f) => {
      for (const [id, key] of [["sy-feat-capture", "capture"], ["sy-feat-digest", "digest"]]) {
        const el = $(`#${id}`); if (!el) continue;
        el.checked = f?.[key] !== false;
        el.addEventListener("change", async () => {
          const r = await post("/api/features", { key, enabled: el.checked });
          toast(r.ok ? (el.checked ? "已开启" : "已关闭") : (r.msg || "保存失败"));
        });
      }
    }).catch(() => {});
    // git 提供商（PR/MR 工作台 GitHub/GitLab）：读当前 → 勾选；gitlab 时才显示 host 输入
    getJSON("/api/git/provider").then((g) => {
      const syncHost = () => { $("#sy-git-host").style.display = $("#sy-git-gitlab").checked ? "" : "none"; };
      $("#sy-git-github").checked = g?.provider !== "gitlab";
      $("#sy-git-gitlab").checked = g?.provider === "gitlab";
      $("#sy-git-host").value = g?.host || "";
      syncHost();
      $("#sy-git-github").addEventListener("change", syncHost);
      $("#sy-git-gitlab").addEventListener("change", syncHost);
      $("#sy-git-save").addEventListener("click", async () => {
        const provider = $("#sy-git-gitlab").checked ? "gitlab" : "github";
        const host = $("#sy-git-host").value.trim();
        const r = await post("/api/git/provider", { provider, host });
        toast(r.ok ? "已保存（下次刷新 PR 列表生效）" : (r.msg || "保存失败"));
      });
    }).catch(() => {});
    loadSystem();
  },
  show() {
    loadSystem();
    Sys.timer = setInterval(() => { if (Sys.autoLog) loadLog(); renderSysState(); }, 5000);
  },
  hide() { clearInterval(Sys.timer); },
};
// _onState 是单槽钩子，多个 tab 都要挂就得链式包一层（lark.js 也这么做）——直接赋值会把先注册的洗掉
const _sysPrevOnState = TABS._onState;
TABS._onState = () => { _sysPrevOnState?.(); if (S.tab === "system") renderSysState(); };

function renderSysState() {
  const st = S.state; if (!$("#sy-health")) return;
  if (!st) { $("#sy-health").innerHTML = stateBox("正在等待 daemon 状态…", "loading"); $("#sy-rhythm").innerHTML = ""; return; }
  const names = { lark: "飞书", github: "GitHub", gmail: "Gmail", stock: "股票" };
  $("#sy-health").innerHTML = Object.entries(names).map(([k, n]) => {
    const enabled = st.sources[k];
    const ts = st.health[k];
    let dot = "hollow", txt = "未启用（配置指南有开启方法）";
    if (k === "gmail" && enabled && !st.gmailConfigured) { txt = "未授权"; }
    else if (enabled) {
      const age = ts ? (Date.now() - new Date(ts)) / 1000 : Infinity;
      const slow = k === "lark" ? 7200 : 1800;
      dot = age < slow ? "ok" : age < slow * 4 ? "warn" : "bad";
      txt = ageText(ts);
    }
    return `<div class="health-row"><span class="dot ${dot}"></span><span class="name">${n}</span><span class="age mono">${txt}</span></div>`;
  }).join("");
  $("#sy-rhythm").innerHTML = `
    <div class="kv"><span>分流间隔</span><span class="v">${st.triageIntervalMin}m（上次 ${st.lastTriageAt ? hhmm(st.lastTriageAt) : "–"}）</span></div>
    <div class="kv"><span>心跳间隔</span><span class="v">${st.heartbeatIntervalMin}m（上次 ${st.lastHeartbeatAt ? hhmm(st.lastHeartbeatAt) : "–"}）</span></div>
    <div class="kv"><span>静默时段</span><span class="v">${st.quietHours.start}–${st.quietHours.end}</span></div>
    <div class="kv"><span>daemon pid</span><span class="v">${st.pid}</span></div>
    <div class="kv"><span>vault</span><span class="v" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(st.vaultRoot || "")}</span></div>`;
}

async function loadSystem() {
  renderSysState();
  loadLog();
  const [usage, schedules, rules, stock, verticals] = await Promise.all([
    getJSON("/api/claude-usage").catch(() => null),
    getJSON("/api/schedules").catch(() => null),
    getJSON("/api/approvals").catch(() => null),
    getJSON("/api/stock/watchlist").catch(() => null),
    getJSON("/api/system/verticals").catch(() => null),
  ]);
  renderVerticals(verticals);
  const u = usage?.usage;
  // 额度 70%/90% 变色（主仓 SwiftUI 的 usageColor 语义）：接近额度顶要肉眼可见
  const pctHtml = (v) => { const n = Number(v); return `<b${n >= 90 ? ` style="color:var(--danger)"` : n >= 70 ? ` style="color:var(--warning)"` : ""}>${Number.isFinite(n) ? n : "?"}%</b>`; };
  $("#sy-usage").innerHTML = u
    ? `<span>5h 窗口 ${pctHtml(u.fiveHourPercent)}${u.weeklyPercent != null ? ` · 周 ${pctHtml(u.weeklyPercent)}` : ""}</span>`
    : `<span style="color:var(--text-tertiary)">拿不到额度数据</span>`;
  renderSchedules(schedules);
  renderStockPanel(stock);
  $("#sy-approvals").innerHTML = rules === null ? stateBox("批准规则暂时无法载入", "error") : rules.length ? rules.map((r) => `
    <div class="kv" style="padding:6px 12px"><span class="mono">${esc(r.pattern || r.tool || r.id)}</span>
      <span class="v">${esc(r.scope || "")} <button class="button sm ghost" onclick="revokeApproval('${jsq(r.id)}')">撤销</button></span></div>`).join("")
    : stateBox("没有自动批准规则；会话里点“总是批准”后会显示在这里");
}
/** 重启 daemon：daemon 自己退出，launchd 拉起。轮询 pid 变了才算成功——不能只看请求发出去了。 */
async function restartDaemon() {
  const pre = await post("/api/system/restart", {});
  if (!pre.needConfirm) { toast(pre.msg || "重启请求被拒绝"); return; }
  const running = pre.running || [];
  const warn = running.length
    ? `正在跑的 ${running.length} 个任务会被中断（会话可在任务页恢复）：\n${running.map((t) => "· " + t.title).join("\n")}\n\n`
    : "";
  if (!confirm(`重启 daemon？\n\n${warn}前端改动本来刷新就生效，只有后端（src/）改动需要重启。\n重启约 2–5 秒，期间页面连不上。`)) return;
  const btn = $("#sy-restart");
  btn.disabled = true;
  toast("重启中…");
  await post("/api/system/restart", { confirm: true });
  // 老进程退出到 launchd 拉起之间有几秒连不上，请求失败是预期内的，接着等
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const st = await getJSON("/api/state").catch(() => null);
    if (st && st.pid !== pre.pid) { toast(`已重启（pid ${st.pid}）`); setTimeout(() => location.reload(), 700); return; }
  }
  btn.disabled = false;
  toast("等了 30 秒没等到新 daemon，去看 daemon 日志");
}
/** 收敛后的运行状态：只展示 ownward 自己管理的任务，分核心/连接两组，退出码翻译成人话。 */
const SCHED_DOT = { ok: "ok", attention: "warn", down: "bad", paused: "hollow", unknown: "hollow" };
/** 纯函数：把收敛后的任务列表渲染成「一句话总览 + 分组卡片」HTML（系统 tab 与设置页共用）。 */
function schedulesPanelHtml(schedules) {
  const core = schedules.filter((s) => s.group === "core"), conn = schedules.filter((s) => s.group === "connection");
  const coreDown = core.filter((s) => s.health?.level === "down").length;
  const attention = schedules.filter((s) => s.health?.level === "attention" || s.health?.level === "down");
  let sum, tone;
  if (coreDown) { sum = "ownward 核心组件未在运行，部分功能暂停"; tone = "bad"; }
  else if (attention.length) { sum = `ownward 正常运行，${attention.length} 项需要处理`; tone = "warn"; }
  else { sum = "ownward 正常运行，所有组件在线"; tone = "ok"; }
  const groupHtml = (title, items) => items.length ? `<div class="sys-group"><div class="sys-group-h">${title}</div>${items.map(scheduleCard).join("")}</div>` : "";
  return `<div class="sys-summary" data-tone="${tone}"><span class="dot ${SCHED_DOT[tone === "ok" ? "ok" : tone === "warn" ? "attention" : "down"]}"></span><span>${esc(sum)}</span></div>` +
    groupHtml("核心组件", core) + groupHtml("连接与维护", conn) +
    (schedules.length ? "" : stateBox("没有找到 ownward 管理的任务"));
}
function renderSchedules(schedules) {
  const el = $("#sy-schedules"); if (!el) return;
  if (schedules === null) { el.innerHTML = stateBox("运行状态暂时无法载入", "error"); return; }
  Sys.schedules = schedules;
  el.innerHTML = schedulesPanelHtml(schedules);
}
/** 设置页「系统与运行」分类：把收敛后的运行健康 + 事件源 + 计划提醒直接渲染进设置内容区。 */
window.renderSystemInSettings = async function (el) {
  if (!el) return;
  el.innerHTML = stateBox("正在读取运行状态…", "loading");
  const [schedules, routines] = await Promise.all([
    getJSON("/api/schedules").catch(() => null),
    getJSON("/api/routines").catch(() => null),
  ]);
  if (schedules) Sys.schedules = schedules;
  const st = S.state;
  const srcNames = { lark: "飞书", github: "GitHub", gmail: "Gmail", stock: "股票" };
  const srcHtml = st ? Object.entries(srcNames).filter(([k]) => st.sources?.[k]).map(([k, n]) => {
    const ts = st.health?.[k], authMissing = k === "gmail" && !st.gmailConfigured;
    const age = ts ? (Date.now() - new Date(ts).getTime()) / 1000 : Infinity, slow = k === "lark" ? 7200 : 1800;
    const dot = authMissing ? "bad" : age < slow ? "ok" : age < slow * 4 ? "warn" : "bad";
    return `<div class="sys-card"><span class="dot ${dot}" style="margin-top:5px"></span><div class="sys-card-main"><div class="sys-card-title">${n}</div><div class="sys-card-sub">${authMissing ? "未授权，去 Gmail 授权后可用" : ts ? "最近同步 " + ageText(ts) : "已启用"}</div></div></div>`;
  }).join("") : "";
  const routineHtml = Array.isArray(routines) && routines.length ? routines.map((r) => {
    const lvl = r.status === "written" ? "ok" : r.stale ? "attention" : "ok";
    return `<div class="sys-card"><span class="dot ${SCHED_DOT[lvl]}" style="margin-top:5px"></span><div class="sys-card-main"><div class="sys-card-title">${esc(r.name || r.id)} <span class="sys-chip" data-level="${lvl}">${esc(r.status || "")}</span></div><div class="sys-card-sub">${esc(r.nextLabel ? "下次 " + r.nextLabel : "")}</div></div></div>`;
  }).join("") : `<div class="settings-callout"><span>暂无计划提醒。规则可在「自动化」分类编辑。</span></div>`;
  el.innerHTML =
    (schedules ? schedulesPanelHtml(schedules) : stateBox("运行状态暂时无法载入", "error")) +
    (srcHtml ? `<div class="sys-group"><div class="sys-group-h">事件源</div>${srcHtml}</div>` : "") +
    `<div class="sys-group"><div class="sys-group-h">计划与提醒</div>${routineHtml}</div>` +
    `<div style="margin-top:12px"><button class="button ghost sm" onclick="switchTab('system')">打开完整系统页（日志、订阅额度、演进、股票）→</button></div>`;
};
function scheduleCard(s) {
  const h = s.health || { level: "unknown", label: "未知" };
  const acts = [];
  if (s.group === "core" && h.level === "down") acts.push(`<button class="button sm ghost" onclick="restartDaemon()">重启</button>`);
  acts.push(`<button class="button sm ghost" onclick="showScheduleDetail('${jsq(s.label)}')">详情</button>`);
  if (s.editable && h.level === "ok") acts.push(`<button class="button sm ghost" onclick="runSchedule('${jsq(s.label)}')">立即运行</button>`);
  if (s.editable) acts.push(`<button class="button sm ghost" onclick="toggleScheduleUi('${jsq(s.label)}','${jsq(s.path)}',${s.disabled ? "true" : "false"})">${s.disabled ? "启用" : "暂停"}</button>`);
  return `<div class="sys-card" data-level="${h.level}">
    <span class="dot ${SCHED_DOT[h.level] || "hollow"}"></span>
    <div class="sys-card-main">
      <div class="sys-card-title">${esc(s.role || s.label)} <span class="sys-chip" data-level="${h.level}">${esc(h.label)}</span></div>
      <div class="sys-card-sub">${esc(s.purpose || "")}${h.reason ? ` · <span class="sys-reason">${esc(h.reason)}</span>` : ""}</div>
      ${h.hint ? `<div class="sys-card-hint">建议：${esc(h.hint)}</div>` : ""}
    </div>
    <div class="sys-card-acts">${acts.join("")}</div>
  </div>`;
}
function showScheduleDetail(label) {
  const s = (Sys.schedules || []).find((x) => x.label === label); if (!s) return;
  const h = s.health || {};
  showText(`${s.role || label} · 详情`, [
    `状态：${h.label || s.state}${h.reason ? "（" + h.reason + "）" : ""}`,
    h.hint ? `建议：${h.hint}` : "",
    `调度：${s.schedule}`,
    `任务标识：${s.label}`,
    `程序：${s.program}`,
    s.lastExit !== undefined ? `上次退出码：${s.lastExit}` : "",
    s.path && s.path !== "crontab" ? `配置文件：${s.path}` : "",
  ].filter(Boolean).join("\n"));
}
/** 高级诊断：全机任务只读表（含系统/第三方）——仅在展开 <details> 时按需拉一次。 */
async function loadAllSchedules() {
  const el = $("#sy-schedules-all"); if (!el) return;
  el.innerHTML = `<tr><td>${stateBox("加载中…", "loading")}</td></tr>`;
  const all = await getJSON("/api/schedules?all=1").catch(() => null);
  if (!all) { el.innerHTML = `<tr><td>${stateBox("无法载入", "error")}</td></tr>`; return; }
  el.innerHTML = `<tr><th>任务</th><th>调度</th><th>状态</th></tr>` + all.map((s) => `<tr>
    <td class="mono" title="${esc(s.label)}">${esc(s.label.split(".").slice(-1)[0] || s.label)}${s.owner === "ownward" ? " ·ownward" : ""}</td>
    <td class="mono">${esc(s.schedule)}</td>
    <td><span class="tag" data-tone="${s.state === "running" ? "ok" : ""}">${esc(s.state)}${s.disabled ? "·停用" : ""}</span></td></tr>`).join("");
}
async function runSchedule(label) { toast((await post("/api/schedules/run", { label })).msg || "已触发"); }
/** 启停 launchd 任务：停用 = bootout+disable（重启不再拉起），启用 = enable+bootstrap */
async function toggleScheduleUi(label, path, enable) {
  if (!enable && !confirm(`停用 ${label}？停用后 daemon 重启也不会拉起它`)) return;
  toast((await post("/api/schedules/toggle", { label, path, enable })).msg || "已提交");
  loadSystem();
}
/** 改调度：轻量输入式编辑（interval 分钟 / daily HH:MM / weekly D HH:MM），后端 PlistBuddy 重写并重载 */
async function editScheduleUi(label, path) {
  const raw = prompt(`改 ${label} 的调度，三种格式：\n· 间隔分钟数，如 30\n· daily HH:MM，如 daily 09:30\n· weekly 星期(0-6) HH:MM，如 weekly 1 09:30`, "");
  if (raw == null) return;
  const s = raw.trim();
  let spec = null;
  let m;
  if (/^\d+$/.test(s)) spec = { mode: "interval", minutes: parseInt(s, 10) };
  else if ((m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/i))) spec = { mode: "daily", hour: +m[1], minute: +m[2] };
  else if ((m = s.match(/^weekly\s+([0-6])\s+(\d{1,2}):(\d{2})$/i))) spec = { mode: "weekly", weekday: +m[1], hour: +m[2], minute: +m[3] };
  if (!spec) { toast("格式不对：数字 / daily HH:MM / weekly D HH:MM"); return; }
  toast((await post("/api/schedules/update", { label, path, spec })).msg || "已提交");
  loadSystem();
}
/** 股票自选面板：查看/增删标的 + 按需分析（后端配置持久化并热重启 stock 连接器） */
function renderStockPanel(stock) {
  const el = $("#sy-stock"); if (!el) return;
  if (!stock) { el.innerHTML = stateBox("watchlist 暂时无法载入", "error"); return; }
  const list = stock.watchlist || [];
  el.innerHTML = `
    <div class="kv"><span>行情源</span><span class="v">${stock.enabled ? "已启用" : "未启用（保存自选会自动启用定点检查）"}</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">${list.length
      ? list.map((s) => `<span class="chip" data-on="true">${esc(s)}
          <button class="button sm ghost" style="min-height:0;padding:0 4px" title="移除" onclick="stockRemove('${jsq(s)}')">✕</button>
          <button class="button sm ghost" style="min-height:0;padding:0 4px" title="跑一次分析" onclick="stockAnalyze('${jsq(s)}')">分析</button></span>`).join("")
      : `<span style="color:var(--text-tertiary);font-size:12px">自选为空——加标的后 daemon 会按 checkTimes 定点检查并把异动交给分流</span>`}</div>
    <div class="row" style="align-items:center;gap:6px">
      <input type="text" id="sy-stock-add" placeholder="标的代码，如 AAPL / 0700.HK" spellcheck="false" style="flex:1;margin:0">
      <button class="button sm secondary" onclick="stockAdd()">加入</button>
    </div>`;
  $("#sy-stock-add")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stockAdd(); } });
  Sys.watchlist = list;
}
async function stockAdd() {
  const sym = ($("#sy-stock-add")?.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.]{1,12}$/.test(sym)) { toast("标的代码不合法"); return; }
  const next = [...new Set([...(Sys.watchlist || []), sym])];
  toast((await post("/api/stock/watchlist", { enabled: true, watchlist: next })).msg || "已保存");
  loadSystem();
}
async function stockRemove(sym) {
  const next = (Sys.watchlist || []).filter((s) => s !== sym);
  toast((await post("/api/stock/watchlist", { watchlist: next })).msg || "已保存");
  loadSystem();
}
async function stockAnalyze(sym) {
  toast(`分析 ${sym} 中（要跑一会）…`);
  const r = await post("/api/stock/analyze", { symbol: sym });
  if (r.ok) showText(`分析 · ${sym}`, r.text || "(空)");
  else toast(r.msg || "分析失败");
}
async function revokeApproval(id) { toast((await post("/api/approvals/revoke", { id })).msg); loadSystem(); }
async function loadLog() {
  const r = await getJSON("/api/logs?lines=200").catch(() => null);
  const pre = $("#sy-log"); if (!pre) return;
  if (!r) { pre.textContent = "日志暂时无法载入"; pre.dataset.state = "error"; return; }
  delete pre.dataset.state;
  const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
  pre.textContent = (r.lines || []).join("\n");
  if (near) pre.scrollTop = pre.scrollHeight;
}

/** 扩展 Vertical 面板：内置只展示状态；外部扩展带「重载」——改完包代码点一下秒级生效。 */
function renderVerticals(diag) {
  const el = $("#sy-verticals"); if (!el) return;
  const list = diag?.verticals;
  if (!Array.isArray(list) || !list.length) { el.innerHTML = `<span style="font-size:12px;color:var(--text-tertiary)">无扩展数据</span>`; return; }
  const dot = (st) => st === "ready" ? "ok" : ["degraded", "starting", "discovered"].includes(st) ? "warn" : st === "disabled" ? "hollow" : "bad";
  el.innerHTML = list.map((v) => `
    <div class="health-row" style="gap:6px">
      <span class="dot ${dot(v.state)}"></span>
      <span class="name" title="${esc(v.id)} ${esc(v.version || "")}">${esc(v.name || v.id)}</span>
      <span class="age mono">${esc(v.state)}${v.errorCode ? " · " + esc(v.errorCode) : ""}</span>
      ${v.source === "external" ? `<button class="button ghost sm" data-vreload="${esc(v.id)}" style="margin-left:auto">重载</button>` : ""}
    </div>`).join("");
  $$("#sy-verticals [data-vreload]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "重载中…";
    const r = await post("/api/system/verticals/reload", { id: b.dataset.vreload });
    toast(r.ok ? `已重载：${b.dataset.vreload} → ${r.status?.state}` : `重载失败：${r.msg || r.code || "未知错误"}`);
    loadSystem();
  }));
}
