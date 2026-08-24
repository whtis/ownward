"use strict";
/* 飞书 tab：会话列表 + 消息流 + 今日总结（夜间收割勾选）+ 飞书文档 chip
 * API: /api/lark/chats  messages  send  hide-read  chat-delete
 *      /api/lark/digest  digest/toggle  digest/select-all  digest/pull
 *      /api/lark/doc  doc/save
 * 移动端 master-detail：#lark-root[data-mobile-view="list"|"detail"] */

const Lark = {
  chats: [], sel: null, msgs: [],
  filter: "all",       // all | p2p | group — 会话筛选 chip
  digestOpen: false,   // 右列显示今日总结面板而非消息流
  digest: null,        // {date, messages: LarkDailyMsg[]}
  timer: null, chatsErr: "", msgsErr: "",
  docPreviews: new Map(),   // feishu URL → {ok,title,excerpt} | "loading"
  builtFor: null,      // 记右列当前为哪个 chat_id | "digest" | null 建的，避免无谓重建
};

/* 移动端 master-detail 需要 #lark-root 专属选择器——不改 style.css，从 JS 注入
 * 逻辑与 #chat-root 的 mobile 规则完全对称 */
(function () {
  const st = document.createElement("style");
  st.textContent = `
.lark-back { display: none; flex: none; }
@media (max-width: 1023px) {
  #lark-root { display: block; overflow: hidden; }
  #lark-root .lark-list-col, #lark-root .lark-detail-col
    { width: 100%; height: 100%; max-height: none; }
  #lark-root[data-mobile-view="detail"] .lark-list-col { display: none; }
  #lark-root:not([data-mobile-view="detail"]) .lark-detail-col { display: none; }
  .lark-back { display: inline-flex; }
}`;
  document.head.appendChild(st);
}());

/* ======== Tab 注册 ======== */
TABS.lark = {
  init(root) {
    root.innerHTML = `
      <div class="col lark-list-col">
        <div class="page-head compact">
          <div><div class="eyebrow">FEISHU</div><h1>飞书消息</h1></div>
          <div class="tools" style="display:flex;gap:6px">
            <button class="button ghost sm" id="lark-digest-btn">今日总结</button>
            <button class="button ghost sm" id="lark-hide-read" title="隐藏所有已读（来新消息自动浮回）">清除已读</button>
          </div>
        </div>
        <div style="display:flex;gap:6px;padding:0 4px 8px">
          <button class="chip" data-lark-f="all" data-on="true">全部</button>
          <button class="chip" data-lark-f="p2p">单聊</button>
          <button class="chip" data-lark-f="group">群聊</button>
        </div>
        <div class="col-scroll panel" id="lark-list" style="flex:1"></div>
      </div>
      <div class="col lark-detail-col">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);min-height:48px;flex:none">
          <button class="button ghost sm lark-back" id="lark-back">← 返回</button>
          <strong id="lark-detail-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px">选择一个会话</strong>
          <button class="button ghost sm" id="lark-delete-btn" style="display:none" title="删除会话（来新消息会浮现，读完自动消失）">删除</button>
        </div>
        <div class="panel session-pane" id="lark-detail" style="flex:1;display:flex;flex-direction:column;min-height:0">
          <div class="session-scroll" id="lark-scroll" style="flex:1;overflow-y:auto;padding:12px">${stateBox("选择左侧会话开始查看消息")}</div>
        </div>
      </div>`;

    // 会话筛选 chip
    $$("[data-lark-f]", root).forEach((b) => b.addEventListener("click", () => {
      Lark.filter = b.dataset.larkF;
      $$("[data-lark-f]", root).forEach((x) => (x.dataset.on = String(x === b)));
      renderLarkList();
    }));

    // 清除已读：把所有无未读会话打 hidden 标，来新消息自动浮回
    $("#lark-hide-read").addEventListener("click", async () => {
      const r = await post("/api/lark/hide-read", {});
      toast(r.msg || (r.ok ? "已清除" : "失败"));
      if (r.ok) loadLarkChats();
    });

    // 今日总结面板切换
    $("#lark-digest-btn").addEventListener("click", () => {
      if (!Lark.digestOpen) {
        Lark.digestOpen = true;
        buildDigestDetail();
        loadLarkDigest();
      } else {
        Lark.digestOpen = false;
        if (Lark.sel) buildChatDetail(Lark.sel, Lark.chats.find((c) => c.chat_id === Lark.sel)?.name || "");
        else buildEmptyDetail();
      }
    });

    // 删除当前选中会话
    $("#lark-delete-btn").addEventListener("click", async () => {
      if (!Lark.sel || !confirm("删除这个会话？（来新消息会浮现，读完自动消失）")) return;
      const r = await post("/api/lark/chat-delete", { chat_id: Lark.sel });
      toast(r.msg || (r.ok ? "已删除" : "失败"));
      if (r.ok) { Lark.sel = null; Lark.msgs = []; Lark.digestOpen = false; buildEmptyDetail(); loadLarkChats(); }
    });

    // 移动端返回列表
    $("#lark-back").addEventListener("click", () => { root.dataset.mobileView = "list"; });

    loadLarkChats();
  },

  show() {
    // 8 秒轮询：刷会话列表 + 当前会话消息
    Lark.timer = setInterval(() => {
      loadLarkChats();
      if (Lark.sel && !Lark.digestOpen) loadLarkMsgs();
    }, 8000);
  },

  hide() { clearInterval(Lark.timer); },
};

