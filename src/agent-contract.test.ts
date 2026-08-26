import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { inventoryLegacySessions } from "./session-contract.ts";
import { CORE_API_PATHS, formatSseEvent, shouldBroadcastTaskUpdate, SSE_EVENT_NAMES } from "./server.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const freshRoot = () => { const r = mkdtempSync(join(tmpdir(), "ownward-contract-")); roots.push(r); return r; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function writeJson(root: string, rel: string, value: unknown) {
  const path = join(root, rel); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function dormantAgentState(dataRoot: string, taskId: string, mode?: "off"): Promise<Record<string, unknown>> {
  const script = `import { cfg } from ${JSON.stringify(join(ROOT, "src", "util.ts"))};import { getAgentState } from ${JSON.stringify(join(ROOT, "src", "agent-backend.ts"))};` +
    `${mode ? `cfg.architecture.sessionRunnerMode=${JSON.stringify(mode)};` : ""}` +
    `console.log(JSON.stringify(await getAgentState(${JSON.stringify(taskId)})));`;
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd: ROOT, env: { ...process.env, OWNWARD_DATA_ROOT: dataRoot }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("AgentState runtime compatibility", () => {
  test("dormant Claude branch emits the real API fixture", async () => {
    const root = freshRoot();
    writeJson(root, "tasks.json", [{ id: "cc-task", mode: "claude-bg", cwd: "/repo", engine: true }]);
    writeJson(root, "tasks/cc-task.session.json", {
      toolSessionId: "cc-native", control: "observing",
      messages: [{ role: "assistant", text: "done" }], plan: [], tokens: { input: 3 },
      model: "sonnet", commands: ["compact"], ctxTokens: 12, lastActivityAt: 9,
    });
    expect(await dormantAgentState(root, "cc-task")).toEqual({
      messages: [{ role: "assistant", text: "done" }], turn: "idle", alive: false, partial: "",
      pending: [], queued: [], plan: [], tokens: { input: 3 }, backend: "claude", model: "sonnet",
      commands: ["compact"], ctxTokens: 12, lastActivityAt: 9,
      resume: { id: "cc-native", tool: "claude", cmd: "cd '/repo' && claude --resume cc-native" },
      providerId: "claude", control: "observing",
    });
  });

  test("dormant Codex branch emits providerId without touching real data", async () => {
    const root = freshRoot();
    writeJson(root, "tasks.json", [{ id: "cdx-task", mode: "codex-bg", cwd: "/repo", engine: true }]);
    writeJson(root, "tasks/cdx-task.codex.json", {
      rolloutId: "00000000-0000-4000-8000-000000000021", home: "codex-alt", cwd: "/worktree", control: "observing", fullAccess: true,
    });
    const state = await dormantAgentState(root, "cdx-task");
    expect(state).toMatchObject({
      messages: [], turn: "idle", alive: false, backend: "codex", providerId: "codex",
      control: "observing", fullAccess: true,
      resume: { id: "00000000-0000-4000-8000-000000000021", tool: "codex", cmd: "cd '/worktree' && CODEX_HOME=\"$HOME/.codex-alt\" codex resume '00000000-0000-4000-8000-000000000021'" },
    });
  });

  test("repository-only Codex recovery preserves alternate provider home", async () => {
    const root = freshRoot();
    writeJson(root, "tasks.json", [{ id: "cdx-repo", mode: "codex-bg", cwd: "/legacy", engine: true }]);
    writeJson(root, "sessions.json", { schemaVersion: 1, sessions: [{
      id: "cdx-repo", providerId: "codex", providerHome: "codex-alt", nativeRef: "00000000-0000-4000-8000-000000000022",
      cwd: "/worktree", control: "observing", taskIds: ["cdx-repo"], recoverable: true,
      source: "native", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    const state = await dormantAgentState(root, "cdx-repo");
    expect(state.resume).toEqual({ id: "00000000-0000-4000-8000-000000000022", tool: "codex",
      cmd: "cd '/worktree' && CODEX_HOME=\"$HOME/.codex-alt\" codex resume '00000000-0000-4000-8000-000000000022'" });
    expect(state.control).toBe("observing");
  });

  test("persisted provider/ref drift fails closed instead of guessing from task mode", async () => {
    const root = freshRoot();
    writeJson(root, "tasks.json", [{ id: "task", mode: "claude-bg", cwd: "/task", engine: true }]);
    writeJson(root, "sessions.json", { schemaVersion: 1, sessions: [{
      id: "task", providerId: "codex", providerHome: "codex-alt", nativeRef: "00000000-0000-4000-8000-000000000023", previousRefs: [],
      cwd: "/wrong", control: "observing", taskIds: ["task"], recoverable: true,
      source: "native", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    await expect(dormantAgentState(root, "task")).rejects.toThrow("Session provider/ref drift");
  });

  test("off mode keeps legacy state readable when sessions.json itself is corrupt", async () => {
    const root = freshRoot(); writeJson(root, "tasks.json", [{ id: "legacy", mode: "claude-bg", cwd: "/repo", engine: true }]); writeJson(root, "tasks/legacy.session.json", { toolSessionId: "native", messages: [{ role: "assistant", text: "kept" }] }); writeFileSync(join(root, "sessions.json"), "{");
    expect(await dormantAgentState(root, "legacy", "off")).toMatchObject({ providerId: "claude", messages: [{ role: "assistant", text: "kept" }], resume: { id: "native" } });
  });

  test("web implicit fields stay inside the runtime AgentState contract", () => {
    const source = readFileSync(join(ROOT, "web", "tasks.js"), "utf8");
    const consumed = [...source.matchAll(/\bdev\??\.([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1]).filter((v, i, all) => all.indexOf(v) === i).sort();
    expect(consumed).toEqual([
      "backend", "commands", "control", "ctxTokens", "cwd", "extraDirs", "fullAccess", "messages", "model", "partial",
      "pending", "plan", "providerId", "queued", "resume", "tokens", "turn",
    ]);
  });
});

describe("legacy session disk reconciliation", () => {
  test("scans tasks, both provider metas, orphans and dangling pins", () => {
    const root = freshRoot();
    writeJson(root, "tasks.json", [
      { id: "cc", mode: "claude-bg", cwd: "/cc" },
      { id: "cdx", mode: "codex-bg", cwd: "/cdx" },
      { id: "term", mode: "terminal", cwd: "/term", ccSessionId: "external-ok" },
    ]);
    writeJson(root, "tasks/cc.session.json", { toolSessionId: "cc-native", control: "observing" });
    writeJson(root, "tasks/cdx.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000024", cwd: "/wt" });
    writeJson(root, "tasks/orphan.session.json", { toolSessionId: "lost" });
    writeJson(root, "pinned-sessions.json", [
      { kind: "task", ref: "cc" }, { kind: "task", ref: "missing" },
      { kind: "cc", ref: "cdx:codex/external-ok" }, { kind: "cc", ref: "external-missing" },
    ]);
    expect(inventoryLegacySessions(root, new Set(["external-ok"]))).toEqual({
      taskCount: 3, sessionCount: 3, nativeRefCount: 3,
      sessions: [
        { sessionId: "cc", providerId: "claude", nativeRef: "cc-native", control: "observing", cwd: "/cc", recoverable: true, metaFile: "cc.session.json" },
        { sessionId: "cdx", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000024", control: "ownward", cwd: "/wt", recoverable: true, metaFile: "cdx.codex.json" },
        { sessionId: "term", providerId: "claude", nativeRef: "external-ok", control: "ownward", cwd: "/term", recoverable: true, metaFile: null },
      ],
      orphanMeta: ["orphan.session.json"],
      danglingPins: [{ kind: "task", ref: "missing" }, { kind: "cc", ref: "external-missing" }],
      invalidFiles: [],
    });
  });

  test("reports corrupt real locations instead of treating them as empty truth", () => {
    const root = freshRoot();
    writeFileSync(join(root, "tasks.json"), "{");
    writeFileSync(join(root, "pinned-sessions.json"), "[");
    expect(inventoryLegacySessions(root).invalidFiles).toEqual([
      join(root, "pinned-sessions.json"), join(root, "tasks.json"),
    ]);
  });

  test("isolates a corrupt claimed meta without hiding healthy records or misclassifying it as orphan", () => {
    const root = freshRoot();
    writeJson(root, "tasks.json", [
      { id: "bad", mode: "claude-bg", cwd: "/bad" },
      { id: "good", mode: "codex-bg", cwd: "/good" },
    ]);
    writeJson(root, "tasks/bad.session.json", { placeholder: true });
    writeFileSync(join(root, "tasks/bad.session.json"), "{");
    writeJson(root, "tasks/good.codex.json", { rolloutId: "00000000-0000-4000-8000-000000000025", cwd: "/work" });
    const report = inventoryLegacySessions(root);
    expect(report.sessions).toEqual([{
      sessionId: "good", providerId: "codex", nativeRef: "00000000-0000-4000-8000-000000000025", control: "ownward",
      cwd: "/work", recoverable: true, metaFile: "good.codex.json",
    }]);
    expect(report.invalidFiles).toEqual([join(root, "tasks/bad.session.json")]);
    expect(report.orphanMeta).toEqual([]);
  });
});

describe("server API and SSE wire contract", () => {
  test("core route names and event names are frozen", () => {
    expect(CORE_API_PATHS).toEqual(["/api/state", "/api/feed", "/api/tasks", "/api/events"]);
    expect(SSE_EVENT_NAMES).toEqual(["state", "feed", "tasks"]);
  });

  test("SSE frame used by server is valid and client subscribes to every event", () => {
    expect(formatSseEvent("feed", { id: "f1" })).toBe('event: feed\ndata: {"id":"f1"}\n\n');
    const client = readFileSync(join(ROOT, "web", "app.js"), "utf8");
    for (const event of SSE_EVENT_NAMES) expect(client).toContain(`addEventListener("${event}"`);
    const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
    for (const path of CORE_API_PATHS) expect(server).toContain(`"${path}"`);
  });

  test("successful legacy work dispatch refreshes task SSE", () => {
    expect(shouldBroadcastTaskUpdate("POST", "/api/work", new Response("ok"))).toBeTrue();
    expect(shouldBroadcastTaskUpdate("POST", "/api/work", new Response("bad", { status: 500 }))).toBeFalse();
    expect(shouldBroadcastTaskUpdate("POST", "/api/verticals/dev/work", new Response("ok"))).toBeFalse();
  });
});
