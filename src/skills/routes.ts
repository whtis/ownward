import { homedir } from "os";
import { existsSync, readFileSync, realpathSync } from "fs";
import { resolve } from "path";
import { DATA, cfg, expandHome } from "../util.ts";
import { isWithin } from "../path-within.ts";
import { ApprovalStore, approvalBinding } from "../control-plane/approval.ts";
import { SkillInventoryService } from "./service.ts";

function registeredProjectRoots(): string[] {
  const allowed = (cfg.architecture?.allowedRoots || []).flatMap((path: unknown) => { try { return typeof path === "string" ? [realpathSync(resolve(expandHome(path)))] : []; } catch { return []; } });
  try { return (JSON.parse(readFileSync(`${DATA}/projects.json`, "utf8")) as Array<{dir?: unknown}>).flatMap((project) => { try { const path = typeof project.dir === "string" ? realpathSync(resolve(expandHome(project.dir))) : ""; return path && existsSync(path) && allowed.some((root: string) => isWithin(root, path)) ? [path] : []; } catch { return []; } }); } catch { return []; }
}
const defaultService = new SkillInventoryService({ home: homedir(), codexHome: process.env.CODEX_HOME, projectRoots: registeredProjectRoots() });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
async function body(req: Request): Promise<any> { const length = Number(req.headers.get("content-length") || 0); if (length > 256 * 1024) throw Object.assign(new Error("请求过大"), { code: "SKILL_REQUEST_TOO_LARGE" }); try { return await req.json(); } catch { throw Object.assign(new Error("请求 JSON 无效"), { code: "SKILL_REQUEST_INVALID" }); } }
function status(error: any) { const code = String(error?.code || ""); if (code.includes("NOT_FOUND") || code === "SKILL_SCAN_REQUIRED") return 404; if (code.includes("STALE") || code.includes("DRIFT") || code.includes("BUSY") || code.includes("IDEMPOTENCY_CONFLICT") || code.includes("REPLAY")) return 409; if (code.includes("APPROVAL") || code.includes("PROTECTED") || code.includes("READ_ONLY") || code.includes("PLATFORM") || code.includes("FROZEN")) return 403; return 400; }
export interface SkillRouteContext { browserSession?: { id: string; interactive: boolean }; confirmUserPresence?: (sessionId: string) => Promise<boolean>; approvals?: ApprovalStore }
async function trustedSession(context: SkillRouteContext | undefined, requirePresence: boolean): Promise<string> { const session = context?.browserSession; if (!session?.id || (requirePresence && session.interactive !== true)) throw Object.assign(new Error("只有经过同源验证的交互式设置页可以执行此操作"), { code: "SKILL_APPROVAL_INTERACTIVE_REQUIRED" }); if (requirePresence && (!context?.confirmUserPresence || await context.confirmUserPresence(session.id) !== true)) throw Object.assign(new Error("未确认本机用户在场"), { code: "SKILL_APPROVAL_PRESENCE_REQUIRED" }); return session.id; }

export async function routeSkills(req: Request, url: URL, service = defaultService, context?: SkillRouteContext): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/skills")) return null;
  try {
    if (url.pathname === "/api/skills" && req.method === "GET") { const inventory = service.current(); return inventory ? json(inventory) : json({ error: "SKILL_SCAN_REQUIRED", message: "尚未扫描 skill" }, 404); }
    if (url.pathname === "/api/skills/registry" && req.method === "GET") return json(service.publicRegistry());
    if (url.pathname === "/api/skills/scan" && req.method === "POST") { if (service === defaultService) service.options.projectRoots = registeredProjectRoots(); return json(await service.scan()); }
    if (url.pathname === "/api/skills/analysis/preview" && req.method === "POST") { const input = await body(req), session = await trustedSession(context, true); if (!context?.approvals) throw Object.assign(new Error("内容授权服务不可用"), { code: "SKILL_CONTENT_CONSENT_UNAVAILABLE" }); const ids = Array.isArray(input.contentObservationIds) ? [...input.contentObservationIds].sort() : input.contentObservationIds, previews = service.contentPreview(input.expectedRevision, ids), consent = context.approvals.mint("skills-content-analysis", session, approvalBinding({ revision: input.expectedRevision, observationIds: ids })); return json({ previews, consentId: consent.id, expiresAt: consent.expiresAt }); }
    if (url.pathname === "/api/skills/analysis" && req.method === "POST") { const input = await body(req); if (Array.isArray(input.contentObservationIds) && input.contentObservationIds.length) { const session = await trustedSession(context, false); if (!context?.approvals) throw Object.assign(new Error("内容授权服务不可用"), { code: "SKILL_CONTENT_CONSENT_UNAVAILABLE" }); const ids = [...input.contentObservationIds].sort(); context.approvals.consume(String(input.consentId || ""), "skills-content-analysis", session, approvalBinding({ revision: input.expectedRevision, observationIds: ids })); input.contentObservationIds = ids; } return json(await service.analysis(input.expectedRevision, input.contentObservationIds)); }
    if (url.pathname === "/api/skills/plan" && req.method === "POST") { const input = await body(req); return json(service.plan({ expectedRevision: input.expectedRevision, actions: input.actions ?? input.proposal?.actions })); }
    const planApproval = /^\/api\/skills\/plans\/([^/]+)\/approval$/.exec(url.pathname);
    if (planApproval && req.method === "POST") { const input = await body(req); return json(service.mintApproval(planApproval[1], input.expectedPlanDigest, await trustedSession(context, true)), 201); }
    if (url.pathname === "/api/skills/apply" && req.method === "POST") { const input = await body(req); if (input.approval) input.approval = { ...input.approval, browserSession: await trustedSession(context, false) }; return json(await service.apply(input), 202); }
    if (url.pathname === "/api/skills/transactions" && req.method === "GET") return json(service.transactions());
    const tx = /^\/api\/skills\/transactions\/([^/]+)$/.exec(url.pathname); if (tx && req.method === "GET") return json(service.transaction(tx[1]));
    const rollbackPlan = /^\/api\/skills\/transactions\/([^/]+)\/rollback-plan$/.exec(url.pathname); if (rollbackPlan && req.method === "GET") return json(service.rollbackPreview(rollbackPlan[1]));
    const rollbackApproval = /^\/api\/skills\/transactions\/([^/]+)\/rollback\/approval$/.exec(url.pathname);
    if (rollbackApproval && req.method === "POST") { const input = await body(req); return json(service.mintRollbackApproval(rollbackApproval[1], input.expectedRevision, await trustedSession(context, true)), 201); }
    const rollback = /^\/api\/skills\/transactions\/([^/]+)\/rollback$/.exec(url.pathname);
    if (rollback && req.method === "POST") { const input = await body(req), browserSession = await trustedSession(context, false); return json(service.rollback({ ...input, approval: { ...input.approval, browserSession }, transactionId: rollback[1] }), 202); }
    return json({ error: "SKILL_ROUTE_NOT_FOUND", message: "未知 Skill API" }, 404);
  } catch (error: any) { return json({ error: error?.code || "SKILL_REQUEST_FAILED", message: error instanceof Error ? error.message : "Skill 请求失败" }, status(error)); }
}

/** Daemon startup hook: recover nonterminal sagas before accepting new mutations. */
export function recoverDefaultSkillTransactions(): void { defaultService.recover(); }
