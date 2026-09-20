"use strict";
/* Composer 图片入口：AI 对话、任务追问、派发弹窗三处共用的同一条流水线。
 *
 * 为什么必须在前端收口：会话附件最终要落 Runner blob，上限 8MiB（base64，见 src/runner/attachments.ts），
 * 而手机截图动辄 6MB 起——原样发出去，用户等完一次上传只会拿到一句「附件超过 blob 上限」，
 * 图还挂在输入框里，也不知道该怎么办。移动端（ios/ImageEncoder.swift、android/ImageEncoder.kt）
 * 早就在本地压好再发，Web 这边把同一套补齐：能压的压，压不动的当场说清楚。
 *
 * 分层照旧：前端这层是体验（不让用户白等一次上传），后端 chat-images.ts 的校验与 blob 上限才是保证。
 */

const COMPOSER_IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const COMPOSER_IMG_MAX = 6;                          // 每条消息张数（与 chat-images.ts MAX_IMAGES 同值）
const COMPOSER_IMG_BYTES = 5 * 1024 * 1024;          // 每张（解码后）
const COMPOSER_IMG_TOTAL = 12 * 1024 * 1024;         // 每条合计
const COMPOSER_IMG_SOURCE_BYTES = 20 * 1024 * 1024;  // 原图上限：再大连解码都不值当，直接让用户先压
const composerImgMb = (n) => `${(n / 1048576).toFixed(1)}MB`;

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const rd = new FileReader();
  rd.onload = () => res(String(rd.result).split(",")[1] || "");
  rd.onerror = () => rej(rd.error || new Error("读取失败"));
  rd.readAsDataURL(blob);
});

/** 一张图从 File 到可发送的 base64：类型白名单 → HEIC 转码 → 超限缩成 jpeg。
 *  返回 {media_type, data, size, blob}；返回 null = 这张不收，原因已经 toast 过（不静默丢）。 */
async function prepareComposerImage(file) {
  if (!file) return null;
  // HEIC 按 type + 扩展名双判：某些拖拽路径下 file.type 是空串（同 skin.js）
  const isHeic = /^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name || "");
  if (!isHeic && !COMPOSER_IMG_TYPES.includes(file.type)) { toast("只支持 PNG / JPEG / WebP / GIF / HEIC"); return null; }
  if (file.size > COMPOSER_IMG_SOURCE_BYTES) { toast(`图片太大（${composerImgMb(file.size)}），先压缩一下`); return null; }
  try {
    let blob = file;
    let type = file.type;
    if (isHeic) {   // Chromium 解不了 HEIC：丢给 daemon 用 macOS sips 转 jpeg（与皮肤壁纸同一条实现）
      toast("HEIC 转码中…");
      const r = await fetch("/api/chat/convert-heic", { method: "POST", body: file });
      if (!r.ok) { toast((await r.json().catch(() => null))?.msg || "HEIC 转换失败"); return null; }
      blob = await r.blob();
      type = "image/jpeg";
    }
    if (blob.size > COMPOSER_IMG_BYTES) {
      const small = await shrinkComposerImage(blob, type);
      if (!small) { toast(`单张不能超过 ${composerImgMb(COMPOSER_IMG_BYTES)}（${composerImgMb(blob.size)}），先压缩一下`); return null; }
      toast(`图片较大（${composerImgMb(blob.size)}），已压缩后附上`);   // 改了内容就明说，不偷偷换掉用户的图
      blob = small; type = "image/jpeg";
    }
    return { media_type: type, data: await blobToBase64(blob), size: blob.size, blob };
  } catch (e) { toast(`读取图片失败：${String(e).slice(0, 80)}`); return null; }
}

/** 张数/合计上限：放在异步准备之后判，并发粘贴多张也不会越界（超限已 toast）。 */
function composerImageFits(list, size) {
  const current = list || [];
  if (current.length >= COMPOSER_IMG_MAX) { toast(`一条消息最多 ${COMPOSER_IMG_MAX} 张图`); return false; }
  if (current.reduce((n, i) => n + (i.size || 0), 0) + size > COMPOSER_IMG_TOTAL) { toast(`图片合计不能超过 ${composerImgMb(COMPOSER_IMG_TOTAL)}，少发几张`); return false; }
  return true;
}

/** 超限图片的兜底压缩：最长边 1920 的 jpeg。GIF 不碰——重编码会把动图拍成一张静图，
 *  那不是"压缩"，是换了张图（宁可让用户明确知道超限）。 */
async function shrinkComposerImage(blob, type) {
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
      if (out && out.size <= COMPOSER_IMG_BYTES) return out;
    }
    return null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}
