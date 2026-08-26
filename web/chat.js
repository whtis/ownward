"use strict";
/* 对话 tab：AI 流式对话（claude / codex），NDJSON 逐行读流
 *
 * 角色绑定只在**新建对话**时选：角色 + 项目范围随第一条消息落盘，之后不可改
 * （续聊换角色 = 历史结论串味，后端也会直接拒）。已有对话这里只如实展示绑定。
 * 绑定项目专家时主项目锁定注入：这里不给取消，后端 roleMemoryPack 还会再强制一次。
 * assistant 消息的「存为候选」只写 _candidates/（可选存到角色或主项目），
 * 晋升永远是角色页上另一次人工点击。 */

const Chat = {
  list: [], sel: null, msgs: [], providers: {}, streaming: false,
  images: [],               // 待发图片 [{media_type, data(base64), size, url(blob 预览)}]
  listLoaded: false, listError: "", openSeq: 0,
  roles: [], rolesLoaded: false,
  binding: null,            // 已有对话的绑定详情（/api/chat/messages 派生，null = 普通对话）
  newRole: "", newProjects: [],   // 新建对话的选择（还没落盘）
  candIndex: -1,            // 存候选 modal 正在处理的消息序号
  candTarget: "role",       // 候选归属：role=角色候选 / project=主项目候选
  provider: localStorage.getItem("ownward-chat-provider") || "claude",
  model: localStorage.getItem("ownward-chat-model") || "sonnet",
  /** 角色页「与这个角色对话」入口：开一个新对话并预选角色 + 全部关联项目 */
  startWithRole(role) {
    stashChatComposer();
    if (!Chat.roles.some((r) => r.id === role.id)) Chat.roles = [...Chat.roles, role];
    Chat.openSeq++;
    Chat.sel = null; Chat.msgs = []; Chat.binding = null;
    restoreChatComposer();
    Chat.newRole = role.id;
    Chat.newProjects = chatDefaultProjects(role);
    $("#chat-root").dataset.mobileView = "detail";
    renderChatMsgs(); renderChatList(); renderChatBind();
    loadChatRoles();
    $("#ch-input").focus();
  },
};

