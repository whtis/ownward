"use strict";
/* 角色 tab：vault <scope>/roles/ 里的持久化一等对象。左栏组织树，右栏详情。
 *
 * 这个页面是三道人工审批门之一的落地处：候选记忆（角色的和项目的）只能由人点「晋升」
 * 才写进正式 markdown，页面上没有任何自动晋升/自动写入的路径，加功能时也别加。
 * 角色只归档不删除——历史对话还引着它，markdown 也是用户自己的资产。
 *
 * V2 的两层组织：职能负责人（lead）管跨项目原则，项目专家（project）绑一个主项目当开发入口。
 * 项目知识不复制进角色：项目候选落在 projects/<主项目>/_candidates/，晋升目标是
 * README/decisions/operations 三份项目文件。
 *
 * 数据全部来自 /api/roles/*；正式记忆的内容走 /api/vault/file 只读预览，
 * 编辑一律跳去笔记 tab（daemon 那边路径校验锁死 vault 内 .md）。 */

const Roles = {
  list: [], sel: null, role: null, candidates: [],
  org: null, projectCandidates: [], projectCandidatesMsg: "",
  icons: [], targets: ["principles", "decisions", "backlog"],
  projectTargets: ["README", "decisions", "operations"],
  showArchived: false, loaded: false, listError: "",
  scopesOn: false, scopesLoaded: false, scopes: [""], projectCache: {},   // scope → slug[]（请求失败时的兜底）
  openSeq: 0, editing: null,                          // editing: 角色 id = 编辑，null = 新建
};

/* icon 是后端白名单枚举（ROLE_ICONS），这里只做「枚举值 → 内置 svg 路径」的查表：
 * 手改坏的 role.json 拿不到任意标记，查不到就退回 star。 */
const ROLE_ICON_PATHS = {
  star: `<path d="M10 3.4l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 14.2l-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z"/>`,
  code: `<path d="M7.6 6.6L4.1 10l3.5 3.4"/><path d="M12.4 6.6L15.9 10l-3.5 3.4"/><path d="M11.2 4.9l-2.4 10.2"/>`,
  design: `<path d="M10 3.5a6.5 6.5 0 1 0 0 13h1a1.6 1.6 0 0 0 0-3.2h-.8a1.15 1.15 0 0 1 0-2.3h2.9a3.2 3.2 0 0 0 3.2-3.2C16.3 5.4 13.6 3.5 10 3.5Z"/><circle cx="6.6" cy="8.2" r=".85"/><circle cx="9" cy="6.1" r=".85"/><circle cx="12.2" cy="6.4" r=".85"/>`,
  product: `<path d="M10 3.3l6 2.9v7.6l-6 2.9-6-2.9V6.2z"/><path d="M4 6.2l6 2.9 6-2.9"/><path d="M10 9.1v7.6"/>`,
  research: `<circle cx="9" cy="9" r="4.6" style="fill:none;stroke:currentColor"/><path d="M12.5 12.5l3.7 3.7"/>`,
  ops: `<circle cx="10" cy="10" r="2.6" style="fill:none;stroke:currentColor"/><path d="M10 2.8v2.2M10 15v2.2M2.8 10h2.2M15 10h2.2M5 5l1.6 1.6M13.4 13.4L15 15M15 5l-1.6 1.6M6.6 13.4L5 15"/>`,
  write: `<path d="M13.4 3.9l2.7 2.7L7.5 15.2l-3.5.8.8-3.5z"/><path d="M11.9 5.4l2.7 2.7"/>`,
  growth: `<path d="M3.6 14.4l4.1-4.6 2.9 2.5 5.8-6.2"/><path d="M12.6 6.1h3.8v3.8"/>`,
  finance: `<path d="M10 3.4v13.2"/><path d="M13.4 6.2H8.6a2.1 2.1 0 0 0 0 4.2h2.8a2.1 2.1 0 0 1 0 4.2H6.6"/>`,
  life: `<path d="M10 16.3S4.2 12.6 4.2 8.9a3.2 3.2 0 0 1 5.8-1.8 3.2 3.2 0 0 1 5.8 1.8c0 3.7-5.8 7.4-5.8 7.4z"/>`,
};
const ROLE_ICON_LABEL = {
  star: "通用", code: "研发", design: "设计", product: "产品", research: "研究",
  ops: "运维", write: "写作", growth: "增长", finance: "财务", life: "生活",
};
/* 内置模板只是「预填表单」，落盘后与手工建的角色完全一样（不存在模板类型）。
 * type 缺省是 lead：项目专家的主项目只有用户知道，模板不该替他选。 */
const ROLE_TEMPLATES = [
  {
    id: "dev", name: "研发", icon: "code", color: "#5b8def",
    description: "负责工程实现与技术取舍",
    instructions: "负责：架构取舍、实现方案、代码质量、上线风险。\n不负责：需求优先级、视觉细节、商务判断。\n回答先给结论和做法，再说风险，不确定就直说不确定。",
  },
  {
    id: "design", name: "设计", icon: "design", color: "#c07ae0",
    description: "负责界面与体验的一致性",
    instructions: "负责：信息层级、交互流程、视觉一致性、可用性。\n不负责：技术实现细节、排期。\n给方案时说清取舍理由，别只给形容词。",
  },
  {
    id: "product", name: "产品", icon: "product", color: "#4fb391",
    description: "负责做什么、先做什么",
    instructions: "负责：需求价值判断、优先级、范围边界、验收标准。\n不负责：具体实现方案、视觉细节。\n先问「解决谁的什么问题」，再谈方案。",
  },
];
const ROLE_COLORS = ["#5b8def", "#4fb391", "#c07ae0", "#e0925b", "#e06b7a", "#4fb0c0", "#9a8ce0", "#7f8a99"];
/* 正式记忆三件套：注入对话的就是这三份 + 本次选中的项目 README */
const ROLE_DOCS = [
  { key: "principles", file: "principles.md", title: "原则", hint: "做判断时的稳定准则，每轮对话都会注入" },
  { key: "decisions", file: "decisions.md", title: "决策", hint: "已经拍板的事和理由，避免重复讨论" },
  { key: "backlog", file: "backlog.md", title: "待办", hint: "这个角色视角下待推进的事" },
];
const TARGET_LABEL = { principles: "原则", decisions: "决策", backlog: "待办" };
/* 项目知识三件套：候选晋升的唯一去处，文件名与后端白名单逐字一致 */
const PROJ_DOCS = [
  { key: "README", file: "README.md", title: "项目现状", hint: "架构与稳定事实，项目的唯一真相" },
  { key: "decisions", file: "decisions.md", title: "项目决策", hint: "已经拍板的技术选择和理由" },
  { key: "operations", file: "operations.md", title: "部署与排障", hint: "怎么发、怎么配、坏了怎么查" },
];
const PROJ_TARGET_LABEL = { README: "项目现状", decisions: "项目决策", operations: "部署与排障" };
const ROLE_TYPE_LABEL = { lead: "职能负责人", project: "项目专家" };
const roleType = (r) => (r && r.type === "project" ? "project" : "lead");   // 旧 role.json 没有 type = lead

