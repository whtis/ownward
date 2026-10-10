"use strict";
/* 笔记 tab：vault 浏览 + 阅读/编辑（路径由 daemon 校验锁死 vault 内 .md）
 * 借鉴 SilverBullet / Obsidian / NoteDiscovery：
 * - 记得住：打开就回到上次那篇；「最近打开 / 收藏」存 daemon（手机电脑共用一份），
 *   阅读位置、阅读/编辑模式、没存上的修改留在本机
 * - 边写边存：停手 1.2 秒自动保存，带着读取时的版本去存——磁盘在别处被改过就停下来让人选，不静默覆盖
 * - 找得到：名字即时过滤 + 正文全文搜索；最近打开 / 最近更新 / 收藏常驻在目录树上面
 * - 读得顺：markdown 渲染、[[双链]] 可点、图片、待办能直接勾、frontmatter 收起、大纲、反向链接 */

/* ==== 纯函数（src/web-notes.test.ts 直接求值：这一段不碰 DOM、不读全局状态） ==== */
const NT_FENCE = /^```/;   // 与 mdHtml 同一判据：行首 ```，没闭合就吃到结尾
const NT_TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s|$)/;
const NT_LIST = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const NT_IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

const ntRelOf = (f) => (f.dir ? `${f.dir}/${f.name}` : f.name);

/** 按 \r\n / \n / 老式 Mac 的单独 \r 切行，换行符另存：改完一行再拼回去，文件原来的换行一个不变。
 *  和 ntRender 的归一化（\r\n? → \n）同一口径，序号才对得上 */
function ntLines(text) {
  const parts = String(text ?? "").split(/(\r\n|\r|\n)/);
  const lines = [], seps = [];
  for (let i = 0; i < parts.length; i++) (i % 2 ? seps : lines).push(parts[i]);
  return { lines, seps, join: () => lines.map((l, i) => l + (seps[i] ?? "")).join("") };
}

