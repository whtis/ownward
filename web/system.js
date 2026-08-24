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
          <div class="section-title">定时任务（launchd / cron）</div>
          <div class="panel" style="overflow-x:auto"><table class="table" id="sy-schedules"></table></div>
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
  const pctHtml = (v) => `<b${v >= 90 ? ` style="color:var(--danger)"` : v >= 70 ? ` style="color:var(--warning)"` : ""}>${v}%</b>`;
  $("#sy-usage").innerHTML = u
    ? `<span>5h 窗口 ${pctHtml(u.fiveHourPercent)}${u.weeklyPercent != null ? ` · 周 ${pctHtml(u.weeklyPercent)}` : ""}</span>`
    : `<span style="color:var(--text-tertiary)">拿不到额度数据</span>`;
  $("#sy-schedules").innerHTML = `<tr><th>任务</th><th>调度</th><th>状态</th><th></th></tr>` +
    (schedules || []).map((s) => `<tr>
      <td class="mono" title="${esc(s.label)}">${esc(s.label.split(".").slice(-1)[0] || s.label)}</td>
      <td class="mono">${esc(s.schedule)}</td>
      <td><span class="tag" data-tone="${s.state === "running" ? "ok" : s.disabled ? "bad" : ""}">${esc(s.state)}${s.disabled ? "·停用" : ""}</span></td>
      <td style="white-space:nowrap">${s.editable ? `
        <button class="button sm ghost" onclick="runSchedule('${jsq(s.label)}')">跑一次</button>
        <button class="button sm ghost" onclick="toggleScheduleUi('${jsq(s.label)}','${jsq(s.path)}',${s.disabled ? "true" : "false"})">${s.disabled ? "启用" : "停用"}</button>
        <button class="button sm ghost" onclick="editScheduleUi('${jsq(s.label)}','${jsq(s.path)}')">改调度</button>` : ""}</td>
    </tr>`).join("") + (schedules === null ? `<tr><td colspan="4">${stateBox("定时任务暂时无法载入", "error")}</td></tr>` : schedules.length ? "" : `<tr><td colspan="4">${stateBox("没有发现定时任务")}</td></tr>`);
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
