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
const MAX_BYTES = 8 * 1024 * 1024;   // 单张上限：超大的不落盘（消息里就不出现，不报错不阻塞）
const MAX_PER_MSG = 8;
const QUOTA_FILES = 500;             // 全仓配额：超了删 mtime 最老的（观测数据，容忍丢失）
const QUOTA_BYTES = 200 * 1024 * 1024;

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

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
  if (typeof data !== "string" || !data || (data.length / 4) * 3 > MAX_BYTES + 8) return null;
  const dir = dirFor(dataRoot, key);
  if (!dir) return null;
  let bin: Buffer;
  try { bin = Buffer.from(data, "base64"); } catch { return null; }
  if (!bin.length || bin.length > MAX_BYTES) return null;
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
  const take = (c: any) => {
    if (urls.length >= MAX_PER_MSG || c?.type !== "image" || c?.source?.type !== "base64") return;
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