TABS.chat = {
  init(root) {
    root.innerHTML = `
      <div class="col chat-list-col">
        <div class="page-head compact">
          <div><div class="eyebrow">CONVERSATIONS</div><h1>对话</h1><p>延续历史，或开启一次新的思考</p></div>
          <div class="tools"><button class="button secondary sm" id="ch-new">新对话</button></div>
        </div>
        <div class="col-scroll panel" id="ch-list"></div>
      </div>
      <div class="col chat-detail-col">
        <div class="chat-context">
          <button class="button ghost sm chat-back" id="ch-back">← 对话</button>
          <div class="chat-models"><select id="ch-provider" aria-label="对话供应商"></select><select id="ch-model" aria-label="对话模型"></select></div>
          <details class="chat-more">
            <summary class="button ghost sm">更多</summary>
            <div class="chat-more-menu">
              <button class="button ghost sm" id="ch-rename">重命名</button>
              <button class="button ghost sm" id="ch-del">删除</button>
            </div>
          </details>
        </div>
        <div class="chat-bind" id="ch-bind"></div>
        <div class="panel session-pane">
          <div class="session-scroll" id="ch-scroll"><div class="empty">新对话，或从左侧选择历史</div></div>
          <div class="composer">
            <div class="composer-box">
              <div class="composer-imgs" id="ch-imgs"></div>
              <textarea id="ch-input" rows="1" placeholder="问点什么（Enter 发送，Shift+Enter 换行）"></textarea>
              <div class="composer-bar">
                <button class="icon-btn" id="ch-attach" title="添加图片（也可粘贴 / 拖入）">🖼</button>
                <span class="hint">Enter 发送 · Shift+Enter 换行 · 可粘贴图片</span>
                <span class="spacer"></span>
                <button class="button primary" id="ch-send">发送</button>
              </div>
            </div>
            <input type="file" id="ch-file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" multiple hidden>
          </div>
        </div>
      </div>`;
    $("#ch-new").addEventListener("click", () => {
      stashChatComposer();
      Chat.openSeq++; Chat.sel = null; Chat.msgs = []; Chat.binding = null;
      Chat.newRole = ""; Chat.newProjects = [];
      restoreChatComposer();
      root.dataset.mobileView = "detail";
      renderChatMsgs(); renderChatList(); renderChatBind(); $("#ch-input").focus();
    });
    $("#ch-back").addEventListener("click", () => { root.dataset.mobileView = "list"; });
    $("#ch-send").addEventListener("click", sendChat);
    const ci = $("#ch-input");
    ci.addEventListener("input", () => { ci.style.height = "auto"; ci.style.height = Math.min(ci.scrollHeight, 200) + "px"; ComposerDrafts.setText(chatDraftKey(), ci.value); });
    // 只要 Enter 发送 + ↑ 翻历史：对话走的是裸模型，没有斜杠命令可补全
    bindComposer(ci, { key: chatDraftKey, send: sendChat });
    bindChatImages(ci);
    restoreChatComposer();
    $("#ch-rename").addEventListener("click", async () => {
      if (!Chat.sel) return;
      const title = prompt("新标题：", Chat.list.find((c) => c.id === Chat.sel)?.title || "");
      if (!title) return;
      await post("/api/chat/rename", { id: Chat.sel, title });
      loadChatList();
    });
    $("#ch-del").addEventListener("click", async () => {
      if (!Chat.sel || !confirm("删除这个对话？")) return;
      const deletingId = Chat.sel;
      Chat.openSeq++;  // 先让尚未返回的历史读取失效，不能等删除请求结束后才清空
      await post("/api/chat/delete", { id: deletingId });
      if (Chat.sel === deletingId) { ComposerDrafts.clearText(`chat:${deletingId}`); clearChatImages(); Chat.sel = null; Chat.msgs = []; restoreChatComposer(); renderChatMsgs(); }
      loadChatList();
    });
    $("#ch-provider").addEventListener("change", () => { Chat.provider = $("#ch-provider").value; localStorage.setItem("ownward-chat-provider", Chat.provider); fillModels(); });
    $("#ch-model").addEventListener("change", () => { Chat.model = $("#ch-model").value; localStorage.setItem("ownward-chat-model", Chat.model); });
    bindCandModal();
    renderChatBind();
    loadProviders(); loadChatList(); loadChatRoles();
  },
  // 切回来重拉角色：可能刚在角色页建了新角色或改了项目关联
  show() { if (Chat.rolesLoaded) loadChatRoles(); },
};

