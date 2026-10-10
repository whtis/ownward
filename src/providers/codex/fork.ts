// Codex 会话分叉：codex exec 没有可验证的原生分叉命令，复制原会话 rollout 到一个新 thread id，
// 之后对新 id 走普通 `exec resume`。原文件只读不写——原会话照常续聊，也不会撞它的 writer 锁
// （锁按 thread id 分，见 ~/.codex/thread-writer-locks/<uuid>.lock）。
// 未在真 CLI 上验证：新版 codex 还有 state_5.sqlite 线程表，若 resume 只认数据库，复制件会找不到，
// adapter 的 resume_not_found / nativeRef 漂移检查会让这一轮明确失败，原会话不受影响。默认由 providers.codex.fork 关着。
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "fs";
import { fsyncSync } from "../../fs-durable.ts";
import { dirname, isAbsolute, join, normalize, relative, sep } from "path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一轮结束的标记：截到最后一个这样的行，复制件里就不会有原会话正在跑的半截轮次 */
function closesTurn(entry: any): boolean {
  return entry?.type === "event_msg" && (entry.payload?.type === "task_complete" || entry.payload?.type === "turn_aborted");
}

function sessionMetaId(line: string): string | null {
  try { const entry = JSON.parse(line); return entry?.type === "session_meta" ? String(entry.payload?.id ?? entry.payload?.session_id ?? "") : null; } catch { return null; }
}

/** 在 <home>/sessions 下按 session_meta 找原会话 rollout（与 readCodexTranscript 同一判据），多份取最新 */
export function findCodexRollout(home: string, nativeRef: string): string {
  const root = join(home, "sessions"); if (!existsSync(root)) throw new Error("Codex sessions 目录不存在");
  const hits: string[] = [];
  for (const item of readdirSync(root, { recursive: true }) as string[]) {
    const path = normalize(join(root, item)), rel = relative(root, path);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !path.endsWith(".jsonl")) continue;
    // 文件名带 id 是快路径；读头部 session_meta 才是判据（文件名可能被改）
    if (!path.includes(nativeRef)) continue;
    try { const head = readFileSync(path, "utf8").slice(0, 96 * 1024).split("\n").slice(0, 8); if (head.some((line) => { const id = sessionMetaId(line); return id === nativeRef; })) hits.push(path); } catch { /* 读不了的跳过 */ }
  }
  if (!hits.length) throw new Error("原会话 rollout 不存在");
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); return hits[0]!;
}

/** 纯函数：把原 rollout 正文变成分叉件正文。只留完整行、截到最后一个完整轮次，session_meta 换成新 id。 */
export function forkRolloutText(source: string, originRef: string, newRef: string): string {
  const complete = source.endsWith("\n") ? source : source.slice(0, source.lastIndexOf("\n") + 1);   // 原会话正在追加的半行不要
  const lines = complete.split("\n").filter(Boolean), parsed = lines.map((line) => { try { return JSON.parse(line); } catch { return undefined; } });
  let cut = -1; for (let i = 0; i < parsed.length; i++) if (closesTurn(parsed[i])) cut = i;
  if (cut < 0) throw new Error("原会话还没有完整结束的一轮，无法分叉");
  let rewritten = 0;
  const out = lines.slice(0, cut + 1).map((line, i) => {
    const entry = parsed[i]; if (entry?.type !== "session_meta") return line;
    const payload = entry.payload ?? {}; if (payload.id !== originRef && payload.session_id !== originRef) return line;
    rewritten++; return JSON.stringify({ ...entry, payload: { ...payload, ...(payload.id !== undefined ? { id: newRef } : {}), ...(payload.session_id !== undefined ? { session_id: newRef } : {}) } });
  });
  if (!rewritten) throw new Error("原会话 rollout 缺少 session_meta");
  return out.join("\n") + "\n";
}

/** 复制出分叉件，返回新 thread id 与文件路径。wx 落盘 + fsync：中途崩了只会留下一份没人引用的文件，不会写坏原件。 */
export function forkCodexRollout(home: string, originRef: string, newRef: string = Bun.randomUUIDv7(), now = new Date()): { nativeRef: string; path: string } {
  if (!UUID.test(originRef) || !UUID.test(newRef)) throw new Error("Codex thread id 非法");
  const source = findCodexRollout(home, originRef), body = forkRolloutText(readFileSync(source, "utf8"), originRef, newRef);
  const day = now.toISOString().slice(0, 10).split("-"), stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const path = join(home, "sessions", day[0]!, day[1]!, day[2]!, `rollout-${stamp}-${newRef}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600);
  try { const data = Buffer.from(body); let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset); fsyncSync(fd); }
  catch (error) { closeSync(fd); rmSync(path, { force: true }); throw error; }
  closeSync(fd);
  return { nativeRef: newRef, path };
}
