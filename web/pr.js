"use strict";
/* PR 审查 tab：GitHub PR 列表 + 审查操作（等我 review / 需我动 / 等别人 / 已忽略） */

const Pr = {
  sel: null,   // { repo, num } | null
  list: [],    // PrItem[]
  timer: null,
};

TABS.pr = {
  init(root) {
    root.innerHTML = `
      <div class="col pr-list-col" style="display:flex;flex-direction:column;min-height:0">
        <div style="padding:12px 14px 8px;display:flex;align-items:center;gap:8px;flex-shrink:0">
          <div style="flex:1">
            <div class="eyebrow">PR REVIEW</div>
            <h1 style="margin:2px 0 0;font-size:17px">Pull Requests</h1>
          </div>
          <button class="button ghost sm" id="pr-refresh">刷新</button>
        </div>
        <div class="col-scroll" id="pr-list" style="flex:1;padding:6px 8px">
          ${stateBox("正在载入…", "loading")}
        </div>
      </div>
      <div class="col" id="pr-detail-col" style="display:flex;flex-direction:column;min-height:0">
        <div id="pr-detail" class="col-scroll" style="flex:1;padding:14px">
          ${stateBox("从左侧选择一个 PR 查看详情")}
        </div>
      </div>`;
    $("#pr-refresh").addEventListener("click", () => prLoadList(true));
    prLoadList(false);
    prMobileSync(false); // 移动端初始：显示列表、隐藏详情
  },
  show() {
    prLoadList(false);
    Pr.timer = setInterval(() => prLoadList(false), 120_000);
  },
  hide() { clearInterval(Pr.timer); Pr.timer = null; },
};

// 移动端 master-detail：媒体查询 + data 属性驱动（与 lark/chat 对称）——
// 内联 display 切换在窗口拉宽回桌面时会残留（列表列永久消失），CSS 方案 resize 自愈
(function () {
  const st = document.createElement("style");
  st.textContent = `
@media (max-width: 1023px) {
  #pr-root { display: block; overflow: hidden; }
  #pr-root .pr-list-col, #pr-root #pr-detail-col { width: 100%; height: 100%; max-height: none; }
  #pr-root[data-mobile-view="detail"] .pr-list-col { display: none; }
  #pr-root:not([data-mobile-view="detail"]) #pr-detail-col { display: none; }
}`;
  document.head.appendChild(st);
}());
function prMobileSync(showDetail = false) {
  const root = $("#pr-root");
  if (root) root.dataset.mobileView = showDetail ? "detail" : "list";
}

/* ---- 列表加载 ---- */
async function prLoadList(force) {
  const el = $("#pr-list");
  if (!el) return;
  try {
    const list = await getJSON(`/api/gh/prs${force ? "?force=1" : ""}`);
    if (!Array.isArray(list)) throw new Error(list?.msg || "返回格式错误");
    Pr.list = list;
    renderPrList();
    const count = list.filter((p) => p.bucket === "review" && !p.ignored).length;
    const badge = $("#b-pr");
    if (badge) badge.textContent = count || "";
  } catch (e) {
    if (!el) return;
    const msg = String(e).replace(/^Error: /, "");
    el.innerHTML = stateBox(
      msg.toLowerCase().includes("gh") || msg.includes("not logged")
        ? "需要 gh CLI 已登录（gh auth login）"
        : msg || "PR 列表载入失败",
      "error"
    );
  }
}

/* ---- 列表渲染 ---- */
function prStateTag(p) {
  if (p.bucket === "review") return `<span class="tag" data-tone="warn">待 Review</span>`;
  const M = {
    "ci-fail": ["bad", "CI 失败"],
    conflict:  ["bad", "冲突"],
    changes:   ["warn", "被要求修改"],
    ready:     ["ok", "可合并"],
    waiting:   ["", "等待中"],
  };
  const [tone, label] = M[p.state] || ["", p.state || ""];
  return `<span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${esc(label)}</span>`;
}

function prCardHtml(p) {
  const sel = Pr.sel?.repo === p.repo && Pr.sel?.num === p.number;
  return `<div class="card clickable" data-selected="${sel}" onclick="prSelect('${jsq(p.repo)}',${p.number})">
    <div class="top">
      <span class="mono" style="font-size:11px;color:var(--text-tertiary)">${esc(p.repo)}#${p.number}</span>
      ${prStateTag(p)}
      <span class="right">${ageText(p.updatedAt)}</span>
    </div>
    <div class="body">${esc(p.title)}</div>
    <div class="foot">
      <span style="font-size:11px;color:var(--text-tertiary)">${esc(p.author)}</span>
      <span style="flex:1"></span>
      <button class="button sm ghost" title="${p.ignored ? "恢复关注此 PR" : "忽略此 PR（不再提醒）"}"
        onclick="event.stopPropagation();prIgnore('${jsq(p.repo)}',${p.number},${!p.ignored})">${p.ignored ? "恢复" : "忽略"}</button>
    </div>
  </div>`;
}

