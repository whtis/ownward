import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { atomicWrite } from "./filesystem.ts";

interface ApprovalRecord { schemaVersion: 1; id: string; planId: string; planDigest: string; inventoryRevision: string; browserSession: string; nonce: string; createdAt: string; expiresAt: string; consumedAt: string | null }
const approvalDir = (storeRoot: string) => join(storeRoot, "approvals");
const pathFor = (storeRoot: string, id: string) => join(approvalDir(storeRoot), `${id}.json`);
const validSession = (value: string) => /^[A-Za-z0-9._:-]{16,160}$/.test(value);

export function mintSkillApproval(storeRoot: string, input: { planId: string; planDigest: string; inventoryRevision: string; browserSession: string }, ttlMs = 5 * 60_000): { id: string; expiresAt: string; nonce: string } {
  if (!validSession(input.browserSession)) throw Object.assign(new Error("浏览器会话标识无效"), { code: "SKILL_APPROVAL_SESSION_INVALID" });
  const now = new Date(), id = randomUUID(), record: ApprovalRecord = { schemaVersion: 1, id, planId: input.planId, planDigest: input.planDigest, inventoryRevision: input.inventoryRevision, browserSession: input.browserSession, nonce: randomUUID(), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + Math.min(ttlMs, 5 * 60_000)).toISOString(), consumedAt: null };
  atomicWrite(pathFor(storeRoot, id), JSON.stringify(record) + "\n"); return { id, expiresAt: record.expiresAt, nonce: record.nonce };
}

export function consumeSkillApproval(storeRoot: string, input: { id: string; nonce: string; planId: string; planDigest: string; inventoryRevision: string; browserSession: string }): void {
  if (!/^[0-9a-f-]{36}$/i.test(input.id) || !/^[0-9a-f-]{36}$/i.test(input.nonce)) throw Object.assign(new Error("审批标识无效"), { code: "SKILL_APPROVAL_INVALID" });
  const path = pathFor(storeRoot, input.id), claim = `${path}.consuming-${process.pid}-${randomUUID()}`;
  try { renameSync(path, claim); } catch { throw Object.assign(new Error("审批不存在、已使用或正在使用"), { code: "SKILL_APPROVAL_REPLAY" }); }
  let record: ApprovalRecord;
  try { record = JSON.parse(readFileSync(claim, "utf8")); } catch { throw Object.assign(new Error("审批记录损坏"), { code: "SKILL_APPROVAL_INVALID" }); }
  const matches = record.schemaVersion === 1 && !record.consumedAt && record.id === input.id && record.nonce === input.nonce && record.planId === input.planId && record.planDigest === input.planDigest && record.inventoryRevision === input.inventoryRevision && record.browserSession === input.browserSession;
  if (!matches) { atomicWrite(`${path}.rejected`, JSON.stringify({ ...record, consumedAt: new Date().toISOString() }) + "\n"); try { if (existsSync(claim)) renameSync(claim, `${claim}.rejected`); } catch {} throw Object.assign(new Error("审批与计划、revision 或浏览器会话不匹配"), { code: "SKILL_APPROVAL_MISMATCH" }); }
  if (Date.parse(record.expiresAt) <= Date.now()) { atomicWrite(`${path}.expired`, JSON.stringify({ ...record, consumedAt: new Date().toISOString() }) + "\n"); throw Object.assign(new Error("审批已过期"), { code: "SKILL_APPROVAL_EXPIRED" }); }
  atomicWrite(`${path}.used`, JSON.stringify({ ...record, consumedAt: new Date().toISOString() }) + "\n");
  try { renameSync(claim, `${claim}.consumed`); } catch {}
}
