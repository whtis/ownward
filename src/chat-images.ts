// AI 对话的图片附件：校验 → 落盘 data/chats/attachments/<chatId>/ → 消息只记 id + 元数据。
//
// 为什么不把 base64 塞进 chat JSON：一张 2MB 截图 = 2.7MB base64，每次 /api/chat/messages
// 都要整份读出来发给前端，几轮之后对话就打不开了（历史消息本来只是几 KB 文本）。
// 所以字节只住附件目录，消息里只留 { id, mediaType, bytes }，取图走单独的只读接口。
//
// 安全边界（与 skins.ts 的资产服务同一套思路）：
//   - media type 白名单 + 魔数嗅探：声明 image/png 实际是 HTML，会被原样回吐成 text/html → XSS；
//   - base64 必须规范（重编码后逐字相等），坏数据不进磁盘；
//   - chatId / imageId 严格正则 + 最终路径必须在附件根目录之下（startsWith(dir + "/")，不是裸前缀）；
//   - 取图前先在**这个对话的消息**里查 id 白名单：磁盘上有的文件≠这个对话能读的文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import type { Fail } from "./roles.ts";
import { DATA, log } from "./util.ts";

export const CHATS_DIR = join(DATA, "chats");
export const ATTACH_ROOT = join(CHATS_DIR, "attachments");

/** 支持的图片类型：Claude 多模态吃这四种，codex --image 同样认。HEIC 不入库——
 *  前端先经 /api/chat/convert-heic（macOS sips）转成 jpeg 再上传，存储白名单不放宽。 */
export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_IMAGES = 6;                       // 每条消息张数
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;    // 每张（解码后）
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;   // 每条消息合计
/** /api/chat/send 的请求体上限：图片 base64 膨胀 4/3，再给文本/JSON 包装留一倍余量。
 *  超了直接 413——别等 JSON.parse 把几十 MB 拉进内存才发现（守则 9：丢弃要可观测）。 */
export const MAX_SEND_BODY_BYTES = Math.round(MAX_TOTAL_BYTES * 4 / 3) + 2 * 1024 * 1024;

const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IMAGE_ID_RE = /^[a-z0-9]{12,40}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 客户端来的原始入参，一律当不可信处理 */
export interface ChatImageInput { media_type?: unknown; data?: unknown }
/** 校验通过、还没落盘的一张图（字节留在内存：claude 直接编进 stream-json 帧） */
export interface PreparedImage { mediaType: string; ext: string; bin: Buffer }
/** 落进 AiMessage 的元数据：只有受控 id 与展示需要的信息，没有字节 */
export interface ChatImageMeta { id: string; mediaType: string; bytes: number }

const fail = (msg: string): Fail => ({ ok: false, code: "invalid", msg });

/** 魔数嗅探：声明的 media type 必须与真实字节一致。
 *  只认这四种容器头——伪装成图片的 HTML/SVG/脚本在这里就被挡住，不会存进磁盘再被回吐。 */
