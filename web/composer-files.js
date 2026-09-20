"use strict";
/* Composer 文件附件：派发弹窗与会话追问两处共用。
 *
 * 和图片是两套机制，别混：图片有 base64 image block，能直接进 stream-json 的用户帧；
 * 任意文件没有这种块，CLI agent 只能用自己的 Read/Bash 从磁盘读。所以文件是
 * 「先上传落盘 → 发送时服务端把绝对路径拼进正文 → 该目录授权给 agent」。
 *
 * 由此带来一个和图片不同的性质：**文件一上传就在服务端了**，刷新页面、切走再切回来都还在，
 * 所以这里不持有文件内容，只持有 scope，列表随时从 /api/uploads 重新拉。
 */

const ComposerFiles = {
  _byKey: new Map(),   // key → { scope, files: [{name, bytes}] }

  _lsKey(key) { return `ownward-upload-scope:${key}`; },

  /** key 拿到它的 scope：**每次组消息一个新的 draft-<uuid>**，发送时由服务端落定。
   *  不能拿 taskId 当 scope——那样第二条消息会把第一条的附件再列一遍。
   *  scope 存 localStorage：刷新页面后还能把「传了但没发」的文件认领回来（文件本来就在服务端盘上）。
   *  存储在隐私窗口/禁用站点数据时会抛，读写都兜住——拿不到就退化成「本次会话内有效」。 */
  scope(key, create = false) {
    let entry = this._byKey.get(key);
    if (!entry) {
      let saved = "";
      try { saved = localStorage.getItem(this._lsKey(key)) || ""; } catch { saved = ""; }
      entry = { scope: saved, files: [] };
      this._byKey.set(key, entry);
    }
    if (!entry.scope && create) {
      entry.scope = `draft-${crypto.randomUUID()}`;
      try { localStorage.setItem(this._lsKey(key), entry.scope); } catch { /* 存不住就只在本次页面有效 */ }
    }
    return entry.scope;
  },
  list(key) { return this._byKey.get(key)?.files ?? []; },
  has(key) { return !!this.list(key).length; },

  /** 从服务端重拉列表——文件在盘上，页面刷新/切会话都不该丢。 */
  async refresh(key, onChange) {
    this.scope(key);   // 先从 localStorage 水合出 scope，否则刷新后认领不回来
    const entry = this._byKey.get(key);
    if (!entry?.scope) return;
    const r = await getJSON(`/api/uploads?scope=${encodeURIComponent(entry.scope)}`).catch(() => null);
    if (!r?.ok) return;
    entry.files = r.files || [];
    onChange?.();
  },

  async add(key, fileList, onChange) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const scope = this.scope(key, true), entry = this._byKey.get(key);
    for (const file of files) {
      // 逐个传：一个失败不影响其余，且每个都能给出自己的原因
      try {
        const r = await fetch(`/api/uploads?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(file.name || "upload")}`,
          { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body?.ok) { toast(body?.msg || `「${file.name}」上传失败`); continue; }
        entry.files = entry.files.filter((f) => f.name !== body.name).concat([{ name: body.name, bytes: body.bytes }]);
        onChange?.();
      } catch { toast(`「${file.name}」上传失败`); }
    }
  },

  async remove(key, name, onChange) {
    const entry = this._byKey.get(key);
    if (!entry?.scope) return;
    await post("/api/uploads/remove", { scope: entry.scope, name });
    entry.files = entry.files.filter((f) => f.name !== name);
    onChange?.();
  },

  /** 发送成功后调用：scope 已交给服务端并落定，本地忘掉；下次传文件会开一个新草稿 scope。 */
  clear(key) {
    this._byKey.delete(key);
    try { localStorage.removeItem(this._lsKey(key)); } catch { /* 清不掉也只是个失效 scope，sweep 会收 */ }
  },

  /** 随消息发出去的 scope（没文件就别发，省得服务端白跑一趟 listUploads）。 */
  payloadScope(key) { return this.has(key) ? this._byKey.get(key).scope : undefined; },

  chipsHtml(key) {
    const files = this.list(key);
    if (!files.length) return "";
    const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
    return files.map((f) => `<span class="file-chip" title="${esc(f.name)}">
      <span class="file-chip-name">${esc(f.name)}</span><span class="file-chip-size">${kb(f.bytes)}</span>
      <button type="button" title="移除" aria-label="移除 ${esc(f.name)}" data-file-remove="${esc(f.name)}">✕</button></span>`).join("");
  },
};

/** 把一个容器里的「✕」按钮接到 remove 上——两处共用，免得各写一遍事件委托。 */
function bindComposerFileChips(container, key, onChange) {
  if (!container) return;
  container.querySelectorAll("[data-file-remove]").forEach((b) => {
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ComposerFiles.remove(key, b.dataset.fileRemove, onChange); });
  });
}

/** 拖放：图片仍走图片流水线，其余一律当文件传。两个 handler 必须互斥，别让同一张图两条路都走。 */
function bindComposerDrop(el, { key, onChange, onImage }) {
  if (!el) return;
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.dataset.dropping = "1"; });
  el.addEventListener("dragleave", () => { delete el.dataset.dropping; });
  el.addEventListener("drop", (e) => {
    e.preventDefault(); delete el.dataset.dropping;
    const all = [...(e.dataTransfer?.files || [])];
    if (!all.length) return;
    const images = onImage ? all.filter((f) => f.type.startsWith("image/")) : [];
    const rest = all.filter((f) => !images.includes(f));
    images.forEach(onImage);
    if (rest.length) ComposerFiles.add(key, rest, onChange);
  });
}