/** 开头的 YAML frontmatter（和 Obsidian 一样只认第一行就是 ---）。props=null 表示没有 */
function ntFrontmatter(text) {
  const { lines } = ntLines(text);
  if (lines[0]?.trim() !== "---") return { props: null, bodyStart: 0 };
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { props: null, bodyStart: 0 };
  const props = [];
  for (const l of lines.slice(1, end)) {
    const kv = l.match(/^([^\s:#-][^:]*):\s*(.*?)\s*$/);
    if (kv) props.push([kv[1].trim(), kv[2].replace(/^(["'])(.*)\1$/, "$2")]);
    else if (/^\s*-\s+/.test(l) && props.length) {   // 多行列表值（tags:\n  - a\n  - b）并进上一个键
      const last = props[props.length - 1];
      last[1] = (last[1] ? `${last[1]}, ` : "") + l.replace(/^\s*-\s+/, "").trim();
    }
  }
  return { props, bodyStart: end + 1 };
}

/** 从 start 行起逐行走，跳过围栏代码块；回 ntLines 的结果（调用方改完 lines 再 join） */
function ntScan(text, start, fn) {
  const doc = ntLines(text);
  let fence = false;
  for (let i = start; i < doc.lines.length; i++) {
    if (NT_FENCE.test(doc.lines[i])) { fence = !fence; continue; }
    if (!fence) fn(doc.lines[i], i);
  }
  return doc;
}

/** 大纲：正文里的 # 标题（围栏里的不算）。顺序与阅读视图里的 data-h 一一对应，line 是全文行号 */
function ntOutline(text) {
  const out = [];
  ntScan(text, ntFrontmatter(text).bodyStart, (l, i) => {
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/\s+#+\s*$/, "").trim(), line: i });
  });
  return out;
}

/** 翻转第 n 条待办。计数口径与 mdHtml 渲染出的 <li>[ ] 相同：frontmatter 之后、围栏之外、行首是列表标记 */
function ntToggleTask(text, n) {
  let k = 0, hit = -1;
  const doc = ntScan(text, ntFrontmatter(text).bodyStart, (l, i) => {
    if (hit < 0 && NT_TASK.test(l) && k++ === n) hit = i;
  });
  if (hit < 0) return text;
  doc.lines[hit] = doc.lines[hit].replace(NT_TASK, (_, pre, c) => `${pre}[${c === " " ? "x" : " "}]`);
  return doc.join();
}

/** [[目标#标题|别名]] 拆开 */
function ntLinkParts(inner) {
  const bar = inner.indexOf("|");
  const left = bar < 0 ? inner : inner.slice(0, bar);
  const hash = left.indexOf("#");
  return {
    target: (hash < 0 ? left : left.slice(0, hash)).trim().replace(/\.md$/i, ""),
    heading: hash < 0 ? "" : left.slice(hash + 1).trim(),
    alias: bar < 0 ? "" : inner.slice(bar + 1).trim(),
  };
}

/** 双链解析（Obsidian 口径）：写文件名按文件名找、写路径按路径后缀找，不分大小写；
 *  重名时先挑和当前笔记同目录的，再挑路径最短的 */
function ntResolveLink(files, target, fromDir) {
  const t = String(target || "").toLowerCase();
  if (!t) return null;
  const hits = files.filter((f) => { const r = ntRelOf(f).toLowerCase(); return r === t || r.endsWith(`/${t}`); });
  if (!hits.length) return null;
  const near = hits.find((f) => f.dir === fromDir);
  return (near || hits.reduce((a, b) => (ntRelOf(b).length < ntRelOf(a).length ? b : a))).path;
}

/** 相对链接拼到所在目录上 → vault 相对路径（去 .md）；越出 vault 回 null */
function ntJoinRel(dir, href) {
  let h = href;
  try { h = decodeURIComponent(href); } catch { /* 保留原样 */ }
  const out = [];
  for (const seg of [...(h.startsWith("/") ? [] : String(dir || "").split("/")), ...h.split("/")]) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join("/").replace(/\.md$/i, "");
}

function ntImgHtml(ref, size, from, alt) {
  const external = /^https?:\/\//i.test(ref);
  if (!external && /^[a-z][a-z0-9+.-]*:/i.test(ref)) return esc(alt || ref);   // data:/file: 等一律不渲染
  const src = external ? safeUrl(ref) : `/api/vault/asset?ref=${encodeURIComponent(ref)}&from=${encodeURIComponent(from.path)}`;
  if (!src) return esc(alt || ref);
  const w = /^\d+/.exec(size || "")?.[0];
  return `<button type="button" class="nt-img" data-image-viewer="${esc(src)}" aria-label="查看图片"><img src="${esc(src)}" alt="${esc(alt || ref)}" loading="lazy"${
    w ? ` width="${w}"` : ""}${external ? ' referrerpolicy="no-referrer"' : ""} onerror="ntImgFailed(this)"></button>`;
}

function ntLinkHtml(path, label, heading, missingTarget) {
  if (!path) return `<a href="#" class="nt-link" data-missing="true" data-target="${esc(missingTarget)}" title="还没有这篇笔记，点一下新建">${esc(label)}</a>`;
  return `<a href="#" class="nt-link" data-note="${esc(path)}"${heading ? ` data-heading="${esc(heading)}"` : ""}>${esc(label)}</a>`;
}

/** 一行里（行内代码之外）的笔记专属语法换成占位符 */
function ntInline(s, from, files, tok) {
  return s
    .replace(/!\[\[([^[\]\n]+?)\]\]/g, (m, inner) => {
      const [ref, size] = inner.split("|");
      if (NT_IMG_EXT.test(ref.trim())) return tok(ntImgHtml(ref.trim(), size, from, ""));
      const p = ntLinkParts(inner);   // ![[另一篇笔记]] 是嵌入整篇，这里退化成链接
      return tok(ntLinkHtml(ntResolveLink(files, p.target, from.dir), p.alias || p.target, p.heading, p.target));
    })
    .replace(/!\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (m, alt, href) => tok(ntImgHtml(href, "", from, alt)))
    .replace(/\[\[([^[\]\n]+?)\]\]/g, (m, inner) => {
      const p = ntLinkParts(inner);
      const label = p.alias || inner.split("|")[0].trim();
      if (!p.target) return tok(ntLinkHtml(from.path, label, p.heading, ""));   // [[#标题]] 页内跳转
      return tok(ntLinkHtml(ntResolveLink(files, p.target, from.dir), label, p.heading, p.target));
    })
    .replace(/\[([^\]\n]+)\]\((?![a-z][a-z0-9+.-]*:)([^)\s]+?\.md)(?:#([^)\s]*))?\)/gi, (m, label, href, hash) => {
      const rel = ntJoinRel(from.dir, href);
      const exact = rel === null ? null : files.find((f) => ntRelOf(f).toLowerCase() === rel.toLowerCase());
      const path = exact?.path || (rel === null ? null : ntResolveLink(files, rel.split("/").pop(), from.dir));
      let heading = hash || "";
      try { heading = decodeURIComponent(heading); } catch { /* 保留原样 */ }
      return tok(ntLinkHtml(path, label, heading, rel || href));
    });
}

/** 阅读视图 HTML。双链/图片/本地链接先换成私用区占位符再交给 mdHtml（它会先 esc 全文），
 *  渲染完再换回拼好的 HTML；围栏代码块与行内代码里的 [[...]] 原样保留。
 *  标题带 data-h（大纲定位）、待办变成可勾的复选框（data-task 与 ntToggleTask 同一计数）。 */
function ntRender(text, from, files) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const { props, bodyStart } = ntFrontmatter(src);
  const tokens = [];
  const tok = (html) => `\ue000${tokens.push(html) - 1}\ue001`;
  let fence = false;
  const body = src.split("\n").slice(bodyStart).map((l) => {
    if (NT_FENCE.test(l)) { fence = !fence; return l; }
    if (fence) return l;
    return l.replace(/^#{5,6}(\s)/, "####$1")   // mdHtml 只认到 ####，五六级标题并进四级，大纲计数不能漏
      .split(/(`[^`\n]+`)/).map((seg, i) => (i % 2 ? seg : ntInline(seg, from, files, tok))).join("");
  }).join("\n");
  let h = 0, t = 0;
  const html = mdHtml(body)
    .replace(/<div class="md-h(\d)">/g, (m, lv) => `<div class="md-h${lv}" data-h="${h++}">`)
    .replace(/<li>\[( |x|X)\](?=\s|<\/li>)/g, (m, c) => `<li class="nt-task"><input type="checkbox" data-task="${t++}"${c === " " ? "" : " checked"} aria-label="待办">`)
    .replace(/\ue000(\d+)\ue001/g, (m, n) => tokens[+n] ?? "");
  const fm = props?.length
    ? `<details class="nt-props"><summary>属性 · ${props.length}</summary><dl>${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v) || "—"}</dd>`).join("")}</dl></details>`
    : "";
  return fm + html;
}

/** 回车续写列表：「- 」「1. 」「- [ ] 」接着往下写；空的列表项再回车就结束列表。回 {from,to,text} 编辑或 null */
function ntListEnter(value, caret) {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const before = value.slice(lineStart, caret);
  const m = before.match(NT_LIST);
  if (!m) return null;
  const lineEnd = value.indexOf("\n", caret) < 0 ? value.length : value.indexOf("\n", caret);
  if (before.length === m[0].length && !value.slice(caret, lineEnd).trim()) return { from: lineStart, to: caret, text: "" };
  const num = /^\d+/.exec(m[2]);
  const marker = num ? `${+num[0] + 1}${m[2].slice(num[0].length)}` : m[2];
  return { from: caret, to: caret, text: `\n${m[1]}${marker}${m[3]}${m[4] ? "[ ] " : ""}` };
}

/** 列表行上按 Tab / Shift+Tab 缩进两格；不是列表行回 null（Tab 照常移焦点） */
function ntListIndent(value, caret, outdent) {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const lineEnd = value.indexOf("\n", caret) < 0 ? value.length : value.indexOf("\n", caret);
  const line = value.slice(lineStart, lineEnd);
  if (!NT_LIST.test(line)) return null;
  if (!outdent) return { from: lineStart, to: lineStart, text: "  ", caret: caret + 2 };
  const n = /^( {1,2}|\t)/.exec(line)?.[0].length || 0;
  return n ? { from: lineStart, to: lineStart + n, text: "", caret: Math.max(lineStart, caret - n) } : { noop: true };
}

/** 高亮搜索词：先按词切开再各自 esc，<mark> 不会切进实体里 */
function ntMark(text, terms) {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return esc(text);
  return String(text).split(new RegExp(`(${words.join("|")})`, "gi"))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
}

/** localStorage 里的小仓库：按 key 存对象，超过 cap 淘汰最久没碰的；
 *  存储损坏按空处理，写不进去（超限/隐私模式）set 回 false，调用方要如实提示 */
function ntStore(storage, name, cap) {
  let items = {};
  try {
    const raw = JSON.parse(storage.getItem(name) || "null");
    if (raw?.v === 1 && raw.items && typeof raw.items === "object") items = raw.items;
  } catch { items = {}; }
  const persist = () => { try { storage.setItem(name, JSON.stringify({ v: 1, items })); return true; } catch { return false; } };
  return {
    get: (key) => items[key] || null,
    set(key, value) {
      items[key] = { ...value, at: Date.now() };
      const keys = Object.keys(items);
      if (keys.length > cap) keys.sort((a, b) => items[a].at - items[b].at).slice(0, keys.length - cap).forEach((k) => delete items[k]);
      return persist();
    },
    del(key) { if (key in items) { delete items[key]; persist(); } },
  };
}
/* ==== 纯函数结束 ==== */

const NT_AUTOSAVE_MS = 1200;
const Notes = {
  files: [], byPath: new Map(), listError: "",
  sel: null, mtime: null,
  text: "", saved: "",          // text = 当前内容（阅读视图也渲染它）；saved = 最近一次确认落盘的内容
  mode: localStorage.getItem("ownward-notes-mode") === "edit" ? "edit" : "view",
  prefs: { recent: [], pinned: [] },
  loading: null,                // 正在打开的路径：自动恢复上次那篇时别抢用户的显式打开
  saving: null, conflict: null, error: "", backlinks: null, pendingScroll: null,
  q: "", search: null,
  timers: { save: 0, draft: 0, pos: 0, search: 0 },
  open(path) {  // 供今日页 Action / 角色页直达
    if (!inited.has("notes")) { inited.add("notes"); TABS.notes.init($("#notes-root")); }
    openNoteFile(path);
  },
};
const NtDrafts = ntStore(localStorage, "ownward-notes-drafts-v1", 30);
const NtPos = ntStore(localStorage, "ownward-notes-pos-v1", 200);
const ntDirty = () => !!Notes.sel && Notes.text !== Notes.saved;

TABS.notes = {
  init(root) {
    root.innerHTML = `
      <div class="col notes-list-col">
        <div class="page-head compact">
          <div><div class="eyebrow">VAULT</div><h1>笔记</h1><p>浏览并维护本地 Markdown 知识库</p></div>
          <div class="tools">
            <button class="button ghost sm" id="nt-refresh">刷新</button>
            <button class="button secondary sm" id="nt-new">新建</button>
          </div>
        </div>
        <div class="nt-search"><input type="text" id="nt-q" placeholder="搜索笔记名或正文" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-label="搜索笔记"></div>
        <div class="col-scroll panel" style="padding:8px"><div class="tree" id="nt-tree"></div></div>
      </div>
      <div class="col notes-detail-col">
        <div class="panel editor">
          <div class="bar">
            <button class="button ghost sm notes-back" id="nt-back">← 笔记</button>
            <span class="path" id="nt-path">选择左侧文件</span>
            <span style="flex:1"></span>
            <button type="button" class="nt-status" id="nt-status" hidden></button>
            <div class="nt-tools" id="nt-tools" hidden>
              <button class="button ghost sm" id="nt-pin" title="收藏">☆</button>
              <div class="nt-outline-wrap">
                <button class="button ghost sm" id="nt-outline-btn" aria-expanded="false" aria-haspopup="true">大纲</button>
                <div class="nt-outline" id="nt-outline" hidden></div>
              </div>
              <div class="nt-seg" role="group" aria-label="视图">
                <button class="button ghost sm" data-nt-mode="view" title="阅读（⌘E 切换）">阅读</button>
                <button class="button ghost sm" data-nt-mode="edit" title="编辑（⌘E 切换）">编辑</button>
              </div>
              <button class="button primary sm" id="nt-save" disabled title="停手 1 秒多会自动保存">保存 ⌘S</button>
            </div>
          </div>
          <div class="nt-banner" id="nt-banner" hidden></div>
          <div class="nt-view" id="nt-view"></div>
          <textarea id="nt-text" placeholder="# 选一个文件，或新建" spellcheck="false" disabled hidden></textarea>
        </div>
      </div>`;
    const ta = $("#nt-text"), view = $("#nt-view"), tree = $("#nt-tree");
    $("#nt-refresh").addEventListener("click", () => { loadNotes(); ntLoadPrefs(); });
    $("#nt-back").addEventListener("click", () => { ntSavePos(); if (ntDirty()) saveNote(); root.dataset.mobileView = "list"; });
    $("#nt-new").addEventListener("click", async () => {
      const name = prompt("笔记名（落在 vault/notes/ 下）：");
      if (!name) return;
      const res = await post("/api/vault/new", { name });
      toast(res.msg);
      if (res.ok) { await loadNotes(); if (await openNoteFile(res.path)) ntSetMode("edit"); }
    });
    $("#nt-save").addEventListener("click", () => saveNote());
    $("#nt-status").addEventListener("click", () => { if (Notes.error) saveNote(); });
    $("#nt-pin").addEventListener("click", ntTogglePin);
    $("#nt-outline-btn").addEventListener("click", (e) => { e.stopPropagation(); ntToggleOutline(); });
    $("#nt-outline").addEventListener("click", (e) => {
      const item = e.target.closest("[data-ol]");
      if (item) { ntToggleOutline(false); ntGoHeading(+item.dataset.ol); }
    });
    document.addEventListener("click", (e) => { if (!e.target.closest?.(".nt-outline-wrap")) ntToggleOutline(false); });
    $$("[data-nt-mode]").forEach((b) => b.addEventListener("click", () => ntSetMode(b.dataset.ntMode)));

    ta.addEventListener("input", () => { Notes.text = ta.value; ntChanged(); });
    ta.addEventListener("scroll", ntPosLater, { passive: true });
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229 || composingEl || e.metaKey || e.ctrlKey || e.altKey) return;
      if (ta.selectionStart !== ta.selectionEnd) return;
      const edit = e.key === "Enter" && !e.shiftKey ? ntListEnter(ta.value, ta.selectionStart)
        : e.key === "Tab" ? ntListIndent(ta.value, ta.selectionStart, e.shiftKey) : null;
      if (!edit) return;
      e.preventDefault();
      if (!edit.noop) ntApplyEdit(ta, edit);
    });

    view.addEventListener("scroll", ntPosLater, { passive: true });
    view.addEventListener("click", (e) => {
      const a = e.target.closest("a.nt-link");
      if (a) { e.preventDefault(); ntFollow(a); return; }
      const hit = e.target.closest("[data-open]");
      if (hit) ntOpenFromList(hit);
    });
    view.addEventListener("change", (e) => {
      const box = e.target.closest?.("input[data-task]");
      if (!box) return;
      const next = ntToggleTask(Notes.text, +box.dataset.task);
      if (next === Notes.text) { toast("没对上这条待办，切到编辑模式改吧"); ntRenderView(); return; }
      ntSetText(next);
    });

    tree.addEventListener("click", (e) => { const row = e.target.closest("[data-open]"); if (row) ntOpenFromList(row); });
    const q = $("#nt-q");
    q.addEventListener("input", (e) => { if (!e.isComposing) ntOnSearch(q.value); });
    q.addEventListener("compositionend", () => ntOnSearch(q.value));
    q.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); const first = $("#nt-tree [data-open]"); if (first) ntOpenFromList(first); }
      else if (e.key === "Escape" && q.value) { e.preventDefault(); q.value = ""; ntOnSearch(""); }
    });

    document.addEventListener("keydown", (e) => {
      if (S.tab !== "notes") return;
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "s") { e.preventDefault(); saveNote(); }
      else if ((e.metaKey || e.ctrlKey) && k === "e" && Notes.sel) { e.preventDefault(); ntSetMode(Notes.mode === "view" ? "edit" : "view"); }
      else if (e.key === "Escape") ntToggleOutline(false);
    });
    // 关页面/切到后台：位置和草稿立刻落本机，能存的顺手存掉（存不上下次打开会从草稿接上）
    window.addEventListener("pagehide", () => { ntSavePos(); ntKeepDraft(); });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      ntSavePos(); ntKeepDraft();
      if (ntDirty()) saveNote();
    });

    ntApplyMode();
    Promise.all([loadNotes(), ntLoadPrefs()]).then(() => {
      if (Notes.sel || Notes.loading) return;   // 用户已经点开了别的（今日页/⌘K 直达）
      const last = Notes.prefs.recent[0];
      if (last) openNoteFile(last.path, { quiet: true });
    });
  },
  // 每次切回都重拉（server 端有 30s 缓存，不贵）：init 时一次失败不该让 tab 永久空白；收藏/最近可能在另一台设备上变了
  show() { loadNotes(); ntLoadPrefs(); },
  hide() { ntSavePos(); ntToggleOutline(false); if (ntDirty()) saveNote(); },
};

