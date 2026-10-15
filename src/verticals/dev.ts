import type { OwnwardVertical, VerticalContext, VerticalManifest } from "../kernel/extensions/contracts.ts";
import type { DevDomainAdapter } from "./dev-domain-adapter.ts";
import type { DevDomainHandler } from "./dev-domain-service.ts";

export const DEV_DOMAIN_ROUTES = [
  "/api/work", "/api/cc-hook", "/api/cc/adopt", "/api/task/adopt-terminal", "/api/task/done",
  "/api/dev/repo", "/api/dev/repo/diff", "/api/dev/repo/open", "/api/dev/repo/act",
  "/api/gh/prs", "/api/gh/pr", "/api/gh/pr/diff", "/api/gh/pr/ignore", "/api/gh/pr/act",
  "/api/evolve", "/api/evolve/apply", "/api/flight/open",
] as const;

export function isDevDomainRoute(pathname: string): boolean { return (DEV_DOMAIN_ROUTES as readonly string[]).includes(pathname); }

export const manifest: VerticalManifest = {
  id: "dev", name: "Development", version: "1.0.0", kernelApiVersion: 1, entry: "builtin:dev",
  capabilities: ["sessions", "tasks", "tasks:full-access", "actions"], roots: [],
  routes: ["/api/verticals/dev/work"],
  navigation: [{ id: "tasks", label: "任务", href: "/#tasks" }],
  commands: [{ id: "work", title: "派发编码任务", schema: { type: "object", required: ["dir", "task"] } }],
};
export function createDevVertical(deps: { domain: DevDomainAdapter; manifest?: VerticalManifest }): OwnwardVertical { let ready = false, context: VerticalContext | null = null, domain: DevDomainHandler | null = null; return {
  manifest: deps.manifest ?? manifest,
  activate(ctx: VerticalContext) { context = ctx; domain = deps.domain.bind(ctx); ready = true; },
  deactivate() { ready = false; domain = null; context = null; },
  async route({ request, url }) { if (url.pathname !== "/api/verticals/dev/work" && url.pathname !== "/api/work") return isDevDomainRoute(url.pathname) ? domain?.route(request, url) ?? null : null; if (request.method !== "POST") return new Response("method not allowed", { status: 405 }); if (!context?.tasks) return new Response(JSON.stringify({ ok: false, code: "TASK_SERVICE_UNAVAILABLE" }), { status: 503 }); const { MAX_IMAGE_BODY_BYTES } = await import("../image-input.ts"), declared = Number(request.headers.get("content-length") || 0); if (declared > MAX_IMAGE_BODY_BYTES) return new Response(JSON.stringify({ ok: false, msg: `请求体太大（${(declared / 1048576).toFixed(1)}MB）：少发几张图或先压缩` }), { status: 413, headers: { "Content-Type": "application/json" } }); try { const task = await context.tasks.startWork(await request.json() as any) as { id: string; mode: string; roleName?: string; roleNote?: string }; return new Response(JSON.stringify({ ok: true, msg: `已派发 [${task.id}] ${task.mode}${task.roleName ? ` · 由「${task.roleName}」接手` : task.roleNote ? ` · 没带上角色：${task.roleNote}` : ""}`, task }), { headers: { "Content-Type": "application/json" } }); } catch (e:any) { const msg = String(e?.message||e),code=String(e?.code||""); return new Response(JSON.stringify({ ok: false, msg, ...(code?{errorCode:code}:{}) }), { status: code==="SESSION_ACCESS_NOT_GRANTED"||/^VERTICAL_(?:CWD|FULL_ACCESS|BYPASS|ROOT)/.test(code)||/VERTICAL_(?:CWD|FULL_ACCESS|BYPASS|ROOT)/.test(msg) ? 403 : code==="SESSION_IMAGE_INVALID" ? 400 /* 图片不合格是入参问题，别报成 500 */ : 500, headers: { "Content-Type": "application/json" } }); } },
  health() { return { ok: ready, compatibility: "legacy /api/work remains active" }; },
}; }
export default createDevVertical;