const R_HEX = /^#[0-9a-fA-F]{6}$/;
/** 颜色直接进 style，手改坏的 role.json 不能带任意 CSS 进来——不合法就退默认 */
const roleColor = (c) => (R_HEX.test(String(c || "")) ? String(c) : "#5b8def");
const roleIcon = (name) => ROLE_ICON_PATHS[name] ? name : "star";
function roleIconSvg(name) {
  return `<svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">${ROLE_ICON_PATHS[roleIcon(name)]}</svg>`;
}
function roleAvatar(role, size) {
  const c = roleColor(role.color);
  return `<span class="role-avatar" data-size="${size === "lg" ? "lg" : "sm"}" style="--rc:${c}">${roleIconSvg(role.icon)}</span>`;
}
const scopeLabel = (s) => (s === "work" ? "工作" : s === "private" ? "私人" : "");

TABS.roles = {
  init(root) {
    root.innerHTML = `
      <div class="col roles-list-col">
        <div class="page-head compact">
          <div><div class="eyebrow">ROLES</div><h1>角色</h1><p>带长期记忆的身份：原则、决策、待办</p></div>
          <div class="tools">
            <button class="button ghost sm" id="rl-arch" aria-pressed="false">含归档</button>
            <button class="button secondary sm" id="rl-new">新建角色</button>
          </div>
        </div>
        <div class="col-scroll panel" id="rl-list"></div>
      </div>
      <div class="col roles-detail-col">
        <div class="roles-context">
          <button class="button ghost sm roles-back" id="rl-back">← 角色</button>
          <div class="rl-crumb" id="rl-crumb">选择左侧角色，或新建一个</div>
          <div class="tools" id="rl-tools"></div>
        </div>
        <div class="col-scroll panel" id="rl-detail"></div>
      </div>`;
    $("#rl-back").addEventListener("click", () => (root.dataset.mobileView = "list"));
    $("#rl-new").addEventListener("click", () => openRoleModal(null));
    $("#rl-arch").addEventListener("click", () => {
      Roles.showArchived = !Roles.showArchived;
      $("#rl-arch").dataset.on = String(Roles.showArchived);
      $("#rl-arch").setAttribute("aria-pressed", String(Roles.showArchived));
      loadRoles();
    });
    bindRoleModal();
    renderRoleDetail();
    loadRoles();
    loadRoleScopes();
  },
  // 切回来重拉：vault 里的 markdown 用户可能刚在 Obsidian 里改过
  show() {
    if (Roles.loaded || Roles.listError) loadRoles();
    if (Roles.sel) openRole(Roles.sel);
    if (!Roles.scopesLoaded) loadRoleScopes();
  },
};

/* ============ 列表 ============ */
async function loadRoles() {
  Roles.listError = "";
  try {
    const r = await getJSON(`/api/roles${Roles.showArchived ? "?archived=1" : ""}`);
    Roles.list = r.roles || [];
    Roles.icons = (r.icons || []).filter((i) => ROLE_ICON_PATHS[i]);
    Roles.targets = r.targets || Roles.targets;
    // 晋升目标以后端白名单为准，但只认识的才画按钮（后端加了新目标不至于渲染出个空标签）
    if (Array.isArray(r.projectTargets)) {
      const known = r.projectTargets.filter((t) => PROJ_TARGET_LABEL[t]);
      if (known.length) Roles.projectTargets = known;
    }
    Roles.loaded = true;
  } catch (e) {
    Roles.listError = "角色列表暂时无法载入";
  }
  renderRoleList();
}
async function loadRoleScopes() {
  // scope 开关与可关联项目都由这个接口给（前端不猜 vault 布局）
  const r = await getJSON("/api/roles/projects").catch(() => null);
  if (!r?.ok) return;   // 拿不到就下次再试：一次抖动不该让整场会话都看不到 scope 选择
  Roles.scopesOn = !!r.scopesOn;
  Roles.scopes = r.scopesOn ? ["work", "private"] : [""];
  Roles.scopesLoaded = true;
  Roles.projectCache[r.scope || ""] = r.projects || [];
}
/** 每次开表单都重问一次：vault 里刚冒出来的新项目要能立刻关联（缓存只作请求失败时的兜底） */
async function roleProjects(scope) {
  const key = scope || "";
  const r = await getJSON(`/api/roles/projects?scope=${encodeURIComponent(key)}`).catch(() => null);
  if (r?.ok) Roles.projectCache[key] = r.projects || [];
  return Roles.projectCache[key] || [];
}