async function loadProviders() {
  Chat.providers = await getJSON("/api/chat/providers").catch(() => ({ claude: ["sonnet"] }));
  $("#ch-provider").innerHTML = Object.keys(Chat.providers).map((p) => `<option ${p === Chat.provider ? "selected" : ""}>${esc(p)}</option>`).join("");
  if (!Chat.providers[Chat.provider]) Chat.provider = Object.keys(Chat.providers)[0];
  fillModels();
}
function fillModels() {
  const models = Chat.providers[Chat.provider] || [];
  $("#ch-model").innerHTML = models.map((m) => `<option ${m === Chat.model ? "selected" : ""}>${esc(m)}</option>`).join("");
  if (!models.includes(Chat.model)) Chat.model = models[0] || "";
}
async function loadChatList() {
  Chat.listError = "";
  try { Chat.list = await getJSON("/api/chat/list"); Chat.listLoaded = true; }
  catch { Chat.listError = "对话历史暂时无法载入"; }
  renderChatList();
}
function renderChatList() {
  if (!$("#ch-list")) return;
  const roleTag = (c) => {
    if (!c.roleId) return "";
    const r = Chat.roles.find((x) => x.id === c.roleId);
    return `<span class="role-chip" style="--rc:${chatRoleColor(r)}">${esc(r?.name || c.roleId)}</span>`;
  };
  $("#ch-list").innerHTML = Chat.listError && !Chat.list.length ? stateBox(Chat.listError, "error") : Chat.list.length ? Chat.list.map((c) => `
    <div class="chat-item" data-on="${Chat.sel === c.id}" onclick="openChat('${jsq(c.id)}')">
      <div class="t">${esc(c.title || "(无标题)")}</div>
      <div class="m"><span>${roleTag(c)}${esc(c.provider || "claude")}/${esc(c.model)}</span><span>${ageText(c.updatedAt)}</span></div>
    </div>`).join("") : stateBox(Chat.listLoaded ? "还没有对话" : "正在载入对话…", Chat.listLoaded ? "empty" : "loading");
}
async function openChat(id) {
  const seq = ++Chat.openSeq;
  if (Chat.sel !== id) stashChatComposer();
  Chat.sel = id;
  restoreChatComposer();
  $("#chat-root").dataset.mobileView = "detail";
  $("#ch-scroll").innerHTML = stateBox("正在载入会话…", "loading");
  const c = await getJSON(`/api/chat/messages?id=${encodeURIComponent(id)}`).catch(() => null);
  if (seq !== Chat.openSeq || Chat.sel !== id) return;
  if (!c) { $("#ch-scroll").innerHTML = stateBox("会话暂时无法载入", "error"); renderChatList(); return; }
  Chat.msgs = c?.messages || [];
  Chat.binding = c?.binding || null;
  renderChatList(); renderChatMsgs(); renderChatBind();
}
function renderChatMsgs(partial) {
  const sc = $("#ch-scroll");
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  // 「存为角色候选」只在绑了角色（且角色还在）的对话里出现；流式中的半截回复不给按钮
  const canSave = !!(Chat.sel && Chat.binding && !Chat.binding.missing);
  sc.innerHTML = (Chat.msgs.map((m, i) => `
    <div class="msg" data-role="${m.role === "user" ? "user" : "assistant"}">
      <div class="who">${m.role === "user" ? "我" : "AI"}</div>
      ${msgImgsHtml(m)}
      <div class="bubble">${m.role === "user" ? esc(m.text) : mdHtml(m.text)}</div>
      ${canSave && m.role !== "user" && !Chat.sending?.has(chatDraftKey())
        ? `<div class="msg-actions"><button class="button ghost sm" onclick="openCandModal(${i})">存为候选</button></div>` : ""}
    </div>`).join("") || `<div class="empty">新对话</div>`) +
    (partial !== undefined ? `<div class="msg" data-role="assistant"><div class="who">AI</div><div class="bubble partial">${mdHtml(partial)}</div></div>` : "");
  if (nearBottom || partial !== undefined) sc.scrollTop = sc.scrollHeight;
}

/* ============ 图片附件（发送前预览 / 历史消息展示） ============ */
// 限制与后端 chat-images.ts 逐条对应：前端先拦是体验（不让用户白等一次上传），
// 后端那份才是保证——两边都得有，谁少一层都不算数
const CH_IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const CH_IMG_MAX = 6;
const CH_IMG_BYTES = 5 * 1024 * 1024;
const CH_IMG_TOTAL = 12 * 1024 * 1024;
const chMb = (n) => `${(n / 1048576).toFixed(1)}MB`;

/** 历史消息里的图：走只读接口按 id 取（消息里只有元数据，没有 base64）；
 *  刚在本地挑好还没落盘的用 blob 预览 url。 */
function chatImgSrc(im) {
  if (im.url) return im.url;
  return `/api/chat/image?chat_id=${encodeURIComponent(Chat.sel || "")}&id=${encodeURIComponent(im.id || "")}`;
}
function msgImgsHtml(m) {
  return imageThumbsHtml((m.images || []).map(chatImgSrc), safeChatImageUrl);
}

function bindChatImages(input) {
  $("#ch-attach").addEventListener("click", () => $("#ch-file").click());
  $("#ch-file").addEventListener("change", (e) => { [...e.target.files].forEach(addChatImage); e.target.value = ""; });
  input.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!items.length) return;   // 纯文本粘贴照旧走浏览器默认行为
    e.preventDefault();
    items.forEach((it) => addChatImage(it.getAsFile()));
  });
  const box = input.closest(".composer-box");
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.dataset.drop = "true"; });
  box.addEventListener("dragleave", () => { box.dataset.drop = "false"; });
  box.addEventListener("drop", (e) => {
    e.preventDefault(); box.dataset.drop = "false";
    [...(e.dataTransfer?.files || [])].forEach((f) => addChatImage(f));
  });
}

