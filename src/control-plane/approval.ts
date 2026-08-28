import { createHash, timingSafeEqual } from "crypto";

export interface ApprovalRecord {
  id: string;
  kind: "settings-apply" | "skills-apply" | "skills-content-analysis";
  sessionId: string;
  bindingDigest: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export class ApprovalError extends Error {
  constructor(public code: "APPROVAL_REQUIRED" | "APPROVAL_EXPIRED" | "APPROVAL_REPLAYED" | "APPROVAL_SESSION_MISMATCH" | "APPROVAL_TAMPERED", message: string) { super(message); }
}

export function approvalBinding(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

function same(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** Approval 只存在于当前浏览器会话所在 daemon；重启前必须已消费并写入 durable operation。 */
export class ApprovalStore {
  private records = new Map<string, ApprovalRecord>();
  constructor(private now = () => Date.now(), private ttlMs = 5 * 60_000) {}

  mint(kind: ApprovalRecord["kind"], sessionId: string, bindingDigest: string): ApprovalRecord {
    if (!sessionId) throw new ApprovalError("APPROVAL_REQUIRED", "缺少交互式浏览器会话");
    const created = this.now(), record: ApprovalRecord = {
      id: crypto.randomUUID(), kind, sessionId, bindingDigest,
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.ttlMs).toISOString(),
    };
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  consume(id: string, kind: ApprovalRecord["kind"], sessionId: string, bindingDigest: string): ApprovalRecord {
    const record = this.records.get(id);
    if (!record || record.kind !== kind) throw new ApprovalError("APPROVAL_REQUIRED", "需要有效的人工作业批准");
    if (record.consumedAt) throw new ApprovalError("APPROVAL_REPLAYED", "批准已使用，不能重放");
    if (this.now() > Date.parse(record.expiresAt)) throw new ApprovalError("APPROVAL_EXPIRED", "批准已过期，请重新确认");
    if (record.sessionId !== sessionId) throw new ApprovalError("APPROVAL_SESSION_MISMATCH", "批准与当前浏览器会话不匹配");
    if (!same(record.bindingDigest, bindingDigest)) throw new ApprovalError("APPROVAL_TAMPERED", "批准内容与应用内容不一致");
    record.consumedAt = new Date(this.now()).toISOString();
    return structuredClone(record);
  }
}