function renderRoleList() {
  const el = $("#rl-list");
  if (!el) return;
  if (Roles.listError && !Roles.list.length) {
    el.innerHTML = `<div class="state-box" data-state="error">${esc(Roles.listError)}<br>
      <button class="button secondary sm" style="margin-top:8px" onclick="loadRoles()">重试</button></div>`;
    return;
  }
  if (!Roles.loaded) { el.innerHTML = stateBox("正在载入角色…", "loading"); return; }
  if (!Roles.list.length) {
    el.innerHTML = `<div class="state-box">还没有角色<br>
      <span style="font-size:12px">建一个「研发」，把原则和决策攒起来</span><br>
      <button class="button secondary sm" style="margin-top:10px" onclick="openRoleModal(null)">新建角色</button></div>`;
    return;
  }
  // 组织树：负责人一行，名下项目专家缩进跟在后面；挂不上的专家（没上级/上级不可用）单独一组。
  // active 在前、归档沉底；同组按后端给的创建顺序。
  const byStatus = (a, b) => (a.status === "archived" ? 1 : 0) - (b.status === "archived" ? 1 : 0);
  const leads = Roles.list.filter((r) => roleType(r) === "lead").sort(byStatus);
  const experts = Roles.list.filter((r) => roleType(r) === "project");
  const attached = new Map();   // 上级 key → 专家[]
  const orphans = [];
  for (const e of experts) {
    // 上级不在当前列表里（归档筛掉了 / 被删了 / 标了 parentMissing）就算挂不上——
    // 静默塞进某个负责人下面等于谎报组织关系
    const lead = e.parentRoleId && !e.parentMissing
      ? leads.find((l) => l.id === e.parentRoleId && l.scope === e.scope) : null;
    if (!lead) { orphans.push(e); continue; }
    const key = `${e.scope} ${e.parentRoleId}`;
    attached.set(key, [...(attached.get(key) || []), e]);
  }

  const rows = [];
  for (const l of leads) {
    rows.push(roleItemHtml(l, false));
    for (const e of (attached.get(`${l.scope} ${l.id}`) || []).sort(byStatus)) rows.push(roleItemHtml(e, true));
  }
  if (orphans.length) {
    rows.push(`<div class="rl-group">未挂靠的项目专家<span class="rl-quiet"> · 在编辑里选一个上级</span></div>`);
    for (const e of orphans.sort(byStatus)) rows.push(roleItemHtml(e, false));
  }
  el.innerHTML = rows.join("");
}

function roleItemHtml(r, child) {
  const expert = roleType(r) === "project";
  const n = (r.projects || []).length;
  const meta = expert
    ? `主项目 ${esc(r.primaryProject || "未设置")}`
    : (r.childCount ? `${r.childCount} 个项目专家` : (n ? `${n} 个项目` : "未关联项目"));
  return `<div class="role-item" data-on="${Roles.sel === r.id}" data-archived="${r.status === "archived"}"
      data-child="${!!child}" onclick="openRole('${jsq(r.id)}')" title="${esc(r.name)}">
    ${roleAvatar(r, "sm")}
    <div class="role-item-main">
      <div class="t">${esc(r.name || r.id)}
        <span class="tag" data-kind="${expert ? "expert" : "lead"}">${esc(ROLE_TYPE_LABEL[roleType(r)])}</span>
        ${r.status === "archived" ? `<span class="tag">已归档</span>` : ""}
        ${r.conflict ? `<span class="tag" data-tone="bad">冲突</span>` : ""}
        ${r.parentMissing ? `<span class="tag" data-tone="warn">上级失联</span>` : ""}</div>
      <div class="m">${esc(r.description || "（没写描述）")}</div>
      ${r.conflict ? `<div class="m rl-quiet" data-warn="true">${esc(r.conflictMsg || "这个角色有歧义，接口一概拒绝操作")}</div>` : ""}
      <div class="m rl-quiet">${esc(r.id)}${r.scope ? ` · ${esc(scopeLabel(r.scope))}` : ""} · ${esc(meta)}</div>
    </div>
  </div>`;
}

/* ============ 详情 ============ */
async function openRole(id) {
  const seq = ++Roles.openSeq;
  Roles.sel = id;
  $("#roles-root").dataset.mobileView = "detail";
  $("#rl-detail").innerHTML = stateBox("正在载入角色…", "loading");
  renderRoleList();
  let r = null, err = "", status = 0;
  try {
    const res = await fetch(`/api/roles/${encodeURIComponent(id)}`);
    status = res.status;
    r = await res.json().catch(() => null);
    if (!res.ok) err = r?.msg || (res.status === 404 ? "角色不存在（可能已在 vault 里被改名或删除）" : "角色详情暂时无法载入");
  } catch { err = "角色详情暂时无法载入"; }
  if (seq !== Roles.openSeq) return;
  if (!r?.ok) {
    Roles.role = null; Roles.candidates = []; Roles.org = null;
    Roles.projectCandidates = []; Roles.projectCandidatesMsg = "";
    // 409（同 id 两份 / 同主项目两个在岗专家）：详情读不了，但"归档这一份"正是解法，
    // 得留个出口——否则用户只能去 Obsidian 手改，页面上是个死胡同
    const escape = status === 409 && Roles.list.some((x) => x.id === id && x.status !== "archived")
      ? `<br><button class="button danger sm" style="margin-top:10px" onclick="toggleArchive('${jsq(id)}',true)">归档这一份</button>`
      : "";
    $("#rl-detail").innerHTML = `<div class="state-box" data-state="error">${esc(err || "角色详情暂时无法载入")}${escape}</div>`;
    $("#rl-tools").innerHTML = "";
    $("#rl-crumb").textContent = id;
    return;
  }
  Roles.role = r.role;
  Roles.candidates = r.candidates || [];
  Roles.org = r.org || null;
  Roles.projectCandidates = r.projectCandidates || [];
  Roles.projectCandidatesMsg = r.projectCandidatesMsg || "";
  renderRoleDetail();
  loadRoleDocs(r.role, seq);
}