/** 挑一张图：类型/大小逐条判 → HEIC 先转码 → 超限先缩 → base64 进待发列表。
 *  每一条拒绝都给原话（哪张、为什么），不静默丢掉。 */
async function addChatImage(file) {
  if (!file) return;
  const key = chatDraftKey();
  const target = ComposerDrafts.getAttachments(key);
  if (target.length >= CH_IMG_MAX) { toast(`一条消息最多 ${CH_IMG_MAX} 张图`); return; }
  // HEIC 按 type + 扩展名双判：某些拖拽路径下 file.type 是空串（同 skin.js）
  const isHeic = /^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name || "");
  if (!isHeic && !CH_IMG_TYPES.includes(file.type)) { toast("只支持 PNG / JPEG / WebP / GIF / HEIC"); return; }
  if (file.size > 20 * 1024 * 1024) { toast(`图片太大（${chMb(file.size)}），先压缩一下`); return; }
  try {
    let blob = file;
    let type = file.type;
    if (isHeic) {   // Chromium 解不了 HEIC：丢给 daemon 用 macOS sips 转 jpeg（与皮肤壁纸同一条实现）
      toast("HEIC 转码中…");
      const r = await fetch("/api/chat/convert-heic", { method: "POST", body: file });
      if (!r.ok) { toast((await r.json().catch(() => null))?.msg || "HEIC 转换失败"); return; }
      blob = await r.blob();
      type = "image/jpeg";
    }
    if (blob.size > CH_IMG_BYTES) {
      const small = await shrinkChatImage(blob, type);
      if (!small) { toast(`单张不能超过 ${chMb(CH_IMG_BYTES)}（${chMb(blob.size)}），先压缩一下`); return; }
      toast(`图片较大（${chMb(blob.size)}），已压缩后附上`);   // 改了内容就明说，不偷偷换掉用户的图
      blob = small; type = "image/jpeg";
    }
    const total = target.reduce((n, i) => n + i.size, 0) + blob.size;
    if (total > CH_IMG_TOTAL) { toast(`图片合计不能超过 ${chMb(CH_IMG_TOTAL)}，少发几张`); return; }
    const data = await blobToBase64(blob);
    target.push({ media_type: type, data, size: blob.size, url: URL.createObjectURL(blob) });
    ComposerDrafts.setAttachments(key, target);
    if (chatDraftKey() === key) { Chat.images = target; renderChatThumbs(); }
  } catch (e) { toast(`读取图片失败：${String(e).slice(0, 80)}`); }
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const rd = new FileReader();
  rd.onload = () => res(String(rd.result).split(",")[1] || "");
  rd.onerror = () => rej(rd.error || new Error("读取失败"));
  rd.readAsDataURL(blob);
});

/** 超限图片的兜底压缩：最长边 1920 的 jpeg。GIF 不碰——重编码会把动图拍成一张静图，
 *  那不是"压缩"，是换了张图（宁可让用户明确知道超限）。 */
async function shrinkChatImage(blob, type) {
  if (type === "image/gif") return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("解码失败"));
      el.src = url;
    });
    const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.7]) {
      const out = await new Promise((res) => c.toBlob(res, "image/jpeg", q));
      if (out && out.size <= CH_IMG_BYTES) return out;
    }
    return null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

function renderChatThumbs() {
  const box = $("#ch-imgs");
  if (!box) return;
  box.innerHTML = Chat.images.map((im, i) =>
    `<div class="thumb" title="${chMb(im.size)}">
      <img src="${esc(im.url)}" alt="">
      <button title="移除" onclick="removeChatImage(${i})">✕</button>
    </div>`).join("");
}
function removeChatImage(i) {
  const [gone] = Chat.images.splice(i, 1);
  if (gone) URL.revokeObjectURL(gone.url);
  ComposerDrafts.setAttachments(chatDraftKey(), Chat.images);
  renderChatThumbs();
}
/** 清空待发图片（换对话/发送成功）：blob url 要还回去，不然这一页一直占着内存 */
function clearChatImages() {
  for (const im of Chat.images) URL.revokeObjectURL(im.url);
  Chat.images = [];
  ComposerDrafts.setAttachments(chatDraftKey(), []);
  renderChatThumbs();
}

