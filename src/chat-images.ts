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
import { DATA, log } from "./util.ts";

export const CHATS_DIR = join(DATA, "chats");
export const ATTACH_ROOT = join(CHATS_DIR, "attachments");

/** 类型白名单 / 上限 / 魔数嗅探 / base64 校验都在 image-input.ts：
 *  对话附件与引擎会话附件共用同一份判据（见那个文件开头）。这里只留对话侧的落盘逻辑。 */
export {
  IMAGE_TYPES, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
  type PreparedImage, type ImageInput as ChatImageInput,
} from "./image-input.ts";  // 老调用方按 chat-images 引这些名字，位置搬了、名字不动
import { IMAGE_TYPES, MAX_IMAGE_BODY_BYTES, validateImageInputs, type PreparedImage } from "./image-input.ts";

/** 落进 AiMessage 的元数据：只有受控 id 与展示需要的信息，没有字节 */
export interface ChatImageMeta { id: string; mediaType: string; bytes: number }

/** 校验一组对话图片入参（与会话附件同一套判据）。 */
export const validateChatImages = validateImageInputs;

const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IMAGE_ID_RE = /^[a-z0-9]{12,40}$/;

/** /api/chat/send 的请求体上限（与会话附件同一个数：image-input.ts） */
export const MAX_SEND_BODY_BYTES = MAX_IMAGE_BODY_BYTES;

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
