import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../../..");
const source = (file: string) => readFileSync(join(root, file), "utf8");

describe("production Session call graph", () => {
  test("daemon and dispatch cannot execute legacy Agent sessions", () => {
    for (const file of ["src/daemon.ts", "src/dispatch.ts"]) {
      const text = source(file);
      expect(text).not.toContain('from "./agent-session.ts"');
      expect(text).not.toContain('import("./agent-session.ts")');
      expect(text).not.toContain('import("./codex-session.ts")');
    }
    expect(source("src/agent-session.ts")).not.toContain("export function reconcileEngine");
    expect(source("src/daemon.ts")).not.toContain("reconcileEngine");
  });

  test("outer Agent entrypoints route through Kernel instead of legacy mutations", () => {
    const forbidden = ["adoptCodexSession", "adoptEngineSession", "decidePerm", "getAgentState", "sendToAgent"];
    for (const file of ["src/workbench.ts", "src/lark-cards.ts", "src/attention.ts", "src/flight-record.ts"]) {
      const text = source(file);
      for (const symbol of forbidden) expect(text).not.toContain(symbol);
    }
  });

  test("product entrypoints do not hard-code Runner mode", () => {
    for (const file of ["src/dispatch.ts", "src/attention.ts", "src/flight-record.ts", "src/lark-cards.ts", "src/workbench.ts"])
      expect(source(file)).not.toMatch(/new KernelSessionService\([^\n]*mode:\s*["']runner["']/);
  });
  test("startWork never writes its stale whole-task snapshot after Runner submit", () => { expect(source("src/dispatch.ts")).not.toContain("updateTask(id, t)"); });
  test("uncertain Runner submit stays running for durable recovery",()=>{const text=source("src/dispatch.ts");expect(text).toContain("error?.outcomeUnknown===true");expect(text).toContain('status:"running",launchState:"accepted"');});
  test("unknown outcome converges Task once but never enters harvest",()=>{const dispatch=source("src/dispatch.ts"),harvest=source("src/harvest.ts");expect(dispatch).toContain('runner?.status === "unknown_outcome"');expect(dispatch).toContain('run.status==="unknown_outcome")return{status:"exited"');expect(dispatch).toContain('runner-uncertain:${t.id}');expect(harvest).toContain("if (t.uncertain) continue");});
  test("new work ignores legacy canary and always enters Runner",()=>{expect(source("src/dispatch.ts")).toContain("createNewSessionService(roots)");});
  test("every manual/Terminal/Codex adoption bypasses the legacy canary",()=>{
    expect(source("src/dispatch.ts")).toContain("createNewSessionService([meta.cwd]).adopt");
    const composition=source("src/verticals.ts"),workbench=source("src/workbench.ts");
    expect(composition).toContain("createNewSessionService([candidate.cwd, providerHomePath]).adopt");
    expect(composition).toContain("createNewSessionService([candidate.cwd]).adopt");
    expect(composition).toContain("devSessionCandidates.consume(token)");
    expect(composition).toContain("context.sessions.adopt");
    const domain=source("src/dev/domain-handler.ts");
    expect(domain).not.toMatch(/(?:cc-sessions|codex-sessions|providers\/|providerHome|rolloutId)/);
    expect(workbench).not.toMatch(/createSessionService\([^\n]*\)\.adopt/);
  });
  test("workbench resolves every session route through the shared composition root",()=>{const workbench=source("src/workbench.ts");expect(workbench).toContain('import { createNewSessionService, createSessionService, effectiveSessionMode } from "./session-service.ts"');expect(workbench).not.toContain("function sessionMode(");expect(workbench).not.toContain("effectiveSessionMigrationMode");});
  test("Runner tasks do not advertise an unwritten engine log and harvest reads Session state",()=>{expect(source("src/dispatch.ts")).not.toContain('t.logFile = join(logDir');const harvest=source("src/harvest.ts");expect(harvest).toContain('createSessionService(t.id');expect(harvest).not.toContain('if (!t.logFile || !existsSync(t.logFile)) continue');});
  test("legacy approval sweep is enabled only for persisted legacy identities",()=>{const daemon=source("src/daemon.ts"),composition=source("src/session-service.ts");expect(daemon).toContain('sessionMode === "off"');expect(daemon).toContain("sweepLegacyApprovalsIfPresent");expect(composition).toContain('s.source==="legacy"');expect(composition).toContain("sweepPendingPerms");});
  test("interrupted Runner tasks use shell-compatible exit 130",()=>{expect(source("src/dispatch.ts")).toContain('run.status==="interrupted"?130');});
  test("failed external adoption removes its provisional task",()=>{expect(source("src/dispatch.ts")).toContain("removeTask(id)");});
  test("opaque candidate adoption looks up reuse first, registers task before durable adopt, and compensates failure",()=>{const composition=source("src/verticals.ts"),start=composition.indexOf("export async function adoptSessionCandidate"),route=composition.slice(start,composition.indexOf("export function createBuiltinDevDomain",start)),lookup=route.indexOf("adoptedSessionFor("),add=route.indexOf("await addTask(task)"),adopt=route.indexOf(".adopt(",add);expect(composition).toContain("adoptSessionCandidate(devSessionCandidates.consume(token))");expect(lookup).toBeGreaterThan(0);expect(add).toBeGreaterThan(lookup);expect(adopt).toBeGreaterThan(add);expect(route.indexOf("if (!reused) await removeTask(id)",adopt)).toBeGreaterThan(adopt);});

  test("fresh installs hard-cut to Runner", () => {
    const config = JSON.parse(source("config.default.json"));
    expect(config.architecture.sessionRunnerMode).toBe("runner");
  });
  test("daemon opens HTTP only after Connector recovery/start, Verticals, and scheduler registration",()=>{const daemon=source("src/daemon.ts"),connectors=daemon.lastIndexOf('await import("./connectors.ts")'),verticals=daemon.lastIndexOf('await import("./verticals.ts")'),scheduler=daemon.indexOf("setInterval(() => runTriage()",verticals),server=daemon.lastIndexOf("startServer();");expect(connectors).toBeGreaterThan(0);expect(connectors).toBeLessThan(verticals);expect(verticals).toBeLessThan(scheduler);expect(scheduler).toBeLessThan(server);});
  test("dispatch preserves a durable accepted launch when post-submit sync disconnects",()=>{const dispatch=source("src/dispatch.ts"),failure=dispatch.indexOf("let durable:");expect(failure).toBeGreaterThan(0);expect(dispatch.indexOf("durableLaunchReceipt(DATA,id)",failure)).toBeGreaterThan(failure);expect(dispatch.indexOf('launchState:"accepted"',failure)).toBeGreaterThan(failure);expect(dispatch.indexOf('status:"running"',failure)).toBeGreaterThan(failure);});
});
