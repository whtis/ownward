"use strict";
/* ownward web workbench — 核心：状态、SSE、tab 路由、通知流。各 tab 在 today/tasks/chat/summary/system.js */

/* ============ 工具 ============ */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** 内联 onclick 的字符串参数编码：反斜杠/引号/换行都要处理——esc() 只管 HTML，
 *  标题/路径里一个尾部反斜杠就能改写 JS 字符串边界（codex 对抗审查实证过） */
const jsq = (s) => esc(String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\n\r\u2028\u2029]/g, " "));
/** 外部可控 URL 只放行 http(s)：feed/action/会议链接是 triage 从邮件/飞书内容里提的，
 *  javascript:/data: 一点就在本页源里执行 = 打穿 localhost API（esc 防不了这个） */
function safeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}
/** IME 组字跟踪：组字中的输入框所在区域必须跳过整块重渲染——
 *  未上屏的拼音不在 input.value 里，DOM 重建会直接吃掉组字（中文没法输入的根源） */
let composingEl = null;
document.addEventListener("compositionstart", (e) => (composingEl = e.target), true);
document.addEventListener("compositionend", () => (composingEl = null), true);
/** LLM 输出的轻量 markdown 渲染（会话/对话气泡用）。先 esc 后组装，不引第三方库。
 *  覆盖：粗斜体、行内代码、链接、围栏代码块、表格、有序/无序列表、标题、分隔线、引用。 */
function mdHtml(src) {
  const inline = (s) => {
    s = esc(s);
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);  // 护住 code span 不被其他规则改写
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`);
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[+n]}</code>`);
  };
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {           // 围栏代码块（没闭合就吃到结尾——流式输出常见半截块）
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre class="md-code">${esc(buf.join("\n"))}</pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      out.push(`<div class="md-tablewrap"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${
        rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]))
        items.push(`<li>${inline(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (/^\s*>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(inline(lines[i++].replace(/^\s*>\s?/, "")));
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push("<hr>"); i++; }
    else if (/^#{1,4}\s+/.test(l)) {
      const h = l.match(/^(#{1,4})\s+(.*)/);
      out.push(`<div class="md-h${h[1].length}">${inline(h[2])}</div>`); i++;
    } else if (!l.trim()) {
      if (out[out.length - 1] !== `<div class="md-gap"></div>`) out.push(`<div class="md-gap"></div>`);
      i++;
    } else { out.push(`<div class="md-p">${inline(l)}</div>`); i++; }
  }
  return `<div class="md">${out.join("")}</div>`;
}
const hhmm = (iso) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
function ageText(iso) {
  if (!iso) return "无信号";
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return `${s}s 前`;
  if (s < 5400) return `${Math.round(s / 60)}m 前`;
  if (s < 172800) return `${Math.round(s / 3600)}h 前`;
  return `${Math.round(s / 86400)}d 前`;
}
function fmtDur(t) {
  const end = t.endedAt ? new Date(t.endedAt) : new Date();
  const m = Math.max(0, Math.round((end - new Date(t.startedAt)) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
async function post(url, body) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return { ok: false, msg: String(e) }; }
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.dataset.show = "false"), 2600);
}
/** 页面级状态占位：统一空白等待与明确失败，不把请求失败伪装成“没有内容”。 */
function stateBox(message, state = "empty") {
  return `<div class="state-box" data-state="${state}">${esc(message)}</div>`;
}
/** 大文本查看弹窗（repo diff 等） */
function showText(title, body) {
  $("#t-title").textContent = title;
  $("#t-body").textContent = body;
  $("#text-overlay").dataset.open = "true";
}

/* ============ 输入框增强：↑/↓ 翻输入历史 + / 命令补全 ============ */
// 历史按会话分桶：同一个任务里 ↑ 只翻自己这条线的输入，不串台
const HIST_KEY = "ownward-input-history";
const HIST_PER = 50;      // 每个会话留几条
const HIST_BUCKETS = 40;  // 留几个会话的桶（localStorage 有容量上限，按最近使用淘汰）
function histAll() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || {}; } catch { return {}; } }
function histList(key) { const l = histAll()[key]; return Array.isArray(l) ? l : []; }
function histPush(key, text) {
  const t = String(text || "").trim();
  if (!key || !t) return;
  const all = histAll();
  const list = (all[key] || []).filter((x) => x !== t);   // 重复输入只留最新那次
  delete all[key];                                        // 删了再插：键的插入序 = LRU 序
  for (const k of Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - HIST_BUCKETS + 1))) delete all[k];
  all[key] = [t, ...list].slice(0, HIST_PER);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(all)); } catch { /* 写不进不影响发送 */ }
}

// ownward 自己解释的命令；其余 / 开头一律原样透传给 agent（CC 自己解释，认识的执行、不认识的回说明）
const LOCAL_CMDS = [
  { name: "new", desc: "同任务丢上下文重开" },
  { name: "clear", desc: "同 /new" },
  { name: "btw", desc: "忙时补一句背景，不打断本轮" },
];
const CP = {};  // key → {i, stash, sel}：历史游标与菜单选中项，跨重渲染保留

/** 给 composer 的 textarea 装上 Enter 发送 / ↑↓ 翻历史 / 斜杠补全。
 *  宿主每次重渲染都会拿新 textarea 再调一次；状态挂在 key 上，所以重渲染不丢。
 *  opts: {key, send(), commands?}——commands 为数组时才开补全菜单（codex/对话没有命令表就不开）。 */