function chatDraftKey() { return Chat.sel ? `chat:${Chat.sel}` : "chat:new"; }
function stashChatComposer() {
  const key = chatDraftKey(), input = $("#ch-input");
  if (input) ComposerDrafts.setText(key, input.value);
  ComposerDrafts.setAttachments(key, Chat.images);
}
function restoreChatComposer() {
  const key = chatDraftKey(), input = $("#ch-input");
  Chat.images = ComposerDrafts.getAttachments(key);
  if (input) { input.value = ComposerDrafts.getText(key); input.dispatchEvent(new Event("input")); }
  if ($("#ch-send")) $("#ch-send").disabled = !!Chat.sending?.has(key);
  renderChatThumbs();
}

/* ============ 角色绑定（新建时可选，落盘后只读） ============ */
const CHAT_HEX = /^#[0-9a-fA-F]{6}$/;
const chatRoleColor = (r) => (CHAT_HEX.test(String(r?.color || "")) ? String(r.color) : "#7f8a99");
const chatIsExpert = (r) => !!(r && r.type === "project" && r.primaryProject);
const CHAT_TYPE_LABEL = { lead: "职能负责人", project: "项目专家" };
/** 选中角色时的默认项目范围：全部关联项目；项目专家的主项目排头且必在 */
function chatDefaultProjects(role) {
  const all = [...(role?.projects || [])];
  if (!chatIsExpert(role)) return all;
  return [role.primaryProject, ...all.filter((s) => s !== role.primaryProject)];
}

async function loadChatRoles() {
  const r = await getJSON("/api/roles").catch(() => null);
  if (!r?.ok) return;   // 拉不到就静默保持上次结果：普通对话不该被角色接口拖累
  Chat.roles = r.roles || [];
  Chat.rolesLoaded = true;
  // 选中的角色被归档/删掉了 → 清掉选择，避免发出去才报错
  if (Chat.newRole && !Chat.roles.some((x) => x.id === Chat.newRole)) { Chat.newRole = ""; Chat.newProjects = []; }
  renderChatBind(); renderChatList();
}

