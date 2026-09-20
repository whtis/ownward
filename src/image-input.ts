// 入站图片附件的统一校验：类型白名单 + 魔数嗅探 + 规范 base64 + 张数/单张/合计上限。
//
// 两条链路共用同一份判据：AI 对话（chat-images.ts，字节落 data/chats/attachments/）与
// 引擎会话附件（kernel/sessions，字节落 Runner blob）。面对的是同一批 provider 限制，
// 规则一旦分叉，就会有一条悄悄放宽——2026-09-16 实撞：会话那条完全没有校验，
// 前端不压缩的原图直接打到 Runner 8MiB blob 上限，用户等完上传才被拒。
//
// 安全边界（与 skins.ts 的资产服务同一套思路）：
//   - media type 白名单 + 魔数嗅探：声明 image/png 实际是 HTML，会被原样回吐成 text/html → XSS；
//   - base64 必须规范（重编码后逐字相等），坏数据不进磁盘。
import type { Fail } from "./roles.ts";

/** 支持的图片类型：Claude 多模态吃这四种，codex --image 同样认。HEIC 不入库——
 *  前端先经 /api/chat/convert-heic（macOS sips）转成 jpeg 再上传，白名单不放宽。 */
export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_IMAGES = 6;                       // 每条消息张数
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;    // 每张（解码后）
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;   // 每条消息合计
/** 带图请求体上限：base64 膨胀 4/3，再给文本/JSON 包装留一倍余量。
 *  超了直接 413——别等 JSON.parse 把几十 MB 拉进内存才发现（守则 9：丢弃要可观测）。 */
export const MAX_IMAGE_BODY_BYTES = Math.round(MAX_TOTAL_BYTES * 4 / 3) + 2 * 1024 * 1024;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 客户端来的原始入参，一律当不可信处理 */
export interface ImageInput { media_type?: unknown; data?: unknown }
/** 校验通过、还没落盘的一张图（字节留在内存：claude 直接编进 stream-json 帧） */
export interface PreparedImage { mediaType: string; ext: string; bin: Buffer }

export const imageMb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
const fail = (msg: string): Fail => ({ ok: false, code: "invalid", msg });

/** 魔数嗅探：声明的 media type 必须与真实字节一致。
 *  只认这四种容器头——伪装成图片的 HTML/SVG/脚本在这里就被挡住，不会存进磁盘再被回吐。 */
export function sniffImage(bin: Buffer): string {
  if (bin.length >= 8 && bin.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (bin.length >= 3 && bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff) return "image/jpeg";
  if (bin.length >= 12 && bin.toString("latin1", 0, 4) === "RIFF" && bin.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bin.length >= 6 && /^GIF8[79]a$/.test(bin.toString("latin1", 0, 6))) return "image/gif";
  return "";
}

/** 校验一组图片入参。失败一律带原话（哪张、为什么），绝不悄悄丢掉其中几张。 */
export function validateImageInputs(raw: unknown): { ok: true; images: PreparedImage[] } | Fail {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return fail("images 必须是数组");
  if (raw.length > MAX_IMAGES) return fail(`一条消息最多 ${MAX_IMAGES} 张图（收到 ${raw.length} 张）`);

  const images: PreparedImage[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const at = `第 ${i + 1} 张图`;
    const item = raw[i] as ImageInput;
    if (!item || typeof item !== "object") return fail(`${at}格式不对（要 {media_type, data}）`);
    const mediaType = String(item.media_type ?? "").trim().toLowerCase();
    const ext = IMAGE_TYPES[mediaType];
    if (!ext) return fail(`${at}类型不支持：${mediaType.slice(0, 40) || "(空)"}（只收 png/jpeg/webp/gif）`);
    const data = String(item.data ?? "");
    if (!data) return fail(`${at}没有数据`);
    // 先按 base64 的字符规则与长度粗筛，别把几十 MB 垃圾串扔给解码器
    if (data.length % 4 !== 0 || !B64_RE.test(data)) return fail(`${at}的 base64 不合法（只收裸 base64，不要 data: 前缀）`);
    if (data.length / 4 * 3 > MAX_IMAGE_BYTES + 8) return fail(`${at}超限（>${imageMb(MAX_IMAGE_BYTES)}），压缩后再发`);
    const bin = Buffer.from(data, "base64");
    // Buffer.from 对坏字符是静默跳过：重编码逐字比对才能真的拒绝截断/掺假的数据
    if (!bin.length || bin.toString("base64") !== data) return fail(`${at}的 base64 数据损坏`);
    if (bin.length > MAX_IMAGE_BYTES) return fail(`${at}超限（${imageMb(bin.length)} > ${imageMb(MAX_IMAGE_BYTES)}），压缩后再发`);
    const real = sniffImage(bin);
    if (real !== mediaType) {
      return fail(real
        ? `${at}声明 ${mediaType}，实际是 ${real}——按真实类型重新选一次`
        : `${at}不是有效的 png/jpeg/webp/gif 图片`);
    }
    total += bin.length;
    if (total > MAX_TOTAL_BYTES) return fail(`图片合计超限（>${imageMb(MAX_TOTAL_BYTES)}），少发几张或先压缩`);
    images.push({ mediaType, ext, bin });
  }
  return { ok: true, images };
}