function renderRoleDetail() {
  const box = $("#rl-detail");
  if (!box) return;
  const role = Roles.role;
  if (!role) {
    $("#rl-crumb").textContent = "选择左侧角色，或新建一个";
    $("#rl-tools").innerHTML = "";
    box.innerHTML = stateBox("角色是带记忆的长期身份：原则、决策、待办跟着它走，开对话时按需注入");
    return;
  }
  const archived = role.status === "archived";
  $("#rl-crumb").innerHTML = `${roleAvatar(role, "sm")}<span class="nm">${esc(role.name || role.id)}</span>`;
  $("#rl-tools").innerHTML = `
    ${archived ? "" : `<button class="button primary sm" onclick="chatWithRole('${jsq(role.id)}')">与这个角色对话</button>`}
    <button class="button ghost sm" onclick="openRoleModal('${jsq(role.id)}')">编辑</button>
    <button class="button ${archived ? "secondary" : "danger"} sm" onclick="toggleArchive('${jsq(role.id)}',${archived ? "false" : "true"})">${archived ? "恢复" : "归档"}</button>`;

  const projects = role.projects || [];
  const cands = Roles.candidates;
  const expert = roleType(role) === "project";
  const org = Roles.org || { parent: null, parentMissing: false, parentMsg: "", children: [] };
  box.innerHTML = `
    <div class="role-hero">
      ${roleAvatar(role, "lg")}
      <div class="role-hero-main">
        <h2>${esc(role.name || role.id)}</h2>
        <div class="role-hero-meta">
          <span class="tag" data-kind="${expert ? "expert" : "lead"}">${esc(ROLE_TYPE_LABEL[roleType(role)])}</span>
          <span class="tag mono">${esc(role.id)}</span>
          ${role.scope ? `<span class="tag">${esc(scopeLabel(role.scope))}</span>` : ""}
          <span class="tag" data-tone="${archived ? "" : "ok"}">${archived ? "已归档" : "启用中"}</span>
          <span class="rl-quiet">更新于 ${esc(ageText(role.updatedAt))}</span>
        </div>
        <p class="role-hero-desc">${esc(role.description || "（还没写描述——编辑里补一句这个角色是干什么的）")}</p>
      </div>
    </div>
    ${archived ? `<div class="rl-note" data-tone="warn">已归档：不出现在默认列表，也不能用它开新对话。历史对话与 vault 文件都还在，点「恢复」即可继续用。</div>` : ""}

    ${expert ? expertOrgHtml(role, org) : leadOrgHtml(role, org)}

    <div class="rl-block">
      <div class="rl-block-head"><h3>职责边界</h3><span class="rl-quiet">随每轮对话注入</span></div>
      <div class="rl-prose">${role.instructions ? esc(role.instructions) : `<span class="rl-quiet">还没写。写清「负责什么、不负责什么」，模型的回答会稳很多。</span>`}</div>
    </div>

    <div class="rl-block">
      <div class="rl-block-head"><h3>关联项目</h3><span class="rl-quiet">${expert ? "主项目锁定，其余可在开对话时缩小" : "开对话时可再缩小范围"}</span></div>
      ${projects.length
        ? `<div class="pick-row">${projects.map((s) => s === role.primaryProject && expert
            ? `<span class="chip" data-static="true" data-on="true">${esc(s)} · 主项目</span>`
            : `<span class="chip" data-static="true">${esc(s)}</span>`).join("")}</div>
           <div class="rl-quiet" style="margin-top:6px">对话会注入这些项目的 README（只读，同 scope）${expert ? "；主项目每轮必注入" : ""}</div>`
        : `<div class="rl-quiet">还没关联项目。关联后，对话会带上项目 README 里的现状与陷阱。</div>`}
    </div>

    ${expert ? projectCandidatesHtml(role) : ""}

    <div class="rl-block">
      <div class="rl-block-head"><h3>角色记忆</h3><span class="rl-quiet">vault 里的 markdown 就是真相，可直接编辑</span></div>
      <div class="rl-docs">
        ${ROLE_DOCS.map((d) => `
          <div class="rl-doc">
            <div class="rl-doc-head">
              <span class="t">${esc(d.title)}</span>
              <span class="c" id="rl-doc-c-${d.key}"></span>
              <button class="button ghost sm" onclick="openRoleDoc('${jsq(role.id)}','${d.key}')">在笔记里编辑</button>
            </div>
            <div class="rl-quiet">${esc(d.hint)}</div>
            <div class="rl-doc-body" id="rl-doc-${d.key}">${stateBox("读取中…", "loading")}</div>
          </div>`).join("")}
      </div>
    </div>

    <div class="rl-block">
      <div class="rl-block-head">
        <h3>角色候选记忆 ${cands.length ? `<span class="count">${cands.length}</span>` : ""}</h3>
        <span class="rl-quiet">人工晋升才进正式记忆</span>
      </div>
      ${cands.length
        ? `<div class="glist">${cands.map((c) => candidateHtml(role, c)).join("")}</div>`
        : `<div class="rl-quiet">还没有候选。在对话里对 AI 的回复点「存为候选」并选「角色」，结论会先落在这里等你确认。</div>`}
    </div>`;
}

/* 组织块：项目专家看「主项目 + 上级」，负责人看「名下专家」。
 * 上级/主项目失联一律如实标出——组织关系错了，注入的记忆就是错的。 */
