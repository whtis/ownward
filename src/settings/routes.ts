import { join } from "path";
import { ROOT, SOURCE_ROOT } from "../util.ts";
import { loadSettings, validateSettingsPatches, type SettingsFiles } from "./service.ts";
import { ApprovalError, ApprovalStore, approvalBinding } from "../control-plane/approval.ts";
import { SettingsOperationError, SettingsOperationStore, abandonSettingsOperation, approveSettingsOperation, clientSettingsRequestDigest } from "./operations.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

export interface SettingsRouteContext {
  browserSession?: { id: string; interactive: boolean };
  approvals?: ApprovalStore;
  operations?: SettingsOperationStore;
  runtimeBuildIdentity?: string;
  requestOrigin?: string;
  proxied?: boolean;
  /** 由原生 UI/浏览器手势桥提供；仅有 localhost session 不能证明人在场。 */
  confirmUserPresence?: (sessionId: string) => Promise<boolean>;
  /** 必须在独立生命周期中确定性排队；resolve 才允许返回 202。 */
  dispatchApply?: (operationId: string) => Promise<void>;
  /** 节流判断必须与 dispatch 共用进程级状态，避免轮询重复启动 recovery helper。 */
  allowRecoveryDispatch?: (operationId: string) => boolean | Promise<boolean>;
  dispatchRecovery?: (operationId: string) => Promise<void>;
}

function publicValidation(result: ReturnType<typeof validateSettingsPatches>) {
  const { candidateOverrideRaw: _raw, normalizedPatches, ...rest } = result;
  return { ...rest, normalizedPatches: normalizedPatches.map((patch) => patch.op === "remove" ? patch : ({ ...patch, value: (rest.redactedDiff.find((entry) => entry.path === patch.path)?.after) })) };
}

function binding(result: ReturnType<typeof validateSettingsPatches>) {
  return approvalBinding({ sourceDigest: result.sourceDigest, patches: result.normalizedPatches, risk: result.risk });
}

function routeError(error: unknown): Response {
  if (error instanceof SyntaxError) return json({ error: { code: "INVALID_REQUEST", message: "请求体必须是有效 JSON" } }, 400);
  if (error instanceof ApprovalError) return json({ error: { code: error.code, message: error.message } }, error.code === "APPROVAL_REQUIRED" ? 403 : 409);
  if (error instanceof SettingsOperationError) {
    const status = error.code === "SETTINGS_OPERATION_NOT_FOUND" ? 404 : error.code === "SETTINGS_APPLY_FROZEN" ? 423 : 409;
    return json({ error: { code: error.code, message: error.message } }, status);
  }
  const any = error as any;
  if (any?.issues) return json({ error: { code: any.code || "VALIDATION_FAILED", message: any.message }, issues: any.issues }, any.code === "STALE_DIGEST" ? 409 : 422);
  return json({ error: { code: any?.code || "SETTINGS_APPLY_FAILED", message: String(any?.message || error).slice(0, 500) } }, typeof any?.status === "number" ? any.status : 500);
}

async function bodyObject(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("请求体必须是 JSON 对象"), { code: "INVALID_REQUEST", status: 400 });
  return body as Record<string, unknown>;
}

async function maybeDispatchRecovery(operation: { id: string; phase: string }, context: SettingsRouteContext) {
  if (["committed", "restored", "manual-repair"].includes(operation.phase) || !context.allowRecoveryDispatch || !context.dispatchRecovery) return undefined;
  try {
    if (!await context.allowRecoveryDispatch(operation.id)) return { state: "throttled" as const };
    await context.dispatchRecovery(operation.id);
    return { state: "dispatched" as const };
  } catch (error) {
    return { state: "failed" as const, error: { code: "SETTINGS_RECOVERY_DISPATCH_FAILED", message: String((error as any)?.message || error).slice(0, 300) } };
  }
}

export function defaultSettingsFiles(): SettingsFiles {
  // 生产 CONFIG_ROOT 指向不可变 release snapshot。控制面必须 CAS/写 source checkout，
  // 否则会篡改快照且下一次完整 install 又把变更丢掉。
  return { defaultFile: join(ROOT, "config.default.json"), overrideFile: join(SOURCE_ROOT, "config.json") };
}