/* SSE state 推送时顺便刷角标（无需额外网络请求，直接用 Lark.chats 缓存算） */
const _larkPrevOnState = TABS._onState;
TABS._onState = () => { _larkPrevOnState?.(); updateLarkBadge(); };

/* ---- 会话列表 ---- */
async function loadLarkChats() {
  try {
    const data = await getJSON("/api/lark/chats");
    if (!Array.isArray(data)) {
      // {ok:false} 说明源未启用或接口错误
      Lark.chatsErr = data?.msg || "接口错误"; renderLarkList(); return;
    }
    Lark.chatsErr = ""; Lark.chats = data;
    renderLarkList(); updateLarkBadge();
  } catch (e) { Lark.chatsErr = String(e); renderLarkList(); }
}

function filteredChats() {
  if (Lark.filter === "p2p") return Lark.chats.filter((c) => c.mode === "p2p");
  if (Lark.filter === "group") return Lark.chats.filter((c) => c.mode !== "p2p");
  return Lark.chats;
}

function larkChatRowHtml(c) {
  const unread = c.unread || 0;
  const badge = unread ? `<span style="background:var(--danger);color:#fff;font-size:10px;border-radius:999px;padding:0 5px;min-width:17px;text-align:center;flex:none;line-height:17px">${unread > 99 ? "99+" : unread}</span>` : "";
  const tag = c.mode === "p2p" ? `<span class="tag">单聊</span>` : `<span class="tag">群</span>`;
  const time = c.last_ts ? ageText(new Date(c.last_ts).toISOString()) : "";
  return `<div class="card clickable" data-selected="${Lark.sel === c.chat_id}" onclick="openLarkChat('${jsq(c.chat_id)}','${jsq(c.name)}')">
    <div class="top">${tag}<span class="title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>${badge}<span class="right">${esc(time)}</span></div>
    ${c.last_text ? `<div class="body" style="-webkit-line-clamp:1;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">${esc(c.last_text)}</div>` : ""}
    <div class="foot" style="justify-content:flex-end">
      <button class="button sm ghost" onclick="event.stopPropagation();larkDeleteChat('${jsq(c.chat_id)}')">删除</button>
    </div>
  </div>`;
}

function renderLarkList() {
  const el = $("#lark-list"); if (!el) return;
  if (composingEl && el.contains(composingEl)) return;  // IME 保护

  if (Lark.chatsErr) {
    // 飞书源未启用的特征：接口出错且 chats 为空
    const hint = Lark.chatsErr.includes("enabled") || (!Lark.chats.length && Lark.chatsErr)
      ? "飞书源未启用——config.json 里 sources.lark.enabled: true"
      : "会话列表加载失败：" + Lark.chatsErr;
    el.innerHTML = stateBox(hint, "error"); return;
  }
  const list = filteredChats();
  if (!list.length) { el.innerHTML = stateBox(Lark.chats.length ? "当前筛选没有会话" : "暂无飞书会话"); return; }

  const pending = list.filter((c) => (c.unread || 0) > 0);
  const done = list.filter((c) => (c.unread || 0) === 0);
  el.innerHTML =
    (pending.length ? `<div class="section-title">待处理</div><div class="glist">${pending.map(larkChatRowHtml).join("")}</div>` : "") +
    (done.length ? `<div class="section-title">已处理</div><div class="glist">${done.map(larkChatRowHtml).join("")}</div>` : "");
}