// 文件夹展开状态（localStorage 持久化，同任务 tab tkExpanded 的习惯）——重建树时恢复，别弹回默认。
// 左栏分组（收藏/最近…）也存在这里，key 带 § 前缀，不会和目录名撞
const ntOpen = new Map(JSON.parse(localStorage.getItem("ownward-notes-open") || "[]"));
function ntToggle(dir, open) {
  if (ntOpen.get(dir) === open) return;   // innerHTML 初次插入也会触发 ontoggle，无变化不落盘
  ntOpen.set(dir, open);
  localStorage.setItem("ownward-notes-open", JSON.stringify([...ntOpen]));
}

function ntFileOf(path) {
  const f = Notes.byPath.get(path);
  if (f) return f;
  const root = S.state?.vaultRoot;
  const rel = root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path.split("/").pop();
  const slash = rel.lastIndexOf("/");
  return { path, name: rel.slice(slash + 1).replace(/\.md$/, ""), dir: slash < 0 ? "" : rel.slice(0, slash), mtime: 0 };
}

/* ---------- 左栏：收藏 / 最近打开 / 最近更新 / 全部 + 搜索 ---------- */
async function loadNotes() {
  try {
    Notes.files = await getJSON("/api/vault/list");
    Notes.listError = "";
  } catch (e) { Notes.listError = String(e); }   // 失败保留上次列表；从没成功过则走错误态
  Notes.byPath = new Map(Notes.files.map((f) => [f.path, f]));
  ntRenderSide();
  // 先打开、后到列表时（今日页直达），双链要按新列表重新解析
  if (Notes.sel && Notes.mode === "view") ntRenderView(true);
}
async function ntLoadPrefs() {
  const r = await getJSON("/api/vault/prefs").catch(() => null);
  if (!r?.ok) return;
  Notes.prefs = { recent: r.recent || [], pinned: r.pinned || [] };
  ntRenderSide();
  ntUpdateUI();
}

