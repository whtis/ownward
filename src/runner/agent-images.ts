// 会话图片仓（runner 架构版）：agent 眼里的图（工具结果里的截图、Read 的图片、CC transcript
// 图片块）落盘 data/runner/agent-images/<key>/，journal payload 与消息只带 URL——
// 图片二进制绝不进 journal（1MiB 帧上限）也不进轮询响应，理由同 chat-images.ts 开头。
//
// 写入方有两个进程：Runner（claude adapter 的 tool_result）与 daemon（cc-sessions 旁观）。
// 内容寻址（sha256 前 16 位做文件名）+ wx 独占写 + EEXIST 容忍 = 跨进程幂等，无需锁；
// 与 Runner 的 inputs/payloads blob 维护锁体系完全隔离（独立目录、自带配额 GC，不碰那套锁序）。
// 安全边界同 chat-images：扩展名来自魔数嗅探（不信声明），key/file 严格正则 + 路径包含校验。
// 观测数据（至多一次）：落盘失败/被 GC 只是看不到图，绝不阻塞事件流。
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";

export const AGENT_IMG_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const AGENT_IMG_FILE_RE = /^[a-f0-9]{16}\.(png|jpg|webp|gif)$/;
export const AGENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const AGENT_IMAGE_MAX_PER_MESSAGE = 8;
export const AGENT_IMAGE_TOTAL_BYTES_PER_MESSAGE = 8 * 1024 * 1024;
// Provider 先收到整行 JSONL 再归一化落盘；按单消息 8MiB 原图总预算计算 base64 膨胀，
// 另留 8MiB 给文本和协议信封，避免把 8x8MiB 的笛卡尔上限变成近 100MiB 常驻半行。
export const AGENT_IMAGE_PROVIDER_LINE_MAX_BYTES = Math.ceil(AGENT_IMAGE_TOTAL_BYTES_PER_MESSAGE * 4 / 3) + 8 * 1024 * 1024;
const QUOTA_FILES = 500;             // 全仓配额：超了删 mtime 最老的（观测数据，容忍丢失）
const QUOTA_BYTES = 200 * 1024 * 1024;

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export type AgentOutputContentPart = { type: "text"; text: string } | { type: "image"; url: string };

function estimatedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function imageBudget() {
  let count = 0, bytes = 0;
  return (data: unknown): data is string => {
    if (typeof data !== "string" || !data) return false;
    const size = estimatedBase64Bytes(data), allowed = count < AGENT_IMAGE_MAX_PER_MESSAGE && size > 0 && size <= AGENT_IMAGE_MAX_BYTES && bytes + size <= AGENT_IMAGE_TOTAL_BYTES_PER_MESSAGE;
    count++;
    if (allowed) bytes += size;
    return allowed;
  };
}

export function agentImageRoot(dataRoot: string): string { return join(dataRoot, "runner", "agent-images"); }