function sniff(bin: Buffer): string {
  if (bin.length >= 8 && bin.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (bin.length >= 3 && bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff) return "image/jpeg";
  if (bin.length >= 12 && bin.toString("latin1", 0, 4) === "RIFF" && bin.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bin.length >= 6 && /^GIF8[79]a$/.test(bin.toString("latin1", 0, 6))) return "image/gif";
  return "";
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;

/** 校验一组图片入参。失败一律带原话（哪张、为什么），绝不悄悄丢掉其中几张。 */
export function validateChatImages(raw: unknown): { ok: true; images: PreparedImage[] } | Fail {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return fail("images 必须是数组");
  if (raw.length > MAX_IMAGES) return fail(`一条消息最多 ${MAX_IMAGES} 张图（收到 ${raw.length} 张）`);

  const images: PreparedImage[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const at = `第 ${i + 1} 张图`;
    const item = raw[i] as ChatImageInput;
    if (!item || typeof item !== "object") return fail(`${at}格式不对（要 {media_type, data}）`);
    const mediaType = String(item.media_type ?? "").trim().toLowerCase();
    const ext = IMAGE_TYPES[mediaType];
    if (!ext) return fail(`${at}类型不支持：${mediaType.slice(0, 40) || "(空)"}（只收 png/jpeg/webp/gif）`);
    const data = String(item.data ?? "");
    if (!data) return fail(`${at}没有数据`);
    // 先按 base64 的字符规则与长度粗筛，别把几十 MB 垃圾串扔给解码器
    if (data.length % 4 !== 0 || !B64_RE.test(data)) return fail(`${at}的 base64 不合法（只收裸 base64，不要 data: 前缀）`);
    if (data.length / 4 * 3 > MAX_IMAGE_BYTES + 8) return fail(`${at}超限（>${mb(MAX_IMAGE_BYTES)}）`);
    const bin = Buffer.from(data, "base64");
    // Buffer.from 对坏字符是静默跳过：重编码逐字比对才能真的拒绝截断/掺假的数据
    if (!bin.length || bin.toString("base64") !== data) return fail(`${at}的 base64 数据损坏`);
    if (bin.length > MAX_IMAGE_BYTES) return fail(`${at}超限（${mb(bin.length)} > ${mb(MAX_IMAGE_BYTES)}）`);
    const real = sniff(bin);
    if (real !== mediaType) {
      return fail(real
        ? `${at}声明 ${mediaType}，实际是 ${real}——按真实类型重新选一次`
        : `${at}不是有效的 png/jpeg/webp/gif 图片`);
    }
    total += bin.length;
    if (total > MAX_TOTAL_BYTES) return fail(`图片合计超限（>${mb(MAX_TOTAL_BYTES)}），少发几张或先压缩`);
    images.push({ mediaType, ext, bin });
  }
  return { ok: true, images };
}

/** 附件目录（chatId 非法返回 null——调用方必须显式处理，不许拼出目录外的路径） */
export function chatAttachDir(chatId: string): string | null {
  if (!CHAT_ID_RE.test(String(chatId || ""))) return null;
  const dir = resolve(join(ATTACH_ROOT, chatId));
  // 正则已排除 / 和 ..，这里是第二道：路径必须落在附件根之下（带 sep，防 attachments-evil/ 同前缀越界）
  return dir.startsWith(resolve(ATTACH_ROOT) + sep) ? dir : null;
}

function newImageId(): string {
  return Date.now().toString(36) + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/** 落盘：每张一个新 id（不做内容寻址——同一张图发两次要是共用文件，
 *  后一次发送失败的清理就会删掉前一次已经成功的消息引用的字节）。
 *  返回元数据（进消息）与文件路径（这一轮失败时按它精确回滚 / codex 按它传 --image）。 */
export function persistChatImages(chatId: string, images: PreparedImage[]): { metas: ChatImageMeta[]; files: string[] } {
  if (!images.length) return { metas: [], files: [] };
  const dir = chatAttachDir(chatId);
  if (!dir) throw new Error(`对话 id 不合法，附件无处存放：${String(chatId).slice(0, 40)}`);
  mkdirSync(dir, { recursive: true });
  const metas: ChatImageMeta[] = [];
  const files: string[] = [];
  try {
    for (const im of images) {
      const id = newImageId();
      const f = join(dir, `${id}.${im.ext}`);
      writeFileSync(f, im.bin);
      files.push(f);
      metas.push({ id, mediaType: im.mediaType, bytes: im.bin.length });
    }
  } catch (e) {
    // 中途写失败时调用方还拿不到 files，必须在这里清掉已写成功的前几张。
    removeChatImageFiles(files);
    throw e;
  }
  return { metas, files };
}

/** 这一轮发送失败的回滚：删掉刚写的字节，目录空了一并收掉（不留孤儿附件）。 */
export function removeChatImageFiles(files: string[]) {
  const dirs = new Set<string>();
  for (const f of files) {
    try { unlinkSync(f); dirs.add(f.slice(0, f.lastIndexOf(sep))); }
    catch (e) { log(`chat: 附件回滚失败 ${f}：${e}`); }   // 删不掉要留痕，不许当没发生
  }
  for (const d of dirs) {
    try { if (existsSync(d) && !readdirSync(d).length) rmSync(d, { recursive: true }); } catch { /* 空目录清不掉无所谓 */ }
  }
}

/** 删对话时清附件目录（chat JSON 没了，字节不许留在磁盘上） */
export function deleteChatAttachments(chatId: string) {
  const dir = chatAttachDir(chatId);
  if (!dir || !existsSync(dir)) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { log(`chat: 附件目录清理失败 ${dir}：${e}`); }
}

/** 只读取图：id 必须出现在**这个对话的消息**里（磁盘上有 ≠ 这个对话能读），
 *  扩展名取自消息里记的 mediaType，不信任调用方传的任何东西。 */
export function readChatImage(
  chat: { id: string; messages?: { images?: ChatImageMeta[] }[] },
  imageId: string,
): { bin: Buffer; mime: string } | null {
  const id = String(imageId || "");
  if (!IMAGE_ID_RE.test(id)) return null;
  const meta = (chat?.messages || []).flatMap((m) => m.images || []).find((im) => im?.id === id);
  const ext = meta && IMAGE_TYPES[meta.mediaType];
  if (!ext) return null;
  const dir = chatAttachDir(chat.id);
  if (!dir) return null;
  const f = join(dir, `${id}.${ext}`);
  if (!f.startsWith(dir + sep) || !existsSync(f)) return null;
  return { bin: readFileSync(f), mime: meta!.mediaType };
}

/** 历史重放/列表里的附件标注：说明有几张图，但不重复塞字节（codex 历史重放靠它） */
export function imageNote(images?: ChatImageMeta[]): string {
  return images?.length ? `[附件：${images.length} 张图片]` : "";
}

/** 纯图片发送时的默认提示语：不许发一条空消息给模型（模型会问"你要我干嘛"） */
export function defaultImageText(n: number): string {
  return n > 1 ? "看一下这几张图" : "看一下这张图";
}

/** chat id 合法性（loadChat / 附件接口共用）：id 就是文件名，非法的一律当不存在 */
export function validChatId(id: unknown): boolean {
  return CHAT_ID_RE.test(String(id || ""));
}
