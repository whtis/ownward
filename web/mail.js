"use strict";
/* 邮件 tab：Gmail 多账号收件箱 / 搜索 / 详情 / 回复 / 写新邮件
 * 安全纪律：所有邮件字段均是不可信输入，一律 esc()；onclick 参数 jsq()；链接 esc(href)。
 * 正文绝不放入 innerHTML——server 已把 HTML 邮件转纯文本，esc() 后写进 <pre>。 */

const Mail = {
  accounts: [],    // string[]：gmailAccounts().map(a => a.email)
  msgs: [],        // 当前列表（inbox 或搜索结果）
  sel: null,       // { id, account } 选中邮件
  selAcc: "all",   // 账号 chip 筛选
  mode: "inbox",   // "inbox" | "search" | "compose"
  source: "gmail", // "gmail" | "outlook"
  searchQ: "",     // 当前搜索词
  timer: null,     // 60s 轮询
  replying: false, // 回复框展开状态
};

TABS.mail = {
  init(root) {
    root.innerHTML = `
      <div class="col mail-list-col">
        <div style="padding-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;padding:2px 2px 8px">
            <div class="eyebrow" style="margin:0">MAIL</div>
            <span style="flex:1"></span>
            <button class="button secondary sm" id="ml-compose">写邮件</button>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <button class="chip sm" data-source="gmail" id="ml-src-gmail">Gmail</button>
            <button class="chip sm" data-source="outlook" id="ml-src-outlook">Outlook</button>
          </div>
          <div id="ml-accounts" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
          <input type="search" id="ml-search" placeholder="Gmail 语法搜索，回车触发；清空回收件箱" style="width:100%;box-sizing:border-box">
        </div>
        <div class="col-scroll panel" style="flex:1;padding:4px" id="ml-list">${stateBox("正在载入…", "loading")}</div>
      </div>
      <div class="col mail-detail-col">
        <div class="panel" id="ml-detail" style="flex:1;min-height:0;overflow-y:auto;padding:16px">
          ${stateBox("从左侧选择一封邮件")}
        </div>
      </div>`;

    $("#ml-compose").addEventListener("click", mailShowCompose);

    // 搜索框：Enter 触发；search 事件（×按钮）清空时回收件箱
    const searchEl = $("#ml-search");
    searchEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const q = searchEl.value.trim();
      if (!q) { Mail.mode = "inbox"; Mail.searchQ = ""; loadMailList(); }
      else { Mail.mode = "search"; Mail.searchQ = q; loadMailSearch(q); }
    });
    searchEl.addEventListener("search", () => {
      if (!searchEl.value.trim()) { Mail.mode = "inbox"; Mail.searchQ = ""; loadMailList(); }
    });

    loadMailAccounts();

    // 源切换：Gmail / Outlook（Outlook 只读，无搜索/回复/写邮件）
    $("#ml-src-gmail").addEventListener("click", () => setMailSource("gmail"));
    $("#ml-src-outlook").addEventListener("click", () => setMailSource("outlook"));
    syncMailSourceVisibility();
  },
  show() {
    loadMailList();
    Mail.timer = setInterval(loadMailList, 60_000);
  },
  hide() { clearInterval(Mail.timer); Mail.timer = null; },
};

/* ---- 源切换：Gmail / Outlook ---- */

// 源显隐偏好（localStorage 持久化，系统设置里可改）：缺省两个源都显示
function mailSourceVisible(s) { return localStorage.getItem(`ownward-mail-${s}-hidden`) !== "1"; }
function setMailSourceVisible(s, visible) { visible ? localStorage.removeItem(`ownward-mail-${s}-hidden`) : localStorage.setItem(`ownward-mail-${s}-hidden`, "1"); }

/** 启动/设置变更后调用：隐藏的源 chip 不显示；当前选中源被隐藏时自动切到第一个可见源 */
function syncMailSourceVisibility() {
  const g = mailSourceVisible("gmail"), o = mailSourceVisible("outlook");
  $("#ml-src-gmail").style.display = g ? "" : "none";
  $("#ml-src-outlook").style.display = o ? "" : "none";
  if (!g && !o) { $("#ml-list").innerHTML = stateBox("两个邮件源都被隐藏——去系统设置恢复", "empty"); return; }
  const cur = Mail.source;
  const curVisible = cur === "gmail" ? g : o;
  if (!curVisible) Mail.source = g ? "gmail" : "outlook";
  syncMailSource();
}