function bindComposer(el, opts) {
  if (!el) return;
  const keyOf = () => typeof opts.key === "function" ? opts.key() : (opts.key || "");
  const state = () => (CP[keyOf()] ||= { i: -1, stash: "", sel: 0 });
  // 菜单挂在 .composer 上而不是 .composer-box：后者 overflow:hidden 会把浮层裁掉
  const host = el.closest(".composer") || el.parentElement;
  let menu = host.querySelector(".slash-menu");
  if (!menu) { menu = document.createElement("div"); menu.className = "slash-menu"; menu.hidden = true; host.prepend(menu); }
  const all = Array.isArray(opts.commands)
    ? [...LOCAL_CMDS, ...opts.commands.filter((n) => !LOCAL_CMDS.some((l) => l.name === n)).map((name) => ({ name, desc: "" }))]
    : null;
  let items = [];
  let quiet = false;  // setVal 触发的 input 事件不当成用户编辑（否则历史游标自己把自己重置）

  // 只在「整条输入就是一个 / 开头的词」时提示：打出空格 = 命令已选定，开始写参数了
  function match() {
    if (!all) return [];
    const m = el.value.match(/^\/(\S*)$/);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return all.filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => (b.name.toLowerCase().startsWith(q)) - (a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 40);
  }
  function draw() {
    const st = state();
    // st.mute：内容是历史回溯填进来的，不弹补全——否则翻出一条裸命令（/new）菜单就开了，
    // 接着按 ↑ 会被菜单接管，历史翻不动
    items = st.mute ? [] : match();
    menu.hidden = !items.length;
    if (!items.length) return;
    st.sel = Math.max(0, Math.min(st.sel, items.length - 1));
    menu.innerHTML = items.map((c, i) =>
      `<button type="button" class="sl-item" data-i="${i}" data-on="${i === st.sel}"><span class="n">/${esc(c.name)}</span>${c.desc ? `<span class="d">${esc(c.desc)}</span>` : ""}</button>`).join("");
    menu.querySelector('[data-on="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function setVal(v, mute) {
    const st = state();
    quiet = true;
    st.mute = !!mute;
    el.value = v ?? "";
    el.dispatchEvent(new Event("input"));  // 让宿主的 autoGrow 跟上
    quiet = false;
    el.setSelectionRange(el.value.length, el.value.length);
  }
  function accept(i) {
    const st = state();
    const c = items[i];
    if (!c) return;
    menu.hidden = true; items = []; st.sel = 0;
    setVal("/" + c.name + " ");
    el.focus();
  }

  menu.onmousedown = (e) => {   // mousedown 而非 click：抢在 textarea 失焦之前，否则菜单已经被 blur 收起来了
    const b = e.target.closest(".sl-item");
    if (!b) return;
    e.preventDefault();
    accept(+b.dataset.i);
  };
  el.addEventListener("input", () => { const st = state(); if (!quiet) { st.sel = 0; st.i = -1; st.mute = false; } draw(); });
  el.addEventListener("blur", () => { menu.hidden = true; items = []; });
  el.addEventListener("keydown", (e) => {
    const st = state();
    if (e.isComposing) return;
    if (!menu.hidden && items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); st.sel = (st.sel + 1) % items.length; draw(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); st.sel = (st.sel - 1 + items.length) % items.length; draw(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(st.sel); return; }
      if (e.key === "Escape") { e.preventDefault(); menu.hidden = true; items = []; return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); opts.send(); return; }
    // ↑/↓ 翻历史：只在光标已经在首行/末行（再按也走不动了）时接管，多行草稿里正常上下移动不受影响。
    // 没发出去的草稿存进 stash，↓ 翻回底还能拿回来
    if (el.selectionStart !== el.selectionEnd) return;   // 有选区时让浏览器自己处理
    const list = histList(keyOf());
    if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n")) {
      if (st.i >= list.length - 1) return;
      if (st.i < 0) st.stash = el.value;
      e.preventDefault();
      setVal(list[++st.i], true);
    } else if (e.key === "ArrowDown" && st.i >= 0 && !el.value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      setVal(--st.i < 0 ? st.stash : list[st.i], true);
    }
  });
  draw();
}
/** 发出去了：进历史 + 游标归位（宿主发送成功后调） */
function composerSent(key, text) { histPush(key, text); const st = CP[key]; if (st) { st.i = -1; st.stash = ""; } }

/* Composer 草稿按稳定会话 identity 隔离。文本写 sessionStorage，附件只留当前页面内存；
 * storage 损坏/超限都降级为内存，不阻断输入。 */
const ComposerDrafts = (() => {
  const STORAGE_KEY = "ownward-composer-drafts-v1";
  const VERSION = 1, MAX_ENTRIES = 80, MAX_TEXT = 20_000;
  let texts = {};
  const attachments = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.version === VERSION && saved.entries && typeof saved.entries === "object") {
      texts = Object.fromEntries(Object.entries(saved.entries)
        .filter(([key, item]) => key && typeof item?.text === "string")
        .slice(-MAX_ENTRIES)
        .map(([key, item]) => [key, { text: item.text.slice(0, MAX_TEXT), touched: Number(item.touched) || 0 }]));
    }
  } catch { texts = {}; }
  const persist = () => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries: texts })); } catch { /* 内存草稿仍可用 */ }
  };
  const trim = () => {
    const keys = Object.keys(texts);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => texts[a].touched - texts[b].touched)
      .slice(0, keys.length - MAX_ENTRIES).forEach((key) => delete texts[key]);
  };
  return {
    getText(key) { return texts[key]?.text || ""; },
    setText(key, text) {
      if (!key) return;
      const value = String(text ?? "").slice(0, MAX_TEXT);
      if (value) texts[key] = { text: value, touched: Date.now() };
      else delete texts[key];
      trim(); persist();
    },
    clearText(key, expected) {
      if (key && texts[key] && (expected === undefined || texts[key].text === expected)) { delete texts[key]; persist(); }
    },
    moveText(from, to) {
      if (!from || !to || from === to) return;
      const value = texts[from]?.text;
      delete texts[from];
      if (value && !texts[to]?.text) texts[to] = { text: value, touched: Date.now() };
      trim(); persist();
    },
    getAttachments(key) { return key ? (attachments.get(key) || []) : []; },
    setAttachments(key, items) {
      if (!key) return;
      const next = items || [];
      // 释放被丢弃的 blob URL（旧条目里、新条目里已不在的）——草稿是这些图的所有者，
      // 清空/发送后置空/替换时若不 revoke，blob 会一直占内存(切走再切回是同一数组，不会误伤重现)。
      for (const old of attachments.get(key) || []) {
        if (old && typeof old.url === "string" && old.url.startsWith("blob:") && !next.includes(old)) {
          try { URL.revokeObjectURL(old.url); } catch { /* 已释放/无效 URL 忽略 */ }
        }
      }
      next.length ? attachments.set(key, next) : attachments.delete(key);
    },
    moveAttachments(from, to) {
      if (!from || !to || from === to) return;
      const items = attachments.get(from);
      attachments.delete(from);
      if (items?.length && !attachments.has(to)) attachments.set(to, items);
    },
  };
})();
globalThis.ComposerDrafts = ComposerDrafts;