function renderChatBind() {
  const box = $("#ch-bind");
  if (!box) return;
  // 已有对话：绑定是创建时定死的，这里只如实展示（含角色被改/被删的实况）
  if (Chat.sel) {
    const b = Chat.binding;
    if (!b) { box.innerHTML = ""; box.dataset.mode = "none"; return; }
    box.dataset.mode = "fixed";
    // 类型/主项目一律来自后端给的**绑定快照**：这里回答的是"这段对话在什么前提下发生的"，
    // 不是"这个角色现在长什么样"——角色后来改了型/换了主项目，历史不跟着变
    const expert = chatIsExpert(b);
    const dropped = (b.projectIds || []).filter((s) => !(b.injectedProjects || []).includes(s));
    const notes = [];
    if (b.missing) notes.push(b.msg || "这个角色在 vault 里找不到了——恢复目录，或另开一个对话（这个对话发不出去）");
    else if (b.status === "archived") notes.push("角色已归档：历史对话可以继续，但开不了新的角色对话");
    if (b.bindNote) notes.push(b.bindNote);
    if (dropped.length) notes.push(`${dropped.join("、")} 已从角色解除关联，这轮不会注入`);
    const inject = (b.injectedProjects || []).map((s) =>
      s === b.primaryProject && expert ? `${s}（主项目）` : s);
    box.innerHTML = `
      <span class="role-chip" style="--rc:${chatRoleColor(b)}">${esc(b.name || b.roleId)}</span>
      ${b.type ? `<span class="bind-kind" data-kind="${expert ? "expert" : "lead"}">${esc(CHAT_TYPE_LABEL[b.type] || b.type)}</span>` : ""}
      ${b.legacy ? `<span class="bind-text">旧对话 · 项目范围按创建时固定</span>` : ""}
      ${expert && b.parentRoleId ? `<span class="bind-text">上级 ${esc(b.parentName || b.parentRoleId)}</span>` : ""}
      <span class="bind-text">注入项目：${inject.length ? esc(inject.join("、")) : "无（只用角色自身记忆）"}</span>
      <span class="bind-lock">创建后不可更改</span>
      ${notes.map((n) => `<span class="bind-warn">${esc(n)}</span>`).join("")}`;
    return;
  }
  // 新建对话：可选角色 + 缩小项目范围（项目专家的主项目锁死，取消不了）
  box.dataset.mode = "new";
  const active = Chat.roles.filter((r) => r.status !== "archived" && !r.conflict);
  const role = active.find((r) => r.id === Chat.newRole) || null;
  const expert = chatIsExpert(role);
  const projects = role ? chatDefaultProjects(role) : [];
  const chip = (s) => (expert && s === role.primaryProject
    ? `<button type="button" class="chip" data-on="true" data-static="true" title="项目专家的主项目必注入，不能取消"
        onclick="toast('主项目必注入：项目专家就是围着它工作的')">${esc(s)} · 主项目</button>`
    : `<button type="button" class="chip" data-on="${Chat.newProjects.includes(s)}" onclick="toggleChatProject('${jsq(s)}')">${esc(s)}</button>`);
  box.innerHTML = `
    <label class="bind-label" for="ch-role">角色</label>
    <select id="ch-role" aria-label="对话角色">
      <option value="">不用角色（普通对话）</option>
      ${active.map((r) => `<option value="${esc(r.id)}" ${r.id === Chat.newRole ? "selected" : ""}>${esc(r.name || r.id)}${r.type === "project" ? "（项目专家）" : ""}</option>`).join("")}
    </select>
    ${role
      ? `<span class="bind-kind" data-kind="${expert ? "expert" : "lead"}">${esc(CHAT_TYPE_LABEL[expert ? "project" : "lead"])}</span>
         ${projects.length
          ? `<span class="bind-text">注入项目</span>
             <span class="pick-row inline">${projects.map(chip).join("")}</span>`
          : `<span class="bind-text">这个角色还没关联项目，只注入它自己的原则/决策/待办</span>`}`
      : (Chat.rolesLoaded && !active.length
        ? `<span class="bind-text">还没有角色 · <a href="#" onclick="switchTab('roles');return false">去建一个</a></span>`
        : `<span class="bind-text">选角色后，对话会带上它的原则、决策、待办</span>`)}`;
  $("#ch-role").addEventListener("change", () => {
    Chat.newRole = $("#ch-role").value;
    const r = Chat.roles.find((x) => x.id === Chat.newRole);
    Chat.newProjects = r ? chatDefaultProjects(r) : [];   // 默认全选，用户可再缩小（主项目除外）
    renderChatBind();
  });
}
function toggleChatProject(slug) {
  const role = Chat.roles.find((r) => r.id === Chat.newRole);
  if (chatIsExpert(role) && slug === role.primaryProject) { toast("主项目必注入：项目专家就是围着它工作的"); return; }
  Chat.newProjects = Chat.newProjects.includes(slug)
    ? Chat.newProjects.filter((s) => s !== slug)
    : [...Chat.newProjects, slug];
  renderChatBind();
}