function expertOrgHtml(role, org) {
  const primary = role.primaryProject || "";
  const parent = org.parent;
  return `
    <div class="rl-block">
      <div class="rl-block-head"><h3>组织与主项目</h3><span class="rl-quiet">主项目 README 每轮对话必注入</span></div>
      <div class="rl-org">
        <div class="rl-org-cell">
          <div class="k">主项目</div>
          <div class="v">${primary ? `<span class="chip" data-static="true" data-on="true">${esc(primary)}</span>` : `<span class="rl-quiet">未设置（编辑里补上）</span>`}</div>
          ${primary ? `<div class="pick-row" style="margin-top:6px">${PROJ_DOCS.map((d) =>
            `<button class="button ghost sm" onclick="openProjectDoc('${jsq(role.id)}','${d.key}')">${esc(d.title)}</button>`).join("")}</div>
            <div class="rl-quiet" style="margin-top:6px">项目知识只住在 projects/${esc(primary)}/，不复制进角色</div>` : ""}
        </div>
        <div class="rl-org-cell">
          <div class="k">上级职能负责人</div>
          <div class="v">${parent
            ? `<a href="#" onclick="openRole('${jsq(parent.id)}');return false">${esc(parent.name || parent.id)}</a>`
            : `<span class="rl-quiet">未挂靠（可选）</span>`}</div>
          ${org.parentMissing ? `<div class="rl-note" data-tone="warn" style="margin-top:8px">${esc(org.parentMsg || "上级不可用")}——在编辑里改挂或清空</div>` : ""}
        </div>
      </div>
    </div>`;
}

function leadOrgHtml(role, org) {
  const kids = org.children || [];
  return `
    <div class="rl-block">
      <div class="rl-block-head">
        <h3>下属项目专家 ${kids.length ? `<span class="count">${kids.length}</span>` : ""}</h3>
        <span class="rl-quiet">归档前要先安置他们</span>
      </div>
      ${kids.length
        ? `<div class="rl-kids">${kids.map((k) => `
            <button class="rl-kid" onclick="openRole('${jsq(k.id)}')" data-archived="${k.status === "archived"}">
              ${roleAvatar(k, "sm")}
              <span class="nm">${esc(k.name || k.id)}</span>
              <span class="rl-quiet">${esc(k.primaryProject || "无主项目")}${k.status === "archived" ? " · 已归档" : ""}</span>
            </button>`).join("")}</div>`
        : `<div class="rl-quiet">名下还没有项目专家。新建一个项目专家并把上级选成这个角色，就能挂进来。</div>`}
    </div>`;
}

/* 项目候选：落在 projects/<主项目>/_candidates/，晋升目标是项目的三份正式文件 */
function projectCandidatesHtml(role) {
  const list = Roles.projectCandidates || [];
  const slug = role.primaryProject || "";
  return `
    <div class="rl-block">
      <div class="rl-block-head">
        <h3>项目候选记忆 ${list.length ? `<span class="count">${list.length}</span>` : ""}</h3>
        <span class="rl-quiet">晋升进 ${esc(slug)}/README·decisions·operations</span>
      </div>
      ${Roles.projectCandidatesMsg ? `<div class="rl-note" data-tone="warn">${esc(Roles.projectCandidatesMsg)}</div>` : ""}
      ${list.length
        ? `<div class="glist">${list.map((c) => projCandidateHtml(role, c)).join("")}</div>`
        : (Roles.projectCandidatesMsg ? "" : `<div class="rl-quiet">还没有项目候选。在这个专家的对话里对 AI 的回复点「存为候选」并选「项目」，只对本项目成立的结论会落在这里。</div>`)}
    </div>`;
}

function projCandidateHtml(role, c) {
  const rid = jsq(role.id), cid = jsq(c.id);
  const chat = String(c.sourceChat || "-");
  return `<div class="card">
    <div class="body">${esc(c.text)}</div>
    ${c.evidence ? `<details class="rl-evidence"><summary>原文证据</summary><div>${esc(c.evidence)}</div></details>` : ""}
    <div class="top" style="margin-top:6px">
      <span class="rl-quiet">${c.createdAt ? esc(ageText(c.createdAt)) : "时间未知"}</span>
      ${/^[\w.:-]+$/.test(chat) && chat !== "-"
        ? `<span class="rl-quiet">· 来自对话 <a href="#" onclick="jumpChat('${jsq(chat)}');return false">${esc(chat)}</a></span>`
        : `<span class="rl-quiet">· 来源未知</span>`}
    </div>
    <div class="foot">
      ${Roles.projectTargets.map((t) => `<button class="button secondary sm" onclick="promoteProjCand('${rid}','${cid}','${jsq(t)}')">晋升为${esc(PROJ_TARGET_LABEL[t] || t)}</button>`).join("")}
      <button class="button danger sm" onclick="dismissProjCand('${rid}','${cid}')">丢弃</button>
    </div>
  </div>`;
}

function candidateHtml(role, c) {
  const rid = jsq(role.id), cid = jsq(c.id);
  const chat = String(c.sourceChat || "-");
  return `<div class="card">
    <div class="body">${esc(c.text)}</div>
    ${c.evidence ? `<details class="rl-evidence"><summary>原文证据</summary><div>${esc(c.evidence)}</div></details>` : ""}
    <div class="top" style="margin-top:6px">
      <span class="rl-quiet">${c.createdAt ? esc(ageText(c.createdAt)) : "时间未知"}</span>
      ${/^[\w.:-]+$/.test(chat) && chat !== "-"
        ? `<span class="rl-quiet">· 来自对话 <a href="#" onclick="jumpChat('${jsq(chat)}');return false">${esc(chat)}</a></span>`
        : `<span class="rl-quiet">· 来源未知</span>`}
    </div>
    <div class="foot">
      ${Roles.targets.map((t) => `<button class="button secondary sm" onclick="promoteCand('${rid}','${cid}','${jsq(t)}')">晋升为${esc(TARGET_LABEL[t] || t)}</button>`).join("")}
      <button class="button danger sm" onclick="dismissCand('${rid}','${cid}')">丢弃</button>
    </div>
  </div>`;
}

