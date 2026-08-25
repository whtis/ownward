import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerClient, RunnerRequestUncertainError } from "./client.ts";
import { ensureRunnerCapability, runnerPaths } from "./capability.ts";
import { RunnerServer } from "./server.ts";
import { RUNNER_INSTANCE_LOCK_GRACE_MS } from "./instance-lock.ts";
import { RunnerCommandJournal, RunnerEventJournal } from "./journals.ts";
import { CodexRunnerProvider } from "../providers/codex/adapter.ts";

const roots: string[] = [], children: Bun.Subprocess[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), "ownward-runner-ipc-")); roots.push(value); return value; };
afterEach(async () => { for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch {} await child.exited.catch(() => -1); } for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

async function spawnRunner(dataRoot: string) {
  const paths = runnerPaths(dataRoot), tokenPath = paths.token;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "testing", "entry-test.ts")], { env: { ...process.env, NODE_ENV: "test", OWNWARD_RUNNER_ALLOW_FAKE: "1", OWNWARD_RUNNER_TEST_ROOT: "1", OWNWARD_DATA_ROOT: dataRoot }, stdout: "ignore", stderr: "pipe" }); children.push(child);
  for (let i = 0; i < 100; i++) {
    if ((process.platform === "win32" || existsSync(paths.socket)) && existsSync(tokenPath)) { try { const probe = new RunnerClient(dataRoot, 50); const pong = await probe.request("ping", {}, 50); probe.close(); if (pong.body.pid === child.pid) return child; } catch {} }
    if (child.exitCode !== null) throw new Error(`Runner 启动失败: ${await new Response(child.stderr).text()}`); await Bun.sleep(10);
  }
  throw new Error("Runner socket 启动超时");
}
const submit = (commandId: string, extra: Record<string, unknown> = {}) => {
  const { fakePlan, input, ...rest } = extra;
  return { commandId, kind: "start-run", runId: `run-${commandId}`, sessionId: `session-${commandId}`, providerId: "fake", input: input ?? JSON.stringify({ prompt: "secret prompt", ...(fakePlan ? { plan: fakePlan } : {}) }), ...rest };
};
async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  if (!condition()) throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