function updateLarkBadge() {
  const total = Lark.chats.reduce((n, c) => n + (c.unread || 0), 0);
  const el = $("#b-lark"); if (el) el.textContent = total > 0 ? (total > 99 ? "99+" : String(total)) : "";
}

/* ---- 打开会话 ---- */
function openLarkChat(chatId, name) {
  if (Lark.sel === chatId && Lark.builtFor === chatId) return;  // 已选中无需重建
  Lark.sel = chatId; Lark.msgs = []; Lark.digestOpen = false; Lark.msgsErr = "";
  $("#lark-root").dataset.mobileView = "detail";
  renderLarkList();  // 更新 data-selected 高亮
  buildChatDetail(chatId, name);
  loadLarkMsgs();
}

/* 行内删除（轻操作，可恢复，不弹 confirm） */
async function larkDeleteChat(chatId) {
  const r = await post("/api/lark/chat-delete", { chat_id: chatId });
  toast(r.msg || (r.ok ? "已删除" : "失败"));
  if (r.ok) {
    if (Lark.sel === chatId) { Lark.sel = null; Lark.msgs = []; buildEmptyDetail(); }
    loadLarkChats();
  }
}

/* ---- 右列结构：三种模式（空 / 会话 / 今日总结）切换时重建 DOM ---- */
function buildEmptyDetail() {
  Lark.builtFor = null;
  const t = $("#lark-detail-title"); if (t) t.textContent = "选择一个会话";
  const d = $("#lark-delete-btn"); if (d) d.style.display = "none";
  const det = $("#lark-detail"); if (!det) return;
  det.innerHTML = `<div class="session-scroll" id="lark-scroll" style="flex:1;overflow-y:auto;padding:12px">${stateBox("选择左侧会话开始查看消息")}</div>`;
}

function buildChatDetail(chatId, name) {
  Lark.builtFor = chatId;
  const t = $("#lark-detail-title"); if (t) t.textContent = name || chatId;
  const d = $("#lark-delete-btn"); if (d) d.style.display = "";
  const det = $("#lark-detail"); if (!det) return;
  det.innerHTML = `
    <div class="session-scroll" id="lark-scroll" style="flex:1;overflow-y:auto;padding:12px">${stateBox("正在加载消息…", "loading")}</div>
    <div class="composer">
      <div class="composer-box">
        <textarea id="lark-input" rows="1" placeholder="回复（Enter 发送，Shift+Enter 换行；↑ 翻历史）"></textarea>
        <div class="composer-bar">
          <span class="hint">Enter 发送 · Shift+Enter 换行</span>
          <span class="spacer"></span>
          <button class="button primary" id="lark-send">发送</button>
        </div>
      </div>
    </div>`;
  const input = $("#lark-input");
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
  bindComposer(input, { key: `lark:${chatId}`, send: sendLarkMsg });
  $("#lark-send").addEventListener("click", sendLarkMsg);
}

function buildDigestDetail() {
  Lark.builtFor = "digest";
  const t = $("#lark-detail-title"); if (t) t.textContent = "今日总结";
  const d = $("#lark-delete-btn"); if (d) d.style.display = "none";
  const det = $("#lark-detail"); if (!det) return;
  det.innerHTML = `<div class="session-scroll" id="lark-digest-scroll" style="flex:1;overflow-y:auto;padding:12px">${stateBox("正在加载今日总结…", "loading")}</div>`;
}

/* ---- 消息流 ---- */
async function loadLarkMsgs() {
  if (!Lark.sel) return;
  const chatId = Lark.sel;
  try {
    const msgs = await getJSON(`/api/lark/messages?chat_id=${encodeURIComponent(chatId)}`);
    if (chatId !== Lark.sel) return;  // 切走了不渲染
    if (!Array.isArray(msgs)) { Lark.msgsErr = msgs?.msg || "加载失败"; renderLarkMsgArea(); return; }
    Lark.msgs = msgs; Lark.msgsErr = "";
    renderLarkMsgArea();
    // 后端 markRead 已执行，前端乐观清零对应会话的未读计数
    const chat = Lark.chats.find((c) => c.chat_id === chatId);
    if (chat && chat.unread) { chat.unread = 0; renderLarkList(); updateLarkBadge(); }
  } catch (e) { if (chatId === Lark.sel) { Lark.msgsErr = String(e); renderLarkMsgArea(); } }
}