/** 行尾的位置提示：只留目录最后两级（inbox 里全是日期名，不看目录分不清是哪篇） */
const ntWhere = (f) => f.dir.split("/").slice(-2).join("/");
function ntRow(f, hint, extra = "") {
  return `<div class="file nt-row" data-open="${esc(f.path)}" data-on="${Notes.sel === f.path}" title="${esc(ntRelOf(f))}"${extra}>` +
    `<span class="nt-name">${esc(f.name)}</span>${hint ? `<span class="nt-hint">${esc(hint)}</span>` : ""}</div>`;
}
function ntSection(key, title, body, count) {
  const open = ntOpen.has(`§${key}`) ? ntOpen.get(`§${key}`) : true;
  return `<details class="nt-sec" ${open ? "open" : ""} ontoggle="ntToggle('§${key}',this.open)"><summary>${esc(title)}${
    count !== undefined ? `<span class="nt-count">${esc(count)}</span>` : ""}</summary><div class="nt-sec-body">${body}</div></details>`;
}
function ntTreeHtml() {
  const root = { dirs: {}, files: [] };
  for (const f of Notes.files) {
    let node = root;
    for (const p of (f.dir ? f.dir.split("/") : [])) node = node.dirs[p] ??= { dirs: {}, files: [] };
    node.files.push(f);
  }
  const renderNode = (node, depth, base) => {
    const dirs = Object.keys(node.dirs).sort().map((d) => {
      const full = base ? `${base}/${d}` : d;
      const open = ntOpen.has(full) ? ntOpen.get(full) : depth < 1;   // 用户动过的优先；默认顶层开
      return `<details ${open ? "open" : ""} ontoggle="ntToggle('${jsq(full)}',this.open)"><summary>${esc(d)}</summary>${renderNode(node.dirs[d], depth + 1, full)}</details>`;
    }).join("");
    const files = node.files.slice(0, 200).map((f) =>
      `<div class="file" data-open="${esc(f.path)}" data-on="${Notes.sel === f.path}" title="${esc(f.name)}">${esc(f.name)}</div>`).join("");
    const more = node.files.length > 200 ? `<div class="nt-more">还有 ${node.files.length - 200} 篇没列出，用上面的搜索找</div>` : "";
    return dirs + files + more;
  };
  return renderNode(root, 0);
}
function ntRenderSide() {
  const box = $("#nt-tree");
  if (!box) return;
  if (Notes.q) { box.innerHTML = ntSearchHtml(); return; }
  if (Notes.listError && !Notes.files.length) {
    box.innerHTML = `<div class="state-box" data-state="error">加载失败：${esc(Notes.listError)}<br>
      <button class="button secondary sm" style="margin-top:6px" onclick="loadNotes()">重试</button></div>`;
    return;
  }
  const pinned = Notes.prefs.pinned.map(ntFileOf);
  const recent = Notes.prefs.recent.slice(0, 8);
  const updated = Notes.files.slice(0, 8);
  const all = Notes.files.length >= 2000 ? "最近 2000 篇" : Notes.files.length;
  box.innerHTML = [
    pinned.length ? ntSection("pinned", "收藏", pinned.map((f) => ntRow(f, ntWhere(f))).join(""), pinned.length) : "",
    recent.length ? ntSection("recent", "最近打开", recent.map((r) => { const f = ntFileOf(r.path); return ntRow(f, [ageText(r.at), ntWhere(f)].filter(Boolean).join(" · ")); }).join("")) : "",
    updated.length ? ntSection("updated", "最近更新", updated.map((f) => ntRow(f, [ageText(new Date(f.mtime).toISOString()), ntWhere(f)].filter(Boolean).join(" · "))).join("")) : "",
    ntSection("all", "全部笔记", ntTreeHtml() || stateBox("vault 还是空的，daemon 落日志或收割后会出现文件"), all),
  ].join("");
}

