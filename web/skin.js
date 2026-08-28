"use strict";
/* 皮肤系统：内置皮肤 + 自定义图片皮肤（上传→取色→存 daemon）。
 * 三层约定见 style.css 头注释：这里只写氛围层（accent/accent-2/壁纸），
 * 语义色/来源色/中性色由 CSS 按 mode 两轨固定，皮肤永远不碰。
 * 皮肤库存 daemon（多设备共享），当前选择按设备存 localStorage。 */

const Skin = { customs: [], activeId: localStorage.getItem("ownward-skin") || "native-light", intensity: localStorage.getItem("ownward-skin-intensity") || "normal" };

/* 内置皮肤：原生两款（无壁纸）+ 四款渐变氛围款（零资产，gradient 常量即壁纸） */
const SKIN_GRADIENTS = {
  aurora: "linear-gradient(135deg, #0b1a2e 0%, #123a4e 34%, #1c5f57 62%, #7db8a0 100%)",
  nebula: "linear-gradient(140deg, #150f2e 0%, #2d1b53 40%, #6f3573 74%, #c96f8e 100%)",
  ember: "linear-gradient(150deg, #1c1210 0%, #3d1f1a 42%, #7a3b24 72%, #d98e4a 100%)",
  daybreak: "linear-gradient(135deg, #dfe9f5 0%, #cfe0f2 38%, #f2d9c8 74%, #f7c9a8 100%)",
  teal: "linear-gradient(#008080, #008080)",   // Win98 经典湖绿桌面（纯色当壁纸）
  // 像素天空：硬色阶断层（不渐变）= 8-bit 晚霞，抖动纹理由 pixel 外观层叠加
  pixelnight: "linear-gradient(180deg, #0b0b2a 0%, #0b0b2a 28%, #1d1d4e 28%, #1d1d4e 52%, #3a2a5e 52%, #3a2a5e 72%, #6a3a6e 72%, #6a3a6e 86%, #b8586a 86%, #b8586a 100%)",
};
const BUILTIN_SKINS = [
  { id: "native-dark", name: "原生 · 暗", mode: "dark", accent: "#63a8ff", accent2: "#47c7f4" },
  { id: "native-light", name: "原生 · 亮", mode: "light", accent: "#176fc1", accent2: "#0d8ebf" },
  { id: "aurora", name: "极光", mode: "dark", accent: "#5fd0a7", accent2: "#63a8ff", gradient: "aurora" },
  { id: "nebula", name: "星云", mode: "dark", accent: "#b58cff", accent2: "#e08bb1", gradient: "nebula" },
  { id: "ember", name: "余烬", mode: "dark", accent: "#f09c5c", accent2: "#e0725c", gradient: "ember" },
  { id: "daybreak", name: "破晓", mode: "light", accent: "#c2622e", accent2: "#2e7dc2", gradient: "daybreak" },
  { id: "pixel", name: "像素夜 ▓", mode: "dark", accent: "#5dd35d", accent2: "#f7d354", gradient: "pixelnight", look: "pixel" },
  { id: "win98", name: "Win98", mode: "light", accent: "#000080", accent2: "#008080", gradient: "teal", look: "win98" },
];
const LOOKS = ["pixel", "win98"];
const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET_RE = /^[a-f0-9]{16,64}\.(webp|jpe?g|png)$/;

function allSkins() { return [...BUILTIN_SKINS, ...Skin.customs]; }
function findSkin(id) { return allSkins().find((s) => s.id === id); }

/** 皮肤 → --wp-image 的 CSS 值（只可能是内置渐变常量或校验过的资产 url，不接受任意字符串） */
function wpImage(s) {
  if (s.gradient && SKIN_GRADIENTS[s.gradient]) return SKIN_GRADIENTS[s.gradient];
  if (s.asset && ASSET_RE.test(s.asset)) return `url("/skin-asset/${s.asset}")`;
  return null;
}

function applySkin(s, intensity) {
  if (!s) return;
  const d = document.documentElement;
  const mode = s.mode === "light" ? "light" : "dark";
  d.dataset.theme = mode === "light" ? "light" : "";
  d.style.setProperty("--accent", HEX.test(s.accent) ? s.accent : "");
  d.style.setProperty("--accent-2", HEX.test(s.accent2) ? s.accent2 : "");
  // 外观维度（形状/字体语言），白名单校验
  if (LOOKS.includes(s.look)) d.dataset.look = s.look; else delete d.dataset.look;
  const wp = wpImage(s);
  const iv = ["subtle", "normal", "vivid"].includes(intensity) ? intensity : "normal";
  if (wp) {
    d.dataset.wp = "1";
    d.dataset.wpIntensity = iv;
    d.style.setProperty("--wp-image", wp);
  } else {
    delete d.dataset.wp; delete d.dataset.wpIntensity;
    d.style.removeProperty("--wp-image");
  }
  // 系统 UI 跟随：theme-color 取 subtle 底色两轨的实色
  const themeColor = mode === "light" ? "#e9eef3" : "#0c1118";
  $("#meta-theme")?.setAttribute("content", themeColor);
  Skin.activeId = s.id;
  Skin.intensity = iv;
  localStorage.setItem("ownward-skin", s.id);
  localStorage.setItem("ownward-skin-intensity", iv);
  // 首屏预应用缓存（index.html 内联脚本回放用）
  localStorage.setItem("ownward-skin-boot", JSON.stringify({
    mode, accent: s.accent, accent2: s.accent2, wp: wp || "", intensity: iv, themeColor, look: s.look || "",
  }));
  localStorage.setItem("ownward-theme", mode === "light" ? "light" : "");  // 兼容旧键（strategy 页等）
}