/* ============ 全局状态 ============ */
const S = {
  tab: new URLSearchParams(location.search).get("tab") || localStorage.getItem("ownward-tab") || "today",
  feed: [], feedError: "", tasks: [], state: null,
  fKind: "all", fSources: new Set(), buffered: [],
  retries: 0, collapsedDone: true,
  projects: [],           // 项目收藏（派发目录补全）
};
const SRC = {
  lark: { label: "飞", color: "var(--source-lark)" },
  github: { label: "GH", color: "var(--source-github)" },
  gmail: { label: "M", color: "var(--source-gmail)" },
  stock: { label: "股", color: "var(--source-stock)" },
  dispatch: { label: ">_", color: "var(--source-dispatch)" },
  heartbeat: { label: "HB", color: "var(--source-heartbeat)" },
  system: { label: "SYS", color: "var(--source-system)" },
};

/* ============ Tab 路由（懒初始化，切走不销毁） ============ */
const TABS = {};  // name → {init(root), show?, hide?} 由各 tab 文件注册
const inited = new Set();
function switchTab(name) {
  if (!TABS[name]) return;
  if (tabHidden(name)) return;  // tab 已隐藏：路由层兜底，快捷键/⌘K 都进不去
  const prev = S.tab;
  if (prev && TABS[prev]?.hide) TABS[prev].hide();
  S.tab = name;
  localStorage.setItem("ownward-tab", name);
  $$('[data-tab]').forEach((b) => {
    const active = b.dataset.tab === name;
    b.dataset.on = active;
    if (b.classList.contains("nav-tab")) active ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current");
  });
  $$(".pane-root").forEach((p) => (p.dataset.active = p.dataset.pane === name));
  if (!inited.has(name)) { inited.add(name); TABS[name].init($(`#${name}-root`)); }
  TABS[name].show?.();
}