function ntOnSearch(value) {
  Notes.q = value.trim();
  clearTimeout(Notes.timers.search);
  if (Notes.q.length >= 2) Notes.timers.search = setTimeout(() => ntFullText(Notes.q), 220);
  ntRenderSide();
}
async function ntFullText(q) {
  const r = await getJSON(`/api/vault/search?q=${encodeURIComponent(q)}`).catch((e) => ({ ok: false, msg: String(e) }));
  if (Notes.q !== q) return;
  Notes.search = { ...r, q };
  ntRenderSide();
}
function ntSearchHtml() {
  const q = Notes.q, terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const named = Notes.files.filter((f) => { const r = ntRelOf(f).toLowerCase(); return terms.every((t) => r.includes(t)); });
  const seen = new Set(named.map((f) => f.path));
  const nameBody = named.length
    ? named.slice(0, 30).map((f) => ntRow(f, ntWhere(f))).join("") + (named.length > 30 ? `<div class="nt-more">还有 ${named.length - 30} 篇同名命中</div>` : "")
    : `<div class="nt-empty">没有名字匹配的笔记</div>`;
  let full;
  if (q.length < 2) full = `<div class="nt-empty">输入两个字以上搜正文</div>`;
  else if (Notes.search?.q !== q) full = `<div class="nt-empty">正在搜正文…</div>`;
  else if (!Notes.search.ok) full = stateBox(`全文搜索失败：${Notes.search.msg || "未知错误"}`, "error");
  else {
    const hits = Notes.search.hits.filter((h) => !seen.has(h.path));
    const extra = [
      Notes.search.truncated ? `共 ${Notes.search.total} 篇命中，只列前 ${Notes.search.hits.length} 篇，换个更具体的词` : "",
      Notes.search.skipped ? `${Notes.search.skipped} 篇超过 4MB 没有搜` : "",
    ].filter(Boolean).map((t) => `<div class="nt-more">${esc(t)}</div>`).join("");
    full = (hits.length ? hits.map((h) => `<div class="nt-hit">${ntRow(h, ntWhere(h), ` data-reveal="${esc(terms[0] || "")}"`)}${
      h.matches.map((m) => `<div class="nt-snip" data-open="${esc(h.path)}" data-reveal="${esc(terms[0] || "")}">${ntMark(m.text, terms)}</div>`).join("")}</div>`).join("")
      : `<div class="nt-empty">正文里也没有${named.length ? "别的" : ""}命中</div>`) + extra;
  }
  return ntSection("q-name", "名称", nameBody, named.length) + ntSection("q-text", "正文", full, Notes.search?.q === q && Notes.search.ok ? Notes.search.total : undefined);
}
function ntOpenFromList(el) {
  openNoteFile(el.dataset.open, { reveal: el.dataset.reveal || "" });
}

/* ---------- 打开 / 视图 ---------- */
/** 打开一篇。上一篇有没存的先存（存不上就留在本机草稿，回来接上）；本机有这篇没存上的草稿就接上。
 *  opts.quiet：自动恢复上次那篇时文件已不在，不弹提示；opts.reveal / heading：打开后定位 */
