// 角色记忆进任务的「信封」：拼在任务首条消息最前面，一对标签包住。
//
// 为什么走首条消息而不是 --append-system-prompt：后台任务的唯一写链是 Runner，Provider options
// 是严格白名单且键序参与 Session 身份（见 SELF.md），往里塞 system prompt 要动 IPC 契约与三家 adapter；
// 而且 append-system-prompt 只活在单个 CLI 进程里，resume 的下一轮就没了。首条消息落进
// Provider 自己的 transcript，claude / codex / codebuddy 一视同仁，续聊、压缩后都还在。
//
// 代价是首条消息的原文里多了一大段记忆——会话视图、搜索索引、旁观列表都必须用 splitRoleContext
// 拆掉信封再展示，否则用户看到的「我说的第一句话」是几千字的记忆。展示侧把信封换成一条
// system 提示（「已带上角色记忆」），说清楚注入了什么，但不把正文铺给人看。
//
// 本文件零依赖：kernel 投影器、会话扫描、派发三处都要用，不能把角色层的重依赖带进去。
export const ROLE_CONTEXT_TAG = "ownward-role-context";
const OPEN = `<${ROLE_CONTEXT_TAG}>`;
const CLOSE = `</${ROLE_CONTEXT_TAG}>`;

export interface RoleContextMeta { id: string; name: string; projects: string[] }

/** 信封头是一行 JSON：角色名可能带引号/尖括号，自造属性语法迟早转义出错 */
export function wrapRoleContext(meta: RoleContextMeta, body: string): string {
  const head = JSON.stringify({ id: meta.id, name: meta.name, projects: meta.projects });
  // 记忆正文来自 vault（人和同步工具都能写）：里面要是恰好有闭合标签，拆信封时会把半截记忆当成用户的话
  const safe = body.trim().replaceAll(CLOSE, `</${ROLE_CONTEXT_TAG}_>`);
  return `${OPEN}${head}\n${safe}\n${CLOSE}\n\n`;
}

function parseMeta(raw: string): RoleContextMeta | null {
  let v: any;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof v.id !== "string" || !v.id || v.id.length > 64) return null;
  if (typeof v.name !== "string" || v.name.length > 80) return null;
  if (!Array.isArray(v.projects) || v.projects.length > 40 || v.projects.some((p: unknown) => typeof p !== "string")) return null;
  return { id: v.id, name: v.name || v.id, projects: v.projects.map((p: string) => p.slice(0, 64)) };
}

/** 不是信封开头 / 信封残缺 / 头部不是合法 JSON → null，调用方原样展示（宁可露出原文也不吞掉用户的话） */
export function splitRoleContext(text: string): { meta: RoleContextMeta; body: string; rest: string } | null {
  if (typeof text !== "string" || !text.startsWith(OPEN)) return null;
  const nl = text.indexOf("\n", OPEN.length);
  const end = text.indexOf(`\n${CLOSE}`, OPEN.length);
  if (nl < 0 || end < 0 || end < nl) return null;
  const meta = parseMeta(text.slice(OPEN.length, nl));
  if (!meta) return null;
  return { meta, body: text.slice(nl + 1, end), rest: text.slice(end + CLOSE.length + 1).replace(/^\s+/, "") };
}

/** 只要用户自己的那部分（标题匹配、搜索、旁观认领用） */
export function stripRoleContext(text: string): string {
  return splitRoleContext(text)?.rest ?? text;
}

/** 会话视图里替代信封的那一行 */
export function roleContextNotice(meta: RoleContextMeta): string {
  const projects = meta.projects.length ? `（项目：${meta.projects.join("、")}）` : "";
  return `已带上角色「${meta.name}」的记忆${projects}`;
}