/* ============ 通知流 tab ============ */
TABS.feed = {
  init(root) {
    root.innerHTML = `<div class="feed-page">
      <div class="page-head">
        <div><div class="eyebrow">ACTIVITY</div><h1>通知流</h1><p>所有事件源的判断与投递记录</p></div>
        <span class="page-count" id="feed-count"></span>
      </div>
      <div class="filters panel" id="filters" aria-label="通知筛选">
        <button class="chip" data-f-kind="all" data-on="true">全部</button>
        <button class="chip" data-f-kind="notify">已通知</button>
        <button class="chip" data-f-kind="log">仅记录</button>
        <span class="filter-divider"></span>
      </div>
      <div class="col-scroll panel" id="feed-scroll" style="padding:2px 0">
        <button class="new-events-btn" id="new-events-btn"></button>
        <div class="feed-list" id="feed-list"></div>
        <div id="feed-empty" style="display:none"></div>
      </div>
    </div>`;
    const box = $("#filters");
    for (const [k, v] of Object.entries(SRC)) {
      if (k === "system") continue;
      const b = document.createElement("button");
      b.className = "chip"; b.dataset.on = "false";
      b.innerHTML = `<span class="sw" style="background:${v.color}"></span>${esc(k)}`;
      b.addEventListener("click", () => {
        S.fSources.has(k) ? S.fSources.delete(k) : S.fSources.add(k);
        b.dataset.on = S.fSources.has(k);
        renderFeed();
      });
      box.appendChild(b);
    }
    $$("[data-f-kind]", box).forEach((b) => b.addEventListener("click", () => {
      S.fKind = b.dataset.fKind;
      $$("[data-f-kind]", box).forEach((x) => (x.dataset.on = x === b));
      renderFeed();
    }));
    $("#new-events-btn").addEventListener("click", () => {
      S.buffered = [];
      $("#new-events-btn").style.display = "none";
      document.title = "Ownward";
      $("#feed-scroll").scrollTop = 0;
      renderFeed();
    });
    renderFeed();
  },
};
function feedVisible(e) {
  if (S.fKind !== "all" && e.kind !== S.fKind) return false;
  if (S.fSources.size && !S.fSources.has(e.source)) return false;
  return true;
}
function feedItemHtml(e, isNew) {
  const src = SRC[e.source] || SRC.system;
  const hasDetail = !!e.detail;
  const flag = e.kind === "notify"
    ? `<span class="dot ok" style="width:5px;height:5px"></span>已通知${(e.channels || []).includes("lark") ? " · 飞书" : ""}`
    : `<span class="dot hollow" style="width:5px;height:5px"></span>记录`;
  return `<div class="feed-item" style="--seg:${src.color}" data-kind="${e.kind}" data-source="${esc(e.source)}"
       data-new="${isNew ? "true" : "false"}" data-has-detail="${hasDetail}" ${hasDetail ? "onclick=\"this.dataset.open = this.dataset.open==='true' ? 'false' : 'true'\"" : ""}>
    <span class="rail-seg"></span><span class="rail-node"></span>
    <span></span>
    <span class="src-badge" title="${esc(e.source)}">${src.label}</span>
    <span class="feed-time mono">${hhmm(e.ts)}</span>
    <span class="feed-text">${safeUrl(e.link) ? `<a href="${esc(safeUrl(e.link))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(e.text)}</a>` : esc(e.text)}</span>
    <span class="feed-flag">${flag}</span>
    ${hasDetail ? `<div class="feed-detail">${esc(e.detail)}</div>` : ""}
  </div>`;
}
function renderFeed(newCount = 0) {
  const el = $("#feed-list");
  if (!el) { $("#b-feed").textContent = ""; return; }
  const list = S.feed.filter(feedVisible);
  el.innerHTML = list.map((e, i) => feedItemHtml(e, i < newCount)).join("");
  const empty = $("#feed-empty");
  empty.style.display = list.length ? "none" : "block";
  empty.innerHTML = list.length ? "" : stateBox(S.feedError ? "通知流暂时无法载入" : S.feed.length ? "没有符合当前筛选的事件" : "今天还没有分流事件", S.feedError ? "error" : "empty");
  $("#feed-count").textContent = `${list.length} 条`;
}
function pushFeed(entry) {
  S.feed.unshift(entry);
  if (S.feed.length > 300) S.feed.pop();
  const sc = $("#feed-scroll");
  if (sc && sc.scrollTop > 40) {
    S.buffered.push(entry);
    const btn = $("#new-events-btn");
    btn.textContent = `↑ ${S.buffered.length} 条新事件`;
    btn.style.display = "block";
    if (document.hidden) document.title = `(${S.buffered.length}) Ownward`;
  } else {
    renderFeed(1);
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Ownward"; });

/* 通知流隐藏开关：纯前端偏好，localStorage 持久化（键值风格照 skin.js）。
 * 只藏渲染层入口——桌面 tab 和移动菜单共用 data-tab="feed"，一条选择器全盖住；
 * SSE 照常进 S.feed，后端与数据不动，恢复开关在系统 tab（system.js）。 */
// 可隐藏的 tab：默认全部隐藏（用户要求先把通知流/对话/角色入口收起来），
// 系统设置里勾选 = 显式写 "0" 恢复。feed 沿用旧键，不动已有用户状态。
const TOGGLABLE_TABS = ["feed", "chat", "roles", "lark", "notes"];   // lark/notes 默认隐藏（D5：入口默认收起，系统 tab 界面区勾选恢复）
const tabHiddenKey = (name) => (name === "feed" ? "ownward-feed-hidden" : `ownward-tab-${name}-hidden`);
const tabHidden = (name) => TOGGLABLE_TABS.includes(name) && localStorage.getItem(tabHiddenKey(name)) !== "0";   // 只有可隐藏 tab 参与判断；其他 tab 永不隐藏
function applyTabVisibility() {
  for (const name of TOGGLABLE_TABS) $$(`[data-tab="${name}"]`).forEach((b) => (b.style.display = tabHidden(name) ? "none" : ""));
}
function setTabHidden(name, hidden) {
  localStorage.setItem(tabHiddenKey(name), hidden ? "1" : "0");   // 默认隐藏，恢复是显式写 0
  applyTabVisibility();
}

/* ============ SSE ============ */
/** 顶栏状态：渐进披露——一切正常只有一个安静的点，异常才说人话（离线/待分流堆积） */
function setLive(ok, txt) {
  S.live = ok; S.liveTxt = txt;
  renderSysStatus();
}
function renderSysStatus() {
  const dot = $("#live-dot"), txtEl = $("#sys-text");
  if (!dot) return;
  const queue = S.state?.queue || 0;
  if (!S.live) { dot.className = "dot bad breathe"; txtEl.textContent = S.liveTxt || "连接中断，重连中"; }
  else if (queue > 0) { dot.className = "dot " + (queue > 20 ? "warn" : "ok"); txtEl.textContent = `${queue} 件待分流`; }
  else { dot.className = "dot ok"; txtEl.textContent = ""; }
}
function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("open", () => { setLive(true, "LIVE"); S.retries = 0; });
  es.addEventListener("state", (ev) => { S.state = JSON.parse(ev.data); renderTopbar(); TABS._onState?.(); });
  es.addEventListener("feed", (ev) => pushFeed(JSON.parse(ev.data)));
  es.addEventListener("tasks", (ev) => {
    S.tasks = JSON.parse(ev.data);
    S.tasksSeq = (S.tasksSeq || 0) + 1;   // 标记 SSE 刚推过新鲜数据；定时轮询据此判断是否已过时
    if (typeof Tasks !== "undefined") Tasks.tasksError = "";
    TABS._onTasks?.();
  });
  es.onerror = () => {
    es.close();
    S.retries++;
    setLive(false, `重连 ${Math.min(S.retries * 3, 30)}s`);
    setTimeout(connectSSE, Math.min(S.retries * 3000, 30000));
  };
}
function renderTopbar() {
  if (!S.state) return;
  renderSysStatus();
  renderHeartbeatPill();
  applyFeatureVisibility();
  const running = S.tasks.filter((t) => t.status === "running" && t.kind !== "routine").length;
  $("#b-tasks").textContent = running || "";
}
/** 关闭的功能不占 tab：邮件（gmail 源）未启用时，隐藏其导航入口；正停在该 tab 就回退今日。 */
function applyFeatureVisibility() {
  const mailOn = !!S.state?.sources?.gmail;
  $$('[data-feature="mail"]').forEach((el) => { el.style.display = mailOn ? "" : "none"; });
  if (!mailOn && S.tab === "mail") switchTab("today");
}
/** 顶栏心跳倒计时（主仓 web 就有，网页化时掉了）：mm:ss 到下次心跳，点击立即触发 */
function renderHeartbeatPill() {
  const el = $("#hb-pill");
  if (!el) return;
  const last = S.state?.lastHeartbeatAt, min = S.state?.heartbeatIntervalMin;
  if (!last || !min) { el.style.display = "none"; return; }
  const left = new Date(last).getTime() + min * 60_000 - Date.now();
  el.style.display = "";
  el.textContent = left <= 0 ? "心跳 即将" : `心跳 ${String(Math.floor(left / 60_000)).padStart(2, "0")}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;
}
setInterval(renderHeartbeatPill, 1000);