async function openNoteFile(path, opts = {}) {
  if (!path) return false;
  if (path === Notes.sel && ntDirty()) { ntAfterRender(opts); return true; }   // 正在改的这篇：不从磁盘重读，免得冲掉修改
  Notes.loading = path;
  if (Notes.sel) {
    ntSavePos();
    if (Notes.sel !== path && ntDirty() && !(await saveNote())) toast("上一篇还没存进 vault，修改留在本机草稿里，回去会自动接上");
  }
  let r;
  try { r = await (await fetch(`/api/vault/file?path=${encodeURIComponent(path)}`)).json(); }
  catch (e) { r = { ok: false, msg: String(e) }; }
  if (Notes.loading !== path) return false;   // 期间又点了别的，晚到的这次作废
  Notes.loading = null;
  if (!r?.ok) {
    if (!opts.quiet) toast(r?.msg === "不存在" ? "这篇笔记不存在（可能被移走或删除了）" : `打不开：${r?.msg || "读取失败"}`);
    return false;
  }
  Object.assign(Notes, { sel: path, mtime: r.mtime, saved: r.text, text: r.text, conflict: null, error: "", backlinks: null });
  const draft = NtDrafts.get(path);
  let resumed = false;
  if (draft && typeof draft.text === "string" && draft.text !== r.text) {
    Notes.text = draft.text;
    if (draft.base === r.mtime) resumed = true;               // 磁盘没动过：直接接着存
    else {
      // 基线留在草稿当初的版本：之后再存草稿也带旧基线，刷新页面不会被误当成「磁盘没动过」静默覆盖
      Notes.mtime = draft.base;
      Notes.conflict = { kind: "draft", mtime: r.mtime };
    }
  } else if (draft) NtDrafts.del(path);
  const ta = $("#nt-text");
  ta.value = Notes.text;
  ta.disabled = false;
  $("#nt-path").textContent = `${ntRelOf(ntFileOf(path))}.md`;
  $("#nt-path").title = path;
  $("#nt-tools").hidden = false;
  $("#notes-root").dataset.mobileView = "detail";
  ntApplyMode(opts);
  ntUpdateUI();
  if (resumed) { toast("接上了上次没存完的修改"); ntScheduleSave(0); }
  ntLoadBacklinks(path);
  post("/api/vault/prefs", { op: "open", path }).then((res) => {
    if (res?.ok) { Notes.prefs = { recent: res.recent || [], pinned: res.pinned || [] }; ntRenderSide(); }
  });
  return true;
}

function ntSetMode(mode) {
  if (mode === Notes.mode) return;
  ntSavePos();
  Notes.mode = mode;
  localStorage.setItem("ownward-notes-mode", mode);
  ntApplyMode();
  if (mode === "edit" && Notes.sel) $("#nt-text").focus({ preventScroll: true });
}
function ntApplyMode(opts = {}) {
  const view = $("#nt-view"), ta = $("#nt-text");
  const reading = !Notes.sel || Notes.mode === "view";
  view.hidden = !reading;
  ta.hidden = reading;
  $$("[data-nt-mode]").forEach((b) => (b.dataset.on = String(b.dataset.ntMode === Notes.mode)));
  if (!Notes.sel) { view.innerHTML = stateBox("选一篇笔记，或点「新建」"); return; }
  if (reading) ntRenderView();
  ntRestorePos(opts);
}
function ntRenderView(keepScroll) {
  const view = $("#nt-view");
  if (!Notes.sel || view.hidden) return;
  const top = view.scrollTop;
  view.innerHTML = `<article class="nt-doc">${ntRender(Notes.text, ntFileOf(Notes.sel), Notes.files)}</article><section class="nt-backlinks tree" id="nt-backlinks"></section>`;
  ntRenderBacklinks();
  if (keepScroll) view.scrollTop = top;
}
function ntImgFailed(img) {
  const box = img.closest(".nt-img");
  if (!box) return;
  box.classList.add("is-error");
  box.removeAttribute("data-image-viewer");
  box.disabled = true;
  const src = img.getAttribute("src") || "";
  let host = "";
  try { host = src.startsWith("/") ? "" : new URL(src).host; } catch { /* 留空 */ }
  // 外链多半是过期的签名地址（飞书/剪藏），只报域名，别把整条 URL 糊一屏
  box.textContent = host ? `外链图片加载失败（${host}）` : `图片没找到：${img.alt}`;
  box.title = src;
}

/* ---------- 位置记忆 ---------- */
function ntSavePos() {
  if (!Notes.sel) return;
  const view = $("#nt-view"), ta = $("#nt-text");
  const pos = { ...(NtPos.get(Notes.sel) || {}) };
  if (!view.hidden) pos.view = Math.round(view.scrollTop);
  if (!ta.hidden) { pos.edit = Math.round(ta.scrollTop); pos.caret = ta.selectionStart; }
  NtPos.set(Notes.sel, pos);
}
function ntPosLater() { clearTimeout(Notes.timers.pos); Notes.timers.pos = setTimeout(ntSavePos, 400); }
function ntRestorePos(opts = {}) {
  const path = Notes.sel, pos = NtPos.get(path);
  requestAnimationFrame(() => {
    if (Notes.sel !== path) return;
    if (Notes.mode === "view") {
      const view = $("#nt-view"), want = pos?.view || 0;
      view.scrollTop = want;
      // 反链是异步到的：正文短时这会儿还滚不到上次的位置，等反链渲染完再补一次（期间用户自己滚过就不补）
      Notes.pendingScroll = want > view.scrollTop && !opts.reveal && !opts.heading ? { path, want, got: view.scrollTop } : null;
    } else {
      const ta = $("#nt-text");
      if (Number.isInteger(pos?.caret)) ta.setSelectionRange(pos.caret, pos.caret);
      ta.scrollTop = pos?.edit || 0;
    }
    ntAfterRender(opts);
  });
}
/** 打开后定位：从搜索点进来的滚到命中处，从 [[x#标题]] 点进来的滚到标题 */
function ntAfterRender(opts) {
  if (opts.heading) ntRevealHeading(opts.heading);
  else if (opts.reveal) ntReveal(opts.reveal);
}
function ntFlash(el) {
  if (!el) return;
  el.classList.add("nt-flash");
  setTimeout(() => el.classList.remove("nt-flash"), 1600);
}
function ntScrollTextareaTo(offset) {
  const ta = $("#nt-text");
  const before = Notes.text.slice(0, offset).split("\n").length - 1, total = Notes.text.split("\n").length || 1;
  ta.scrollTop = Math.max(0, (before / total) * ta.scrollHeight - ta.clientHeight / 3);   // 按行比例粗定位，caret 再精确拉进视口
  ta.focus({ preventScroll: true });
}
function ntReveal(term) {
  const t = String(term || "").toLowerCase();
  if (!t || !Notes.sel) return;
  if (Notes.mode === "view") {
    const el = $$("#nt-view .nt-doc :is(.md-p, .md-h1, .md-h2, .md-h3, .md-h4, li, td, th, blockquote, pre, dd)")
      .find((x) => x.textContent.toLowerCase().includes(t));
    el?.scrollIntoView({ block: "center" });
    ntFlash(el);
  } else {
    const i = Notes.text.toLowerCase().indexOf(t);
    if (i < 0) return;
    ntScrollTextareaTo(i);
    $("#nt-text").setSelectionRange(i, i + t.length);
  }
}
function ntGoHeading(i) {
  const h = ntOutline(Notes.text)[i];
  if (!h) return;
  if (Notes.mode === "view") {
    const el = $(`#nt-view [data-h="${i}"]`);
    el?.scrollIntoView({ block: "start" });
    ntFlash(el);
  } else {
    const { lines, seps } = ntLines(Notes.text);
    const offset = lines.slice(0, h.line).reduce((n, l, k) => n + l.length + (seps[k] ?? "").length, 0);
    ntScrollTextareaTo(offset);
    $("#nt-text").setSelectionRange(offset, offset);
  }
}
function ntRevealHeading(text) {
  const t = text.trim().toLowerCase();
  const i = ntOutline(Notes.text).findIndex((h) => h.text.toLowerCase() === t);
  if (i >= 0) ntGoHeading(i);
}
function ntToggleOutline(force) {
  const box = $("#nt-outline"), btn = $("#nt-outline-btn");
  if (!box) return;
  const open = force ?? box.hidden;
  if (open) {
    const items = ntOutline(Notes.text);
    box.innerHTML = items.length
      ? items.map((h, i) => `<button type="button" class="nt-ol-item" data-ol="${i}" style="padding-left:${8 + (h.level - 1) * 12}px">${esc(h.text || "（空标题）")}</button>`).join("")
      : `<div class="nt-empty">这篇没有标题</div>`;
  }
  box.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}

