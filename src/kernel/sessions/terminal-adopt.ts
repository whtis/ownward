import { modeBitsClear, ownedByCurrentUser } from "../../posix-owner.ts";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const LAUNCH_ID = /^[a-f0-9]{32}$/;
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_REF = /^[A-Za-z0-9._:-]{8,256}$/;
export const TERMINAL_ADOPT_TTL_MS = 5 * 60_000;

type ProviderId = "claude" | "codex" | "codebuddy";
interface LaunchRecord {
  schemaVersion: 2;
  launchId: string;
  taskId: string;
  providerId: ProviderId;
  cwd: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  sessionId: string | null;
}

export class TerminalAdoptError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function dirs(dataRoot: string) {
  const root = join(dataRoot, "terminal-adopt"), pending = join(root, "pending"), tokens = join(root, "tokens");
  for (const dir of [root, pending, tokens]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  return { root, pending, tokens };
}
function hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function sameHash(actual: string, expected: string): boolean { const a = Buffer.from(hash(actual), "hex"), b = Buffer.from(expected, "hex"); return a.length === b.length && timingSafeEqual(a, b); }
function strictRecord(value: unknown): LaunchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TerminalAdoptError("TERMINAL_ADOPT_RECORD_INVALID", "握手记录无效");
  const row = value as Record<string, unknown>, keys = Object.keys(row).sort(), expected = ["createdAt", "cwd", "expiresAt", "launchId", "providerId", "schemaVersion", "sessionId", "taskId", "tokenHash"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || row.schemaVersion !== 2 || !LAUNCH_ID.test(String(row.launchId)) || !TASK_ID.test(String(row.taskId)) || !["claude", "codex", "codebuddy"].includes(String(row.providerId)) || typeof row.cwd !== "string" || (row.sessionId!==null&&!TASK_ID.test(String(row.sessionId))) || !/^[a-f0-9]{64}$/.test(String(row.tokenHash)) || Number.isNaN(Date.parse(String(row.createdAt))) || Number.isNaN(Date.parse(String(row.expiresAt)))) throw new TerminalAdoptError("TERMINAL_ADOPT_RECORD_INVALID", "握手记录无效");
  return row as unknown as LaunchRecord;
}
function privateFile(path: string): void { const st = statSync(path); if (!st.isFile() || !ownedByCurrentUser(st) || !modeBitsClear(st, 0o077)) throw new TerminalAdoptError("TERMINAL_ADOPT_FILE_INSECURE", "握手文件权限不安全"); }
function credential(path:string):{token:string;record:LaunchRecord}{privateFile(path);const raw=readFileSync(path,"utf8"),newline=raw.indexOf("\n");if(newline<1)throw new TerminalAdoptError("TERMINAL_ADOPT_RECORD_INVALID","握手凭证损坏");const token=raw.slice(0,newline),record=strictRecord(JSON.parse(raw.slice(newline+1)));if(!sameHash(token,record.tokenHash))throw new TerminalAdoptError("TERMINAL_ADOPT_RECORD_INVALID","握手凭证与记录不匹配");return{token,record};}
function writeCredential(path:string,token:string,record:LaunchRecord,flag:"wx"|"w"="wx"):void{writeFileSync(path,`${token}\n${JSON.stringify(record)}`,{mode:0o600,flag});chmodSync(path,0o600);}

export function createTerminalAdoptLaunch(dataRoot: string, input: { taskId: string; providerId: ProviderId; cwd: string; now?: Date; ttlMs?: number }): { launchId: string; tokenFile: string; expiresAt: string } {
  if (!TASK_ID.test(input.taskId)) throw new TerminalAdoptError("TERMINAL_ADOPT_TASK_INVALID", "任务 id 无效");
  const cwd = realpathSync(input.cwd), now = input.now ?? new Date(), ttl = input.ttlMs ?? TERMINAL_ADOPT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > TERMINAL_ADOPT_TTL_MS) throw new TerminalAdoptError("TERMINAL_ADOPT_TTL_INVALID", "握手 TTL 无效");
  sweepTerminalAdoptLaunches(dataRoot, now);
  const { pending, tokens } = dirs(dataRoot), launchId = randomBytes(16).toString("hex"), token = randomBytes(32).toString("base64url"), tokenFile = join(tokens, launchId), expiresAt = new Date(now.getTime() + ttl).toISOString();
  const record: LaunchRecord = { schemaVersion: 2, launchId, taskId: input.taskId, providerId: input.providerId, cwd, tokenHash: hash(token), createdAt: now.toISOString(), expiresAt, sessionId:null };
  writeCredential(tokenFile,token,record);
  return { launchId, tokenFile, expiresAt };
}

export function revokeTerminalAdoptLaunch(dataRoot: string, launchId: string): void {
  if (!LAUNCH_ID.test(launchId)) return;
  const { pending, tokens } = dirs(dataRoot);
  rmSync(join(pending, `${launchId}.json`), { force: true }); rmSync(join(tokens, launchId), { force: true });
}

export function terminalAdoptReceipt(dataRoot:string,launchId:string):{launchId:string;taskId:string;providerId:ProviderId;outcome:string;sessionId?:string}|null{if(!LAUNCH_ID.test(launchId))return null;try{const lines=readFileSync(join(dirs(dataRoot).root,"receipts.jsonl"),"utf8").trim().split("\n").reverse();for(const line of lines){const row=JSON.parse(line);if(row?.launchId===launchId&&typeof row.taskId==="string"&&(row.providerId==="claude"||row.providerId==="codex")&&typeof row.outcome==="string")return row;}return null;}catch{return null;}}