/* ============ 顶栏动作 / 派发 modal ============ */
function bindTopbar() {
  $$("[data-action]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const res = await post("/api/action", { action: b.dataset.action });
    toast(res.msg || (res.ok ? "已触发 ✓" : "失败"));
    b.closest("details")?.removeAttribute("open");
    setTimeout(() => (b.disabled = false), 1200);
  }));
  $$('[data-tab]').forEach((b) => b.addEventListener("click", () => {
    switchTab(b.dataset.tab);
    b.closest("details")?.removeAttribute("open");
  }));

  $("#t-close").addEventListener("click", () => ($("#text-overlay").dataset.open = "false"));
  $("#text-overlay").addEventListener("click", (e) => { if (e.target.id === "text-overlay") e.target.dataset.open = "false"; });

  const overlay = $("#work-overlay");
  let workExtraDirs = [];
  const refreshProjectCandidates = async () => {
    S.projects = await getJSON("/api/projects").catch(() => S.projects);
    const options = S.projects.map((p) => `<option value="${esc(p.dir)}">`).join("");
    $("#w-dir-list").innerHTML = options;
    $("#add-dir-list").innerHTML = options;
  };
  const renderWorkExtraDirs = () => {
    $("#w-extra-chips").innerHTML = workExtraDirs.map((dir, i) => {
      const name = dir.split("/").filter(Boolean).at(-1) || dir;
      const removeLabel = `移除附加目录：${name}`;
      return `<span class="dir-chip" title="${esc(dir)}"><span>${esc(name)}</span><button type="button" data-i="${i}" title="${esc(removeLabel)}" aria-label="${esc(removeLabel)}">✕</button></span>`;
    }).join("");
    $$("#w-extra-chips button").forEach((b) => b.addEventListener("click", () => { workExtraDirs.splice(+b.dataset.i, 1); renderWorkExtraDirs(); }));
  };
  const addWorkExtraDir = (value) => {
    const dir = String(value || "").trim();
    if (!dir) return;
    if (dir === $("#w-dir").value.trim()) { toast("附加目录不能和主目录相同"); return; }
    if (!workExtraDirs.includes(dir)) workExtraDirs.push(dir);
    renderWorkExtraDirs();
  };
  const syncWorkMode = () => {
    const enabled = $("#w-bg").checked;
    $("#w-extra-browse").disabled = !enabled;
    $("#w-extra-disabled").hidden = enabled;
    if (!enabled && workExtraDirs.length) { workExtraDirs = []; renderWorkExtraDirs(); toast("terminal 模式已清除附加目录"); }
  };
  const openWork = (dir) => {
    overlay.dataset.open = "true";
    // 默认值由服务端下发（config dispatch.defaults）：目录/模型/权限预填好，
    // 描述可留空直接派——开一个"待命会话"再慢慢说要干啥
    const d = S.state?.dispatchDefaults || {};
    if (dir) $("#w-dir").value = dir;
    else if (!$("#w-dir").value && d.dir) $("#w-dir").value = d.dir;
    if (!$("#w-task").value) { if (d.provider) $("#w-engine").value = d.provider; else if (d.codex !== undefined) $("#w-engine").value = d.codex ? "codex" : "claude"; }
    if (d.model && !$("#w-model").value) { $("#w-engine").dispatchEvent(new Event("change")); $("#w-model").value = d.model; }
    const options = S.projects.map((p) => `<option value="${esc(p.dir)}">`).join("");
    $("#w-dir-list").innerHTML = options;
    const bypass=$("#w-perm option[value=bypass]");if(bypass){bypass.disabled=S.state?.allowFullAccess!==true;bypass.hidden=S.state?.allowFullAccess!==true;if(bypass.disabled&&$("#w-perm").value==="bypass")$("#w-perm").value="";}
    if (d.permission && !$("#w-perm").value && !(d.permission === "bypass" && S.state?.allowFullAccess !== true)) $("#w-perm").value = d.permission;
    ($("#w-dir").value ? $("#w-task") : $("#w-dir")).focus();
  };
  const closeWork = () => { overlay.dataset.open = "false"; workExtraDirs = []; renderWorkExtraDirs(); };
  window.openWork = openWork;
  $("#btn-work").addEventListener("click", () => openWork());
  $("#w-cancel").addEventListener("click", closeWork);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeWork(); });

  // 浏览目录：浏览器内弹窗（/api/fs/dirs，圈在授权根内）——旧版弹本机 Finder，
  // 远程打开 web 时弹窗在 daemon 那台机器的屏幕上，这边只会挂死
  $("#w-browse").addEventListener("click", () =>
    openDirPicker((dir) => { $("#w-dir").value = dir; $("#w-task").focus(); }, $("#w-dir").value.trim() || null));
  $("#w-extra-browse").addEventListener("click", () =>
    openDirPicker((dir) => addWorkExtraDir(dir), $("#w-dir").value.trim() || null));
  $("#w-bg").addEventListener("change", syncWorkMode);
  syncWorkMode();

  // 给现有 agent 会话追加目录：沿用派新任务的候选补全、手动输入和目录选择弹窗。
  const addDirOverlay = $("#add-dir-overlay");
  let addDirTaskId = "";
  const closeAddDir = () => {
    addDirOverlay.dataset.open = "false";
    addDirTaskId = "";
  };
  window.openAddDirPicker = (taskId) => {
    addDirTaskId = taskId;
    $("#add-dir-input").value = "";
    $("#add-dir-status").innerHTML = "";
    $("#add-dir-list").innerHTML = S.projects.map((p) => `<option value="${esc(p.dir)}">`).join("");
    addDirOverlay.dataset.open = "true";
    $("#add-dir-input").focus();
  };
  $("#add-dir-cancel").addEventListener("click", closeAddDir);
  addDirOverlay.addEventListener("click", (e) => { if (e.target === addDirOverlay) closeAddDir(); });
  $("#add-dir-browse").addEventListener("click", () =>
    openDirPicker((dir) => { $("#add-dir-input").value = dir; $("#add-dir-submit").focus(); }, $("#add-dir-input").value.trim() || null));
  const submitAddDir = async () => {
    const dir = $("#add-dir-input").value.trim();
    if (!dir) { toast("请选择或输入项目目录"); return; }
    if (!addDirTaskId) return;
    const btn = $("#add-dir-submit");
    btn.disabled = true;
    const r = await post("/api/dev/add-dir", { id: addDirTaskId, dir });
    btn.disabled = false;
    toast(r.msg || (r.ok ? "已加入" : "失败"));
    const status = $("#add-dir-status");
    status.insertAdjacentHTML("beforeend", `<div data-ok="${!!r.ok}" title="${esc(dir)}">${r.ok ? "✓" : "✕"} ${esc(dir)}${r.ok ? "" : ` · ${esc(r.msg || "失败")}`}</div>`);
    if (r.ok) { $("#add-dir-input").value = ""; await refreshProjectCandidates(); $("#add-dir-input").focus(); }
    if (typeof pollDetail === "function") pollDetail(true);
  };
  $("#add-dir-submit").addEventListener("click", submitAddDir);
  $("#add-dir-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitAddDir(); }
  });

  // 模型选单随引擎切换：claude 走别名，codex 走 gpt-5.x 型号，codebuddy 走腾讯网关型号（值原样透传 --model / -m）
  const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
  const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.5-pro"];
  const CODEBUDDY_MODELS = ["hy3", "glm-5.2", "kimi-k3-1", "minimax-m3", "deepseek-v4-pro", "deepseek-v3-2-volc"];
  const fillModels = () => {
    const keep = $("#w-model").value;
    const list = { codex: CODEX_MODELS, codebuddy: CODEBUDDY_MODELS }[$("#w-engine").value] || CLAUDE_MODELS;
    $("#w-model").innerHTML = `<option value="">默认</option>` + list.map((m) => `<option>${m}</option>`).join("");
    if (list.includes(keep)) $("#w-model").value = keep;
  };
  $("#w-engine").addEventListener("change", fillModels);
  fillModels();

  // 派发附图：粘贴/拖入/选文件 → base64 暂存，随 /api/work 发出（派发成功才清，失败留着重试）
  let workImgs = [];   // [{media_type, data(base64)}]
  const renderWorkImgs = () => {
    $("#w-imgs").innerHTML = workImgs.map((im, i) =>
      `<div class="thumb"><img src="data:${esc(im.media_type)};base64,${im.data}" alt="">
        <button title="移除" data-i="${i}">✕</button></div>`).join("");
    $$("#w-imgs .thumb button").forEach((b) =>
      b.addEventListener("click", () => { workImgs.splice(+b.dataset.i, 1); renderWorkImgs(); }));
  };
  const addWorkImg = (f) => {
    if (!f || !f.type?.startsWith("image/")) return;
    const rd = new FileReader();
    rd.onload = () => { workImgs.push({ media_type: f.type, data: String(rd.result).split(",")[1] }); renderWorkImgs(); };
    rd.readAsDataURL(f);
  };
  $("#w-attach").addEventListener("click", () => $("#w-file").click());
  $("#w-file").addEventListener("change", (e) => { [...e.target.files].forEach(addWorkImg); e.target.value = ""; });
  $("#w-task").addEventListener("paste", (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/"));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((it) => addWorkImg(it.getAsFile()));
  });
  $("#w-task").addEventListener("dragover", (e) => e.preventDefault());
  $("#w-task").addEventListener("drop", (e) => {
    e.preventDefault();
    [...(e.dataTransfer?.files || [])].forEach(addWorkImg);
  });

  $("#w-submit").addEventListener("click", async () => {
    const dir = $("#w-dir").value.trim();
    // 描述可留空：开一个"待命会话"，具体要干啥进会话里再说（bg 模式限定——terminal 没有追问通道）
    const task = $("#w-task").value.trim()
      || (($("#w-bg").checked) ? "你是常驻结对助手。本条只是开场，简短确认待命即可，等我下一条消息再开始干活。" : "");
    if (!dir || !task) { toast(dir ? "terminal 模式必须写任务描述" : "先选项目目录"); return; }
    if (workImgs.length && !$("#w-bg").checked) { toast("terminal 模式不支持图片——勾选「后台运行」"); return; }
    if (workExtraDirs.length && !$("#w-bg").checked) { toast("terminal 模式不支持附加目录——勾选「后台运行」"); return; }
    // 附加目录去重只在「添加时」挡过主目录，之后主目录可能被改成某个附加目录——提交前再滤一次，
    // 别把主目录当附加目录重复下发（后端也会拒，但这里先把用户能改的重复挡掉）。
    const submitExtraDirs = [...new Set(workExtraDirs)].filter((d) => d !== dir);
    $("#w-submit").disabled = true;
    const res = await post("/api/work", {
      dir, task,
      bg: $("#w-bg").checked, provider: $("#w-engine").value || undefined, worktree: $("#w-worktree").checked,
      model: $("#w-model").value || undefined, permission: $("#w-perm").value || undefined,
      extraDirs: submitExtraDirs.length ? submitExtraDirs : undefined,
      images: workImgs.length ? workImgs : undefined,
    });
    $("#w-submit").disabled = false;
    toast(res.msg);
    if (res.ok) {
      closeWork(); $("#w-task").value = ""; workImgs = []; renderWorkImgs();
      await refreshProjectCandidates();
      await Promise.all([refreshTasks(), typeof loadTasksAux === "function" ? loadTasksAux() : Promise.resolve()]);
      switchTab("tasks");
      // 派完直接进会话（而不是停在列表）：追问/旁观零点击开始
      if (res.task?.id && typeof Tasks !== "undefined") Tasks.select(res.task.id);
    }
  });

  document.addEventListener("click", (e) => {
    $$(".topbar-more[open]").forEach((menu) => {
      if (!menu.contains(e.target)) menu.removeAttribute("open");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey) {
      if (e.key === "Escape") {
        $$(".overlay").forEach((o) => (o.dataset.open = "false"));
        $$(".topbar-more[open]").forEach((m) => m.removeAttribute("open"));
      }
      return;
    }
    if (e.key === "n" || e.key === "N") { e.preventDefault(); openWork(); }
    if (e.key === "Escape") {
      $$(".overlay").forEach((o) => (o.dataset.open = "false"));
      $$(".topbar-more[open]").forEach((m) => m.removeAttribute("open"));
    }
    // 新增的 tab 一律追加在末尾：改既有数字等于把用户的肌肉记忆洗掉一次
    const idx = "1234567890".indexOf(e.key);
    if (idx >= 0) switchTab(["today", "feed", "tasks", "chat", "", "system", "roles", "summary", "mail", "pr"][idx]);
  });

  $("#skin-btn").addEventListener("click", (e) => {
    openSkinPicker();
    e.currentTarget.closest("details")?.removeAttribute("open");
  });  // 皮肤系统在 skin.js（首屏预应用在 index.html 内联）
  $("#sys-status").addEventListener("click", () => switchTab("system"));
  $("#hb-pill").addEventListener("click", async () => {
    const r = await post("/api/action", { action: "heartbeat" });
    toast(r.msg || (r.ok ? "已触发" : "失败"));
  });
}