/* ---------- 链接 / 反链 / 收藏 ---------- */
async function ntFollow(a) {
  if (a.dataset.missing) {
    const target = a.dataset.target || "";
    if (!target || !confirm(`还没有「${target}」这篇笔记，现在新建？`)) return;
    const slash = target.lastIndexOf("/");
    const res = await post("/api/vault/new", { name: target.slice(slash + 1), dir: slash < 0 ? ntFileOf(Notes.sel).dir || "notes" : target.slice(0, slash) });
    toast(res.msg);
    if (res.ok) { await loadNotes(); if (await openNoteFile(res.path)) ntSetMode("edit"); }
    return;
  }
  const path = a.dataset.note, heading = a.dataset.heading || "";
  if (path === Notes.sel) { if (heading) ntRevealHeading(heading); return; }
  openNoteFile(path, { heading });
}
async function ntLoadBacklinks(path) {
  const r = await getJSON(`/api/vault/backlinks?path=${encodeURIComponent(path)}`).catch((e) => ({ ok: false, msg: String(e) }));
  if (Notes.sel !== path) return;
  Notes.backlinks = { ...r, path };
  ntRenderBacklinks();
}
function ntRenderBacklinks() {
  const box = $("#nt-backlinks"), b = Notes.backlinks;
  if (!box) return;
  if (!b || b.path !== Notes.sel) { box.innerHTML = ""; return; }
  queueMicrotask(ntSettleScroll);
  if (!b.ok) { box.innerHTML = `<div class="nt-bl-head">链接到这里</div>${stateBox(`反向链接加载失败：${b.msg || "未知错误"}`, "error")}`; return; }
  const name = ntFileOf(Notes.sel).name;
  box.innerHTML = `<div class="nt-bl-head">链接到这里<span class="nt-count">${b.hits.length}</span></div>` + (b.hits.length
    ? b.hits.map((h) => `<div class="nt-hit">${ntRow(h, ntWhere(h))}${h.matches.map((m) => `<div class="nt-snip" data-open="${esc(h.path)}">${ntMark(m.text, [name])}</div>`).join("")}</div>`).join("")
    : `<div class="nt-empty">还没有笔记用 [[${esc(name)}]] 链到这篇</div>`) +
    (b.skipped ? `<div class="nt-more">${b.skipped} 篇超过 4MB 没有扫</div>` : "");
}
function ntSettleScroll() {
  const p = Notes.pendingScroll, view = $("#nt-view");
  if (!p || p.path !== Notes.sel || !view) return;
  Notes.pendingScroll = null;
  if (view.scrollTop === p.got) view.scrollTop = p.want;
}
async function ntTogglePin() {
  const path = Notes.sel;
  if (!path) return;
  const op = Notes.prefs.pinned.includes(path) ? "unpin" : "pin";
  const res = await post("/api/vault/prefs", { op, path });
  if (!res?.ok) { toast(res?.msg || "收藏没存上"); return; }
  Notes.prefs = { recent: res.recent || [], pinned: res.pinned || [] };
  ntRenderSide();
  ntUpdateUI();
  toast(op === "pin" ? "已收藏" : "已取消收藏");
}

/* ---------- 编辑 / 自动保存 / 冲突 ---------- */
function ntApplyEdit(ta, edit) {
  ta.setSelectionRange(edit.from, edit.to);
  // execCommand 走浏览器自己的编辑栈，⌘Z 撤销还能用；不支持时退回 setRangeText 并手动触发保存
  const done = edit.text ? document.execCommand("insertText", false, edit.text) : edit.from === edit.to || document.execCommand("delete");
  if (!done) { ta.setRangeText(edit.text, edit.from, edit.to, "end"); Notes.text = ta.value; ntChanged(); }
  if (edit.caret !== undefined) ta.setSelectionRange(edit.caret, edit.caret);
}
/** 阅读视图里勾待办走这里（编辑框输入走 input 事件） */
function ntSetText(text) {
  Notes.text = text;
  $("#nt-text").value = text;
  ntChanged();
}
function ntChanged() {
  Notes.error = "";
  clearTimeout(Notes.timers.draft);
  Notes.timers.draft = setTimeout(() => ntKeepDraft(true), 300);
  ntScheduleSave();
  ntUpdateUI();
}
function ntScheduleSave(ms = NT_AUTOSAVE_MS) {
  clearTimeout(Notes.timers.save);
  if (!Notes.conflict) Notes.timers.save = setTimeout(() => saveNote(), ms);
}
let ntDraftWarned = false;
/** 没存上的修改留一份在本机。edited=true 表示刚在本页改过：改回原样就删掉草稿；
 *  关页面/切后台时只写不删——同一篇开着两个标签页，干净的那个不能把另一个的草稿删了 */