function sniffExt(bin: Buffer): string {
  if (bin.length >= 8 && bin.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (bin.length >= 3 && bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff) return "jpg";
  if (bin.length >= 12 && bin.toString("latin1", 0, 4) === "RIFF" && bin.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (bin.length >= 6 && /^GIF8[79]a$/.test(bin.toString("latin1", 0, 6))) return "gif";
  return "";
}

/** key（session id / CC transcript uuid）→ 目录；非法返回 null，绝不拼出仓外路径 */
function dirFor(dataRoot: string, key: string): string | null {
  if (!AGENT_IMG_KEY_RE.test(String(key || ""))) return null;
  const root = resolve(agentImageRoot(dataRoot));
  const dir = resolve(join(root, key));
  return dir.startsWith(root + sep) ? dir : null;
}

/** 全仓配额 GC：超限删最老（跨 key）。只在写入路径触发，失败静默——观测数据不值得为它报警。 */
function enforceQuota(dataRoot: string): void {
  try {
    const root = agentImageRoot(dataRoot);
    if (!existsSync(root)) return;
    const files: { path: string; mtime: number; size: number }[] = [];
    for (const key of readdirSync(root)) {
      const dir = join(root, key);
      try { for (const f of readdirSync(dir)) { const st = statSync(join(dir, f)); files.push({ path: join(dir, f), mtime: st.mtimeMs, size: st.size }); } } catch { /* 单目录坏了不拦整体 */ }
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (files.length <= QUOTA_FILES && total <= QUOTA_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    let count = files.length;
    for (const f of files) {
      if (count <= QUOTA_FILES && total <= QUOTA_BYTES) break;
      try { rmSync(f.path); count--; total -= f.size; } catch { /* 删不掉跳过 */ }
    }
  } catch { /* GC 失败不影响写入 */ }
}

/** 落一张 base64 图：嗅探定型、哈希命名、幂等写。成功返回客户端可直接用的 URL。 */
export function saveAgentImage(dataRoot: string, key: string, data: unknown): string | null {
  if (typeof data !== "string" || !data || (data.length / 4) * 3 > AGENT_IMAGE_MAX_BYTES + 8) return null;
  const dir = dirFor(dataRoot, key);
  if (!dir) return null;
  let bin: Buffer;
  try { bin = Buffer.from(data, "base64"); } catch { return null; }
  if (!bin.length || bin.length > AGENT_IMAGE_MAX_BYTES) return null;
  const ext = sniffExt(bin);
  if (!ext) return null;
  const name = `${createHash("sha256").update(bin).digest("hex").slice(0, 16)}.${ext}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, name), bin, { flag: "wx", mode: 0o600 });
    enforceQuota(dataRoot);
  } catch (e: any) {
    if (e?.code !== "EEXIST") return null;  // 已存在=幂等命中（跨进程/transcript 重读都走这）
  }
  return `/api/agent-image/${key}/${name}`;
}

/** 消息 content 数组里捞图片块（顶层 image 块 + tool_result 内层），返回 URL 列表。 */
export function saveContentImages(dataRoot: string, key: string, content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  const withinBudget = imageBudget();
  const take = (c: any) => {
    if (c?.type !== "image" || c?.source?.type !== "base64" || !withinBudget(c.source.data)) return;
    const u = saveAgentImage(dataRoot, key, c.source.data);
    if (u && !urls.includes(u)) urls.push(u);
  };
  for (const c of content) {
    take(c);
    if ((c as any)?.type === "tool_result" && Array.isArray((c as any).content)) {
      for (const inner of (c as any).content) take(inner);
    }
  }
  return urls;
}

/** Codex MCP ImageContent 是 {type:"image",data,mimeType}，与 Claude 的 source.base64
 *  形状不同。递归替换成仓内 URL，任何失败路径也必须删掉 data，避免 base64 进入 durable payload。 */
export function normalizeCodexContentImages(dataRoot: string | undefined, key: string, value: unknown): unknown {
  const withinBudget = imageBudget();
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    const item = current as Record<string, unknown>;
    if (item.type === "image" && typeof item.data === "string") {
      const { data: _data, ...safe } = item;
      const url = dataRoot && withinBudget(item.data) ? saveAgentImage(dataRoot, key, item.data) : null;
      return { ...safe, ...(url ? { url } : { unavailable: true }) };
    }
    return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child)]));
  };
  return visit(value);
}

/** Claude 图片块递归脱敏：保留文本和容器，base64 图片换成 URL 或 unavailable。 */
export function normalizeClaudeContentImages(dataRoot: string | undefined, key: string, value: unknown): unknown {
  const withinBudget = imageBudget();
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    const item = current as Record<string, unknown>, source = item.source;
    if (item.type === "image" && source && typeof source === "object" && (source as any).type === "base64") {
      const data = (source as any).data, url = dataRoot && withinBudget(data) ? saveAgentImage(dataRoot, key, data) : null;
      return { type: "image", ...((source as any).media_type ? { mediaType: (source as any).media_type } : {}), ...(url ? { url } : { unavailable: true }) };
    }
    return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child)]));
  };
  return visit(value);
}

export function contentImageUrls(value: unknown): string[] {
  const urls: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { for (const child of current) visit(child); return; }
    if (!current || typeof current !== "object") return;
    const item = current as Record<string, unknown>;
    if (item.type === "image" && typeof item.url === "string" && item.url.startsWith("/api/agent-image/")) { if (!urls.includes(item.url)) urls.push(item.url); return; }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return urls;
}

/** 从已脱敏的 Codex mcp_tool_call item 取可见输出。只沿 MCP 结果容器查找，
 *  不把 arguments 里碰巧叫 content 的数组误当工具返回。 */
export function codexMcpOutputParts(value: unknown): AgentOutputContentPart[] {
  const find = (current: unknown, depth: number): unknown[] | null => {
    if (!current || typeof current !== "object" || Array.isArray(current) || depth > 4) return null;
    const item = current as Record<string, unknown>;
    if (Array.isArray(item.content) && item.content.some((part: any) => part?.type === "text" || part?.type === "image")) return item.content;
    for (const name of ["result", "output", "response", "Ok", "ok"] as const) {
      const found = find(item[name], depth + 1);
      if (found) return found;
    }
    return null;
  };
  const content = find(value, 0) ?? [];
  const parts: AgentOutputContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") parts.push({ type: "text", text: item.text });
    else if (item.type === "image" && typeof item.url === "string" && item.url.startsWith("/api/agent-image/")) parts.push({ type: "image", url: item.url });
  }
  return parts;
}

/** 服务端路由读图：双正则 + 路径包含校验，读不到返回 null。 */
export function readAgentImage(dataRoot: string, key: string, file: string): { bin: Buffer; mime: string } | null {
  if (!AGENT_IMG_FILE_RE.test(file)) return null;
  const dir = dirFor(dataRoot, key);
  if (!dir) return null;
  try {
    const bin = readFileSync(join(dir, file));
    return { bin, mime: MIME[file.split(".").pop()!] };
  } catch { return null; }
}