/* ============ 存为候选（人工门入口：只写 _candidates/） ============ */
const CAND_MAX = 1000;   // 与后端 MAX_CANDIDATE_TEXT 一致；超了后端会明确拒，这里先提示
function bindCandModal() {
  const ov = $("#cand-overlay");
  const count = () => {
    const n = [...$("#cd-text").value.trim()].length;
    $("#cd-count").textContent = `${n} / ${CAND_MAX}`;
    $("#cd-count").dataset.over = String(n > CAND_MAX);
  };
  $("#cd-text").addEventListener("input", count);
  $("#cd-cancel").addEventListener("click", () => (ov.dataset.open = "false"));
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.dataset.open = "false"; });
  $("#cd-save").addEventListener("click", saveCandidate);
}
function openCandModal(index) {
  const m = Chat.msgs[index];
  const b = Chat.binding;
  if (!m || !b || b.missing) { toast("这个对话没有可用的角色绑定"); return; }
  Chat.candIndex = index;
  Chat.candTarget = "role";      // 缺省存角色：跟 V1 一致，选项目是显式动作
  renderCandTarget();
  $("#cd-text").value = m.text.trim();
  $("#cd-text").dispatchEvent(new Event("input"));
  $("#cand-overlay").dataset.open = "true";
  $("#cd-text").focus();
}
/** 归属选择只在项目专家对话里出现（负责人没有主项目，选了也没处放） */
function renderCandTarget() {
  const b = Chat.binding || {};
  const expert = chatIsExpert(b);
  $("#cd-target-wrap").style.display = expert ? "" : "none";
  if (expert) {
    const opts = [
      { key: "role", label: `角色「${b.name || b.roleId}」` },
      { key: "project", label: `项目「${b.primaryProject}」` },
    ];
    $("#cd-targets").innerHTML = opts.map((o) =>
      `<button type="button" class="chip" data-on="${Chat.candTarget === o.key}" onclick="pickCandTarget('${jsq(o.key)}')">${esc(o.label)}</button>`).join("");
  }
  $("#cd-note").textContent = !expert
    ? `存到角色「${b.name || b.roleId}」的候选记忆。太长就改写成一句结论（${CAND_MAX} 字以内）。`
    : Chat.candTarget === "project"
      ? `存到项目「${b.primaryProject}」的候选：只对这个项目成立的事实/决策/运维，晋升后写进项目 README·decisions·operations。`
      : `存到角色「${b.name || b.roleId}」的候选：换个项目也成立的原则/决策/待办，晋升后写进角色记忆。`;
}
function pickCandTarget(key) {
  Chat.candTarget = key === "project" ? "project" : "role";
  renderCandTarget();
}
async function saveCandidate() {
  const text = $("#cd-text").value.trim();
  if (!text) { toast("候选内容不能为空"); return; }
  if (!Chat.sel || Chat.candIndex < 0) { toast("对话状态已变，重新点一次"); return; }
  $("#cd-save").disabled = true;
  const res = await post("/api/chat/save-candidate", {
    chat_id: Chat.sel, index: Chat.candIndex, text, target: Chat.candTarget,
  });
  $("#cd-save").disabled = false;
  toast(res.msg || (res.ok ? "已存为候选" : "保存失败"));
  if (res.ok) { $("#cand-overlay").dataset.open = "false"; Chat.candIndex = -1; }
}

