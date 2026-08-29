"use strict";
/* 每日总结 tab：纯日报列表（vault daily/ 只读查看与生成）。
 * 飞书消息已改由 sweepCapture 每 2h AI 精选后直接写 inbox（勾选制退役），这里不再要勾选区。
 * API: /api/vault/list  /api/vault/file  /api/digest/run */

const Summary = { dailyFiles: [], dailySel: null, dailyText: "", genBusy: false, dailyErr: "" };

/* ======== Tab 注册 ======== */
TABS.summary = {
  init(root) {
    root.innerHTML = `
      <div class="col sum-daily-col">
        <div class="page-head compact">
          <div><div class="eyebrow">DAILY</div><h1>日报</h1></div>
          <div class="tools" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="button ghost sm" id="sum-daily-refresh">刷新</button>
            <button class="button primary sm" id="sum-generate">生成今日日报</button>
          </div>
        </div>
        <div id="sum-daily-chips" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 4px 8px"></div>
        <div class="col-scroll panel" id="sum-daily-body" style="flex:1">${stateBox("正在加载…", "loading")}</div>
      </div>`;

    $("#sum-daily-refresh").addEventListener("click", loadDailyList);
    $("#sum-generate").addEventListener("click", generateToday);
    loadDailyList();
  },

  // 不做轮询：日报只被定时任务/本页显式动作改变，切回时刷新一次即可
  show() { loadDailyList(); },
};

/* ---- 日报区 ---- */
async function loadDailyList() {
  try {
    const list = await getJSON("/api/vault/list");
    Summary.dailyErr = "";
    // 日报只认 daily/ 下按日期命名的文件。dir 是 vault 相对路径——未开 scope 分流时
    // daily 就在 vault 根（dir === "daily"），开了则是 "work/daily" 之类；name 已去掉 .md 后缀
    Summary.dailyFiles = (Array.isArray(list) ? list : [])
      .filter((f) => {
        const dir = String(f?.dir || "");
        return (dir === "daily" || dir.endsWith("/daily")) && /^\d{4}-\d{2}-\d{2}$/.test(String(f?.name || ""));
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (e) { Summary.dailyErr = String(e); }   // 失败保留上次列表；从没成功过走错误态
  renderDailyList();
  renderDailyBody();
  if (!Summary.dailySel && Summary.dailyFiles.length) openDaily(Summary.dailyFiles[0].path);
}

function renderDailyList() {
  const box = $("#sum-daily-chips");
  if (!box) return;
  const files = Summary.dailyFiles;
  if (!files.length) { box.innerHTML = ""; return; }
  const shown = files.slice(0, 60);
  box.innerHTML = shown.map((f) =>
    `<button class="chip" data-on="${Summary.dailySel === f.path}" onclick="openDaily('${jsq(f.path)}')">${esc(f.name)}</button>`).join("")
    + (files.length > shown.length ? `<span style="font-size:12px;color:var(--text-tertiary)">还有 ${files.length - shown.length} 篇更早</span>` : "");
}

async function openDaily(path) {
  const r = await getJSON(`/api/vault/file?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!r?.ok) { toast(`日报读取失败${r?.msg ? "：" + r.msg : ""}`); return; }
  Summary.dailySel = path;
  Summary.dailyText = r.text || "";
  renderDailyList();   // 更新 chip 选中态
  renderDailyBody();
}

function renderDailyBody() {
  const el = $("#sum-daily-body");
  if (!el) return;
  if (Summary.dailyErr && !Summary.dailyFiles.length) { el.innerHTML = stateBox("日报列表加载失败：" + Summary.dailyErr, "error"); return; }
  if (!Summary.dailyFiles.length) { el.innerHTML = stateBox("还没有日报——点「生成今日日报」生成第一篇"); return; }
  if (!Summary.dailySel) { el.innerHTML = stateBox("选择一篇日报查看"); return; }
  el.innerHTML = `
    <div style="display:flex;justify-content:flex-end;padding:10px 12px 0">
      <button class="button ghost sm" id="sum-daily-raw">原文</button>
    </div>
    <div style="padding:4px 14px 14px">${mdHtml(Summary.dailyText)}</div>`;
  $("#sum-daily-raw").addEventListener("click", () =>
    showText(`日报 · ${String(Summary.dailySel).split("/").pop()}`, Summary.dailyText));
}

/* 生成今天的日报：confirm 确认 + busy 防重复，成功后刷新列表并自动打开今天这篇 */
async function generateToday() {
  if (Summary.genBusy) return;
  if (!confirm("生成今天的日报？（会调用一次 AI，约 30 秒）")) return;
  const btn = $("#sum-generate");
  Summary.genBusy = true;
  if (btn) btn.disabled = true;
  toast("日报生成中…");
  const r = await post("/api/digest/run", {});
  Summary.genBusy = false;
  if (btn) btn.disabled = false;
  toast(r.msg || (r.ok ? "已生成" : "生成失败"));
  if (!r.ok) return;
  await loadDailyList();
  const today = Summary.dailyFiles.find((f) => f.name === todayLocalISO());
  if (today) openDaily(today.path);
}

/** 本地时区的 YYYY-MM-DD（不用 toISOString：那是 UTC，零点后几小时内会错一天） */
function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