/** 正式记忆预览：只读 /api/vault/file（daemon 侧锁死 vault 内 .md），编辑走笔记 tab */
function roleDocPath(role, file) {
  const root = S.state?.vaultRoot;
  if (!root) return "";
  return `${root}/${role.scope ? role.scope + "/" : ""}roles/${role.id}/${file}`;
}
/** 条目 = 顶格的一行；缩进行是上一条的来源/证据，标题和引导语（#/>）不算 */
function docEntries(text) {
  const body = String(text || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const out = [];
  for (const raw of body.split("\n")) {
    if (!raw.trim() || /^\s/.test(raw) || /^[>#]/.test(raw.trim())) continue;
    const line = raw.replace(/^[-*]\s+/, "").trim();
    if (line) out.push(line);
  }
  return out;
}
async function loadRoleDocs(role, seq) {
  for (const d of ROLE_DOCS) {
    const path = roleDocPath(role, d.file);
    const body = $(`#rl-doc-${d.key}`), count = $(`#rl-doc-c-${d.key}`);
    if (!body) continue;
    if (!path) { body.innerHTML = `<div class="rl-quiet">daemon 状态还没到，稍后刷新可看内容</div>`; continue; }
    const r = await getJSON(`/api/vault/file?path=${encodeURIComponent(path)}`).catch(() => null);
    if (seq !== Roles.openSeq) return;
    if (!$(`#rl-doc-${d.key}`)) return;    // 详情已被重渲染
    if (!r?.ok) {
      $(`#rl-doc-${d.key}`).innerHTML = `<div class="rl-quiet">读不到 ${esc(d.file)}（文件被删或改名？在笔记里新建同名文件即可恢复）</div>`;
      continue;
    }
    const entries = docEntries(r.text);
    if (count) count.textContent = entries.length ? `${entries.length} 条` : "空";
    $(`#rl-doc-${d.key}`).innerHTML = entries.length
      ? `<ul class="rl-doc-list">${entries.slice(0, 4).map((t) => `<li>${esc(t.length > 140 ? t.slice(0, 140) + "…" : t)}</li>`).join("")}</ul>
         ${entries.length > 4 ? `<div class="rl-quiet">还有 ${entries.length - 4} 条，在笔记里看全文</div>` : ""}`
      : `<div class="rl-quiet">还是空的——晋升一条候选，或直接在笔记里写。</div>`;
  }
}
function openRoleDoc(id, key) {
  const role = Roles.role && Roles.role.id === id ? Roles.role : Roles.list.find((r) => r.id === id);
  const doc = ROLE_DOCS.find((d) => d.key === key);
  if (!role || !doc) return;
  const path = roleDocPath(role, doc.file);
  if (!path) { toast("daemon 状态还没到，稍后再试"); return; }
  switchTab("notes");
  Notes.open(path);
}
/** 主项目的正式文件：在笔记 tab 里打开（可能还不存在——笔记那边会如实说） */
function openProjectDoc(id, key) {
  const role = Roles.role && Roles.role.id === id ? Roles.role : Roles.list.find((r) => r.id === id);
  const doc = PROJ_DOCS.find((d) => d.key === key);
  const root = S.state?.vaultRoot;
  if (!role || !doc || !role.primaryProject) return;
  if (!root) { toast("daemon 状态还没到，稍后再试"); return; }
  switchTab("notes");
  Notes.open(`${root}/${role.scope ? role.scope + "/" : ""}projects/${role.primaryProject}/${doc.file}`);
}

/* ============ 动作（危险动作一律先确认，失败一律回显后端原话） ============ */
async function toggleArchive(id, archived) {
  const role = Roles.list.find((r) => r.id === id) || Roles.role;
  const name = role?.name || id;
  if (archived && !confirm(`归档角色「${name}」？\n\n它会从默认列表消失，也不能再用它开新对话。历史对话和 vault 文件都保留，随时可以恢复。`)) return;
  const res = await post(`/api/roles/${encodeURIComponent(id)}/archive`, { archived: !!archived });
  toast(res.msg || (res.ok ? "已处理" : "操作失败"));
  if (!res.ok) return;
  await loadRoles();
  // 归档后若列表里已看不到它（未开「含归档」），详情跟着清空，避免停在一个不存在的选中态
  if (!Roles.list.some((r) => r.id === id)) { Roles.sel = null; Roles.role = null; Roles.candidates = []; renderRoleDetail(); renderRoleList(); }
  else openRole(id);
}
async function promoteCand(id, cid, target) {
  const label = TARGET_LABEL[target] || target;
  if (!confirm(`把这条候选晋升为「${label}」？\n\n内容会追加进 ${target}.md，候选随即删除——这一步不可撤销（想反悔就去笔记里删那一行）。`)) return;
  const res = await post(`/api/roles/${encodeURIComponent(id)}/candidates/${encodeURIComponent(cid)}/promote`, { target });
  toast(res.msg || (res.ok ? "已晋升" : "晋升失败"));
  if (res.ok && Roles.sel === id) openRole(id);
}
async function dismissCand(id, cid) {
  if (!confirm("丢弃这条候选？\n\n候选文件会被删除，无法恢复（正式记忆不受影响）。")) return;
  const res = await post(`/api/roles/${encodeURIComponent(id)}/candidates/${encodeURIComponent(cid)}/dismiss`, {});
  toast(res.msg || (res.ok ? "已丢弃" : "丢弃失败"));
  if (res.ok && Roles.sel === id) openRole(id);
}
/* 项目候选：同一道人工门，只是写到 projects/<主项目>/ 而不是角色目录 */
async function promoteProjCand(id, cid, target) {
  const slug = (Roles.role && Roles.role.id === id ? Roles.role.primaryProject : "") || "项目";
  const label = PROJ_TARGET_LABEL[target] || target;
  if (!confirm(`把这条候选晋升为「${label}」？\n\n内容会追加进 ${slug}/${target}.md，候选随即删除——这一步不可撤销（想反悔就去笔记里删那一行）。`)) return;
  const res = await post(`/api/roles/${encodeURIComponent(id)}/project-candidates/${encodeURIComponent(cid)}/promote`, { target });
  toast(res.msg || (res.ok ? "已晋升" : "晋升失败"));
  if (res.ok && Roles.sel === id) openRole(id);
}
async function dismissProjCand(id, cid) {
  if (!confirm("丢弃这条项目候选？\n\n候选文件会被删除，无法恢复（项目正式记忆不受影响）。")) return;
  const res = await post(`/api/roles/${encodeURIComponent(id)}/project-candidates/${encodeURIComponent(cid)}/dismiss`, {});
  toast(res.msg || (res.ok ? "已丢弃" : "丢弃失败"));
  if (res.ok && Roles.sel === id) openRole(id);
}
/** 从角色发起新对话：切到对话 tab 并预选角色 + 全部关联项目，范围在那边还能缩小 */
function chatWithRole(id) {
  const role = Roles.role && Roles.role.id === id ? Roles.role : Roles.list.find((r) => r.id === id);
  if (!role) return;
  if (role.status === "archived") { toast("角色已归档，先恢复再开对话"); return; }
  switchTab("chat");
  Chat.startWithRole(role);
}
function jumpChat(chatId) {
  switchTab("chat");
  openChat(chatId);
}

/* ============ 新建 / 编辑 modal ============ */
const roleForm = { icon: "star", projects: new Set(), scope: "", type: "lead", primary: "", parent: "" };

function bindRoleModal() {
  const ov = $("#role-overlay");
  $("#r-cancel").addEventListener("click", () => (ov.dataset.open = "false"));
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.dataset.open = "false"; });
  $("#r-save").addEventListener("click", saveRole);
  $("#r-color").addEventListener("change", renderRoleIcons);   // 自定义取色后，预设色块的选中态跟着走
  $("#r-scope").addEventListener("change", async () => {
    roleForm.scope = $("#r-scope").value;
    // 换 scope = 换了一整套可选项目与可选上级，旧选择一律作废（跨 scope 挂靠后端也会拒）
    roleForm.projects.clear();
    roleForm.primary = "";
    roleForm.parent = "";
    renderRoleOrg();
    renderRoleProjects(await roleProjects(roleForm.scope));
  });
  $("#r-type").addEventListener("change", () => {
    roleForm.type = $("#r-type").value === "project" ? "project" : "lead";
    if (roleForm.type === "lead") { roleForm.primary = ""; roleForm.parent = ""; }
    renderRoleOrg();
    renderRoleProjects(Roles.projectCache[roleForm.scope || ""] || []);
  });
  $("#r-primary").addEventListener("change", () => {
    roleForm.primary = $("#r-primary").value;
    // 主项目必然是关联项目之一（后端也会自动并进去），这里同步勾上，别让用户看着像没关联
    if (roleForm.primary) roleForm.projects.add(roleForm.primary);
    renderRoleProjects(Roles.projectCache[roleForm.scope || ""] || []);
    renderRoleOrg();
  });
  $("#r-parent").addEventListener("change", () => { roleForm.parent = $("#r-parent").value; });
}

async function openRoleModal(id) {
  const role = id ? (Roles.role && Roles.role.id === id ? Roles.role : Roles.list.find((r) => r.id === id)) : null;
  if (id && !role) { toast("角色读不到，刷新一下列表"); return; }
  Roles.editing = id || null;
  roleForm.scope = role ? role.scope || "" : (Roles.scopes[0] || "");
  roleForm.icon = roleIcon(role?.icon);
  roleForm.projects = new Set(role?.projects || []);
  roleForm.type = roleType(role);
  roleForm.primary = role?.primaryProject || "";
  roleForm.parent = role?.parentRoleId || "";

  $("#r-title").textContent = role ? `编辑角色 · ${role.name || role.id}` : "新建角色";
  $("#r-tpl-wrap").style.display = role ? "none" : "";
  $("#r-id-wrap").style.display = role ? "none" : "";
  $("#r-id").value = "";
  $("#r-name").value = role?.name || "";
  $("#r-desc").value = role?.description || "";
  $("#r-ins").value = role?.instructions || "";
  $("#r-color").value = roleColor(role?.color);
  $("#r-scope-wrap").style.display = Roles.scopesOn && !role ? "" : "none";
  $("#r-scope").innerHTML = Roles.scopes.map((s) => `<option value="${esc(s)}">${esc(scopeLabel(s) || "默认")}</option>`).join("");
  $("#r-scope").value = roleForm.scope;
  $("#r-type").value = roleForm.type;
  renderRoleTemplates();
  renderRoleIcons();
  renderRoleOrg();
  $("#r-projects").innerHTML = stateBox("正在读项目…", "loading");
  $("#r-proj-hint").textContent = Roles.scopesOn ? `（只列 ${scopeLabel(roleForm.scope) || "本"} scope 下的项目）` : "";
  $("#role-overlay").dataset.open = "true";
  (role ? $("#r-name") : $("#r-id")).focus();
  renderRoleProjects(await roleProjects(roleForm.scope));
  renderRoleOrg();   // 项目列表回来后主项目下拉才有内容
}

/** 类型/主项目/上级三件套。上级只列同 scope 的在岗负责人——列了也提交不上去的选项不该出现 */
function renderRoleOrg() {
  const expert = roleForm.type === "project";
  $("#r-type-note").textContent = expert
    ? "项目专家：一个主项目的开发入口，主项目 README 每轮必注入；项目结论存进项目候选，不进角色。"
    : "职能负责人：管跨项目的原则与决策，不绑主项目；名下可以挂项目专家。";
  $("#r-org-wrap").style.display = expert ? "" : "none";
  if (!expert) return;

  const projects = Roles.projectCache[roleForm.scope || ""] || [];
  $("#r-primary").innerHTML = [
    `<option value="">（请选择主项目）</option>`,
    ...projects.map((s) => `<option value="${esc(s)}" ${s === roleForm.primary ? "selected" : ""}>${esc(s)}</option>`),
    // 编辑旧角色时主项目目录可能已被改名：留着它，别让"保存"把它悄悄换成别的项目
    ...(roleForm.primary && !projects.includes(roleForm.primary)
      ? [`<option value="${esc(roleForm.primary)}" selected>${esc(roleForm.primary)}（vault 里已找不到这个目录）</option>`] : []),
  ].join("");

  const leads = Roles.list.filter((r) => roleType(r) === "lead" && r.status !== "archived"
    && !r.conflict && (r.scope || "") === (roleForm.scope || "") && r.id !== Roles.editing);
  $("#r-parent").innerHTML = [
    `<option value="">（不挂靠）</option>`,
    ...leads.map((r) => `<option value="${esc(r.id)}" ${r.id === roleForm.parent ? "selected" : ""}>${esc(r.name || r.id)}</option>`),
    ...(roleForm.parent && !leads.some((r) => r.id === roleForm.parent)
      ? [`<option value="${esc(roleForm.parent)}" selected>${esc(roleForm.parent)}（当前上级，已不在可选列表）</option>`] : []),
  ].join("");
}

function renderRoleTemplates() {
  $("#r-templates").innerHTML = ROLE_TEMPLATES.map((t, i) =>
    `<button type="button" class="chip" onclick="applyRoleTemplate(${i})">${roleIconSvg(t.icon)}${esc(t.name)}</button>`).join("");
}
function applyRoleTemplate(i) {
  const t = ROLE_TEMPLATES[i];
  if (!t) return;
  $("#r-id").value = t.id;
  $("#r-name").value = t.name;
  $("#r-desc").value = t.description;
  $("#r-ins").value = t.instructions;
  $("#r-color").value = t.color;
  roleForm.icon = t.icon;
  renderRoleIcons();
}
function renderRoleIcons() {
  const icons = Roles.icons.length ? Roles.icons : Object.keys(ROLE_ICON_PATHS);
  $("#r-icons").innerHTML = icons.map((i) =>
    `<button type="button" class="icon-opt" data-on="${roleForm.icon === i}" title="${esc(ROLE_ICON_LABEL[i] || i)}"
      aria-label="${esc(ROLE_ICON_LABEL[i] || i)}" onclick="pickRoleIcon('${jsq(i)}')">${roleIconSvg(i)}</button>`).join("");
  const cur = roleColor($("#r-color").value).toLowerCase();
  $("#r-colors").innerHTML = ROLE_COLORS.map((c) =>
    `<button type="button" class="color-opt" data-on="${c === cur}" style="--rc:${c}" title="${c}" aria-label="主色 ${c}" onclick="pickRoleColor('${c}')"></button>`).join("");
}
function pickRoleIcon(i) { roleForm.icon = roleIcon(i); renderRoleIcons(); }
function pickRoleColor(c) { if (R_HEX.test(c)) { $("#r-color").value = c; renderRoleIcons(); } }
function renderRoleProjects(list) {
  const box = $("#r-projects");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<span class="rl-quiet">vault 里还没有项目目录（&lt;scope&gt;/projects/），收割过任务后会自动出现</span>`;
    return;
  }
  // 主项目那颗 chip 恒选中且点不动：取消它等于让项目专家没有项目（后端也会拒）
  box.innerHTML = list.map((s) => s && s === roleForm.primary && roleForm.type === "project"
    ? `<button type="button" class="chip" data-on="true" data-static="true" title="主项目不能取消关联"
        onclick="toast('主项目不能取消关联，换主项目请改上面的下拉')">${esc(s)} · 主项目</button>`
    : `<button type="button" class="chip" data-on="${roleForm.projects.has(s)}" onclick="toggleRoleProject('${jsq(s)}')">${esc(s)}</button>`).join("");
}
function toggleRoleProject(slug) {
  if (roleForm.type === "project" && slug === roleForm.primary) { toast("主项目不能取消关联"); return; }
  roleForm.projects.has(slug) ? roleForm.projects.delete(slug) : roleForm.projects.add(slug);
  renderRoleProjects(Roles.projectCache[roleForm.scope || ""] || []);
}

async function saveRole() {
  const btn = $("#r-save");
  const expert = roleForm.type === "project";
  const projects = new Set(roleForm.projects);
  if (expert && roleForm.primary) projects.add(roleForm.primary);
  const payload = {
    name: $("#r-name").value.trim(),
    description: $("#r-desc").value.trim(),
    icon: roleForm.icon,
    color: roleColor($("#r-color").value),
    instructions: $("#r-ins").value.trim(),
    projects: [...projects],
    type: roleForm.type,
    // 负责人的这两个字段必须显式清空：改类型时留着旧值，后端会（正确地）拒绝保存
    primaryProject: expert ? roleForm.primary : "",
    parentRoleId: expert ? roleForm.parent : "",
  };
  if (!payload.name) { toast("角色名不能为空"); $("#r-name").focus(); return; }
  if (expert && !payload.primaryProject) { toast("项目专家必须选一个主项目"); $("#r-primary").focus(); return; }
  let url = `/api/roles/${encodeURIComponent(Roles.editing)}/update`;
  if (!Roles.editing) {
    const id = $("#r-id").value.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) { toast("id 只能是小写字母/数字/连字符，2–40 位，且以字母数字开头"); $("#r-id").focus(); return; }
    payload.id = id;
    if (Roles.scopesOn) payload.scope = $("#r-scope").value;
    url = "/api/roles";
  }
  btn.disabled = true;
  const res = await post(url, payload);
  btn.disabled = false;
  if (!res.ok) { toast(res.msg || "保存失败"); return; }
  toast(Roles.editing ? "已保存" : "角色已创建");
  $("#role-overlay").dataset.open = "false";
  const id = res.role?.id || Roles.editing;
  await loadRoles();
  if (id) openRole(id);
}