export async function routeSettings(req: Request, url: URL, files: SettingsFiles = defaultSettingsFiles(), context: SettingsRouteContext = {}): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/settings/schema") return json(loadSettings(files).schema);
  if (req.method === "GET" && url.pathname === "/api/settings/effective") return json(loadSettings(files).snapshot);
  if (req.method === "POST" && url.pathname === "/api/settings/validate") {
    try {
      const body = await req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: { code: "INVALID_REQUEST", message: "请求体必须是 JSON 对象" } }, 400);
      const result = validateSettingsPatches(body as Record<string, unknown>, files);
      const stale = result.issues.find((issue) => issue.code === "STALE_DIGEST");
      if (stale) return json({ error: { code: "STALE_DIGEST", message: stale.message }, sourceDigest: result.sourceDigest }, 409);
      if (!result.valid) return json({ error: { code: "VALIDATION_FAILED", message: "设置校验失败" }, issues: result.issues, sourceDigest: result.sourceDigest }, 422);
      return json(publicValidation(result));
    } catch (error) { return json({ error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) } }, 400); }
  }
  if (req.method === "POST" && url.pathname === "/api/settings/approve") {
    try {
      if (!context.browserSession?.interactive || !context.approvals || !context.confirmUserPresence) throw new ApprovalError("APPROVAL_REQUIRED", "必须由交互式浏览器会话确认设置变更");
      const body = await bodyObject(req), result = validateSettingsPatches(body, files);
      if (!result.valid) return json(publicValidation(result), result.issues.some((issue) => issue.code === "STALE_DIGEST") ? 409 : 422);
      if (!result.normalizedPatches.length) return json({ error: { code: "NO_CHANGES", message: "没有需要应用的设置变更" } }, 422);
      const confirmations = Array.isArray(body.confirmations) ? body.confirmations.filter((item): item is string => typeof item === "string") : [];
      const missing = result.risk.confirmations.filter((item) => !confirmations.includes(item));
      if (missing.length) return json({ error: { code: "CONFIRMATION_REQUIRED", message: "高风险设置需要额外确认" }, missing }, 422);
      if (!await context.confirmUserPresence(context.browserSession.id)) throw new ApprovalError("APPROVAL_REQUIRED", "未确认当前用户在场，拒绝签发批准");
      const approval = context.approvals.mint("settings-apply", context.browserSession.id, binding(result));
      return json({ approvalId: approval.id, expiresAt: approval.expiresAt, bindingDigest: approval.bindingDigest });
    } catch (error) { return routeError(error); }
  }
  if (req.method === "POST" && url.pathname === "/api/settings/apply") {
    try {
      if (!context.browserSession?.id || !context.approvals) throw new ApprovalError("APPROVAL_REQUIRED", "缺少浏览器会话批准");
      if (!context.operations || !context.dispatchApply || !context.runtimeBuildIdentity) return json({ error: { code: "SETTINGS_APPLY_UNAVAILABLE", message: "设置部署 helper 或 runtime identity 尚未接通" } }, 503);
      const body = await bodyObject(req);
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      const previous = context.operations.findIdempotent(context.browserSession.id, idempotencyKey);
      const clientRequestDigest = clientSettingsRequestDigest(body.sourceDigest, body.patches);
      if (previous) {
        if (previous.clientRequestDigest !== clientRequestDigest) throw new SettingsOperationError("SETTINGS_IDEMPOTENCY_CONFLICT", "同一幂等键已绑定其他设置变更");
        return json({ operation: context.operations.public(previous.id), reused: true }, previous.phase === "committed" ? 200 : 202);
      }
      const result = validateSettingsPatches(body, files);
      if (!result.valid) return json(publicValidation(result), result.issues.some((issue) => issue.code === "STALE_DIGEST") ? 409 : 422);
      if (!result.normalizedPatches.length) return json({ error: { code: "NO_CHANGES", message: "没有需要应用的设置变更" } }, 422);
      const approval = context.approvals.consume(String(body.approvalId || ""), "settings-apply", context.browserSession.id, binding(result));
      const prepared = context.operations.prepare({ sourceDigest: result.sourceDigest, patches: result.normalizedPatches, idempotencyKey, browserSessionId: context.browserSession.id, runtimeBuildIdentity: context.runtimeBuildIdentity, requestOrigin: context.requestOrigin, proxied: context.proxied, clientRequestDigest }, files);
      approveSettingsOperation(context.operations, prepared.operation.id, approval);
      try { await context.dispatchApply(prepared.operation.id); }
      catch (error) { abandonSettingsOperation(context.operations, prepared.operation.id, error); throw error; }
      return json({ operation: context.operations.public(prepared.operation.id), reused: prepared.reused }, 202);
    } catch (error) { return routeError(error); }
  }
  const operationMatch = url.pathname.match(/^\/api\/settings\/operations\/([a-f0-9-]{36})$/);
  if (req.method === "GET" && operationMatch) {
    try {
      if (!context.operations) return json({ error: { code: "SETTINGS_APPLY_UNAVAILABLE", message: "设置操作日志不可用" } }, 503);
      const operation = context.operations.read(operationMatch[1]!);
      return json({ operation: context.operations.public(operation.id), recoveryDispatch: await maybeDispatchRecovery(operation, context) });
    } catch (error) { return routeError(error); }
  }
  if (req.method === "GET" && (url.pathname === "/api/settings/operations" || url.pathname === "/api/settings/operations/current")) {
    try {
      if (!context.operations) return json({ error: { code: "SETTINGS_APPLY_UNAVAILABLE", message: "设置操作日志不可用" } }, 503);
      const operations = context.operations.list().slice(-50).reverse();
      if (url.pathname.endsWith("/current")) {
        const current = operations.find((op) => !["committed", "restored", "manual-repair"].includes(op.phase)) ?? operations[0];
        return json({ operation: current ? context.operations.public(current.id) : null, recoveryDispatch: current ? await maybeDispatchRecovery(current, context) : undefined });
      }
      return json({ operations: operations.map((op) => context.operations!.public(op.id)) });
    } catch (error) { return routeError(error); }
  }
  return null;
}