async function sendChat() {
  const sendKey = chatDraftKey();
  if ((Chat.sending ||= new Set()).has(sendKey)) { toast("这条对话的上一条还在生成"); return; }
  const input = $("#ch-input");
  const draftSnapshot = input.value;
  const text = draftSnapshot.trim();
  const pics = Chat.images;
  if (!text && !pics.length) return;
  input.value = "";
  input.style.height = "auto";
  // 纯图片发送的默认提示语与后端 defaultImageText 一致：气泡上写的必须是真发出去的那句
  const shown = text || (pics.length > 1 ? "看一下这几张图" : "看一下这张图");
  Chat.images = [];
  ComposerDrafts.setAttachments(sendKey, []);
  renderChatThumbs();
  Chat.msgs.push({
    role: "user", text: shown, ts: new Date().toISOString(),
    ...(pics.length ? { images: pics.map((im) => ({ url: im.url })) } : {}),
  });
  const sendMsgs = Chat.msgs;
  Chat.sending.add(sendKey);
  $("#ch-send").disabled = true;
  renderChatMsgs("");
  let acc = "";
  let status = "";  // 联网工具进行时的状态行（tool 事件），有正文后不再显示
  const paint = () => paintChatSend(sendKey, createdId, acc + (!acc && status ? `⟳ ${status}…` : ""));
  // 角色只在新建那一刻带上；已有对话不重发绑定（后端对改绑一律报错，不静默忽略）
  const isNew = !Chat.sel;
  const bind = isNew && Chat.newRole ? { role_id: Chat.newRole, project_ids: Chat.newProjects } : {};
  let createdId = "";
  let landed = false;   // 收到 done = 后端真落盘了（没有 done 就是这轮什么都没存下来）
  let failMsg = "";
  const pendingAt = Chat.msgs.length - 1;   // 刚推的那条本地气泡（按序号撤，别按文本找：同样的话可能发过好几次）
  try {
    const res = await fetch("/api/chat/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Chat.sel || undefined, text, provider: Chat.provider, model: Chat.model, ...bind,
        ...(pics.length ? { images: pics.map(({ media_type, data }) => ({ media_type, data })) } : {}),
      }),
    });
    // 4xx 的正文是 {ok:false,msg}（角色被归档/项目没关联等），把后端原话透出去——
    // 只报 HTTP 400 的话，用户根本不知道是绑定被拒还是服务挂了
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error(j?.msg || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("响应没有数据流");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "delta" && ev.text) { acc += ev.text; paint(); }
        else if (ev.type === "tool" && ev.text) { status = ev.text; paint(); }  // 「联网搜索：xxx」，避免长工具调用看着像卡死
        else if (ev.type === "error") { failMsg = ev.msg || "发送失败"; acc += `\n[错误] ${ev.msg}`; paint(); }
        else if (ev.type === "done" && ev.chat) {
          if (isNew) createdId = ev.chat.id;
          sendMsgs.splice(0, sendMsgs.length, ...ev.chat.messages);   // 服务端真相：图片换成受控 id 引用
          if (chatDraftKey() === sendKey) {
            Chat.sel = ev.chat.id;
            Chat.msgs = sendMsgs;
          }
          landed = true;
        }
      }
    }
  } catch (e) {
    sendMsgs.push({ role: "assistant", text: `[请求失败] ${e}`, ts: new Date().toISOString() });
  } finally {
    Chat.sending.delete(sendKey);
    if (chatSendOwnsView(sendKey, createdId)) $("#ch-send").disabled = false;
    if (landed) {
      composerSent(createdId ? `chat:${createdId}` : sendKey, text);
      ComposerDrafts.clearText(sendKey, draftSnapshot);
      if (createdId) { ComposerDrafts.moveText(sendKey, `chat:${createdId}`); ComposerDrafts.moveAttachments(sendKey, `chat:${createdId}`); }
      for (const im of pics) URL.revokeObjectURL(im.url);   // 已经能按 id 取图，预览可以还回去
    } else {
      // 没有 done = 后端一个字都没落盘（用户消息、附件都回滚了）。
      // 本地也要退回发送前：撤掉那条气泡，内容与图片放回输入框，点一下就能重发
      // 用发送前记下的序号撤回，不能按文本找：相同问题可能在历史里出现多次。
      if (sendMsgs[pendingAt]?.role === "user") sendMsgs.splice(pendingAt, 1);
      if (!ComposerDrafts.getText(sendKey)) ComposerDrafts.setText(sendKey, draftSnapshot);
      ComposerDrafts.setAttachments(sendKey, [...pics, ...ComposerDrafts.getAttachments(sendKey)].slice(0, CH_IMG_MAX));
      if (chatDraftKey() === sendKey) restoreChatComposer();
      if (failMsg && chatSendOwnsView(sendKey, createdId)) toast(failMsg);
    }
    // 新对话刚落盘：绑定详情（角色名/真正注入的项目）以后端为准，不在前端拼一份平行逻辑
    if (createdId) { Chat.newRole = ""; Chat.newProjects = []; await loadChatBinding(createdId); }
    if (chatSendOwnsView(sendKey, createdId)) {
      Chat.msgs = sendMsgs;
      renderChatMsgs(); renderChatBind();
    }
    loadChatList();
  }
}

/** 流式请求只能绘制它发起时的 composer；chat:new 落盘后允许新 id 接续同一视图。 */
function chatSendOwnsView(sendKey, createdId = "") {
  return chatDraftKey() === sendKey || !!createdId && Chat.sel === createdId;
}
function paintChatSend(sendKey, createdId, partial) {
  if (!chatSendOwnsView(sendKey, createdId)) return false;
  renderChatMsgs(partial);
  return true;
}

/** 只取绑定详情（消息已经在手上）；对话已被切走就丢弃结果 */
async function loadChatBinding(id) {
  const c = await getJSON(`/api/chat/messages?id=${encodeURIComponent(id)}`).catch(() => null);
  if (Chat.sel !== id) return;
  Chat.binding = c?.binding || null;
}
