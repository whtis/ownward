import { findFlightRecord } from "../flight-record.ts";
import { listPrs, prAct, prDetail, prDiff, setPrIgnored } from "../github-pr.ts";
import { openInEditor, repoAct, repoDiff, repoStatus } from "../repo-panel.ts";
import { applyCcHook, finalizeTerminalTask } from "../terminal-tasks.ts";
import type { VerticalContext } from "../kernel/extensions/contracts.ts";
import type { DevDomainHandler } from "../verticals/dev-domain-service.ts";

type AdoptResult = { id: string };
export interface DevSessionCandidate {
  readonly id: string;
  readonly kind: "claude" | "codex" | "codebuddy";
  readonly active: boolean;
  readonly project: string;
  readonly title: string;
}
export interface DevSessionDiscovery {
  verifyClaudeTranscript(input: { transcriptPath: string; nativeRef: string }): boolean;
  findTerminalSession(task: unknown): Promise<DevSessionCandidate | null>;
}
export interface DevKernelGateways {
  taskById(id: string): Promise<any | null> | any | null;
  addTask(task: any): Promise<void> | void;
  removeTask(id: string): Promise<void> | void;
  updateTask(id: string, patch: Record<string, unknown>): Promise<void> | void;
  adoptCandidate(token: string): Promise<any>;
  startEvolve(requirement: string): Promise<any>;
  applyEvolve(id: string): Promise<string>;
  adoptTerminalLaunch(input: {
    launchId: string; token: string; taskId: string; cwd: string; nativeRef: string;
  }): Promise<AdoptResult>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const message = (error: unknown) => String(error instanceof Error ? error.message : error);

/**
 * Dev Vertical 的领域 HTTP handler。这里可以依赖 Dev 领域模块与旧实现 adapter，
 * 但 Kernel 私有 repository/capability token 只能经 gateways 与 scoped context 使用。
 */
export function createDevDomainHandler(context: VerticalContext, gateways: DevKernelGateways, discovery: DevSessionDiscovery): DevDomainHandler {
  return Object.freeze({
    async route(req, url) {
      const p = url.pathname;

      if (req.method === "POST" && p === "/api/cc-hook") {
        const taskId = url.searchParams.get("taskId") || "";
        if (!taskId) return json({ ok: false, msg: "缺少 taskId" }, 400);
        let hook: any;
        try { hook = await req.json(); } catch { return json({ ok: false, msg: "钩子载荷不是 JSON" }, 400); }
        if (hook && typeof hook === "object") delete hook.__ownwardAdopted;
        try {
          let adoptedSessionId: string | undefined;
          if (String(hook?.hook_event_name || "") === "SessionStart") {
            const task = await gateways.taskById(taskId);
            if (!task || task.mode !== "terminal") return json({ ok: false, msg: "没有对应的 Terminal 任务" }, 409);
            if (task.terminalLaunchId) {
              const launchId = req.headers.get("x-ownward-adopt-launch") || "";
              const token = req.headers.get("x-ownward-adopt-token") || "";
              const nativeRef = String(hook?.session_id || ""), cwd = String(hook?.cwd || "");
              if (!discovery.verifyClaudeTranscript({ transcriptPath: String(hook?.transcript_path || ""), nativeRef })) return json({ ok: false, msg: "Session 身份与 transcript 不一致" }, 400);
              try { adoptedSessionId = (await gateways.adoptTerminalLaunch({ launchId, token, taskId, cwd, nativeRef })).id; }
              catch (error: any) {
                const code = String(error?.code || "SESSION_ADOPT_FAILED");
                const status = code === "TERMINAL_ADOPT_TOKEN_INVALID" ? 401 : code === "TERMINAL_ADOPT_EXPIRED" ? 410 : 409;
                return json({ ok: false, msg: "Terminal 会话接管失败", errorCode: code }, status);
              }
            }
          }
          if (adoptedSessionId) hook.__ownwardAdopted = true;
          const result = await applyCcHook(taskId, hook);
          return json({ ...result, ...(adoptedSessionId ? { sessionId: adoptedSessionId } : {}) }, result.ok ? 200 : 404);
        } catch (error) {
          context.log("cc-hook", `failed: ${message(error)}`);
          return json({ ok: false, msg: message(error) }, 500);
        }
      }

      if (p === "/api/gh/prs") try { return json(await listPrs(url.searchParams.get("force") === "1")); } catch (e) { return json({ ok: false, msg: message(e) }, 500); }
      if (p === "/api/gh/pr") try { return json(await prDetail(url.searchParams.get("repo") || "", parseInt(url.searchParams.get("num") || "0", 10))); } catch (e) { return json({ ok: false, msg: message(e) }, 500); }
      if (p === "/api/gh/pr/diff") try { return json({ ok: true, text: await prDiff(url.searchParams.get("repo") || "", parseInt(url.searchParams.get("num") || "0", 10)) }); } catch (e) { return json({ ok: false, msg: message(e) }, 500); }
      if (req.method === "POST" && p === "/api/gh/pr/ignore") {
        const body = await req.json() as { repo: string; num: number; ignore: boolean };
        if (!context.actions) return json({ ok: false, msg: "Action Service 不可用", errorCode: "VERTICAL_SERVICE_UNAVAILABLE" }, 503);
        setPrIgnored(body.repo, body.num, body.ignore);
        if (body.ignore) {
          const tail = `/${body.repo}/pull/${body.num}`;
          for (const action of await context.actions.list()) if (action.source === "github" && action.ref?.url?.endsWith(tail)) void context.actions.resolve(action.id, "ignored");
        }
        return json({ ok: true, msg: body.ignore ? "已忽略（不再提醒）" : "已恢复关注" });
      }
      if (req.method === "POST" && p === "/api/gh/pr/act") {
        const body = await req.json() as { repo: string; num: number; action: any; body?: string };
        try { return json({ ok: true, msg: await prAct(body.repo, body.num, body.action, body.body) }); } catch (e) { return json({ ok: false, msg: message(e) }, 400); }
      }

      if (p === "/api/dev/repo") try { return json(await repoStatus(url.searchParams.get("id") || "")); } catch (e) { return json({ ok: false, msg: message(e) }, 400); }
      if (p === "/api/dev/repo/diff") try { return json({ ok: true, text: await repoDiff(url.searchParams.get("id") || "") }); } catch (e) { return json({ ok: false, msg: message(e) }, 400); }
      if (req.method === "POST" && p === "/api/dev/repo/open") { const body = await req.json() as { id: string; file?: string }; try { return json({ ok: true, msg: await openInEditor(body.id, body.file) }); } catch (e) { return json({ ok: false, msg: message(e) }, 400); } }
      if (req.method === "POST" && p === "/api/dev/repo/act") { const body = await req.json() as { id: string; action: any; msg?: string }; try { return json({ ok: true, msg: await repoAct(body.id, body.action, body.msg) }); } catch (e) { return json({ ok: false, msg: message(e) }, 400); } }

      if (req.method === "POST" && p === "/api/cc/adopt") {
        const body = await req.json() as { id: string; adoptToken?: string };
        try {
          if (!body.adoptToken) return json({ ok: false, msg: "接管凭证缺失，请刷新会话列表后重试", errorCode: "DEV_SESSION_CANDIDATE_INVALID" }, 400);
          const task = await gateways.adoptCandidate(body.adoptToken);
          return json({ ok: true, msg: `已接管 [${task.id}]，可以直接续聊`, task });
        } catch (e) { return json({ ok: false, msg: message(e) }, 400); }
      }

      if (req.method === "POST" && p === "/api/task/adopt-terminal") {
        const body = await req.json() as { id: string };
        try {
          const task = await gateways.taskById(body.id);
          if (!task) return json({ ok: false, msg: "任务不存在" }, 404);
          if (task.mode !== "terminal") return json({ ok: false, msg: "不是 terminal 模式任务" }, 400);
          const cc = await discovery.findTerminalSession(task);
          if (!cc) return json({ ok: false, msg: "找不到该任务对应的 Claude 会话（可能还没落盘，稍后再试）" }, 400);
          if (cc.active) return json({ ok: false, msg: "Terminal 会话仍在运行，请先在 Terminal 里结束/关闭它再接管（避免双端同时驱动同一会话）" }, 409);
          const adopted = await gateways.adoptCandidate(cc.id);
          await gateways.updateTask(task.id, { status: "done", endedAt: task.endedAt || new Date().toISOString(), harvested: true });
          return json({ ok: true, msg: `已接管 [${adopted.id}]，可以直接续聊`, task: adopted });
        } catch (e) { return json({ ok: false, msg: message(e) }, 400); }
      }

      if (req.method === "POST" && p === "/api/task/done") {
        const body = await req.json() as { id: string };
        const task = await gateways.taskById(body.id);
        if (!task) return json({ ok: false, msg: "任务不存在" }, 404);
        if (task.mode !== "terminal") return json({ ok: false, msg: "只支持结束 terminal 任务" }, 400);
        if (task.status === "done") return json({ ok: true, msg: "已经结束过了" });
        try { await finalizeTerminalTask(task); return json({ ok: true, msg: "已结束并收割（Terminal 窗口请自行关闭）" }); } catch (e) { return json({ ok: false, msg: message(e) }, 500); }
      }

      if (req.method === "POST" && p === "/api/evolve") { const body = await req.json() as { requirement: string }; if (!body.requirement?.trim()) return json({ ok: false, msg: "需求为空" }, 400); try { const task = await gateways.startEvolve(body.requirement.trim()); return json({ ok: true, msg: `演进任务已派发 [${task.id}]`, task }); } catch (e) { return json({ ok: false, msg: message(e) }, 500); } }
      if (req.method === "POST" && p === "/api/evolve/apply") { const body = await req.json() as { id: string }; try { return json({ ok: true, msg: await gateways.applyEvolve(body.id) }); } catch (e) { return json({ ok: false, msg: message(e) }, 400); } }
      if (req.method === "POST" && p === "/api/flight/open") { const body = await req.json() as { id: string }; const path = findFlightRecord(body.id || ""); if (!path) return json({ ok: false, msg: "还没有飞行记录（任务结束后自动生成）" }, 404); Bun.spawn(["open", `obsidian://open?path=${encodeURIComponent(path)}`]); return json({ ok: true, msg: "已在 Obsidian 打开飞行记录" }); }
      return null;
    },
  });
}