/* 把飞书时间戳（epoch ms 字符串 / ISO 字符串）统一转 ISO，供 hhmm() 使用 */
function larkMsgTs(ts) {
  const s = String(ts || "");
  if (/^\d{13}$/.test(s)) return new Date(+s).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(+s * 1000).toISOString();
  return s ? new Date(s).toISOString() : "";
}

/* 检测消息文本中的飞书文档链接（docx / wiki / docs 路径） */
const FEISHU_DOC_RE = /https?:\/\/[^\s<>"]*(?:feishu\.cn|larksuite\.com)[^\s<>"#]*\/(?:docx|wiki|docs)\/[^\s<>"#]*/gi;
function extractFeishuDocs(text) {
  const found = []; let m; FEISHU_DOC_RE.lastIndex = 0;
  while ((m = FEISHU_DOC_RE.exec(text)) !== null) found.push(m[0]);
  return [...new Set(found)];
}

function docChipHtml(url) {
  const safe = esc(safeUrl(url)); if (!safe) return "";
  const jUrl = jsq(url);
  const p = Lark.docPreviews.get(url);
  if (!p) {
    return `<span class="lark-doc" style="display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border-default);border-radius:7px;padding:3px 8px;margin:3px 0;font-size:12px;cursor:pointer" onclick="fetchDocPreview('${jUrl}')">
      📄 <span>飞书文档</span> <a class="button ghost sm" style="height:20px;padding:0 5px" href="${safe}" target="_blank" rel="noopener" onclick="event.stopPropagation()">打开</a>
    </span>`;
  }
  if (p === "loading") {
    return `<span class="lark-doc" style="display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border-default);border-radius:7px;padding:3px 8px;margin:3px 0;font-size:12px">📄 <span style="color:var(--text-tertiary)">解析中…</span></span>`;
  }
  const title = esc(p.title || "飞书文档");
  return `<div class="lark-doc" style="border:1px solid var(--border-default);border-radius:7px;padding:5px 8px;margin:3px 0;font-size:12px;background:var(--surface-1)">
    <div style="display:flex;align-items:center;gap:6px">
      <span>📄</span><span style="font-weight:600;flex:1">${title}</span>
      <a class="button ghost sm" style="height:22px;padding:0 6px" href="${safe}" target="_blank" rel="noopener">打开</a>
      <button class="button ghost sm" style="height:22px;padding:0 6px" onclick="saveDocToInbox('${jUrl}','${jsq(p.title || "")}')">收藏</button>
    </div>
    ${p.excerpt ? `<div style="color:var(--text-secondary);font-size:11.5px;margin-top:3px;line-height:1.4;overflow:hidden;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical">${esc(p.excerpt.slice(0, 200))}</div>` : ""}
  </div>`;
}

async function fetchDocPreview(url) {
  if (Lark.docPreviews.has(url)) return;
  Lark.docPreviews.set(url, "loading"); renderLarkMsgArea();
  try {
    const r = await getJSON(`/api/lark/doc?url=${encodeURIComponent(url)}`);
    Lark.docPreviews.set(url, r);
  } catch { Lark.docPreviews.set(url, { ok: false, title: "获取失败", excerpt: "" }); }
  renderLarkMsgArea();
}

async function saveDocToInbox(url, title) {
  const r = await post("/api/lark/doc/save", { url, title });
  toast(r.msg || (r.ok ? "已收藏到收件箱" : "失败"));
}

function larkMsgHtml(m) {
  const role = m.mine ? "user" : "assistant";
  const who = m.mine ? "我" : esc(m.sender || "对方");
  const ts = larkMsgTs(m.ts);
  const docs = extractFeishuDocs(m.text || "");
  return `<div class="msg" data-role="${role}">
    <div class="who">${who}${ts ? ` · ${hhmm(ts)}` : ""}</div>
    <div class="bubble">${mdHtml(m.text || "")}</div>
    ${docs.length ? `<div style="margin-top:4px">${docs.map(docChipHtml).join("")}</div>` : ""}
  </div>`;
}

function renderLarkMsgArea() {
  const sc = $("#lark-scroll"); if (!sc) return;
  // IME 保护：composer 在本区域内组字中，跳过整块重渲染，防止未上屏拼音被吃掉
  if (composingEl && sc.closest("#lark-detail")?.contains(composingEl)) return;
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  if (Lark.msgsErr) { sc.innerHTML = stateBox("消息加载失败：" + Lark.msgsErr, "error"); return; }
  if (!Lark.msgs.length) { sc.innerHTML = stateBox("这个会话还没有消息"); return; }
  sc.innerHTML = Lark.msgs.map(larkMsgHtml).join("");
  if (nearBottom) sc.scrollTop = sc.scrollHeight;
}

/* ---- 发送消息 ---- */
async function sendLarkMsg() {
  const input = $("#lark-input"); if (!input) return;
  const text = input.value.trim(); if (!text || !Lark.sel) return;
  const chatId = Lark.sel;
  composerSent(`lark:${chatId}`, text);
  input.value = ""; input.style.height = "auto";
  // 乐观追加气泡：让用户立刻看到自己的消息（不用等服务端回包）
  Lark.msgs.push({ id: `opt-${Date.now()}`, sender: "我", ts: String(Date.now()), text, mine: true });
  renderLarkMsgArea();
  const r = await post("/api/lark/send", { chat_id: chatId, text });
  if (!r.ok) toast(r.msg || "发送失败");
  // 无论成功与否都重拉，用服务端真实消息 id 覆盖乐观气泡
  if (Lark.sel === chatId) await loadLarkMsgs();
}

/* ---- 今日总结面板 ---- */
async function loadLarkDigest() {
  try {
    const d = await getJSON("/api/lark/digest");
    Lark.digest = d;
    if (Lark.digestOpen) renderDigestPanel();
  } catch (e) { toast("总结数据加载失败：" + String(e)); }
}

function renderDigestPanel() {
  const container = $("#lark-digest-scroll") || $("#lark-detail");
  if (!container) return;
  const d = Lark.digest;
  if (!d) { container.innerHTML = stateBox("正在加载…", "loading"); return; }
  const msgs = d.messages || [];
  const selCount = msgs.filter((m) => m.selected).length;
  const det = $("#lark-detail"); if (!det) return;
  det.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-subtle);flex:none;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text-secondary)">${esc(d.date || "")} · ${selCount} / ${msgs.length} 条已选</span>
      <button class="button ghost sm" onclick="larkDigestSelectAll(true)">全选</button>
      <button class="button ghost sm" onclick="larkDigestSelectAll(false)">全不选</button>
      <button class="button ghost sm" id="lark-pull-btn" title="手动拉取今天此刻前的飞书消息">重新收割</button>
    </div>
    <div class="session-scroll" id="lark-digest-scroll" style="flex:1;overflow-y:auto;padding:10px">
      ${msgs.length ? msgs.map(digestMsgHtml).join("") : stateBox("今日暂无飞书消息（可点「重新收割」手动拉取）")}
    </div>`;
  $("#lark-pull-btn").addEventListener("click", async () => {
    toast("收割中…");
    const r = await post("/api/lark/digest/pull?today=1", {});
    toast(r.msg || (r.ok ? "完成" : "失败"));
    if (r.ok) await loadLarkDigest();
  });
}

function digestMsgHtml(m) {
  const ts = m.ts ? hhmm(new Date(m.ts).toISOString()) : "";
  return `<div class="card" style="margin-bottom:6px;cursor:pointer" onclick="toggleDigestMsg('${jsq(m.id)}',${!m.selected})">
    <div class="top">
      <input type="checkbox" ${m.selected ? "checked" : ""} style="width:14px;height:14px;flex:none"
        onclick="event.stopPropagation();toggleDigestMsg('${jsq(m.id)}',this.checked)">
      <span class="tag">${esc(m.chat_name || m.chat_id)}</span>
      <span style="color:var(--text-secondary);font-size:11.5px">${esc(m.sender || "")}</span>
      <span class="right mono" style="font-size:11px">${ts}</span>
    </div>
    <div class="body">${esc(m.text || "")}</div>
  </div>`;
}

async function toggleDigestMsg(id, selected) {
  const d = Lark.digest; if (!d) return;
  const m = d.messages.find((x) => x.id === id); if (m) m.selected = !!selected;
  renderDigestPanel();
  await post("/api/lark/digest/toggle", { date: d.date, id, selected: !!selected });
}

async function larkDigestSelectAll(selected) {
  const d = Lark.digest; if (!d) return;
  for (const m of d.messages) m.selected = !!selected;
  renderDigestPanel();
  await post("/api/lark/digest/select-all", { date: d.date, selected: !!selected });
}
