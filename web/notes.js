"use strict";
/* 笔记 tab：vault 浏览 + 编辑（路径由 daemon 校验锁死 vault 内 .md） */

const Notes = {
  files: [], sel: null, dirty: false,
  open(path) {  // 供今日页 Action 直达
    if (!inited.has("notes")) { inited.add("notes"); TABS.notes.init($("#notes-root")); }
    openNoteFile(path);
  },
};

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
        <div class="col-scroll panel" style="padding:8px"><div class="tree" id="nt-tree"></div></div>
      </div>
      <div class="col notes-detail-col">
        <div class="panel editor">
          <div class="bar">
            <button class="button ghost sm notes-back" id="nt-back">← 笔记</button>
            <span class="path" id="nt-path">选择左侧文件</span>
            <span style="flex:1"></span>
            <span id="nt-dirty" style="font-size:11px;color:var(--warning);display:none">未保存</span>
            <button class="button secondary sm" id="nt-append">追加到今日</button>
            <button class="button primary sm" id="nt-save" disabled>保存 ⌘S</button>
          </div>
          <textarea id="nt-text" placeholder="# 选一个文件，或新建" spellcheck="false" disabled></textarea>
        </div>
      </div>`;
    $("#nt-refresh").addEventListener("click", loadNotes);
    $("#nt-back").addEventListener("click", () => { if (!Notes.dirty || confirm("有未保存修改，返回列表但保留修改？")) root.dataset.mobileView = "list"; });
    $("#nt-new").addEventListener("click", async () => {
      const name = prompt("笔记名（落在 vault/notes/ 下）：");
      if (!name) return;
      const res = await post("/api/vault/new", { name });
      toast(res.msg);
      if (res.ok) { await loadNotes(); openNoteFile(res.path); }
    });
    $("#nt-append").addEventListener("click", async () => {
      const text = prompt("追加一条到今日 Ownward 日志：");
      if (!text?.trim()) return;
      toast((await post("/api/vault/append-today", { text })).msg || "已追加");
    });
    $("#nt-save").addEventListener("click", saveNote);
    $("#nt-text").addEventListener("input", () => setDirty(true));
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && S.tab === "notes") { e.preventDefault(); saveNote(); }
    });
    loadNotes();
  },
  // 每次切回都重拉（server 端有 30s 缓存，不贵）：init 时一次失败不该让 tab 永久空白
  show() { loadNotes(); },
};

// 文件夹展开状态（localStorage 持久化，同任务 tab tkExpanded 的习惯）——重建树时恢复，别弹回默认
const ntOpen = new Map(JSON.parse(localStorage.getItem("ownward-notes-open") || "[]"));
function ntToggle(dir, open) {
  if (ntOpen.get(dir) === open) return;   // innerHTML 初次插入也会触发 ontoggle，无变化不落盘
  ntOpen.set(dir, open);
  localStorage.setItem("ownward-notes-open", JSON.stringify([...ntOpen]));
}

function setDirty(d) {
  Notes.dirty = d;
  $("#nt-dirty").style.display = d ? "inline" : "none";
  $("#nt-save").disabled = !d || !Notes.sel;
}
async function loadNotes() {
  let err = null;
  try { Notes.files = await getJSON("/api/vault/list"); }
  catch (e) { err = e; }   // 失败保留上次列表；从没成功过则走下面的错误态
  if (err && !Notes.files.length) {
    $("#nt-tree").innerHTML = `<div class="state-box" data-state="error">加载失败：${esc(String(err))}<br>
      <button class="button secondary sm" style="margin-top:6px" onclick="loadNotes()">重试</button></div>`;
    return;
  }
  // 目录树：dir 路径 → 嵌套 <details>
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
      `<div class="file" data-on="${Notes.sel === f.path}" data-path="${esc(f.path)}" title="${esc(f.name)}" onclick="openNoteFile('${jsq(f.path)}')">${esc(f.name)}</div>`).join("");
    return dirs + files;
  };
  $("#nt-tree").innerHTML = renderNode(root, 0) || stateBox("vault 还是空的，daemon 落日志或收割后会出现文件");
}
async function openNoteFile(path) {
  if (Notes.dirty && !confirm("有未保存修改，丢弃？")) return;
  const r = await getJSON(`/api/vault/file?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!r?.ok) { toast(r?.msg || "读取失败"); return; }
  Notes.sel = path;
  $("#notes-root").dataset.mobileView = "detail";
  $("#nt-text").value = r.text;
  $("#nt-text").disabled = false;
  const rel = S.state?.vaultRoot && path.startsWith(S.state.vaultRoot + "/") ? path.slice(S.state.vaultRoot.length + 1) : path;
  $("#nt-path").textContent = rel;
  setDirty(false);
  // 高亮就地更新——重建整棵树会把用户手动收展的文件夹打回默认态
  $$("#nt-tree .file").forEach((el) => (el.dataset.on = String(el.dataset.path === path)));
}
async function saveNote() {
  if (!Notes.sel || !Notes.dirty) return;
  const res = await post("/api/vault/save", { path: Notes.sel, content: $("#nt-text").value });
  toast(res.msg || "已保存");
  if (res.ok) setDirty(false);
}