function ntKeepDraft(edited = false) {
  clearTimeout(Notes.timers.draft);
  if (!Notes.sel) return;
  if (!ntDirty()) { if (edited) NtDrafts.del(Notes.sel); return; }
  if (!NtDrafts.set(Notes.sel, { text: Notes.text, base: Notes.mtime }) && !ntDraftWarned) {
    ntDraftWarned = true;
    toast("浏览器存储满了，本机草稿没留住——这篇请尽快保存");
  }
}
/** 存盘。串行：上一次没回来就等它；回来后内容又变了就再排一轮。成功（或本来就不用存）回 true。
 *  opts.force：用户在冲突里选了「按我的重新创建」，不带版本基线直接写 */
async function saveNote(opts = {}) {
  clearTimeout(Notes.timers.save);
  while (Notes.saving) await Notes.saving;
  const path = Notes.sel;
  if (!path || !ntDirty()) return true;
  if (Notes.conflict && !opts.force) return false;
  if (!opts.force && typeof Notes.mtime !== "number") {   // 没有版本基线就不写，宁可停下来让人选
    Notes.conflict = { kind: "disk" };
    ntKeepDraft(); ntUpdateUI();
    return false;
  }
  const content = Notes.text;
  const body = { path, content };
  if (!opts.force) body.baseMtime = Notes.mtime;
  Notes.saving = post("/api/vault/save", body);
  ntUpdateUI();
  const res = await Notes.saving;
  Notes.saving = null;
  if (Notes.sel !== path) { if (res?.ok) NtDrafts.del(path); return !!res?.ok; }
  if (res?.ok) {
    Object.assign(Notes, { mtime: res.mtime, saved: content, conflict: null, error: "" });
    if (ntDirty()) { ntKeepDraft(); ntScheduleSave(); } else NtDrafts.del(path);
    ntUpdateUI();
    return true;
  }
  ntKeepDraft();
  if (res?.code === "VAULT_CONFLICT" && !opts.rebased) {
    // 只动了修改时间、内容还是我们读到的那版（vault 自动同步、git checkout 常见）：换个基线再存一次，不打扰人
    const disk = await getJSON(`/api/vault/file?path=${encodeURIComponent(path)}`).catch(() => null);
    if (Notes.sel === path && disk?.ok && disk.text === Notes.saved) {
      Notes.mtime = disk.mtime;
      return saveNote({ rebased: true });
    }
  }
  if (res?.code === "VAULT_CONFLICT" || res?.code === "VAULT_GONE") {
    Notes.conflict = { kind: res.code === "VAULT_GONE" ? "gone" : "disk", mtime: res.mtime };
  } else {
    // 断网 / daemon 重启中：修改在本机草稿里，过一会儿自己再试
    Notes.error = res?.msg || "保存失败";
    Notes.timers.save = setTimeout(() => saveNote(), 10_000);
  }
  ntUpdateUI();
  return false;
}
function ntBannerHtml() {
  const c = Notes.conflict;
  if (!c) return "";
  const msg = c.kind === "gone" ? "这篇笔记在磁盘上已经不在了（被删除或移走）。你的修改还留在本机。"
    : c.kind === "draft" ? "本机留着一份上次没存上的修改，但这篇笔记之后在别处被改过。"
    : "这篇笔记在别处被改过（收割追加、Obsidian 或另一台设备），自动保存已暂停，没有覆盖。";
  return `<span class="nt-banner-msg">${esc(msg)}</span><span class="nt-banner-actions">
    <button class="button primary sm" onclick="ntSettle('mine')">${c.kind === "gone" ? "按我的重新创建" : "用我的覆盖"}</button>
    <button class="button ghost sm" onclick="ntSettle('copy')">复制我的版本</button>
    <button class="button ghost sm" onclick="ntSettle('disk')">${c.kind === "gone" ? "丢弃我的修改" : "改用磁盘上的版本"}</button></span>`;
}
async function ntSettle(choice) {
  const path = Notes.sel, c = Notes.conflict;
  if (!path || !c) return;
  if (choice === "copy") {
    try { await navigator.clipboard.writeText(Notes.text); toast("已复制你的版本"); }
    catch { toast("复制失败：浏览器不让写剪贴板"); }
    return;
  }
  if (choice === "mine") {
    // 把基线挪到磁盘现在的版本上再存：之后要是又被别处改了，照样会拦下来
    if (typeof c.mtime === "number") Notes.mtime = c.mtime;
    Notes.conflict = null;
    await saveNote({ force: c.kind === "gone" });
    return;
  }
  if (!confirm("丢弃你在这篇里的修改？")) return;
  NtDrafts.del(path);
  Object.assign(Notes, { conflict: null, error: "", text: Notes.saved });
  if (c.kind !== "gone") { await openNoteFile(path); return; }
  Object.assign(Notes, { sel: null, mtime: null, text: "", saved: "", backlinks: null });
  const ta = $("#nt-text");
  ta.value = ""; ta.disabled = true;
  $("#nt-path").textContent = "选择左侧文件";
  $("#nt-tools").hidden = true;
  ntApplyMode();
  ntUpdateUI();
  loadNotes();
}
function ntUpdateUI() {
  const has = !!Notes.sel, dirty = ntDirty();
  const st = $("#nt-status");
  if (!st) return;
  const [text, state] = !has ? ["", ""]
    : Notes.conflict ? ["有冲突，没保存", "warning"]
    : Notes.saving ? ["保存中…", ""]
    : Notes.error ? ["保存失败，点这里重试", "error"]
    : dirty ? ["编辑中…", ""]
    : ["已保存", "ok"];
  st.hidden = !has;
  st.textContent = text;
  st.dataset.state = state;
  st.title = Notes.error ? `${Notes.error}（修改已留在本机草稿）` : "";
  $("#nt-save").disabled = !has || !dirty || !!Notes.conflict;
  const pinned = has && Notes.prefs.pinned.includes(Notes.sel);
  const pin = $("#nt-pin");
  pin.textContent = pinned ? "★" : "☆";
  pin.dataset.on = String(pinned);
  pin.title = pinned ? "取消收藏" : "收藏";
  const banner = $("#nt-banner"), html = ntBannerHtml();
  banner.hidden = !html;
  if (banner.innerHTML !== html) banner.innerHTML = html;
  // 高亮就地更新——重建整棵树会把用户手动收展的文件夹打回默认态
  $$("#nt-tree [data-open]").forEach((el) => (el.dataset.on = String(el.dataset.open === Notes.sel)));
}