async function loadCustomSkins() {
  Skin.customs = await getJSON("/api/skins").catch(() => Skin.customs);
}

/* ---- 选择器 UI ---- */
function skinCardHtml(s) {
  const wp = wpImage(s);
  const canvas = s.mode === "light" ? "#f1f4f7" : "#090c10";
  const surface = s.mode === "light" ? "#ffffffd8" : "#111720d8";
  return `<div class="skin-card" data-on="${Skin.activeId === s.id}" onclick="pickSkin('${jsq(s.id)}')">
    <div class="prev" style="background:${wp ? `linear-gradient(#00000014,#00000014),${wp.replace(/"/g, "&quot;")},` : ""}${canvas}">
      <div class="mock" style="background:${surface}"></div>
      <div class="dots"><i style="background:${esc(s.accent)}"></i><i style="background:${esc(s.accent2)}"></i></div>
    </div>
    <div class="meta"><span class="name">${esc(s.name)}</span>
      ${s.custom ? `<button class="del" title="删除" onclick="event.stopPropagation();deleteSkin('${jsq(s.id)}')">✕</button>` : ""}
    </div>
  </div>`;
}
function renderSkinPicker() {
  const box = $("#skin-body"); if (!box) return;
  const active = findSkin(Skin.activeId);
  const hasWp = active && !!wpImage(active);
  box.innerHTML = `
    <div class="skin-grid">
      ${allSkins().map(skinCardHtml).join("")}
      <div class="skin-upload" onclick="$('#skin-file').click()">
        <span style="font-size:20px">🖼</span><span>上传图片生成皮肤</span>
        <span style="font-size:11px;color:var(--text-disabled)">自动取色 + 全景壁纸<br>JPEG / PNG / WebP / HEIC</span>
      </div>
    </div>
    <div class="skin-row" ${hasWp ? "" : `style="display:none"`}>
      壁纸强度
      <span class="skin-seg">${["subtle", "normal", "vivid"].map((v) =>
        `<button data-on="${Skin.intensity === v}" onclick="setSkinIntensity('${v}')">${{ subtle: "含蓄", normal: "标准", vivid: "浓郁" }[v]}</button>`).join("")}</span>
      <span style="color:var(--text-disabled);font-size:11px">越浓郁面板越透，可读性优先选含蓄</span>
    </div>`;
}
function openSkinPicker() {
  $("#skin-overlay").dataset.open = "true";
  renderSkinPicker();
  loadCustomSkins().then(renderSkinPicker);
}
function pickSkin(id) {
  const s = findSkin(id); if (!s) { toast("皮肤不存在"); return; }
  applySkin(s, Skin.intensity);
  renderSkinPicker();
}
function setSkinIntensity(v) {
  applySkin(findSkin(Skin.activeId), v);
  renderSkinPicker();
}
async function deleteSkin(id) {
  if (!confirm("删除这个自定义皮肤？")) return;
  const r = await post("/api/skins/delete", { id });
  toast(r.msg || (r.ok ? "已删除" : "删除失败"));
  await loadCustomSkins();
  if (!findSkin(Skin.activeId)) applySkin(BUILTIN_SKINS[0], Skin.intensity);
  renderSkinPicker();
}

/* ---- 图片 → 皮肤：客户端缩图重编码（顺带去 EXIF）+ 直方图取色 ---- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = URL.createObjectURL(file);
  });
}
/** 直方图分桶取色（RGB 每通道 4bit）：按 占比×饱和度×明度适中 评分选 accent，
 *  secondary 取与 accent 色相差足够大的次优桶。k-means 不稳定，不用。 */
function extractPalette(img) {
  const c = document.createElement("canvas");
  const w = 64, h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * 64) || 64);
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const buckets = new Map();
  let lumSum = 0, lumN = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    if (a < 200) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumSum += lum; lumN++;
    if (mx < 28 || mn > 232) continue;              // 极黑/极白不参与取色
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  const scored = [...buckets.values()].map((e) => {
    const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const midness = 1 - Math.abs(lum - 0.55) * 1.6;  // 明度适中的更适合当 accent
    return { r, g, b, sat, score: e.n * (0.25 + sat) * Math.max(0.1, midness) };
  }).sort((a, b) => b.score - a.score);
  const toHex = (c0) => "#" + [c0.r, c0.g, c0.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const hueOf = (c0) => Math.atan2(Math.sqrt(3) * (c0.g - c0.b), 2 * c0.r - c0.g - c0.b);
  const primary = scored[0];
  let secondary = null;
  if (primary) {
    for (const s of scored.slice(1, 24)) {
      const dh = Math.abs(hueOf(s) - hueOf(primary));
      if (Math.min(dh, Math.PI * 2 - dh) > 0.9 && s.sat > 0.18) { secondary = s; break; }
    }
  }
  const avgLum = lumN ? lumSum / lumN / 255 : 0.2;
  return {
    accent: primary ? toHex(primary) : null,
    accent2: secondary ? toHex(secondary) : null,
    suggestMode: avgLum > 0.62 ? "light" : "dark",   // 建议值，固化进皮肤，用户可换
  };
}
/** accent 用作按钮底时保证 text-inverse 可读：明度极端就往中间收 */
function tuneAccent(hex, mode) {
  if (!HEX.test(hex || "")) return mode === "light" ? "#176fc1" : "#63a8ff";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const mix = (v, t, k) => Math.round(v * (1 - k) + t * k);
  let k = 0;
  if (mode === "dark" && lum < 0.32) k = (0.32 - lum) * 1.6;        // 暗轨太暗的 accent 提亮
  else if (mode === "light" && lum > 0.62) k = (lum - 0.62) * 1.6;  // 亮轨太亮的压暗
  else return hex;
  const t = mode === "dark" ? 255 : 0;
  return "#" + [r, g, b].map((v) => mix(v, t, Math.min(0.55, k)).toString(16).padStart(2, "0")).join("");
}

async function createSkinFromFile(file) {
  if (!file) return;
  // HEIC 按 type + 扩展名双判：Windows / 某些拖拽路径下 file.type 是空串
  const isHeic = /^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if (!isHeic && !/^image\/(png|jpeg|webp)$/.test(file.type)) { toast("只支持 JPEG / PNG / WebP / HEIC"); return; }
  if (file.size > 20 * 1024 * 1024) { toast("图片太大（>20MB）"); return; }
  toast("处理图片中…");
  try {
    let blob = file;
    if (isHeic) {  // Chromium 解不了 HEIC：先丢给 daemon 用 macOS sips 转成 jpeg，回来照旧走取色+重编码
      const r = await fetch("/api/skins/convert-heic", { method: "POST", body: file });
      if (!r.ok) { toast((await r.json().catch(() => null))?.msg || "HEIC 转换失败"); return; }
      blob = await r.blob();
    }
    const img = await loadImage(blob);
    const pal = extractPalette(img);
    // 壁纸重编码：最长边 1920，webp 不支持就 jpeg（canvas 重编码顺带剥掉 EXIF/GPS）
    const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    let dataUrl = c.toDataURL("image/webp", 0.82);
    if (!dataUrl.startsWith("data:image/webp")) dataUrl = c.toDataURL("image/jpeg", 0.85);
    URL.revokeObjectURL(img.src);
    const mode = pal.suggestMode;
    const body = {
      name: (file.name.replace(/\.[^.]+$/, "") || "自定义").slice(0, 24),
      mode,
      accent: tuneAccent(pal.accent, mode),
      accent2: pal.accent2 && HEX.test(pal.accent2) ? pal.accent2 : (mode === "light" ? "#0d8ebf" : "#47c7f4"),
      image: dataUrl,
    };
    const r = await post("/api/skins", body);
    if (!r.ok) { toast(r.msg || "保存失败"); return; }
    await loadCustomSkins();
    applySkin(findSkin(r.skin.id), Skin.intensity);
    renderSkinPicker();
    toast(`皮肤「${body.name}」已生成 ✓`);
  } catch (e) { toast(`生成失败：${e.message || e}`); }
}

/* ---- 初始化 ---- */
(function initSkin() {
  document.addEventListener("DOMContentLoaded", () => {
    $("#skin-close")?.addEventListener("click", () => ($("#skin-overlay").dataset.open = "false"));
    $("#skin-file")?.addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; createSkinFromFile(f); });
    // 迁移：没选过皮肤但旧明暗开关是 light → 对应原生亮
    if (!localStorage.getItem("ownward-skin") && localStorage.getItem("ownward-theme") === "light") Skin.activeId = "native-light";
    const builtin = findSkin(Skin.activeId);
    if (builtin) applySkin(builtin, Skin.intensity);
    else loadCustomSkins().then(() => {  // 自定义皮肤要等 daemon 列表（boot 缓存已先顶上，无闪色）
      const s = findSkin(Skin.activeId);
      if (s) applySkin(s, Skin.intensity);
      else applySkin(BUILTIN_SKINS.find((skin) => skin.id === "native-light"), Skin.intensity);
    });
  });
})();