describe("Runner Unix IPC", () => {
  test("read-history 通过 Provider 只读返回且不创建 command journal", async () => { const r = root(), server = new RunnerServer(r, () => ({ async *execute() {}, readHistory: async (input: any) => [{ role: "assistant", text: `history:${input.nativeRef}` }] } as any)); server.start(); const client = new RunnerClient(r); try { expect((await client.readHistory({ providerId: "claude", nativeRef: "native-1", cwd: "/tmp" })).body.messages).toEqual([{ role: "assistant", text: "history:native-1" }]); expect(existsSync(join(r, "runner/commands.jsonl"))).toBe(false); } finally { client.close(); server.stop(); } });
  test("真实大量 transcript 扫描不阻塞 Runner control ack", async () => {
    const r = root(), home = root(), sessions = join(home, ".codex", "sessions", "2026", "08", "17"); mkdirSync(sessions, { recursive: true });
    for (let i = 0; i < 8_000; i++) writeFileSync(join(sessions, `rollout-decoy-${i}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` } })}\n`);
    const nativeRef = "019ffae9-ad07-7ef0-ab0a-761b9a426650";
    writeFileSync(join(sessions, "rollout-target.jsonl"), [JSON.stringify({ type: "session_meta", payload: { id: nativeRef } }), JSON.stringify({ timestamp: "2026-08-17T00:00:00Z", type: "event_msg", payload: { type: "agent_message", message: "restored" } }), ""].join("\n"));
    const provider = new CodexRunnerProvider(["codex"], { ...process.env, HOME: home }), server = new RunnerServer(r, () => provider); server.start();
    const history = new RunnerClient(r, 10_000), control = new RunnerClient(r, 1_000); let settled = false;
    try {
      const pending = history.readHistory({ providerId: "codex", nativeRef }).finally(() => { settled = true; });
      await Bun.sleep(5); const started = performance.now(), pong = await control.request("ping", {}), latency = performance.now() - started;
      expect(pong.kind).toBe("pong"); expect(latency).toBeLessThan(250); expect(settled).toBe(false);
      expect((await pending).body.messages).toEqual([{ role: "assistant", text: "restored", ts: "2026-08-17T00:00:00Z" }]);
    } finally { history.close(); control.close(); server.stop(); await provider.close(); }
  });
  test("socket/token 权限收敛，旧普通文件目标 fail closed", async () => {
    const r = root(); await spawnRunner(r); const paths = runnerPaths(r);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700); expect(statSync(paths.socket).mode & 0o777).toBe(0o600); expect(statSync(paths.token).mode & 0o777).toBe(0o600); expect(readFileSync(paths.token, "utf8")).toMatch(/^[a-f0-9]{64}$/);
    const bad = root(), badPaths = runnerPaths(bad); ensureRunnerCapability(bad); writeFileSync(badPaths.socket, "do not unlink");
    const server = new RunnerServer(bad, () => { throw new Error("unused"); }); expect(() => server.start()).toThrow("非 socket"); expect(readFileSync(badPaths.socket, "utf8")).toBe("do not unlink");
    const insecure = root(); ensureRunnerCapability(insecure); chmodSync(runnerPaths(insecure).token, 0o644); expect(() => ensureRunnerCapability(insecure)).toThrow("权限或所有权");
  });

  test("单实例锁阻止第二 Runner 劫持或清理活实例 socket", async () => {
    const r = root(), first = new RunnerServer(r, () => { throw new Error("unused"); }); first.start(); const socket = runnerPaths(r).socket, inode = statSync(socket).ino;
    try { const second = new RunnerServer(r, () => { throw new Error("unused"); }); expect(() => second.start()).toThrow("已由 pid"); expect(statSync(socket).ino).toBe(inode); }
    finally { first.stop(); }
  });

  test("durable accepted 后响应；重复 command 幂等、内容冲突拒绝", async () => {
    const r = root(); await spawnRunner(r); const client = new RunnerClient(r);
    expect((await client.request("submit", submit("one"))).body).toMatchObject({ commandId: "one", appended: true });
    expect(readFileSync(join(r, "runner", "commands.jsonl"), "utf8")).toContain('"commandId":"one"');
    expect((await client.request("submit", submit("one"))).body).toMatchObject({ appended: false });
    await expect(client.request("submit", submit("one", { input: "changed" }))).rejects.toThrow("冲突"); client.close();
  });

  test("quiesce 原子关闭新命令入口并保持 health 可查询", async () => {
    const r = root(), server = new RunnerServer(r, () => ({ async *execute() {} } as any)); server.start(); const client = new RunnerClient(r);
    try { expect((await client.request("quiesce", {})).body).toMatchObject({ draining: true, activeRuns: [] }); expect((await client.request("ping", {})).body).toMatchObject({ runnerApiVersion: 1, capabilities: ["quiesce", "resume"], draining: true, activeRuns: [] }); await expect(client.request("submit", submit("after-quiesce"))).rejects.toMatchObject({ code: "RUNNER_DRAINING" }); expect((await client.request("resume", {})).body).toMatchObject({ draining: false }); expect(await client.request("submit", submit("after-resume"))).toMatchObject({ kind: "accepted" }); }
    finally { client.close(); server.stop(); }
  });

  test("accepted-only 同内容 resubmit 首次越过 dispatching 并只执行一次", async () => {
    const r = root(), body = { ...submit("resume-accepted"), providerId: "custom" }; new RunnerCommandJournal(r).accept(body as any); let executions = 0;
    const server = new RunnerServer(r, () => ({ async *execute(command) { executions++; yield { eventId: `${command.commandId}:started`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; yield { eventId: `${command.commandId}:done`, type: "completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; } })); server.start();
    try { const client = new RunnerClient(r); await client.request("submit", body); await Bun.sleep(30); await client.request("submit", body); await Bun.sleep(20); expect(executions).toBe(1); expect((await client.queryCommand("resume-accepted")).body.events).toMatchObject([{ type: "dispatching" }, { type: "started" }, { type: "completed" }]); client.close(); }
    finally { server.stop(); }
  });

  test("真实 command/event journal 写锁占用分别返回 busy 分类", async () => {
    const r = root(), server = new RunnerServer(r, () => ({ async *execute() {} } as any)); server.start(); const client = new RunnerClient(r), runner = join(r, "runner");
    try {
      const commandLock = join(runner, "commands.jsonl.write.lock"); writeFileSync(commandLock, JSON.stringify({ pid: process.pid, token: "held-command", at: Date.now() }), { mode: 0o600 });
      await expect(client.request("submit", submit("busy-command"))).rejects.toMatchObject({ code: "RUNNER_COMMAND_JOURNAL_BUSY" }); unlinkSync(commandLock);
      const eventLock = join(runner, "events.jsonl.write.lock"); writeFileSync(eventLock, JSON.stringify({ pid: process.pid, token: "held-event", at: Date.now() }), { mode: 0o600 });
      await expect(client.request("submit", submit("busy-dispatch"))).rejects.toMatchObject({ code: "RUNNER_DISPATCH_JOURNAL_BUSY" }); unlinkSync(eventLock); client.close();
    } finally { server.stop(); }
  });

  test("dispatching journal 硬闸失败时分类报错且绝不调用 Provider", async () => {
    const r = root(); let executed = 0;
    const server = new RunnerServer(r, () => ({ async *execute() { executed++; yield undefined as never; } }), { beforeDispatchAppend: () => { throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); } }); server.start();
    try { const client = new RunnerClient(r); await expect(client.request("submit", submit("dispatch-fail"))).rejects.toMatchObject({ code: "RUNNER_DISPATCH_JOURNAL_UNAVAILABLE" }); await Bun.sleep(20); expect(executed).toBe(0); expect((await client.queryCommand("dispatch-fail")).body.events).toEqual([]); client.close(); }
    finally { server.stop(); }
  });

  test("错误 token 拒绝；timeout/断线明确不代表取消，重连可 query", async () => {
    const r = root(); const child = await spawnRunner(r); const unauthorized = new RunnerClient(r); (unauthorized as any).capability = "0".repeat(64);
    await expect(unauthorized.request("ping", {})).rejects.toMatchObject({ code: "RUNNER_UNAUTHORIZED" });
    // Keep the RPC deadline below the provider turn, but leave enough scheduling
    // headroom for a freshly spawned Runner on a loaded CI worker.
    const client = new RunnerClient(r, 100); await expect(client.request("submit", submit("slow", { fakePlan: { delayMs: 150, deltas: ["done"] } }), 100)).resolves.toMatchObject({ kind: "accepted" });
    client.close(); await Bun.sleep(250); const again = new RunnerClient(r); const status = await again.queryCommand("slow");
    expect(status.body.found).toBe(true); expect((status.body.events as any[]).map((event) => event.type)).toEqual(["dispatching", "started", "delta", "completed"]);
    const ping = await again.request("ping", {}); expect(ping.body.pid).toBe(child.pid); again.close();
  });

  test("push 只发给已鉴权且 watch 同 command 的连接，query 支持 cursor 分页", async () => {
    const r = root(); await spawnRunner(r); const watcher = new RunnerClient(r), pingOnly = new RunnerClient(r), other = new RunnerClient(r); const watched: any[] = [], leaked: any[] = [];
    watcher.onPush = (frame) => watched.push(frame.body.event); pingOnly.onPush = (frame) => leaked.push(frame.body.event); other.onPush = (frame) => leaked.push(frame.body.event);
    await pingOnly.request("ping", {}); await other.queryCommand("different");
    await watcher.request("submit", submit("paged", { fakePlan: { delayMs: 30, deltas: ["a", "b", "c"] } })); await waitFor(() => watched.length === 5);
    expect(watched.map((event) => event.type)).toEqual(["started", "delta", "delta", "delta", "completed"]); expect(leaked).toEqual([]);
    const page1 = await watcher.queryCommand("paged", 1_000, { limit: 2 }); expect(page1.body).toMatchObject({ truncated: true, nextSequence: 2 });
    const page2 = await watcher.queryCommand("paged", 1_000, { afterSequence: 2, limit: 3 }); expect((page2.body.events as any[]).map((event) => event.sequence)).toEqual([3, 4, 5]);
    watcher.close(); pingOnly.close(); other.close();
  });

  test("Provider 在 started 前抛错也 durable failed，不留 accepted 假成功", async () => {
    const r = root(); await spawnRunner(r); const client = new RunnerClient(r); await client.request("submit", submit("bad-fixture", { input: "not-json" })); await Bun.sleep(30);
    const status = await client.queryCommand("bad-fixture"); expect((status.body.events as any[]).map((event) => event.type)).toEqual(["dispatching", "failed"]); client.close();
  });

  test("Provider 正常 EOF 但无终态时 durable provider_exit", async () => {
    const r = root(); const server = new RunnerServer(r, () => ({ async *execute(command) { yield { eventId: `${command.commandId}:started`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; } })); server.start();
    try { const client = new RunnerClient(r); await client.request("submit", { ...submit("eof"), providerId: "custom" }); await Bun.sleep(30); const status = await client.queryCommand("eof"); expect((status.body.events as any[]).map((event) => [event.type, event.reason])).toEqual([["dispatching", undefined], ["started", undefined], ["failed", "provider_exit"]]); client.close(); }
    finally { server.stop(); }
  });

  test("best-effort delta 无法落盘只计数丢弃，turn 仍可 completed", async () => {
    const r = root(); let aborted = 0;
    const server = new RunnerServer(r, () => ({
      async *execute(command) {
        yield { eventId: `${command.commandId}:started`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId };
        const lock = join(r, "runner", ".blob-maintenance.write.lock"); writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held-observation", at: Date.now() }), { mode: 0o600 });
        yield { eventId: `${command.commandId}:delta`, type: "delta", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, payload: "best-effort" };
        await Bun.sleep(80); unlinkSync(lock);
        yield { eventId: `${command.commandId}:completed`, type: "completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId };
      },
      abort() { aborted++; },
    })); server.start();
    try {
      const client = new RunnerClient(r); await client.request("submit", { ...submit("event-hard-gate"), providerId: "custom" }); await Bun.sleep(80);
      const events = (await client.queryCommand("event-hard-gate")).body.events as any[];
      expect(events.map((event) => event.type)).toEqual(["dispatching", "started", "completed"]); expect(aborted).toBe(0); expect(server.metrics.observationalDropped).toBe(1); client.close();
    } finally { server.stop(); }
  });

  test("Provider 无 normalized 进展触发 watchdog、abort 与 provider_no_progress unknown", async () => {
    const r = root(); let aborted = 0; const server = new RunnerServer(r, () => ({ async *execute() { await Bun.sleep(5_000); if (false) yield undefined as never; }, abort() { aborted++; throw new Error("abort failed"); } }), { providerNoProgressMs: 30 }); server.start();
    try { const client = new RunnerClient(r); await client.request("submit", { ...submit("no-progress"), providerId: "custom" }); await Bun.sleep(100); const events = (await client.queryCommand("no-progress")).body.events as any[]; expect(events.at(-1)).toMatchObject({ type: "unknown-outcome", reason: "provider_no_progress" }); expect(events.at(-1)?.payloadRef).toBeUndefined(); expect(aborted).toBe(1); expect(server.metrics.providerTimeouts).toBe(1); client.close(); }
    finally { server.stop(); }
  });

  test("默认不启用无进展 watchdog，Provider 静默后仍可正常完成", async () => {
    const r = root(); let aborted = 0;
    const server = new RunnerServer(r, () => ({
      async *execute(command) {
        yield { eventId: `${command.commandId}:started`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId };
        await Bun.sleep(100);
        yield { eventId: `${command.commandId}:completed`, type: "completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId };
      },
      abort() { aborted++; },
    })); server.start();
    try { const client = new RunnerClient(r); await client.request("submit", { ...submit("silent-success"), providerId: "custom" }); await Bun.sleep(150); const events = (await client.queryCommand("silent-success")).body.events as any[]; expect(events.map((event) => event.type)).toEqual(["dispatching", "started", "completed"]); expect(aborted).toBe(0); expect(server.metrics.providerTimeouts).toBe(0); client.close(); }
    finally { server.stop(); }
  });

  // This intentionally writes 5,000 durable journal records. Keep a finite
  // deadline, but allow macOS hosted runners enough I/O scheduling headroom.
  test("5000 个 best-effort usage 有容量、append latency 与 drop metrics", async () => {
    const r = root(), server = new RunnerServer(r, () => ({ async *execute(command) { yield { eventId: "load-start", type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; for (let i = 0; i < 5_000; i++) yield { eventId: `load-${i}`, type: "usage", durability: "best-effort", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, payload: "{\"inputTokens\":0,\"outputTokens\":0}" }; yield { eventId: "load-done", type: "completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; } })); server.start();
    try { const client = new RunnerClient(r, 10_000); await client.request("submit", { ...submit("load"), providerId: "custom" }); client.close(); const probe = new RunnerClient(r, 10_000); const deadline = Date.now() + 15_000; while (Date.now() < deadline && ((await probe.request("ping", {})).body.activeRuns as string[]).includes("load")) await Bun.sleep(20); const events = new RunnerEventJournal(r).readStrict().filter((event) => event.commandId === "load"); expect(events).toHaveLength(5_003); expect(server.metrics).toMatchObject({ observationalAppended: 5_000, observationalDropped: 0, eventsAttempted: 5_002 }); expect(server.metrics.appendLatencyMsMax).toBeGreaterThan(0); expect(statSync(join(r, "runner", "events.jsonl")).size).toBeGreaterThan(100_000); probe.close(); }
    finally { server.stop(); }
  }, 15_000);

  test("关键 message event 无法落盘会 abort Provider 并以无 payload unknown 收敛", async () => {
    const r = root(); let aborted = 0;
    const server = new RunnerServer(r, () => ({ async *execute(command) {
      yield { eventId: `${command.commandId}:started`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId };
      yield { eventId: `${command.commandId}:message`, type: "message-completed", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId, payload: "x".repeat(8 * 1024 * 1024 + 1) };
    }, abort() { aborted++; throw new Error("abort failed"); } })); server.start();
    try { const client = new RunnerClient(r); await client.request("submit", { ...submit("critical-hard-gate"), providerId: "custom" }); await Bun.sleep(100); const events = (await client.queryCommand("critical-hard-gate")).body.events as any[]; expect(events.map((event) => event.type)).toEqual(["dispatching", "started", "unknown-outcome"]); expect(events.at(-1)?.payloadRef).toBeUndefined(); expect(aborted).toBe(1); client.close(); }
    finally { server.stop(); }
  });

  test("shutdown unknown append 与 completed 竞态时把 durable terminal 视为成功", async () => {
    const r = root(), events = new RunnerEventJournal(r); let raced = false;
    const server = new RunnerServer(r, () => ({ async *execute(command) { yield { eventId: `${command.commandId}:started`, type: "started", at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId }; await Bun.sleep(80); } }), { beforeShutdownUnknownAppend: () => { if (raced) return; raced = true; events.append({ eventId: "shutdown-race:completed", type: "completed", at: new Date().toISOString(), commandId: "shutdown-race", runId: "run-shutdown-race", sessionId: "session-shutdown-race", providerId: "custom" }); throw new Error("terminal won race"); } }); server.start();
    const client = new RunnerClient(r); await client.request("submit", { ...submit("shutdown-race"), providerId: "custom" }); await Bun.sleep(15); await expect(server.shutdown(5)).resolves.toBeUndefined(); expect(events.readStrict().at(-1)?.type).toBe("completed"); client.close();
  });

  test("client timeout 明确声明不等于取消", async () => {
    const r = root(), paths = runnerPaths(r); ensureRunnerCapability(r);
    const listener = Bun.listen({ unix: paths.socket, socket: { data() { /* 故意不响应，验证 client timeout 语义 */ } } }); chmodSync(paths.socket, 0o600);
    try {
      let found: unknown; try { await new RunnerClient(r, 15).request("ping", {}); } catch (error) { found = error; }
      expect(found).toBeInstanceOf(RunnerRequestUncertainError); expect((found as Error).message).toContain("不代表命令已取消");
    }
    finally { listener.stop(true); }
  });

  test("Runner SIGKILL/restart 不 replay accepted command；同 token/同 client 可重连 query", async () => {
    const r = root(); const first = await spawnRunner(r); const client = new RunnerClient(r);
    const token = readFileSync(runnerPaths(r).token, "utf8"); await client.request("submit", submit("killed", { fakePlan: { delayMs: 2_000 } })); first.kill("SIGKILL"); await first.exited; children.splice(children.indexOf(first), 1); await Bun.sleep(RUNNER_INSTANCE_LOCK_GRACE_MS + 20);
    await spawnRunner(r); expect(readFileSync(runnerPaths(r).token, "utf8")).toBe(token); const status = await client.queryCommand("killed");
    expect(status.body.found).toBe(true); expect((status.body.events as any[]).map((event) => event.type)).toEqual(["dispatching", "unknown-outcome"]); client.close();
  });

  test("生产环境拒绝 Fake Provider 开关", async () => {
    const r = root(), child = Bun.spawn([process.execPath, join(import.meta.dir, "entry.ts")], { env: { ...process.env, NODE_ENV: "production", OWNWARD_RUNNER_ALLOW_FAKE: "1", OWNWARD_DATA_ROOT: r }, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).not.toBe(0); expect(await new Response(child.stderr).text()).toContain("生产 Runner 拒绝");
  });
});
