"use strict";
/* ownward web workbench — 核心：状态、SSE、tab 路由、通知流。各 tab 在 today/tasks/chat/notes/system.js */

/* ============ 工具 ============ */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** 内联 onclick 的字符串参数编码：反斜杠/引号/换行都要处理——esc() 只管 HTML，
 *  标题/路径里一个尾部反斜杠就能改写 JS 字符串边界（codex 对抗审查实证过） */
const jsq = (s) => esc(String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\n\r\u2028\u2029]/g, " "));
// 派发与会话重配共用同一份能力表。这里是离线兜底的内置快照（2026-09-05）；页面载入后由
// /api/providers/catalog 覆盖——Codex 那份来自 CLI 自己的官方模型缓存（~/.codex/models_cache.json），
// 新型号（gpt-6-astra）上线不用再改前端。efforts 必须与 Runner provider protocol 的白名单一致，
// 不能把某家 CLI 不认识的档位画进下拉框后再寄希望于后端兜底。
const WORK_PROVIDER_CAPABILITIES_BUILTIN = Object.freeze({
  claude: Object.freeze({
    label: "Claude Code",
    models: Object.freeze(["fable", "opus", "sonnet", "haiku"]),
    efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    defaultModel: "", handoffModel: "sonnet", handoffEffort: "medium",
  }),
  codex: Object.freeze({
    label: "Codex",
    models: Object.freeze(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"]),
    defaultModel: "gpt-5.6-sol", handoffModel: "gpt-5.6-sol", handoffEffort: "medium",
  }),
  codebuddy: Object.freeze({
    label: "CodeBuddy",
    // 2026-09-05 `codebuddy --help` 的 Currently supported 列表；服务端会用实时解析结果覆盖
    models: Object.freeze(["hy3", "hy3-x", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3-pay", "minimax-m2.7", "kimi-k3-2", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash"]),
    // CodeBuddy 复用 Claude provider protocol，不能暴露 Codex-only 档位；但它比 claude 多一档 minimal
    efforts: Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]),
    defaultModel: "", handoffModel: "hy3", handoffEffort: "medium",
  }),
});
const WORK_CODEX_MODEL_EFFORTS_BUILTIN = Object.freeze({
  "gpt-6-astra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-sol": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-terra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-luna": Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  "gpt-5.5": Object.freeze(["low", "medium", "high", "xhigh"]),
  "gpt-5.3-codex-spark": Object.freeze(["low", "medium", "high", "xhigh"]),
});
let WORK_PROVIDER_CAPABILITIES = WORK_PROVIDER_CAPABILITIES_BUILTIN;
let WORK_CODEX_MODEL_EFFORTS = WORK_CODEX_MODEL_EFFORTS_BUILTIN;
let WORK_CODEX_MODEL_INFO = Object.freeze({});   // slug → {displayName, defaultEffort, fast}，只有官方缓存才带
let WORK_PROVIDER_CATALOG_SOURCE = "builtin";     // builtin | official-cache（Codex 目录来源，设置页/弹窗提示用）
const WORK_EFFORT_LABELS = Object.freeze({ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", ultra: "ultra" });
/** 服务端目录到达后整体替换查表。形状不对就整份不用——宁可继续用旧表，也不画出半份目录 */
function applyProviderCatalog(catalog) {
  const strings = (list) => Array.isArray(list) && list.length > 0 && list.every((x) => typeof x === "string" && x);
  if (!catalog || typeof catalog !== "object" || !catalog.codex || !Array.isArray(catalog.codex.models)) return false;
  const models = catalog.codex.models.filter((m) => m && typeof m.slug === "string" && m.slug && Array.isArray(m.efforts) && m.efforts.every((x) => typeof x === "string" && x));
  if (!models.length) return false;
  const caps = { ...WORK_PROVIDER_CAPABILITIES_BUILTIN };
  // CLI 自己配置的默认型号/档位（只用于把「默认」标清楚）；形状不对就当没有，别画出半截文案
  const cliDefault = (v) => Object.freeze(Object.fromEntries(["model", "effort"].filter((k) => typeof v?.[k] === "string" && v[k]).map((k) => [k, v[k]])));
  for (const id of ["claude", "codebuddy"]) {
    const c = catalog[id];
    if (c && strings(c.models) && strings(c.efforts)) caps[id] = Object.freeze({ ...WORK_PROVIDER_CAPABILITIES_BUILTIN[id], models: Object.freeze([...c.models]), efforts: Object.freeze([...c.efforts]), cliDefault: cliDefault(c.cliDefault) });
  }
  const defaultModel = typeof catalog.codex.defaultModel === "string" && catalog.codex.defaultModel ? catalog.codex.defaultModel : WORK_PROVIDER_CAPABILITIES_BUILTIN.codex.defaultModel;
  caps.codex = Object.freeze({ ...WORK_PROVIDER_CAPABILITIES_BUILTIN.codex, models: Object.freeze(models.map((m) => m.slug)), defaultModel, handoffModel: defaultModel, cliDefault: cliDefault(catalog.codex.cliDefault) });
  WORK_PROVIDER_CAPABILITIES = Object.freeze(caps);
  WORK_CODEX_MODEL_EFFORTS = Object.freeze(Object.fromEntries(models.map((m) => [m.slug, Object.freeze([...m.efforts])])));
  WORK_CODEX_MODEL_INFO = Object.freeze(Object.fromEntries(models.map((m) => [m.slug, Object.freeze({ displayName: m.displayName || m.slug, defaultEffort: m.defaultEffort || "", fast: m.fast || null })])));
  WORK_PROVIDER_CATALOG_SOURCE = catalog.codex.source || "server";
  // 被关掉的引擎从下拉里摘掉：留着只会让人选中后拿到 PROVIDER_MISSING
  if (catalog.enabled && typeof catalog.enabled === "object") WORK_PROVIDER_ENABLED = Object.freeze({ ...catalog.enabled });
  return true;
}
/** 默认全开：catalog 还没回来之前不该先把引擎藏掉（宁可多列，也别让人以为引擎没了） */
let WORK_PROVIDER_ENABLED = Object.freeze({ claude: true, codex: true, codebuddy: true });
function workProviderEnabled(providerId) { return WORK_PROVIDER_ENABLED[providerId] !== false; }
async function refreshProviderCatalog() {
  const catalog = await getJSON("/api/providers/catalog").catch(() => null);
  return applyProviderCatalog(catalog);
}
function workProviderCapability(providerId) { return WORK_PROVIDER_CAPABILITIES[providerId] || WORK_PROVIDER_CAPABILITIES.claude; }
function workProviderEfforts(providerId, model) {
  const capability = workProviderCapability(providerId);
  return providerId === "codex" ? (WORK_CODEX_MODEL_EFFORTS[model || capability.defaultModel] || []) : capability.efforts;
}
function workProviderDefaultEffort(providerId, model) {
  const efforts = workProviderEfforts(providerId, model);
  return efforts.includes("medium") ? "medium" : efforts[0] || "";
}
/** 派发弹窗的型号/思考深度选中项与「默认」文案（纯函数，web/provider-catalog.test.ts 直接求值）。
 *  「默认」= 不传参数，交给 CLI 自己的配置（Codex 读 ~/.codex/config.toml，Claude 读 settings.json），文案里标出它会落到哪。
 *  切到 Codex 不再替人选死某个型号：2026-09-22 之前一律选 gpt-5.6-sol，config.toml 里配的 gpt-6-astra 从没被派发用上。
 *  current 是下拉框当前值（切引擎时沿用），selection 是调用方显式要的（打开弹窗时的 dispatch.defaults） */
function workDialogChoice(providerId, selection = {}, current = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(selection, k);
  const capability = workProviderCapability(providerId), cli = capability.cliDefault || {};
  const requestedModel = selection.model ?? current.model ?? "";
  const explicitModel = has("model") && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(requestedModel);
  const model = capability.models.includes(requestedModel) || explicitModel ? requestedModel : "";
  const customModel = explicitModel && !capability.models.includes(requestedModel) ? [requestedModel] : [];
  const efforts = workProviderEfforts(providerId, model);
  const requestedEffort = selection.effort ?? current.effort ?? "";
  // 显式选了型号、而 CLI 配的档位它不支持（配的 ultra、选的 gpt-5.5）：不能留「默认」，CLI 收到不认识的档位直接报错
  const cliEffortFits = !cli.effort || efforts.includes(cli.effort);
  const effort = efforts.includes(requestedEffort) ? requestedEffort
    : !model || (!requestedEffort && cliEffortFits) || (has("effort") && !requestedEffort) ? ""
    : workProviderDefaultEffort(providerId, model);
  const defaultModel = cli.model || (providerId === "codex" ? capability.defaultModel : "");
  const defaultEffort = !cliEffortFits ? ""
    : cli.effort || (providerId === "codex" ? (WORK_CODEX_MODEL_INFO[model || capability.defaultModel]?.defaultEffort || "") : "");
  return {
    model, customModel, efforts, effort,
    modelLabel: defaultModel ? `默认（${defaultModel}）` : "默认",
    effortLabel: defaultEffort ? `默认（${WORK_EFFORT_LABELS[defaultEffort] || defaultEffort}）` : "默认",
  };
}
/** 只配了默认模型没配默认引擎时（dispatch.defaults.model="opus"、provider 留空），按模型反查它属于哪家 */
function workProviderForModel(model) {
  return Object.keys(WORK_PROVIDER_CAPABILITIES).find((providerId) => WORK_PROVIDER_CAPABILITIES[providerId].models.includes(model)) || "";
}
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
    const links = [];  // 护住已组装的 <a>，免得裸链接规则再把 href 里的 URL 包一层
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `\u0001${links.push(`<a href="${u}" target="_blank" rel="noopener">${t}</a>`) - 1}\u0001`);
    // 裸链接：中文里 URL 常紧跟全角标点，遇到全角字符或转义后的 <>" 就截断；句尾的半角标点不算进链接。
    // 私用区（\ue000-\uf8ff）也截断：笔记阅读视图拿它给双链/图片占位，被吞进 href 就拼坏了
    s = s.replace(/https?:\/\/(?:(?!&(?:lt|gt|quot);)[^\s<>\u0000\u0001\u3000-\u303f\uff00-\uffef\ue000-\uf8ff])+/g, (u) => {
      const tail = u.match(/[.,;:!?)\]'*]+$/)?.[0] || "";
      u = u.slice(0, u.length - tail.length);
      return `\u0001${links.push(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`) - 1}\u0001${tail}`;
    });
    s = s.replace(/\u0001(\d+)\u0001/g, (_, n) => links[+n]);
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
const hhmm = (iso) => new Date(iso).toLocaleTimeString(globalThis.I18N?.locale || "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
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
  // showModal() 的 <dialog> 在浏览器 top layer，z-index 再大也盖不过它——恢复流程里的报错
  // 因此整条被弹窗挡住，用户只看到「点了没反应」。popover 同样进 top layer 且不抢焦点。
  try { t.hidePopover?.(); t.showPopover?.(); } catch { /* 不支持 popover 就退回普通层 */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.dataset.show = "false"; try { t.hidePopover?.(); } catch {} }, 2600);
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
  { name: "model", desc: "同引擎就地换模型（不接力）：/model opus" },
  { name: "effort", desc: "同引擎就地换思考深度：/effort high" },
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
      document.title = appTitle();
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
    if (document.hidden) document.title = appTitle(`(${S.buffered.length}) `);
  } else {
    renderFeed(1);
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = appTitle(); });

/* 人正盯着工作台时，横幅和飞书都是重复打扰：聚焦状态下每 30s 上报一次，
   daemon 据此把通知降级成只进 feed（src/presence.ts）。失焦就不报，到点自然过期。
   还要真有人在操作：窗口开着没人管（锁屏、去开会）不算在场，否则「人不在电脑前」的飞书兜底就失效了。 */
const PRESENCE_IDLE_MS = 10 * 60 * 1000;
let lastInteractionAt = Date.now();
for (const ev of ["pointerdown", "keydown", "wheel", "pointermove"])
  addEventListener(ev, () => (lastInteractionAt = Date.now()), { passive: true });
function pingPresence() {
  if (document.hasFocus() && !document.hidden && Date.now() - lastInteractionAt < PRESENCE_IDLE_MS)
    post("/api/presence", { client: "web" });
}
pingPresence();
setInterval(pingPresence, 30000);
addEventListener("focus", pingPresence);
document.addEventListener("visibilitychange", pingPresence);

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
  // 重连 = daemon 刚起来过，扩展的启停正是在那时生效：顺手把扩展入口重新拉一次，
  // 否则关掉的扩展会一直挂在导航上（界面不许显示一个已经不存在的东西）
  es.addEventListener("open", () => { setLive(true, "LIVE"); S.retries = 0; window.VerticalNav?.loadNavigation?.(); });
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
/** 页面标题：预发布实例一律带前缀（未读数等前缀放在最前） */
function appTitle(prefix = "") { return `${prefix}${S.state?.staging ? "[预发布] " : ""}Ownward`; }
function renderTopbar() {
  if (!S.state) return;
  // 预发布实例（../dev，端口 4519）挂醒目标记：配置和生产一样、派的任务也是真跑，别当成生产在用
  const staging = S.state.staging === true;
  $("#staging-badge").hidden = !staging;
  if (staging && !document.title.includes("[预发布]")) document.title = appTitle();
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
  // 「最近目录」两条路都给：datalist 供手输补全；chip 行永远可见可点。
  // 只有 datalist 时，目录框一旦预填了默认目录（dispatch.defaults.dir），浏览器按当前值做子串
  // 过滤，别的目录一条都不冒出来——用户看到的就是「历史记录丢了」。
  const renderRecentDirs = () => {
    const wrap = $("#w-dir-recent"); if (!wrap) return;
    const dirs = S.projects.slice(0, 12);
    wrap.hidden = !dirs.length;
    wrap.innerHTML = dirs.map((p) => `<button type="button" class="dir-chip" data-dir="${esc(p.dir)}" title="${esc(p.dir)}"><span>${esc(p.name || p.dir)}</span></button>`).join("");
    $$("#w-dir-recent button").forEach((b) => b.addEventListener("click", () => { $("#w-dir").value = b.dataset.dir; $("#w-task").focus(); }));
  };
  const paintProjectCandidates = () => {
    const options = S.projects.map((p) => `<option value="${esc(p.dir)}">`).join("");
    $("#w-dir-list").innerHTML = options;
    $("#add-dir-list").innerHTML = options;
    renderRecentDirs();
  };
  let projectsSeq = 0;  // 打开弹窗的后台刷新与「追加目录」后的刷新可能交错，只认最后一次发出的结果
  const refreshProjectCandidates = async () => {
    const seq = ++projectsSeq;
    const fresh = await getJSON("/api/projects").catch(() => null);
    if (seq !== projectsSeq) return;
    if (fresh) S.projects = fresh;
    paintProjectCandidates();
  };
  // 目录一变就重新匹配角色；真正的实现在下面的角色段里赋值（先占位，免得 const 暂时性死区）
  let onWorkDirsChanged = () => {};
  const renderWorkExtraDirs = () => {
    onWorkDirsChanged();
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

  // ---- 谁来接（role-auto.ts）：缺省自动匹配项目 Owner（没有就在派发时建）；跨了几个项目时问一句；
  //      主目录不是仓库时按任务描述匹配领域角色，拿不准就列候选让人手选 ----
  let workRoles = [];                // /api/roles 的角色（每次开弹窗重拉：角色页刚建/刚归档的要立刻反映）
  let workPreview = null;            // /api/roles/resolve 最近一次结果：「自动」会落到谁、是不是跨项目
  let workPreviewTask = "";          // 上面那次预览用的任务描述（按描述匹配时，描述改了预览就过期了）
  let workPreviewDirs = "";          // 上面那次预览对应的目录组合（主目录 + 附加目录）：目录改了预览也过期
  let workPendingRetries = 0;        // 模型还在判断（pending）时自动再问的次数，换描述/目录清零
  /** 当前要派的目录组合，与预览请求同口径（terminal 模式不带附加目录） */
  const workDirsKey = () => {
    const dir = $("#w-dir").value.trim();
    return JSON.stringify([dir, $("#w-bg").checked ? workExtraDirs.filter((d) => d !== dir) : []]);
  };
  let rolePreviewSeq = 0, rolePreviewTimer = null;
  const crossSkipped = new Set();    // 这次弹窗里点过「不用」的组合，别反复问
  let openWithRole = "";             // openWorkForRole 点名的角色：openWork 读一次就清
  const workRoleKind = (r) => r.origin === "domain" ? "领域角色" : r.type === "project" ? (r.origin === "auto" ? "项目 Owner" : "项目专家") : (r.origin === "auto" ? "跨项目角色" : "职能负责人");
  const WORK_PICK_MSG = "拿不准由哪个领域角色接，先在「角色」里选一个（或选「不用角色」）";
  const WORK_MATCHING_MSG = "正在按新的任务描述匹配角色，稍等一下再派";
  const WORK_DIR_MATCHING_MSG = "正在匹配这个目录的角色，稍等一下再派";
  /** 提交时 role 键的最终值（与手机端 roleSubmit 同口径）：按描述匹配上的就点名发过去——预览给人看的是谁，
   *  派出去就是谁（服务端重判可能因描述多了附件、模型超时而落到别处）；描述改了还没重新匹配完、或拿不准，就先拦下 */
  const workRoleSubmit = (task) => {
    const choice = $("#w-role").value || "auto";
    if (choice !== "auto") return { role: choice };
    // 目录刚改、预览还没跟上：上一个目录的预览（比如按描述匹配到的工作领域角色）不能拿来点名
    if (workPreviewDirs !== workDirsKey()) return { block: WORK_DIR_MATCHING_MSG };
    if (workPreview?.auto?.by !== "task" || !task) return { role: choice };
    if (workPreviewTask !== task) return { block: WORK_MATCHING_MSG };
    if (workPreview.auto.candidates?.length) return { block: WORK_PICK_MSG };
    return { role: workPreview.auto.roleId || "auto" };
  };
  /** 「自动」拿不准、要人手选的候选（只在选择还是「自动」时算数：人已经点了一个，就不用再问） */
  const workPickCandidates = () => ($("#w-role").value === "auto" && workPreview?.auto?.candidates?.length ? workPreview.auto.candidates : []);
  const fillWorkRoles = (keep) => {
    const sel = $("#w-role");
    const cur = keep ?? sel.value ?? "auto";
    const usable = workRoles.filter((r) => r.status !== "archived" && !r.conflict);
    const group = (label, list) => list.length
      ? `<optgroup label="${esc(label)}">${list.map((r) => `<option value="${esc(r.id)}">${esc(r.name || r.id)}</option>`).join("")}</optgroup>` : "";
    sel.innerHTML = `<option value="auto">自动匹配（推荐）</option>`
      + group("项目 Owner", usable.filter((r) => r.type === "project" && r.origin !== "domain"))
      + group("领域角色", usable.filter((r) => r.origin === "domain"))
      + group("跨项目角色", usable.filter((r) => r.type !== "project"))
      + `<option value="none">不用角色</option>`;
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "auto";
  };
  const loadWorkRoles = async (keep) => {
    const r = await getJSON("/api/roles").catch(() => null);
    if (r?.ok) workRoles = r.roles || [];
    fillWorkRoles(keep);
  };
  const renderWorkRoleHint = () => {
    const hint = $("#w-role-hint"), box = $("#w-role-cross");
    const choice = $("#w-role").value, p = workPreview;
    let text = "", tone = "";
    if (choice === "none") text = "不带角色记忆，agent 从零了解项目";
    else if (choice !== "auto") {
      const r = workRoles.find((x) => x.id === choice);
      text = r ? `由「${r.name || r.id}」接手 · ${workRoleKind(r)}` : "这个角色读不到了，刷新一下";
    } else if (!p) text = $("#w-dir").value.trim() ? "正在匹配…" : "选好目录后自动匹配这个项目的 Owner";
    else if (p.auto.roleId && p.auto.by === "task") text = `由「${p.auto.name}」接手 · 按任务描述匹配${p.auto.why ? `（${p.auto.why}）` : ""}`;
    else if (p.auto.roleId) text = `由「${p.auto.name}」接手`;
    else if (p.auto.willCreate) { text = `将自动生成「${p.auto.name}」接手——这个项目还没有 Owner`; tone = "new"; }
    else if (p.auto.candidates?.length) { text = p.auto.reason || "拿不准由哪个领域角色接，手选一个"; tone = "warn"; }
    else text = p.auto.reason || "这次不带角色";
    hint.textContent = text;
    hint.dataset.tone = tone;
    // 拿不准：候选一字排开，点一个就由它接；「不用角色」也给一个出口
    const pick = $("#w-role-pick"), cands = workPickCandidates();
    pick.hidden = !cands.length;
    pick.innerHTML = cands.length
      ? cands.map((c) => `<button type="button" class="button secondary sm" data-pick="${esc(c.id)}">${esc(c.name || c.id)}</button>`).join("")
        + `<button type="button" class="button ghost sm" data-pick="none">不用角色</button>` : "";
    pick.querySelectorAll("button[data-pick]").forEach((b) => b.addEventListener("click", () => chooseWorkRole(b.dataset.pick)));
    // 跨项目只在「自动」时问：用户已经点名了某个角色，就别再劝他换
    const c = p?.cross, key = c ? c.slugs.join("+") : "";
    if (choice !== "auto" || !c || crossSkipped.has(key)) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = c.possible
      ? `<div>这次任务跨了 ${c.labels.length} 个项目（${esc(c.labels.join("、"))}），还没有角色同时管它们。要建一个能同时读这几个项目记忆的角色来接吗？</div>
         <div class="row"><button type="button" class="button secondary sm" id="w-cross-create">建「${esc(c.name)}」并由它接手</button>
         <button type="button" class="button ghost sm" id="w-cross-skip">不用，只带主项目的</button></div>`
      : `<div class="quiet">${esc(c.reason)}，这次只带主项目的记忆</div>`;
    $("#w-cross-create")?.addEventListener("click", createWorkCrossRole);
    $("#w-cross-skip")?.addEventListener("click", () => { crossSkipped.add(key); renderWorkRoleHint(); });
  };
  const refreshRolePreview = (delay = 0) => {
    clearTimeout(rolePreviewTimer);
    rolePreviewTimer = setTimeout(async () => {
      if (overlay.dataset.open !== "true") return;   // 关弹窗时清附加目录也会触发到这里，没人看就不问了
      const dir = $("#w-dir").value.trim(), seq = ++rolePreviewSeq;
      if (!dir) { workPreview = null; renderWorkRoleHint(); return; }
      // 还没有任何预览（刚打开）：先说「正在匹配…」——按描述匹配要问模型，几秒钟里提示行不能是空的
      if (!workPreview) renderWorkRoleHint();
      const extraDirs = $("#w-bg").checked ? workExtraDirs.filter((d) => d !== dir) : [];
      // 任务描述总带上：主目录不是仓库时服务端按它匹配领域角色（是仓库就忽略）
      const taskText = $("#w-task").value.trim(), dirsKey = JSON.stringify([dir, extraDirs]);
      if (taskText !== workPreviewTask || dirsKey !== workPreviewDirs) workPendingRetries = 0;
      const r = await post("/api/roles/resolve", { dir, extraDirs, task: taskText });
      if (seq !== rolePreviewSeq) return;   // 用户又改了目录：只认最后一次
      workPreview = r?.ok ? r : null;
      workPreviewTask = taskText;
      workPreviewDirs = dirsKey;
      // 模型这会儿还没判完（服务端预览只等十来秒）：过几秒再问一次，判完了提示行会更新；最多问三次，别一直烧模型
      if (r?.auto?.pending && workPendingRetries < 3) { workPendingRetries++; refreshRolePreview(4000); }
      if (!r?.ok) { $("#w-role-hint").textContent = r?.msg || "匹配角色失败"; $("#w-role-hint").dataset.tone = "warn"; $("#w-role-cross").hidden = true; $("#w-role-pick").hidden = true; return; }
      renderWorkRoleHint();
    }, delay);
  };
  onWorkDirsChanged = () => refreshRolePreview(250);
  // 最近目录 chip 改的是 value（不触发 input 事件）：在容器上冒泡接一下，chip 自己的点击先把值填好
  $("#w-dir-recent")?.addEventListener("click", (e) => { if (e.target.closest("button")) onWorkDirsChanged(); });
  const createWorkCrossRole = async () => {
    const c = workPreview?.cross;
    if (!c) return;
    const btn = $("#w-cross-create");
    if (btn) btn.disabled = true;
    const r = await post("/api/roles/cross", { dirs: c.dirs });
    toast(r.msg || (r.ok ? "已建角色" : "没建成"));
    if (!r.ok) { if (btn) btn.disabled = false; return; }
    await loadWorkRoles(r.role.id);
    refreshRolePreview();
  };
  /** 点名一个角色：它登记了工作目录就替人填好（第一个当主目录，其余当附加目录）——派给角色，不用再找目录。
   *  领域角色不绑目录（登记的一般就是 ~/workspace）：主目录已经填了就别改；角色页「派任务给它」进来时 force */
  const applyRoleDirs = (role, force = false) => {
    const dirs = (role?.dirs || []).filter(Boolean);
    if (!dirs.length) return;
    if (role.origin === "domain" && !force && $("#w-dir").value.trim()) return;
    $("#w-dir").value = dirs[0];
    if ($("#w-bg").checked) { workExtraDirs = dirs.slice(1); renderWorkExtraDirs(); }
    else if (dirs.length > 1) toast("terminal 模式不支持附加目录，只填了主目录");
    onWorkDirsChanged();
  };
  const chooseWorkRole = (v) => {
    $("#w-role").value = v;
    if (v !== "auto" && v !== "none") applyRoleDirs(workRoles.find((r) => r.id === v));
    renderWorkRoleHint();
  };
  $("#w-role").addEventListener("change", () => chooseWorkRole($("#w-role").value));
  // 按描述匹配时，描述改了要重新匹配（服务端会调一次模型：防抖放长一点，别每敲一个字问一次）
  $("#w-task").addEventListener("input", () => { if (workPreview?.auto?.by === "task") refreshRolePreview(800); });
  $("#w-dir").addEventListener("input", () => refreshRolePreview(500));
  $("#w-dir").addEventListener("change", () => refreshRolePreview());
  const syncWorkMode = () => {
    const enabled = $("#w-bg").checked;
    $("#w-extra-browse").disabled = !enabled;
    $("#w-extra-disabled").hidden = enabled;
    if (!enabled && workExtraDirs.length) { workExtraDirs = []; renderWorkExtraDirs(); toast("terminal 模式已清除附加目录"); }
  };
  const fillWorkProviderOptions = (selection = {}) => {
    // 先按 catalog 的 enabled 收拾下拉本身，再谈型号：被关掉的引擎不列，
    // 当前选中的那个若正好被关掉，落回第一个还开着的（否则停在一个必然报错的选项上）
    const engineSelect = $("#w-engine");
    for (const option of engineSelect.options) option.hidden = !workProviderEnabled(option.value);
    if (!workProviderEnabled(engineSelect.value)) {
      const first = [...engineSelect.options].find((o) => !o.hidden);
      if (first) engineSelect.value = first.value;
    }
    const providerId = engineSelect.value;
    const capability = workProviderCapability(providerId);
    const c = workDialogChoice(providerId, selection, { model: $("#w-model").value, effort: $("#w-effort").value });
    $("#w-model").innerHTML = `<option value="">${esc(c.modelLabel)}</option>` + [...c.customModel, ...capability.models].map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join("");
    $("#w-model").value = c.model;
    $("#w-effort").innerHTML = `<option value="">${esc(c.effortLabel)}</option>` + c.efforts.map((item) => `<option value="${esc(item)}">${esc(WORK_EFFORT_LABELS[item] || item)}</option>`).join("");
    $("#w-effort").value = c.effort;
  };
  const openWork = (dir) => {
    overlay.dataset.open = "true";
    // 角色：新开（描述为空）回到「自动」；角色页点「派任务给它」走 openWorkForRole，点名角色并按它登记的目录填好
    const freshOpen = !$("#w-task").value, wantRole = openWithRole;
    openWithRole = "";
    crossSkipped.clear();
    workPreview = null; workPreviewTask = ""; workPreviewDirs = ""; workPendingRetries = 0;
    loadWorkRoles(wantRole || (freshOpen ? "auto" : $("#w-role").value)).then(() => {
      if (wantRole) {
        const role = workRoles.find((r) => r.id === wantRole);
        if (role) applyRoleDirs(role, true); else toast("这个角色读不到了（可能刚被归档）");
      }
      refreshRolePreview();
    });
    // 默认值由服务端下发（config dispatch.defaults）：目录/引擎/模型/思考深度/权限预填好，
    // 描述可留空直接派——开一个"待命会话"再慢慢说要干啥
    const d = S.state?.dispatchDefaults || {};
    if (dir) $("#w-dir").value = dir;
    else if (!$("#w-dir").value && d.dir) $("#w-dir").value = d.dir;
    if (!$("#w-task").value) {
      // 引擎和模型/思考深度必须一起回到默认值。弹窗的 <select> 在派发后不清空，上一次选的 codex 会留到
      // 下一次打开；这时只把模型重置成默认的 opus，就画出「codex + opus」这种服务端必拒的组合
      // （2026-09-05 实撞：defaults 只配了 model 没配 provider）。默认引擎没配就按默认模型反查，再不行落 claude。
      $("#w-engine").value = d.provider
        || (d.codex !== undefined ? (d.codex ? "codex" : "claude") : "")
        || workProviderForModel(d.model || "")
        || "claude";
      fillWorkProviderOptions({ model: d.model || "", effort: d.effort || "" });
    } else fillWorkProviderOptions();
    paintProjectCandidates();     // 先用缓存立刻画出来
    refreshProjectCandidates();   // 再后台刷新：刚派过/刚聊过的目录要能立刻出现在最近目录里
    // 模型目录也顺手刷一次：codex CLI 刚更新过缓存（新型号上线）就能立刻出现在下拉框里；
    // 目录没变就不动 DOM，变了按当前选择重画（选中的型号仍有效就保留）
    refreshProviderCatalog().then((changed) => { if (changed && overlay.dataset.open === "true") fillWorkProviderOptions({ model: $("#w-model").value, effort: $("#w-effort").value }); });
    const bypass=$("#w-perm option[value=bypass]");if(bypass){bypass.disabled=S.state?.allowFullAccess!==true;bypass.hidden=S.state?.allowFullAccess!==true;if(bypass.disabled&&$("#w-perm").value==="bypass")$("#w-perm").value="";}
    if (d.permission && !$("#w-perm").value && !(d.permission === "bypass" && S.state?.allowFullAccess !== true)) $("#w-perm").value = d.permission;
    ($("#w-dir").value ? $("#w-task") : $("#w-dir")).focus();
  };
  const closeWork = () => { overlay.dataset.open = "false"; workExtraDirs = []; renderWorkExtraDirs(); };
  window.openWork = openWork;
  window.openWorkForRole = (roleId) => { openWithRole = String(roleId || ""); openWork(); };
  $("#btn-work").addEventListener("click", () => openWork());
  $("#w-cancel").addEventListener("click", closeWork);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeWork(); });

  // 浏览目录：浏览器内弹窗（/api/fs/dirs，圈在授权根内）——旧版弹本机 Finder，
  // 远程打开 web 时弹窗在 daemon 那台机器的屏幕上，这边只会挂死
  $("#w-browse").addEventListener("click", () =>
    openDirPicker((dir) => { $("#w-dir").value = dir; onWorkDirsChanged(); $("#w-task").focus(); }, $("#w-dir").value.trim() || null));
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

  // 模型和思考深度一起随 Provider 切换；没显式选的停在「默认」，由 CLI 自己的配置决定（文案里标出会落到哪）。
  $("#w-engine").addEventListener("change", () => fillWorkProviderOptions());
  $("#w-model").addEventListener("change", () => fillWorkProviderOptions({ model: $("#w-model").value }));
  fillWorkProviderOptions();

  // 派发附图：粘贴/拖入/选文件 → base64 暂存，随 /api/work 发出（派发成功才清，失败留着重试）
  let workImgs = [];   // [{media_type, data(base64), size}]
  const renderWorkImgs = () => {
    $("#w-imgs").innerHTML = workImgs.map((im, i) =>
      `<div class="thumb"><img src="data:${esc(im.media_type)};base64,${im.data}" alt="">
        <button title="移除" data-i="${i}">✕</button></div>`).join("");
    $$("#w-imgs .thumb button").forEach((b) =>
      b.addEventListener("click", () => { workImgs.splice(+b.dataset.i, 1); renderWorkImgs(); }));
  };
  // 走共用流水线（类型判 / HEIC 转码 / 超限压缩）：原图直发会撞 Runner 8MiB blob 上限
  const addWorkImg = async (f) => {
    if (workImgs.length >= COMPOSER_IMG_MAX) { toast(`一条消息最多 ${COMPOSER_IMG_MAX} 张图`); return; }
    const image = await prepareComposerImage(f);
    if (!image) return;
    if (!composerImageFits(workImgs, image.size)) return;   // 张数/合计在 await 之后再判，并发粘贴也不越界
    workImgs.push({ media_type: image.media_type, data: image.data, size: image.size });
    renderWorkImgs();
  };
  // 文件附件（任意类型）：与图片是两条路——图片进消息，文件落盘后由服务端把路径拼进任务正文
  const renderWorkFiles = () => {
    const box = $("#w-files"); if (!box) return;
    box.innerHTML = ComposerFiles.chipsHtml("work");
    bindComposerFileChips(box, "work", renderWorkFiles);
  };
  $("#w-attach").addEventListener("click", () => $("#w-file").click());
  $("#w-file").addEventListener("change", (e) => { [...e.target.files].forEach(addWorkImg); e.target.value = ""; });
  $("#w-attach-file").addEventListener("click", () => $("#w-file-any").click());
  $("#w-file-any").addEventListener("change", async (e) => { const files = [...e.target.files]; e.target.value = ""; await ComposerFiles.add("work", files, renderWorkFiles); });
  $("#w-task").addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((it) => it.type.startsWith("image/"));
    // 粘贴非图片文件（Finder 里 ⌘C 一个 pdf 再粘进来）也收下；纯文本粘贴不受影响
    const files = items.filter((it) => it.kind === "file" && !it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
    if (!imgs.length && !files.length) return;
    e.preventDefault();
    imgs.forEach((it) => addWorkImg(it.getAsFile()));
    if (files.length) void ComposerFiles.add("work", files, renderWorkFiles);
  });
  bindComposerDrop($("#w-task"), { key: "work", onChange: renderWorkFiles, onImage: addWorkImg });

  $("#w-submit").addEventListener("click", async () => {
    const dir = $("#w-dir").value.trim();
    // 描述可留空：开一个"待命会话"，具体要干啥进会话里再说（bg 模式限定——terminal 没有追问通道）
    const task = $("#w-task").value.trim()
      || (($("#w-bg").checked) ? "你是常驻结对助手。本条只是开场，简短确认待命即可，等我下一条消息再开始干活。" : "");
    if (!dir || !task) { toast(dir ? "terminal 模式必须写任务描述" : "先选项目目录"); return; }
    if (workImgs.length && !$("#w-bg").checked) { toast("terminal 模式不支持图片——勾选「后台运行」"); return; }
    if (workExtraDirs.length && !$("#w-bg").checked) { toast("terminal 模式不支持附加目录——勾选「后台运行」"); return; }
    // 「自动」按描述匹配：拿不准先让人选、还在匹配就等一下（派出去服务端也不会替人挑，只会不带角色）
    const roleSubmit = workRoleSubmit($("#w-task").value.trim());
    if (roleSubmit.block) { toast(roleSubmit.block); if (roleSubmit.block !== WORK_PICK_MSG) refreshRolePreview(0); return; }
    const selectedProvider = $("#w-engine").value, selectedModel = $("#w-model").value, selectedEffort = $("#w-effort").value;
    if (selectedEffort && !workProviderEfforts(selectedProvider, selectedModel).includes(selectedEffort)) {
      toast("所选模型不支持这个思考深度，请重新选择"); return;
    }
    // 附加目录去重只在「添加时」挡过主目录，之后主目录可能被改成某个附加目录——提交前再滤一次，
    // 别把主目录当附加目录重复下发（后端也会拒，但这里先把用户能改的重复挡掉）。
    const submitExtraDirs = [...new Set(workExtraDirs)].filter((d) => d !== dir);
    $("#w-submit").disabled = true;
    const res = await post("/api/work", {
      dir, task,
      bg: $("#w-bg").checked, provider: $("#w-engine").value || undefined, worktree: $("#w-worktree").checked,
      model: $("#w-model").value || undefined, effort: $("#w-effort").value || undefined, permission: $("#w-perm").value || undefined,
      extraDirs: submitExtraDirs.length ? submitExtraDirs : undefined,
      images: workImgs.length ? workImgs.map(({ media_type, data }) => ({ media_type, data })) : undefined,
      uploadScope: ComposerFiles.payloadScope("work"),
      role: roleSubmit.role,
    });
    $("#w-submit").disabled = false;
    toast(res.msg);
    if (res.ok) {
      closeWork(); $("#w-task").value = ""; workImgs = []; renderWorkImgs();
      ComposerFiles.clear("work"); renderWorkFiles();   // scope 已交给服务端，本地忘掉，免得下一次派发重复带上
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
    if (idx >= 0) switchTab(["today", "feed", "tasks", "chat", "notes", "system", "roles", "lark", "mail", "pr"][idx]);
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

/* ============ 手机键盘避让：可视视口 → CSS 变量 ============ */
/** 手机浏览器弹键盘时 position:fixed 的弹窗不会跟着缩（iOS Safari 从不缩布局视口，安卓 Chrome
 *  默认 resizes-visual 也不缩），底部被键盘盖住——审草稿这种长文本编辑区尤其明显。
 *  把 visualViewport 的高度/偏移写成 --vv-h / --vv-top，需要贴合可视区的弹窗在 CSS 里取用。 */
function bindVisualViewport() {
  const vv = window.visualViewport; if (!vv) return;
  const root = document.documentElement.style;
  let last = "";
  const sync = () => {
    // scroll 事件在键盘动画/惯性滚动期间每帧都来，值没变就别碰样式（改自定义属性会触发全树重算）
    const h = Math.round(vv.height), top = Math.round(vv.offsetTop), key = `${h}/${top}`;
    if (key === last) return;
    last = key;
    root.setProperty("--vv-h", `${h}px`);
    root.setProperty("--vv-top", `${top}px`);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
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
 *  精简版：tab 跳转 + 快捷动作 + 任务/对话/笔记三个域的标题搜索；选中即跳。 */
const PAL = { items: [], filtered: [], sel: 0, open: false, remote: { q: "", items: [] }, timer: null };
function palStatic() {
  const tabs = [["today", "今日"], ["tasks", "任务"], ["chat", "对话"], ["lark", "飞书"], ["mail", "邮件"], ["pr", "PR"], ["roles", "角色"], ["notes", "笔记"], ["feed", "通知流"], ["system", "系统"], ["settings", "设置"]];
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
  // 对话/笔记异步补进来（面板已可用，不等网络）
  const [chats, notes] = await Promise.all([
    getJSON("/api/chat/list").catch(() => []),
    getJSON("/api/vault/list").catch(() => []),
  ]);
  if (!PAL.open) return;
  PAL.items.push(
    ...(chats || []).slice(0, 60).map((c) => ({ label: `对话 · ${c.title || c.id}`, hint: c.provider || "", go: () => { switchTab("chat"); if (typeof openChat === "function") openChat(c.id); } })),
    ...(notes || []).slice(0, 120).map((n) => { const path = n.path || n; const name = String(path).split("/").pop(); return { label: `笔记 · ${name}`, hint: String(path), go: () => { switchTab("notes"); if (typeof openNoteFile === "function") openNoteFile(path); } }; }),
  );
  palRender();
}
function palClose() { PAL.open = false; PAL.remote = { q: "", items: [] }; clearTimeout(PAL.timer); $("#palette-overlay").dataset.open = "false"; }
/** 全文命中：输入 ≥2 字就查派生索引（/api/search，读库不开会话），结果排在本地标题匹配后面——
 *  归档 / 早已滚出「最近」的会话正文也能搜到。每个任务只留第一条命中，免得一个会话刷满面板。 */
function palSearch(q) {
  clearTimeout(PAL.timer);
  PAL.timer = setTimeout(async () => {
    const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}&limit=30`).catch(() => null);
    if (!PAL.open || $("#pal-input").value.trim().toLowerCase() !== q) return;
    const seen = new Set(), items = [];
    for (const h of r?.hits || []) {
      if (seen.has(h.taskId)) continue; seen.add(h.taskId);
      items.push({ label: `会话 · ${h.project || "?"} · ${String(h.snippet || "").replace(/\s+/g, " ")}`, hint: h.title || h.taskId, go: () => { switchTab("tasks"); if (typeof Tasks !== "undefined") Tasks.select(h.taskId); } });
    }
    PAL.remote = { q, items };
    palRender();
  }, 200);
}
function palRender() {
  const q = $("#pal-input").value.trim().toLowerCase();
  const local = (q ? PAL.items.filter((x) => (x.label + " " + x.hint).toLowerCase().includes(q)) : PAL.items).slice(0, 20);
  if (q.length >= 2 && PAL.remote.q !== q) palSearch(q);
  PAL.filtered = [...local, ...(q.length >= 2 && PAL.remote.q === q ? PAL.remote.items : [])].slice(0, 40);
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
  bindVisualViewport();
  let feedFailed = false, tasksFailed = false;
  const [feed, tasks, state, projects] = await Promise.all([
    getJSON("/api/feed?limit=150").catch(() => (feedFailed = true, [])),
    getJSON("/api/tasks").catch(() => (tasksFailed = true, [])),
    getJSON("/api/state").catch(() => null),
    getJSON("/api/projects").catch(() => []),
    refreshProviderCatalog(),   // Provider 模型目录（Codex 来自官方缓存）；失败就留着内置兜底表
  ]);
  S.feed = feed.reverse(); S.feedError = feedFailed ? "通知流暂时无法载入" : ""; S.tasks = tasks; S.state = state; S.projects = projects;
  if (typeof Tasks !== "undefined") Tasks.tasksError = tasksFailed ? "任务列表暂时无法载入" : "";
  renderTopbar();
  switchTab(S.tab in TABS ? S.tab : "today");
  connectSSE();
  setInterval(refreshTasks, 30000);
}