function renderPrList() {
  const el = $("#pr-list");
  if (!el) return;
  const list = Pr.list;
  if (!list.length) { el.innerHTML = stateBox("暂无相关 PR"); return; }
  const reviews    = list.filter((p) => p.bucket === "review" && !p.ignored);
  const actionable = list.filter((p) => p.bucket === "mine" && !p.ignored && p.state !== "waiting");
  const waiting    = list.filter((p) => p.bucket === "mine" && !p.ignored && p.state === "waiting");
  const ignored    = list.filter((p) => p.ignored);
  const sec = (title, items) => items.length
    ? `<div class="section-title">${esc(title)}</div><div class="glist">${items.map(prCardHtml).join("")}</div>`
    : "";
  el.innerHTML =
    sec(`等我 Review（${reviews.length}）`, reviews) +
    sec(`需要我动（${actionable.length}）`, actionable) +
    sec(`等别人（${waiting.length}）`, waiting) +
    sec(`已忽略（${ignored.length}）`, ignored);
}

/* ---- 详情 ---- */
async function prSelect(repo, num) {
  Pr.sel = { repo, num };
  renderPrList();
  prMobileSync(true);
  const el = $("#pr-detail");
  if (el) el.innerHTML = stateBox("正在载入详情…", "loading");
  try {
    const d = await getJSON(`/api/gh/pr?repo=${encodeURIComponent(repo)}&num=${num}`);
    if (!d || d.ok === false) throw new Error(d?.msg || "详情获取失败");
    renderPrDetail(d);
  } catch (e) {
    const el2 = $("#pr-detail");
    if (el2) el2.innerHTML = stateBox(String(e).replace(/^Error: /, "") || "详情载入失败", "error");
  }
}

function prCiTone(state) {
  const s = (state || "").toUpperCase();
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s)) return "bad";
  if (["SUCCESS", "COMPLETED"].includes(s)) return "ok";
  return "warn";
}

function renderPrDetail(d) {
  const el = $("#pr-detail");
  if (!el) return;

  const safeGhUrl = safeUrl(d.url || "");
  const mergeTag = { CONFLICTING: `<span class="tag" data-tone="bad">冲突</span>`, MERGEABLE: `<span class="tag" data-tone="ok">可合并</span>` }[d.mergeable] || "";
  const reviewTag = {
    APPROVED:           `<span class="tag" data-tone="ok">已 Approve</span>`,
    CHANGES_REQUESTED:  `<span class="tag" data-tone="bad">被要求修改</span>`,
    REVIEW_REQUIRED:    `<span class="tag" data-tone="warn">需要 Review</span>`,
  }[d.reviewDecision] || "";

  const checksHtml = d.checks.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin:6px 0">${d.checks.map((c) =>
        `<span class="tag" data-tone="${prCiTone(c.state)}" title="${esc(c.name)}">${esc(c.name.slice(0, 26))} · ${esc(c.state.toLowerCase())}</span>`).join("")}</div>`
    : "";

  const filesHtml = d.files.length
    ? `<details style="margin:8px 0">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-tertiary)">改动文件（${d.files.length}）</summary>
        <div style="font-size:11.5px;font-family:var(--font-mono);margin-top:6px">${d.files.map((f) =>
          `<div style="display:flex;gap:8px;padding:2px 4px">
            <span style="color:var(--success)">+${f.additions}</span>
            <span style="color:var(--danger)">-${f.deletions}</span>
            <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.path)}</span>
          </div>`).join("")}
        </div>
      </details>`
    : "";

  const commentsHtml = d.comments.length
    ? `<div class="section-title">评论（${d.comments.length}）</div>` + d.comments.map((c) =>
        `<div class="panel" style="padding:10px 12px;margin-bottom:8px">
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${esc(c.author)} · ${ageText(c.at)}</div>
          ${mdHtml(c.body)}
        </div>`).join("")
    : "";

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="button ghost sm" onclick="prMobileSync(false)">← 返回</button>
      <span style="flex:1"></span>
      ${safeGhUrl ? `<a href="${esc(safeGhUrl)}" target="_blank" rel="noopener" class="button ghost sm">在 GitHub 打开</a>` : ""}
      <button class="button ghost sm" id="pr-diff-btn" onclick="prViewDiff('${jsq(d.repo)}',${d.number})">看 Diff</button>
    </div>
    <h2 style="font-size:15px;margin:0 0 6px;line-height:1.4">${esc(d.title)}</h2>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span class="tag">${esc(d.repo)}#${d.number}</span>
      <span class="tag mono">${esc(d.branch)} → ${esc(d.baseBranch)}</span>
      ${mergeTag}${reviewTag}
      <span style="font-size:11.5px;color:var(--text-secondary)">
        <span style="color:var(--success)">+${d.additions}</span> <span style="color:var(--danger)">-${d.deletions}</span>
      </span>
    </div>
    ${checksHtml}
    ${d.body ? `<div class="panel" style="padding:10px 12px;margin-bottom:10px">${mdHtml(d.body)}</div>` : ""}
    ${filesHtml}
    ${commentsHtml}
    <div class="section-title">操作</div>
    <div id="pr-act-area" data-repo="${esc(d.repo)}" data-num="${d.number}">
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        <button class="button secondary sm" onclick="prDoAct(this,'approve')">Approve</button>
        <button class="button ghost sm" onclick="prShowBody('request-changes')">Request changes</button>
        <button class="button ghost sm" onclick="prShowBody('comment')">Comment</button>
        <button class="button danger sm" id="pr-merge-btn" onclick="prMerge(this)">Merge (squash)</button>
      </div>
      <div id="pr-body-box" hidden style="margin-top:4px">
        <textarea id="pr-body-input" rows="3" placeholder="内容…" style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:6px"></textarea>
        <div style="display:flex;gap:6px">
          <button class="button primary sm" id="pr-body-submit">提交</button>
          <button class="button ghost sm" onclick="document.getElementById('pr-body-box').hidden=true">取消</button>
        </div>
      </div>
    </div>`;
}