/** 清掉过期握手及孤儿 claim/token；启动/创建时可安全重复调用。 */
export function sweepTerminalAdoptLaunches(dataRoot: string, now = new Date()): number {
  const { tokens } = dirs(dataRoot); let removed = 0;
  for (const name of readdirSync(tokens)) {
    const launchId = name.split(".")[0]; if (!LAUNCH_ID.test(launchId)) continue;
    let expired = false;
    try { const {record} = credential(join(tokens,name)); expired ||= now.getTime() > Date.parse(record.expiresAt); } catch { expired = true; }
    if (expired) { rmSync(join(tokens,name), { force: true }); removed++; }
  }
  return removed;
}

export async function consumeTerminalAdoptLaunch<T extends { id: string }>(dataRoot: string, input: { launchId: string; token: string; taskId: string; providerId: ProviderId; cwd: string; nativeRef: string; now?: Date }, adopt: () => Promise<T>): Promise<{ session: T; receipt: Record<string, unknown> }> {
  if (!LAUNCH_ID.test(input.launchId) || !input.token || !TASK_ID.test(input.taskId) || !PROVIDER_REF.test(input.nativeRef)) throw new TerminalAdoptError("TERMINAL_ADOPT_INPUT_INVALID", "握手输入无效");
  const { root, tokens } = dirs(dataRoot), source = join(tokens,input.launchId);
  let record: LaunchRecord;
  try { record=credential(source).record; } catch (error: any) { if (error instanceof TerminalAdoptError) throw error; throw new TerminalAdoptError("TERMINAL_ADOPT_NOT_PENDING", "握手不存在或已使用"); }
  if (!sameHash(input.token, record.tokenHash)) throw new TerminalAdoptError("TERMINAL_ADOPT_TOKEN_INVALID", "握手凭证无效");
  const now = input.now ?? new Date();
  if (now.getTime() > Date.parse(record.expiresAt)) {
    if (record.sessionId) {
      const nextToken=randomBytes(32).toString("base64url"),nextRecord:LaunchRecord={...record,tokenHash:hash(nextToken),createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+TERMINAL_ADOPT_TTL_MS).toISOString()},next=`${source}.next.${process.pid}.${randomBytes(4).toString("hex")}`;
      writeCredential(next,nextToken,nextRecord);renameSync(next,source);
    } else revokeTerminalAdoptLaunch(dataRoot,input.launchId);
    throw new TerminalAdoptError("TERMINAL_ADOPT_EXPIRED", "握手已过期");
  }
  let cwd: string; try { cwd = realpathSync(input.cwd); } catch { throw new TerminalAdoptError("TERMINAL_ADOPT_BINDING_MISMATCH", "工作目录不匹配"); }
  if (record.launchId !== input.launchId || record.taskId !== input.taskId || record.providerId !== input.providerId || record.cwd !== cwd) throw new TerminalAdoptError("TERMINAL_ADOPT_BINDING_MISMATCH", "握手绑定不匹配");
  const claim = join(tokens, `${input.launchId}.claim.${process.pid}.${randomBytes(4).toString("hex")}`);
  try { renameSync(source, claim); } catch { throw new TerminalAdoptError("TERMINAL_ADOPT_REPLAY", "握手已被使用"); }
  const claimed=credential(claim).record;
  if(claimed.tokenHash!==record.tokenHash||claimed.taskId!==record.taskId||claimed.sessionId!==record.sessionId){try{renameSync(claim,source);}catch{}throw new TerminalAdoptError("TERMINAL_ADOPT_REPLAY","握手在认领窗口已轮换");}
  record=claimed;
  const base = { schemaVersion: 2, at: now.toISOString(), launchId: input.launchId, taskId: input.taskId, providerId: input.providerId };
  try {
    const session = await adopt(), receipt = { ...base, outcome: "adopted", sessionId: session.id };
    if(record.sessionId&&record.sessionId!==session.id)throw new TerminalAdoptError("TERMINAL_ADOPT_BINDING_MISMATCH","轮换凭证绑定的 Session 不匹配");
    const nextToken=randomBytes(32).toString("base64url"),nextRecord:LaunchRecord={...record,tokenHash:hash(nextToken),createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+TERMINAL_ADOPT_TTL_MS).toISOString(),sessionId:session.id},next=`${source}.next.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeCredential(next,nextToken,nextRecord);renameSync(next,source);
    appendFileSync(join(root, "receipts.jsonl"), JSON.stringify(receipt) + "\n", { mode: 0o600 }); chmodSync(join(root, "receipts.jsonl"), 0o600); rmSync(claim, { force: true });
    return { session, receipt };
  } catch (error: any) {
    // 系统/CAS/磁盘故障不消耗一次性凭证：把 claim 原子放回，允许同一 hook 重试。
    // 有稳定业务错误码的拒绝才是最终结局，必须 single-use 并留下 receipt。
    const terminalBusinessCodes = new Set([
      "SESSION_ACCESS_NOT_GRANTED", "SESSION_CWD_NOT_GRANTED", "SESSION_LEGACY_OWNED",
      "SESSION_NATIVE_REF_REQUIRED", "SESSION_NATIVE_REF_INVALID", "SESSION_PROVIDER_DRIFT",
      "PROVIDER_CAPABILITY_UNSUPPORTED", "PROVIDER_INPUT_INVALID",
    ]);
    const business = error instanceof TerminalAdoptError || terminalBusinessCodes.has(String(error?.code || ""));
    if (!business) { try { renameSync(claim, source); } catch { /* claim 保留，sweep 后人工处置 */ } throw error; }
    const receipt = { ...base, outcome: "failed", errorCode: error.code };
    appendFileSync(join(root, "receipts.jsonl"), JSON.stringify(receipt) + "\n", { mode: 0o600 }); chmodSync(join(root, "receipts.jsonl"), 0o600); rmSync(claim, { force: true }); rmSync(source, { force: true });
    throw error;
  }
}
