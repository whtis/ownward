import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DEV_DOMAIN_ROUTES } from "../verticals/dev.ts";
import { createDevDomainHandler, type DevKernelGateways, type DevSessionDiscovery } from "./domain-handler.ts";

const context = { log: () => {} } as any;
const gateways = (patch: Partial<DevKernelGateways> = {}): DevKernelGateways => ({
  taskById: () => null,
  addTask: () => {},
  removeTask: () => {},
  updateTask: () => {},
  adoptCandidate: async () => ({}),
  startEvolve: async () => ({}),
  applyEvolve: async () => "applied",
  adoptTerminalLaunch: async () => ({ id: "session" }),
  ...patch,
});
const discovery = (patch: Partial<DevSessionDiscovery> = {}): DevSessionDiscovery => ({
  verifyClaudeTranscript: () => true,
  findTerminalSession: async () => null,
  ...patch,
});

describe("Dev domain boundary", () => {
  test("all 17 compatibility routes have exactly one Dev owner and none remain in Workbench", () => {
    expect(DEV_DOMAIN_ROUTES).toHaveLength(17);
    const handler = readFileSync(join(import.meta.dir, "domain-handler.ts"), "utf8");
    const vertical = readFileSync(join(import.meta.dir, "../verticals/dev.ts"), "utf8");
    const workbench = readFileSync(join(import.meta.dir, "../workbench.ts"), "utf8");
    for (const route of DEV_DOMAIN_ROUTES) {
      expect(route === "/api/work" ? vertical : handler, `missing Dev owner for ${route}`).toContain(JSON.stringify(route));
      expect(workbench, `Workbench still owns ${route}`).not.toContain(JSON.stringify(route));
    }
  });

  test("Terminal launch adoption crosses the explicit Kernel gateway and preserves error contract", async () => {
    let calls = 0;
    const handler = createDevDomainHandler(context, gateways({
      taskById: () => ({ id: "task", mode: "terminal", terminalLaunchId: "launch", cwd: "/tmp/repo" }),
      adoptTerminalLaunch: async (input) => {
        calls++;
        expect(input).toMatchObject({ launchId: "launch", token: "bad", taskId: "task", nativeRef: "native", cwd: "/tmp/repo" });
        throw Object.assign(new Error("denied"), { code: "TERMINAL_ADOPT_TOKEN_INVALID" });
      },
    }), discovery());
    const response = await handler.route(new Request("http://x/api/cc-hook?taskId=task", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ownward-adopt-launch": "launch", "x-ownward-adopt-token": "bad" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "native", cwd: "/tmp/repo", transcript_path: join(process.env.HOME!, ".claude/projects/-tmp-repo/native.jsonl") }),
    }), new URL("http://x/api/cc-hook?taskId=task"));
    expect(calls).toBe(1);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ ok: false, msg: "Terminal 会话接管失败", errorCode: "TERMINAL_ADOPT_TOKEN_INVALID" });
  });

  test("opaque discovery capability is the only value crossing into adoption", async () => {
    let adopted: unknown;
    const handler = createDevDomainHandler(context, gateways({ adoptCandidate: async (token) => { adopted = token; return { id: "20260817-test" }; } }), discovery());
    const response = await handler.route(new Request("http://x/api/cc/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "stable-observation-id", adoptToken: "opaque-token" }) }), new URL("http://x/api/cc/adopt"));
    expect(response?.status).toBe(200);
    expect(adopted).toBe("opaque-token");
    const missing = await handler.route(new Request("http://x/api/cc/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "stable-observation-id" }) }), new URL("http://x/api/cc/adopt"));
    expect(missing?.status).toBe(400);
    expect(await missing?.json()).toMatchObject({ errorCode: "DEV_SESSION_CANDIDATE_INVALID" });
  });

  test("Terminal Claude discovery returns only id/active before the adoption gateway", async () => {
    let nativeId = "";
    const handler = createDevDomainHandler(context, gateways({
      taskById: () => ({ id: "terminal", mode: "terminal", endedAt: null }),
      adoptCandidate: async (id) => { nativeId = id; return { id: "adopted" }; },
    }), discovery({ findTerminalSession: async () => ({ id: "opaque-terminal", kind: "claude", project: "repo", title: "terminal", active: false }) }));
    const response = await handler.route(new Request("http://x/api/task/adopt-terminal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "terminal" }) }), new URL("http://x/api/task/adopt-terminal"));
    expect(response?.status).toBe(200);
    expect(nativeId).toBe("opaque-terminal");
  });

  test("unknown routes remain unhandled", async () => {
    expect(await createDevDomainHandler(context, gateways(), discovery()).route(new Request("http://x/api/chat/list"), new URL("http://x/api/chat/list"))).toBeNull();
  });
});