/* ============ 浏览器内目录选择 ============ */
/** 数据来自 /api/fs/dirs（realpath 圈死在 architecture.allowedRoots）。
 *  为什么不弹本机 Finder：远程打开 web 时 osascript 弹窗出现在 daemon 的屏幕上。 */
const DP = { path: null, parent: null, onPick: null };
function openDirPicker(onPick, startPath) {
  DP.onPick = onPick;
  $("#dir-overlay").dataset.open = "true";
  dpLoad(startPath || null, true);
}
async function dpLoad(path, fallbackToRoots) {
  const list = $("#dp-list");
  list.innerHTML = stateBox("载入中…", "loading");
  let r = null;
  try { r = await getJSON(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`); } catch { /* 4xx/断网都走下面的失败分支 */ }
  if (!r || r.ok === false) {
    // 打开时带入的初始路径（手输的 ~/xxx、失效路径）不可用就退回根视图；导航中出错要留在原地报错
    if (fallbackToRoots && path) return dpLoad(null);
    list.innerHTML = stateBox((r && r.msg) || "目录载入失败", "error");
    return;
  }
  DP.path = r.path; DP.parent = r.parent;
  $("#dp-path").textContent = r.path || "授权根目录";
  $("#dp-up").disabled = r.path === null;
  $("#dp-select").disabled = r.path === null;
  list.innerHTML = (r.entries.length
    ? r.entries.map((e) => `<div class="pal-item" style="cursor:pointer" onclick="dpLoad('${jsq(e.path)}')">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📁 ${esc(e.name)}${e.git ? ` <span class="tag mono">git</span>` : ""}</span>
        <button class="button sm ghost" type="button" onclick="event.stopPropagation();dpPick('${jsq(e.path)}')">选择</button>
      </div>`).join("")
    : stateBox("没有子目录——用下面的「选择此目录」"))
    + (r.truncated ? `<div class="pal-empty">目录太多只显示前 300 个，继续下钻或手输路径</div>` : "");
}
function dpPick(path) { const f = DP.onPick; dpClose(); f?.(path); }
function dpClose() { $("#dir-overlay").dataset.open = "false"; DP.onPick = null; }
function bindDirPicker() {
  const dirOverlay = $("#dir-overlay");
  // 始终放到 body 最后，避免与派任务/追加目录弹窗处于同一层叠上下文时被后创建的弹窗盖住。
  document.body.append(dirOverlay);
  $("#dp-cancel").addEventListener("click", dpClose);
  dirOverlay.addEventListener("click", (e) => { if (e.target === dirOverlay) dpClose(); });
  $("#dp-up").addEventListener("click", () => dpLoad(DP.parent));  // parent=null 即回根视图
  $("#dp-select").addEventListener("click", () => { if (DP.path) dpPick(DP.path); });
}

/* ============ ⌘K 全局搜索/命令面板 ============ */
/** 主仓 SwiftUI 有 CommandPalette（跨域模糊搜 + 快捷动作），网页化时掉了。
 *  精简版：tab 跳转 + 快捷动作 + 任务/对话两个域的标题搜索；选中即跳。 */
const PAL = { items: [], filtered: [], sel: 0, open: false };
function palStatic() {
  const tabs = [["today", "今日"], ["tasks", "任务"], ["chat", "对话"], ["summary", "每日总结"], ["lark", "飞书"], ["mail", "邮件"], ["pr", "PR"], ["roles", "角色"], ["notes", "笔记"], ["feed", "通知流"], ["system", "系统"], ["settings", "设置"]].filter(([id]) => !tabHidden(id));
  return [
    ...tabs.map(([id, n]) => ({ label: `去 · ${n}`, hint: "tab", go: () => switchTab(id) })),
    { label: "派新任务", hint: "动作", go: () => window.openWork?.() },
    { label: "立即分流", hint: "动作", go: async () => toast((await post("/api/action", { action: "triage" })).msg || "已触发") },
    { label: "立即心跳", hint: "动作", go: async () => toast((await post("/api/action", { action: "heartbeat" })).msg || "已触发") },
    { label: "更换皮肤", hint: "动作", go: () => typeof openSkinPicker === "function" && openSkinPicker() },
  ];
}
async function palOpen() {
  PAL.open = true;
  $("#palette-overlay").dataset.open = "true";
  const input = $("#pal-input");
  input.value = ""; PAL.sel = 0;
  PAL.items = [
    ...palStatic(),
    ...S.tasks.map((t) => ({ label: `任务 · ${t.title || t.task.split("\n")[0].slice(0, 50)}`, hint: t.project || "", go: () => { switchTab("tasks"); if (typeof Tasks !== "undefined") Tasks.select(t.id); } })),
  ];
  palRender();
  input.focus();
  // 对话异步补进来（面板已可用，不等网络）
  const chats = await getJSON("/api/chat/list").catch(() => []);
  if (!PAL.open) return;
  PAL.items.push(
    ...(chats || []).slice(0, 60).map((c) => ({ label: `对话 · ${c.title || c.id}`, hint: c.provider || "", go: () => { switchTab("chat"); if (typeof openChat === "function") openChat(c.id); } })),
  );
  palRender();
}
function palClose() { PAL.open = false; $("#palette-overlay").dataset.open = "false"; }
function palRender() {
  const q = $("#pal-input").value.trim().toLowerCase();
  PAL.filtered = (q ? PAL.items.filter((x) => (x.label + " " + x.hint).toLowerCase().includes(q)) : PAL.items)
    .slice(0, 20);
  PAL.sel = Math.max(0, Math.min(PAL.sel, PAL.filtered.length - 1));
  $("#pal-list").innerHTML = PAL.filtered.length
    ? PAL.filtered.map((x, i) => `<button type="button" class="pal-item" data-i="${i}" data-on="${i === PAL.sel}"><span>${esc(x.label)}</span><span class="hint">${esc(x.hint)}</span></button>`).join("")
    : `<div class="pal-empty">没有匹配项</div>`;
  $("#pal-list [data-on=\"true\"]")?.scrollIntoView({ block: "nearest" });
}
function palGo(i) {
  const item = PAL.filtered[i];
  if (!item) return;
  palClose();
  item.go();
}
function bindPalette() {
  const overlay = $("#palette-overlay"), input = $("#pal-input");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) palClose(); });
  input.addEventListener("input", () => { PAL.sel = 0; palRender(); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); PAL.sel = Math.min(PAL.sel + 1, PAL.filtered.length - 1); palRender(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); PAL.sel = Math.max(PAL.sel - 1, 0); palRender(); }
    else if (e.key === "Enter") { e.preventDefault(); palGo(PAL.sel); }
    else if (e.key === "Escape") { e.preventDefault(); palClose(); }
  });
  $("#pal-list").addEventListener("mousedown", (e) => {
    const b = e.target.closest(".pal-item");
    if (b) { e.preventDefault(); palGo(+b.dataset.i); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); PAL.open ? palClose() : palOpen(); }
  });
}

/* ============ 初始化 ============ */
async function refreshTasks() {
  const seq = S.tasksSeq || 0;
  let data;
  try {
    data = await getJSON("/api/tasks");
  } catch {
    if (typeof Tasks !== "undefined") Tasks.tasksError = "任务列表暂时无法载入";
    TABS._onTasks?.();
    return;
  }
  // 定时轮询的响应是发请求那一刻的快照；若这期间 SSE 已推过更新的任务列表(seq 变了)，
  // 别拿过时快照盖回去——否则任务状态会闪回旧值，直到下一次 SSE/轮询才自愈
  if ((S.tasksSeq || 0) !== seq) return;
  S.tasks = data;
  if (typeof Tasks !== "undefined") Tasks.tasksError = "";
  renderTopbar();
  TABS._onTasks?.();
}
async function appInit() {
  bindTopbar();
  bindPalette();
  bindDirPicker();
  applyTabVisibility();  // 隐藏时先把各 tab 入口藏掉（渲染层过滤，不动 HTML）
  let feedFailed = false, tasksFailed = false;
  const [feed, tasks, state, projects] = await Promise.all([
    getJSON("/api/feed?limit=150").catch(() => (feedFailed = true, [])),
    getJSON("/api/tasks").catch(() => (tasksFailed = true, [])),
    getJSON("/api/state").catch(() => null),
    getJSON("/api/projects").catch(() => []),
  ]);
  S.feed = feed.reverse(); S.feedError = feedFailed ? "通知流暂时无法载入" : ""; S.tasks = tasks; S.state = state; S.projects = projects;
  if (typeof Tasks !== "undefined") Tasks.tasksError = tasksFailed ? "任务列表暂时无法载入" : "";
  renderTopbar();
  if (tabHidden(S.tab)) S.tab = "today";  // 上次停在已隐藏的 tab：回今日，别落空
  switchTab(S.tab in TABS ? S.tab : "today");
  connectSSE();
  setInterval(refreshTasks, 30000);
}