function setMailSource(s) {
  Mail.source = s;
  Mail.sel = null;
  syncMailSource();
  loadMailList();
}

/** 切换后同步 UI 状态：chip 高亮、隐藏 Gmail 专属控件（账号/搜索/写邮件） */
function syncMailSource() {
  const isOutlook = Mail.source === "outlook";
  $("#ml-src-gmail").dataset.active = !isOutlook;
  $("#ml-src-outlook").dataset.active = isOutlook;
  $("#ml-accounts").style.display = isOutlook ? "none" : "";
  $("#ml-search").style.display = isOutlook ? "none" : "";
  $("#ml-compose").style.display = isOutlook ? "none" : "";
  $("#ml-detail").innerHTML = stateBox(isOutlook ? "从左侧选择一封邮件（Outlook 本地库，只读）" : "从左侧选择一封邮件");
}

/* ---- 账号 ---- */

async function loadMailAccounts() {
  try {
    // 返回 string[]（各账号 email）
    Mail.accounts = await getJSON("/api/gmail/accounts");
  } catch {
    Mail.accounts = [];
  }
  renderMailAccounts();
  if (!Mail.accounts.length) {
    const el = $("#ml-list");
    if (el) el.innerHTML = stateBox("Gmail 未配置——运行 bun scripts/gmail-auth.ts 完成 OAuth", "empty");
  }
}