/* ---- 操作 ---- */
function prShowBody(action) {
  const box = $("#pr-body-box");
  if (!box) return;
  box.hidden = false;
  const sub = $("#pr-body-submit");
  if (sub) {
    sub.textContent = action === "request-changes" ? "Request changes" : "Comment";
    sub.onclick = () => prDoAct(sub, action, $("#pr-body-input")?.value);
  }
  $("#pr-body-input")?.focus();
}

async function prDoAct(triggerEl, action, body) {
  const area = $("#pr-act-area");
  if (!area) return;
  const repo = area.dataset.repo;
  const num = parseInt(area.dataset.num, 10);
  const btns = $$("button", area);
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await post("/api/gh/pr/act", { repo, num, action, body: body || undefined });
    toast(res.msg || (res.ok ? "操作成功" : "操作失败"));
    if (res.ok) {
      await prLoadList(true);
      if (Pr.sel?.repo === repo && Pr.sel?.num === num) prSelect(repo, num);
    }
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

async function prMerge(btn) {
  if (!btn) return;
  // 两步确认防误点
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "确认合并？";
    setTimeout(() => { if (btn) { btn.dataset.confirm = ""; btn.textContent = "Merge (squash)"; } }, 4000);
    return;
  }
  btn.disabled = true; btn.textContent = "合并中…";
  const area = $("#pr-act-area");
  const repo = area?.dataset.repo || "";
  const num = parseInt(area?.dataset.num || "0", 10);
  try {
    const res = await post("/api/gh/pr/act", { repo, num, action: "merge" });
    toast(res.msg || (res.ok ? "已合并" : "合并失败"));
    if (res.ok) {
      Pr.sel = null;
      await prLoadList(true);
      const detail = $("#pr-detail");
      if (detail) detail.innerHTML = stateBox("PR 已合并");
      prMobileSync(false);
    } else {
      btn.disabled = false; btn.textContent = "Merge (squash)"; btn.dataset.confirm = "";
    }
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""));
    btn.disabled = false; btn.textContent = "Merge (squash)"; btn.dataset.confirm = "";
  }
}

async function prIgnore(repo, num, ignore) {
  const res = await post("/api/gh/pr/ignore", { repo, num, ignore });
  toast(res.msg || (res.ok ? "已更新" : "操作失败"));
  if (!res.ok) return;
  const p = Pr.list.find((x) => x.repo === repo && x.number === num);
  if (p) p.ignored = ignore;
  renderPrList();
  const count = Pr.list.filter((x) => x.bucket === "review" && !x.ignored).length;
  const badge = $("#b-pr");
  if (badge) badge.textContent = count || "";
  if (ignore && Pr.sel?.repo === repo && Pr.sel?.num === num) {
    Pr.sel = null;
    const detail = $("#pr-detail");
    if (detail) detail.innerHTML = stateBox("PR 已忽略");
    prMobileSync(false);
  }
}

async function prViewDiff(repo, num) {
  const btn = $("#pr-diff-btn");
  if (btn) btn.disabled = true;
  toast("拉取 diff…");
  try {
    const r = await getJSON(`/api/gh/pr/diff?repo=${encodeURIComponent(repo)}&num=${num}`);
    if (r?.ok && r.text !== undefined) showText(`${repo}#${num} Diff`, r.text || "(空 diff)");
    else toast(r?.msg || "diff 获取失败");
  } catch (e) {
    toast(String(e).replace(/^Error: /, "") || "diff 获取失败");
  } finally {
    if (btn) btn.disabled = false;
  }
}