function renderMailAccounts() {
  const el = $("#ml-accounts");
  if (!el) return;
  // 单账号无需切换 chip；多账号才显示「全部」+ 各账号
  if (Mail.accounts.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = [
    `<button class="chip" data-on="${Mail.selAcc === "all"}" onclick="mailSetAcc('all')">全部</button>`,
    ...Mail.accounts.map((a) =>
      `<button class="chip" data-on="${Mail.selAcc === a}" onclick="mailSetAcc('${jsq(a)}')">${esc(mailShort(a))}</button>`),
  ].join("");
}

/** "foo@gmail.com" → "foo"（列表标签太长会溢出） */
function mailShort(email) {
  return String(email || "").split("@")[0] || email;
}

function mailSetAcc(acc) {
  Mail.selAcc = acc;
  Mail.mode = "inbox";
  Mail.searchQ = "";
  const el = $("#ml-search"); if (el) el.value = "";
  renderMailAccounts();
  loadMailList();
}

/* ---- 收件箱 / 搜索 ---- */

async function loadMailList() {
  if (Mail.mode === "search") return; // 搜索结果不被轮询覆盖
  const el = $("#ml-list");
  if (!el) return;
  if (Mail.source === "outlook") return loadOutlookList(el);
  try {
    const data = await getJSON(`/api/gmail/inbox?account=${encodeURIComponent(Mail.selAcc)}`);
    Mail.msgs = Array.isArray(data) ? data : [];
    renderMailList();
  } catch (e) {
    // 500 通常是未配置 OAuth；其余算网络错误
    const hint = String(e).includes("500") || String(e).includes("bun")
      ? "Gmail 未配置——运行 bun scripts/gmail-auth.ts 完成 OAuth"
      : `载入失败：${String(e).slice(0, 100)}`;
    el.innerHTML = stateBox(hint, "error");
  }
}

/** Outlook 本地库列表：{ mails, unread }；GitLab 邮件后端已过滤 */
async function loadOutlookList(el) {
  try {
    const data = await getJSON("/api/verticals/corp-outlook/inbox?limit=30");
    Mail.msgs = data.mails || [];
    renderOutlookList(el);
  } catch (e) {
    el.innerHTML = stateBox(`Outlook 本地库读取失败：${String(e).slice(0, 80)}（确认 Outlook 客户端已登录公司邮箱）`, "error");
  }
}

function renderOutlookList(el) {
  if (!Mail.msgs.length) { el.innerHTML = stateBox("收件箱为空（噪音邮件已过滤）", "empty"); return; }
  const purgeBtn = `<div style="display:flex;align-items:center;gap:6px;padding:6px 4px 8px;border-bottom:1px solid var(--border-subtle);margin-bottom:6px">
    <button class="button danger sm" id="ml-purge" onclick="mailPurgeNoise()">清理垃圾邮件</button>
    <span style="flex:1"></span>
    <button class="button ghost sm" id="ml-filter-toggle" onclick="mailToggleFilter()">屏蔽词管理</button>
  </div>
  <div id="ml-filter-panel" style="display:none;padding:8px;border:1px solid var(--border-subtle);border-radius:6px;margin-bottom:8px">
    <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px">屏蔽关键词（发件人含 @ 精确匹配，主题模糊匹配）：</div>
    <div id="ml-filter-list" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px"></div>
    <div style="display:flex;gap:6px">
      <input type="text" id="ml-filter-input" placeholder="新屏蔽词（如 周报）" style="flex:1;padding:4px 8px;font-size:12px;border:1px solid var(--border-subtle);border-radius:4px">
      <button class="button primary sm" onclick="mailAddFilter()">添加</button>
    </div>
  </div>`;
  el.innerHTML = purgeBtn + `<div class="glist">${Mail.msgs.map((m) => {
    const timeStr = m.receivedAt ? ageText(m.receivedAt) : "";
    return `<div class="card clickable" data-selected="${Mail.sel?.id === m.id}"
        onclick="mailSelectOutlook(${m.id})">
      <div class="top">
        ${!m.read ? `<span class="dot ok" style="flex:none;width:7px;height:7px"></span>` : ""}
        <span style="font-weight:${!m.read ? 600 : 400};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${esc(m.senderName || m.senderEmail)}</span>
        <span class="right mono" style="font-size:11px;flex:none">${esc(timeStr)}</span>
      </div>
      <div class="body" style="${!m.read ? "font-weight:600" : ""}">${esc(m.subject || "(无主题)")}</div>
      ${m.preview ? `<div class="body" style="color:var(--text-tertiary);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2">${esc(m.preview)}</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

/* ---- 垃圾邮件清理 + 屏蔽词管理 ---- */

async function mailPurgeNoise() {
  const preview = await getJSON("/api/verticals/corp-outlook/purge");
  if (!preview.wouldDelete) { toast("没有可清理的垃圾邮件"); return; }
  if (!confirm(`将删除 ${preview.wouldDelete} 封命中屏蔽关键词且早于 30 天的邮件（GitLab 通知、自动报表、巡检、告警等），近 30 天不动。不可恢复，确认？`)) return;
  const res = await post("/api/verticals/corp-outlook/purge", {});
  toast(`已删除 ${res.deleted} 封垃圾邮件`);
  loadMailList();
}

async function mailToggleFilter() {
  const panel = $("#ml-filter-panel");
  const show = panel.style.display === "none";
  panel.style.display = show ? "" : "none";
  if (show) {
    const data = await getJSON("/api/verticals/corp-outlook/filter");
    renderFilterList(data.keywords || []);
  }
}

function renderFilterList(keywords) {
  $("#ml-filter-list").innerHTML = keywords.map((k) =>
    `<span class="tag" style="display:inline-flex;align-items:center;gap:4px">${esc(k)}<button onclick="mailRemoveFilter('${jsq(k)}')" style="border:none;background:none;cursor:pointer;padding:0;color:var(--text-tertiary);font-size:14px;line-height:1">×</button></span>`
  ).join("");
}

async function mailAddFilter() {
  const input = $("#ml-filter-input");
  const kw = input.value.trim();
  if (!kw) { toast("输入屏蔽词"); return; }
  const data = await getJSON("/api/verticals/corp-outlook/filter");
  const keywords = [...new Set([...(data.keywords || []), kw])];
  await post("/api/verticals/corp-outlook/filter", { keywords });
  input.value = "";
  renderFilterList(keywords);
  toast(`已添加屏蔽词「${kw}」`);
  loadMailList(); // 列表立即按新规则过滤
}

async function mailRemoveFilter(kw) {
  const data = await getJSON("/api/verticals/corp-outlook/filter");
  const keywords = (data.keywords || []).filter((k) => k !== kw);
  await post("/api/verticals/corp-outlook/filter", { keywords });
  renderFilterList(keywords);
  toast(`已移除屏蔽词「${kw}」`);
  loadMailList();
}

async function loadMailSearch(q) {
  const el = $("#ml-list");
  if (!el) return;
  el.innerHTML = stateBox("搜索中…", "loading");
  try {
    const data = await getJSON(`/api/gmail/search?q=${encodeURIComponent(q)}&account=${encodeURIComponent(Mail.selAcc)}`);
    Mail.msgs = Array.isArray(data) ? data : [];
    renderMailList();
  } catch (e) {
    el.innerHTML = stateBox(`搜索失败：${String(e).slice(0, 80)}`, "error");
  }
}

function renderMailList() {
  const el = $("#ml-list");
  if (!el) return;
  if (!Mail.msgs.length) {
    // stateBox 内部会 esc，所以这里直接传原始字符串
    el.innerHTML = stateBox(Mail.mode === "search" ? `"${Mail.searchQ}" 无搜索结果` : "收件箱为空");
    return;
  }
  const multi = Mail.accounts.length > 1;
  el.innerHTML = `<div class="glist">${Mail.msgs.map((m) => mailMsgCard(m, multi)).join("")}</div>`;
}

function mailMsgCard(m, multi) {
  // 发件人：优先取 "Name <email>" 里的 Name
  const name = mailSenderName(m.from);
  const timeStr = m.date ? ageText(new Date(m.date).toISOString()) : "";
  return `<div class="card clickable" data-selected="${Mail.sel?.id === m.id}"
      onclick="mailSelectMsg('${jsq(m.id)}','${jsq(m.account || "")}')">
    <div class="top">
      ${m.unread ? `<span class="dot ok" style="flex:none;width:7px;height:7px"></span>` : ""}
      <span style="font-weight:${m.unread ? 600 : 400};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${esc(name)}</span>
      <span class="right mono" style="font-size:11px;flex:none">${esc(timeStr)}</span>
    </div>
    <div class="body" style="${m.unread ? "font-weight:600" : ""}">${esc(m.subject || "(无主题)")}</div>
    ${m.snippet ? `<div class="body" style="color:var(--text-tertiary);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2">${esc(m.snippet)}</div>` : ""}
    ${multi ? `<div class="foot"><span class="tag">${esc(mailShort(m.account || ""))}</span></div>` : ""}
  </div>`;
}

/** "Name <email>" → "Name"；纯邮箱取 @ 前 */
function mailSenderName(from) {
  if (!from) return "";
  const m = from.match(/^"?([^"<]+)"?\s*</);
  return m ? m[1].trim() : from.split("@")[0] || from;
}

/* ---- 邮件详情 ---- */

/** Outlook 邮件详情（只读）：选中 → 拉正文 → 渲染 */
async function mailSelectOutlook(id) {
  Mail.sel = { id };
  renderOutlookList($("#ml-list")); // 更新选中高亮
  mailMobileView("detail");
  const el = $("#ml-detail");
  if (el) el.innerHTML = stateBox("正在载入邮件…", "loading");
  try {
    const d = await getJSON(`/api/verticals/corp-outlook/message?id=${id}`);
    if (el) el.innerHTML = `
      <div style="margin-bottom:12px">
        <button class="button ghost sm" onclick="mailBackToList()" style="margin-bottom:10px">← 返回列表</button>
        <div style="font-size:16px;font-weight:600;line-height:1.35;margin-bottom:8px">${esc(d.subject || "(无主题)")}</div>
        <div style="font-size:11.5px;color:var(--text-tertiary)">Outlook 本地库 · 只读 · GitLab 邮件已过滤</div>
      </div>
      <div style="border-top:1px solid var(--border-subtle);margin-bottom:12px"></div>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.65;font-family:inherit;margin:0">${esc(d.body || "（无正文）")}</pre>`;
  } catch (e) {
    if (el) el.innerHTML = stateBox(`载入失败：${String(e).slice(0, 80)}`, "error");
  }
}

async function mailSelectMsg(id, account) {
  Mail.sel = { id, account };
  Mail.replying = false;
  // 从写邮件模式切回时恢复 inbox
  if (Mail.mode === "compose") Mail.mode = "inbox";
  renderMailList(); // 更新选中高亮
  mailMobileView("detail");
  const el = $("#ml-detail");
  if (el) el.innerHTML = stateBox("正在载入邮件…", "loading");
  try {
    // → { ok, from, to, subject, date, threadId, body }
    const d = await getJSON(`/api/gmail/message?id=${encodeURIComponent(id)}&account=${encodeURIComponent(account || "")}`);
    if (!d.ok) { if (el) el.innerHTML = stateBox(d.msg || "载入失败", "error"); return; }
    renderMailDetail(d, id);
  } catch (e) {
    if (el) el.innerHTML = stateBox(`载入失败：${String(e).slice(0, 80)}`, "error");
  }
}

function renderMailDetail(d, msgId) {
  const el = $("#ml-detail");
  if (!el) return;
  // Gmail 消息直链——fragment 不走服务端，safeUrl 已通过 https 前缀检验
  const gmailHref = `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(msgId || "")}`;
  el.innerHTML = `
    <div style="margin-bottom:12px">
      <button class="button ghost sm" onclick="mailBackToList()" style="margin-bottom:10px">← 返回列表</button>
      <div style="font-size:16px;font-weight:600;line-height:1.35;margin-bottom:8px">${esc(d.subject || "(无主题)")}</div>
      <div style="font-size:12px;color:var(--text-secondary);display:flex;flex-direction:column;gap:3px;margin-bottom:10px">
        <div><b>发件人：</b>${esc(d.from || "")}</div>
        ${d.to ? `<div><b>收件人：</b>${esc(d.to)}</div>` : ""}
        <div><b>时间：</b>${esc(d.date || "")}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="button sm secondary" onclick="mailAct('archive')">归档</button>
        <button class="button sm ghost" onclick="mailAct('read')">标已读</button>
        <button class="button sm ghost" onclick="mailAct('star')">加星</button>
        <a class="button sm ghost" href="${esc(gmailHref)}" target="_blank" rel="noopener"
           style="text-decoration:none;display:inline-flex;align-items:center">在 Gmail 打开</a>
        <button class="button sm secondary" id="ml-reply-btn" onclick="mailToggleReply()">回复</button>
      </div>
    </div>
    <div style="border-top:1px solid var(--border-subtle);margin-bottom:12px"></div>
    <pre style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.65;font-family:inherit;margin:0">${esc(d.body || "（无正文）")}</pre>
    <div id="ml-reply-area" style="display:none;margin-top:16px;border-top:1px solid var(--border-subtle);padding-top:12px">
      <textarea id="ml-reply-text" rows="4" placeholder="回复内容…（Shift+Enter 换行）"
        style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="button primary sm" onclick="mailSendReply()">发送</button>
        <button class="button ghost sm" onclick="mailToggleReply()">取消</button>
      </div>
    </div>`;
}

function mailToggleReply() {
  Mail.replying = !Mail.replying;
  const area = $("#ml-reply-area");
  const btn = $("#ml-reply-btn");
  if (area) area.style.display = Mail.replying ? "" : "none";
  if (btn) btn.textContent = Mail.replying ? "收起" : "回复";
  if (Mail.replying) $("#ml-reply-text")?.focus();
}

async function mailAct(action) {
  if (!Mail.sel) return;
  // action: "archive" | "read" | "unread" | "star" | "unstar"
  const r = await post("/api/gmail/act", { id: Mail.sel.id, action, account: Mail.sel.account || undefined });
  toast(r.msg || (r.ok ? "完成" : "失败"));
  if (r.ok && action === "archive") {
    // 归档后从本地列表移除，回到列表视图
    Mail.msgs = Mail.msgs.filter((m) => m.id !== Mail.sel?.id);
    Mail.sel = null;
    renderMailList();
    const el = $("#ml-detail");
    if (el) el.innerHTML = stateBox("从左侧选择一封邮件");
    mailMobileView("list");
  }
}

async function mailSendReply() {
  if (!Mail.sel) return;
  const textEl = $("#ml-reply-text");
  const text = textEl?.value.trim();
  if (!text) { toast("回复内容不能为空"); return; }
  const r = await post("/api/gmail/reply", { id: Mail.sel.id, text, account: Mail.sel.account || undefined });
  toast(r.msg || (r.ok ? "已回复" : "失败"));
  if (r.ok) {
    Mail.replying = false;
    const area = $("#ml-reply-area"); if (area) area.style.display = "none";
    const btn = $("#ml-reply-btn"); if (btn) btn.textContent = "回复";
  }
}

/* ---- 写新邮件 ---- */

function mailShowCompose() {
  Mail.mode = "compose";
  Mail.sel = null;
  renderMailList();
  mailMobileView("detail");
  const el = $("#ml-detail");
  if (!el) return;
  const accs = Mail.accounts;
  // 多账号：select；单账号：只读显示
  const fromField = accs.length > 1
    ? `<select id="ml-c-from" style="width:100%">${accs.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select>`
    : `<div style="font-size:13px;color:var(--text-secondary)">${esc(accs[0] || "(无账号)")}</div>`;
  el.innerHTML = `
    <button class="button ghost sm" onclick="mailCancelCompose()" style="margin-bottom:12px">← 取消</button>
    <div style="font-size:15px;font-weight:600;margin-bottom:14px">写新邮件</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">发件账号</div>
        ${fromField}
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">收件人</div>
        <input type="email" id="ml-c-to" placeholder="to@example.com" style="width:100%;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">主题</div>
        <input type="text" id="ml-c-subject" placeholder="邮件主题" style="width:100%;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">正文</div>
        <textarea id="ml-c-body" rows="10" placeholder="邮件正文…"
          style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="button primary sm" onclick="mailSendCompose()">发送</button>
        <button class="button ghost sm" onclick="mailCancelCompose()">取消</button>
      </div>
    </div>`;
  $("#ml-c-to")?.focus();
}

async function mailSendCompose() {
  const to = $("#ml-c-to")?.value.trim();
  const subject = $("#ml-c-subject")?.value.trim();
  const text = $("#ml-c-body")?.value.trim();
  if (!to || !subject || !text) { toast("收件人、主题和正文都要填"); return; }
  const accs = Mail.accounts;
  const account = accs.length > 1 ? ($("#ml-c-from")?.value || accs[0]) : accs[0];
  const r = await post("/api/gmail/compose", { to, subject, text, account: account || undefined });
  toast(r.msg || (r.ok ? "已发送" : "失败"));
  if (r.ok) mailCancelCompose();
}

function mailCancelCompose() {
  Mail.mode = "inbox";
  Mail.sel = null;
  renderMailList();
  const el = $("#ml-detail");
  if (el) el.innerHTML = stateBox("从左侧选择一封邮件");
  mailMobileView("list");
}

/* ---- 移动端 master-detail：媒体查询 + data 属性驱动（与 chat 对称）——
 *  内联 display 切换在窗口拉宽回桌面时会残留（列表列永久消失），CSS 方案 resize 自愈 ---- */
(function () {
  const st = document.createElement("style");
  st.textContent = `
@media (max-width: 1023px) {
  #mail-root { display: block; overflow: hidden; }
  #mail-root .mail-list-col, #mail-root .mail-detail-col { width: 100%; height: 100%; max-height: none; }
  #mail-root[data-mobile-view="detail"] .mail-list-col { display: none; }
  #mail-root:not([data-mobile-view="detail"]) .mail-detail-col { display: none; }
}`;
  document.head.appendChild(st);
}());
function mailMobileView(v) {
  const root = $("#mail-root");
  if (root) root.dataset.mobileView = v === "detail" ? "detail" : "list";
}

function mailBackToList() {
  Mail.sel = null;
  const el = $("#ml-detail");
  if (el) el.innerHTML = stateBox("从左侧选择一封邮件");
  mailMobileView("list");
}
