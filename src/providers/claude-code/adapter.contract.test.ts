import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerClient } from "../../runner/client.ts";
import { stageRunnerAttachment } from "../../runner/attachments.ts";
import { auditRunnerBlobs, RunnerEventJournal } from "../../runner/journals.ts";
import { RunnerServer } from "../../runner/server.ts";
import { ClaudeCodeRunnerProvider, type ClaudeProviderOptions } from "./adapter.ts";
import { CLAUDE_EFFORTS, CLAUDE_PROVIDER_CAPABILITIES, buildClaudeProviderArgs, parseClaudeOptions } from "./protocol.ts";
import { canaryProvider } from "../../release/provider-canary.ts";

const roots: string[] = [], providers: ClaudeCodeRunnerProvider[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) await provider.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), "ownward-claude-provider-")); roots.push(value); return value; };
const command = [process.execPath, join(import.meta.dir, "testing", "fake-claude.ts")];
const options = { access: "standard" as const, extraDirs: [] as string[], model: "sonnet", effort: "high" };
const startBody = (id: string, text: string, sessionId = `session-${id}`) => ({ commandId: id, kind: "start-run", runId: `run-${id}`, sessionId, providerId: "claude", input: JSON.stringify({ text, cwd: tmpdir(), images: [], options }) });
async function fixture(providerOptions: ClaudeProviderOptions = {}, serverHooks: ConstructorParameters<typeof RunnerServer>[2] = {}, envOverride:Record<string,string>={}) {
  const data = root(), provider = new ClaudeCodeRunnerProvider(command, { ...process.env, NODE_ENV: "test", OWNWARD_CLAUDE_FAKE: "1", FAKE_CLAUDE_SESSION_ID: "native-claude-1", CLAUDE_CODE_SECRET_SHOULD_CLEAR: "secret",...envOverride }, { dataRoot: data, ...providerOptions }); providers.push(provider);
  const server = new RunnerServer(data, (id) => { if (id !== "claude") throw new Error("unregistered"); return provider; }, serverHooks); server.start();
  const client = new RunnerClient(data); return { data, provider, server, client };
}
async function waitTerminal(client: RunnerClient, commandId: string, timeout = 2_000): Promise<any[]> {
  const deadline = Date.now() + timeout; while (Date.now() < deadline) { const status = await client.queryCommand(commandId); const events = status.body.events as any[]; if (events.some((event) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(event.type))) return events; await Bun.sleep(10); } throw new Error(`timeout waiting ${commandId}`);
}
const payloads = (data: string, events: any[]) => { const journal = new RunnerEventJournal(data); return events.filter((event) => event.payloadRef).map((event) => JSON.parse(journal.readPayload(event)!)); };

describe("Claude Code Runner Provider contract", () => {
  test("release canary fixture proves exact start/resume nonce through payload blobs",async()=>{const{server,client}=await fixture();try{expect(await canaryProvider(client,"claude",tmpdir(),2_000)).toMatchObject({ok:true,providerId:"claude"});}finally{client.close();server.stop();}});
  test("read-history 从真实 Claude transcript fixture 恢复，坏历史返回显式 marker", async () => {
    const home = root(), dir = join(home, ".claude/projects/-repo"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "native-history.jsonl"), [JSON.stringify({ type: "user", timestamp: "2026-08-01T00:00:00Z", message: { content: "question" } }), JSON.stringify({ type: "assistant", timestamp: "2026-08-01T00:00:01Z", message: { content: [{ type: "text", text: "answer" }] } }), ""].join("\n"));
    const provider = new ClaudeCodeRunnerProvider(command, { ...process.env, HOME: home }); providers.push(provider); expect(await provider.readHistory({ nativeRef: "native-history" })).toEqual([{ role: "user", text: "question", ts: "2026-08-01T00:00:00Z" }, { role: "assistant", text: "answer", ts: "2026-08-01T00:00:01Z" }]); expect((await provider.readHistory({ nativeRef: "missing" }))[0]).toMatchObject({ role: "system", name: "history" });
  });
  test("声明阶段 2 capability，参数只由 Kernel grant 映射", () => {
    expect([...CLAUDE_PROVIDER_CAPABILITIES]).toEqual(["stream", "resume", "interrupt", "approval", "images", "tools", "add-dir", "set-access", "new-session", "model", "effort"]);
    expect(buildClaudeProviderArgs(["claude"], { access: "standard", extraDirs: ["/a"] }, "native")).toContain("--permission-prompt-tool");
    expect(buildClaudeProviderArgs(["claude"], { access: "bypass", extraDirs: [] })).toContain("--dangerously-skip-permissions");
  });

  test("model/effort whitelist、合法值与 argv contract", () => {
    const parsed = parseClaudeOptions({ access: "standard", extraDirs: [], model: "claude-sonnet-4.5", effort: "high" });
    expect(parsed).toMatchObject({ model: "claude-sonnet-4.5", effort: "high" });
    expect(buildClaudeProviderArgs(["claude"], parsed)).toEqual(expect.arrayContaining(["--model", "claude-sonnet-4.5", "--effort", "high"]));
    for (const bad of ["", "--opus", "opus latest", "opus\0"]) expect(() => parseClaudeOptions({ access: "standard", extraDirs: [], model: bad })).toThrow("model 非法");
    for (const effort of CLAUDE_EFFORTS) expect(parseClaudeOptions({ access: "standard", extraDirs: [], effort })).toMatchObject({ effort });
    for (const bad of ["", "minimal", "ultra", "HIGH", "high --resume bad"]) expect(() => parseClaudeOptions({ access: "standard", extraDirs: [], effort: bad })).toThrow("effort 非法");
    expect(() => parseClaudeOptions({ access: "standard", extraDirs: [], temperature: 1 })).toThrow("options 含未知字段");
  });
  test("explicit effort either reaches argv or fails before spawn when unsupported/probe-failed",async()=>{for(const mode of["supported","unsupported","probe-failed"] as const){const spawnRecord=join(root(),`${mode}.jsonl`),{data,server,client,provider}=await fixture({}, {}, {FAKE_CLAUDE_EFFORT:mode==="unsupported"?"0":"1",FAKE_CLAUDE_HELP_DELAY_MS:"40",FAKE_CLAUDE_HELP_FAIL:mode==="probe-failed"?"1":"0",FAKE_CLAUDE_SPAWN_RECORD:spawnRecord});try{await Promise.all([client.request("submit",startBody(`effort-first-${mode}`,"capability")),client.request("submit",startBody(`effort-concurrent-${mode}`,"capability-2"))]);const first=await waitTerminal(client,`effort-first-${mode}`),second=await waitTerminal(client,`effort-concurrent-${mode}`);if(mode==="supported"){expect(JSON.stringify(payloads(data,first))).toContain("--effort|high");expect(JSON.stringify(payloads(data,second))).toContain("--effort|high");expect(readFileSync(spawnRecord,"utf8").trim().split("\n")).toHaveLength(2);}else{for(const events of[first,second]){expect(events.at(-1)).toMatchObject({type:"failed",reason:"unsupported_command"});expect(events.some(event=>event.type==="started"||event.type==="session-updated")).toBeFalse();}expect(() => readFileSync(spawnRecord,"utf8")).toThrow();}expect(provider.metrics.effortProbePending).toBeGreaterThan(0);expect(provider.metrics.effortUnsupported).toBe(mode==="supported"?0:2);expect(provider.metrics.effortProbeFailures).toBe(mode==="probe-failed"?1:0);}finally{client.close();server.stop();}}});

  test("slow effort help keeps Runner query responsive and remains bounded",async()=>{const{server,client}=await fixture({}, {}, {FAKE_CLAUDE_EFFORT:"1",FAKE_CLAUDE_HELP_DELAY_MS:"500"});try{await client.request("submit",startBody("slow-help","capability"));const before=Date.now();expect((await client.queryCommand("slow-help")).body.events).toBeArray();expect(Date.now()-before).toBeLessThan(400);expect((await waitTerminal(client,"slow-help",3_000)).at(-1)?.type).toBe("completed");}finally{client.close();server.stop();}});

  test("start 产生 normalized stream/session/message/usage/terminal，内容全部外置 blob", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("start", "hello")); const events = await waitTerminal(client, "start");
      expect(events.map((event) => event.type)).toEqual(["dispatching", "started", "session-updated", "delta", "message-completed", "usage", "usage", "completed"]);
      expect(events.find((event) => event.type === "session-updated")?.nativeRef).toBe("native-claude-1");
      expect(JSON.stringify(events)).not.toContain("reply:hello"); expect(payloads(data, events).some((value) => value.text?.includes("reply:hello") && value.text?.includes("envleak:none"))).toBe(true);
    } finally { client.close(); server.stop(); }
  });

  test("1-3MiB 图片先写授权 blob ref，socket input 保持小帧并校验 hash", async () => {
    const { data, server, client } = await fixture(); try {
      const blob = stageRunnerAttachment(data, Buffer.alloc(2 * 1024 * 1024, 7).toString("base64"));
      const body = startBody("image", "see-image") as any; body.input = JSON.stringify({ text: "see-image", cwd: tmpdir(), images: [{ mediaType: "image/png", blob }], options });
      expect(Buffer.byteLength(body.input)).toBeLessThan(1024); await client.request("submit", body); const events = await waitTerminal(client, "image"); expect(events.at(-1)?.type).toBe("completed"); expect(JSON.stringify(payloads(data, events))).toContain("images:1"); expect(auditRunnerBlobs(data).referenced).toContain(blob.ref);
      const bad = startBody("bad-image", "x") as any; bad.input = JSON.stringify({ text: "x", cwd: tmpdir(), images: [{ mediaType: "image/png", blob: { ...blob, sha256: "0".repeat(64) } }], options }); await client.request("submit", bad); expect((await waitTerminal(client, "bad-image")).at(-1)).toMatchObject({ type: "failed", reason: "provider_input_invalid" });
    } finally { client.close(); server.stop(); }
  });

  test("daemon 客户端断开不影响 Claude PID/turn，重连按 journal 查询", async () => {
    const { server, client, data } = await fixture(); try {
      await client.request("submit", startBody("disconnect", "hello")); client.close(); await Bun.sleep(80);
      const again = new RunnerClient(data), events = await waitTerminal(again, "disconnect"); expect(events.at(-1)?.type).toBe("completed"); again.close();
    } finally { server.stop(); }
  });

  test("terminal durable 后 daemon 断开重连可在同一 Runner 立即 resume", async () => {
    const { server, client, data } = await fixture(); try {
      await client.request("submit", startBody("lifecycle-start", "RESULT_THEN_LINGER", "lifecycle-session"));
      const first = await waitTerminal(client, "lifecycle-start"); expect(first.at(-1)?.type).toBe("completed"); client.close();
      const again = new RunnerClient(data);
      await again.request("submit", { commandId: "lifecycle-resume", kind: "resume-run", runId: "run-lifecycle-resume", sessionId: "lifecycle-session", providerId: "claude", input: JSON.stringify({ text: "two", images: [], cwd: tmpdir(), options, nativeRef: "native-claude-1" }) });
      const resumed = await waitTerminal(again, "lifecycle-resume"); expect(resumed.at(-1)?.type).toBe("completed"); expect(resumed.at(-1)?.reason).not.toBe("provider_busy"); const firstPayload = JSON.stringify(payloads(data, first)), resumedPayload = JSON.stringify(payloads(data, resumed)); expect(resumedPayload).toContain("reply:two"); const firstPid = /pid:(\d+)/.exec(firstPayload)?.[1], resumedPid = /pid:(\d+)/.exec(resumedPayload)?.[1]; expect(firstPid).toBeTruthy(); expect(resumedPid).toBeTruthy(); expect(resumedPid).not.toBe(firstPid); again.close();
    } finally { server.stop(); }
  });

  test("T1 迟到 abort/interrupt 按 turn identity 隔离，不影响 T2", async () => {
    const { server, client, provider } = await fixture(); try {
      await client.request("submit", startBody("old-turn", "one", "generation-session")); await waitTerminal(client, "old-turn");
      await client.request("submit", startBody("new-turn", "LONG", "generation-session"));
      for (let i = 0; i < 100; i++) { const events = (await client.queryCommand("new-turn")).body.events as any[]; if (events.some((event) => event.type === "started")) break; await Bun.sleep(5); }
      await provider.abort({ commandId: "old-turn", runId: "run-old-turn", sessionId: "generation-session" } as any);
      await client.request("interrupt", { commandId: "late-old-interrupt", runId: "run-old-turn", sessionId: "generation-session", providerId: "claude" }); expect((await waitTerminal(client, "late-old-interrupt")).at(-1)?.reason).toBe("run_not_active");
      expect(((await client.queryCommand("new-turn")).body.events as any[]).some((event) => ["failed", "interrupted", "unknown-outcome"].includes(event.type))).toBe(false);
      await client.request("interrupt", { commandId: "stop-new-turn", runId: "run-new-turn", sessionId: "generation-session", providerId: "claude" }); expect((await waitTerminal(client, "stop-new-turn")).at(-1)?.type).toBe("completed"); expect((await waitTerminal(client, "new-turn")).at(-1)?.type).toBe("interrupted");
    } finally { client.close(); server.stop(); }
  });

  test("resume、add-dir、set-access 与 new-session 均显式执行并改变下一次 spawn", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("base", "one", "shared")); await waitTerminal(client, "base");
      await client.request("submit", { commandId: "dir", kind: "add-dir", runId: "run-dir", sessionId: "shared", providerId: "claude", input: JSON.stringify({ dir: "/extra" }) }); await waitTerminal(client, "dir");
      await client.request("submit", { commandId: "access", kind: "set-access", runId: "run-access", sessionId: "shared", providerId: "claude", input: JSON.stringify({ access: "bypass" }) }); await waitTerminal(client, "access");
      await client.request("submit", { commandId: "resume", kind: "send-input", runId: "run-resume", sessionId: "shared", providerId: "claude", input: JSON.stringify({ text: "two", images: [] }) });
      let events = await waitTerminal(client, "resume"), values = payloads(data, events); expect(JSON.stringify(values)).toContain("--resume|native-claude-1"); expect(JSON.stringify(values)).toContain("--add-dir|/extra"); expect(JSON.stringify(values)).toContain("--dangerously-skip-permissions");
      await client.request("submit", { commandId: "new", kind: "new-session", runId: "run-new", sessionId: "shared", providerId: "claude", input: "{}" }); await waitTerminal(client, "new");
      await client.request("submit", { commandId: "fresh", kind: "send-input", runId: "run-fresh", sessionId: "shared", providerId: "claude", input: JSON.stringify({ text: "three", images: [] }) }); events = await waitTerminal(client, "fresh"); values = payloads(data, events); expect(JSON.stringify(values)).not.toContain("--resume|native-claude-1");
    } finally { client.close(); server.stop(); }
  });

  test("Runner 重建后用显式 nativeRef 恢复，不从 mode 或 session 文件猜 Provider", async () => {
    const data = root(), first = new ClaudeCodeRunnerProvider(command, { ...process.env, NODE_ENV: "test", OWNWARD_CLAUDE_FAKE: "1", FAKE_CLAUDE_SESSION_ID: "native-old" }, { dataRoot: data }); providers.push(first);
    let server = new RunnerServer(data, () => first); server.start(); let client = new RunnerClient(data);
    await client.request("submit", startBody("first", "one", "stable")); await waitTerminal(client, "first"); client.close(); server.stop(); await first.close();
    const second = new ClaudeCodeRunnerProvider(command, { ...process.env, NODE_ENV: "test", OWNWARD_CLAUDE_FAKE: "1", FAKE_CLAUDE_SESSION_ID: "native-new" }, { dataRoot: data }); providers.push(second); server = new RunnerServer(data, () => second); server.start(); client = new RunnerClient(data);
    try { await client.request("submit", { commandId: "resume-explicit", kind: "resume-run", runId: "run-resume-explicit", sessionId: "stable", providerId: "claude", input: JSON.stringify({ text: "again", images: [], cwd: tmpdir(), options, nativeRef: "native-old" }) }); const events = await waitTerminal(client, "resume-explicit"); expect(JSON.stringify(payloads(data, events))).toContain("--resume|native-old"); }
    finally { client.close(); server.stop(); }
  });

  test("审批只上报且等待 Kernel 明确响应，不含自动批准策略", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("approval-turn", "APPROVAL", "approval-session"));
      let approval: any; for (let i = 0; i < 100; i++) { const events = (await client.queryCommand("approval-turn")).body.events as any[]; approval = events.find((event) => event.type === "approval-requested"); if (approval) break; await Bun.sleep(10); }
      expect(approval?.approvalRequestId).toBe("approval-1"); expect((await client.queryCommand("approval-turn")).body.events).not.toContainEqual(expect.objectContaining({ type: "completed" }));
      await client.request("approval-response", { commandId: "approve-command", runId: "run-approval-turn", sessionId: "approval-session", providerId: "claude", approvalRequestId: "approval-1", input: JSON.stringify({ targetRunId: "run-approval-turn", response: "allow", remember: "global" }) });
      expect((await waitTerminal(client, "approve-command")).at(-1)?.type).toBe("completed"); const turn = await waitTerminal(client, "approval-turn"); expect(turn.at(-1)?.type).toBe("completed"); expect(JSON.stringify(payloads(data, turn))).toContain("approval:allow");
      await expect(client.request("approval-response", { commandId: "stale", runId: "run-approval-turn", sessionId: "approval-session", providerId: "claude", approvalRequestId: "approval-1", input: JSON.stringify({ targetRunId: "run-approval-turn", response: "allow" }) })).resolves.toMatchObject({ kind: "accepted" });
      expect((await waitTerminal(client, "stale")).at(-1)).toMatchObject({ type: "failed", reason: "approval_stale" });
    } finally { client.close(); server.stop(); }
  });

  test("AskUserQuestion 规范为 question/options，审批正文仍只在 blob", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("question-turn", "QUESTION", "question-session")); let approval: any;
      for (let i = 0; i < 100; i++) { approval = ((await client.queryCommand("question-turn")).body.events as any[]).find((event) => event.type === "approval-requested"); if (approval) break; await Bun.sleep(10); }
      expect(JSON.stringify(approval)).not.toContain("Which way"); expect(JSON.parse(new RunnerEventJournal(data).readPayload(approval)!)).toEqual({ kind: "question", question: "Which way?", options: ["Left", "Right"] });
      await client.request("approval-response", { commandId: "question-answer", runId: "run-question-turn", sessionId: "question-session", providerId: "claude", approvalRequestId: "approval-1", input: JSON.stringify({ targetRunId: "run-question-turn", response: "deny", message: "Left" }) }); expect((await waitTerminal(client, "question-answer")).at(-1)?.type).toBe("completed"); expect((await waitTerminal(client, "question-turn")).at(-1)?.type).toBe("completed");
    } finally { client.close(); server.stop(); }
  });

  test("interrupt 只在 Provider result 确认后将原 turn 标记 interrupted", async () => {
    const { server, client } = await fixture(); try {
      await client.request("submit", startBody("long", "LONG", "long-session")); await Bun.sleep(30);
      await client.request("interrupt", { commandId: "interrupt-command", runId: "run-long", sessionId: "long-session", providerId: "claude" }); expect((await waitTerminal(client, "interrupt-command")).at(-1)?.type).toBe("completed");
      expect((await waitTerminal(client, "long")).at(-1)).toMatchObject({ type: "interrupted", reason: "user_interrupt" });
    } finally { client.close(); server.stop(); }
  });

  test("control stdin write 后必须等匹配 ack，超时显式 provider_no_ack", async () => {
    const { server, client } = await fixture({ controlAckTimeoutMs: 40 }); try {
      await client.request("submit", startBody("no-ack-turn", "NO_ACK_LONG", "no-ack-session")); await Bun.sleep(20);
      await client.request("interrupt", { commandId: "no-ack-control", runId: "run-no-ack-turn", sessionId: "no-ack-session", providerId: "claude" });
      await client.request("interrupt", { commandId: "second-control", runId: "run-no-ack-turn", sessionId: "no-ack-session", providerId: "claude" }); expect((await waitTerminal(client, "second-control")).at(-1)?.reason).toBe("provider_busy");
      expect((await waitTerminal(client, "no-ack-control")).at(-1)).toMatchObject({ type: "failed", reason: "provider_no_ack" });
    } finally { client.close(); server.stop(); }
  });

  test("同 Session reconfigure/new 与 send 交错由 mutex 原子占用，不挂起或假 completed", async () => {
    for (const [kind, input] of [["new-session", "{}"], ["add-dir", JSON.stringify({ dir: "/extra" })], ["set-access", JSON.stringify({ access: "bypass" })]] as const) {
      const { server, client } = await fixture(); const sessionId = `race-${kind}`;
      try {
        await client.request("submit", startBody(`base-${kind}`, "base", sessionId)); await waitTerminal(client, `base-${kind}`);
        await client.request("submit", { commandId: `config-${kind}`, kind, runId: `run-config-${kind}`, sessionId, providerId: "claude", input });
        await client.request("submit", { commandId: `send-${kind}`, kind: "send-input", runId: `run-send-${kind}`, sessionId, providerId: "claude", input: JSON.stringify({ text: "racy", images: [] }) });
        expect((await waitTerminal(client, `config-${kind}`)).at(-1)?.type).toBe("completed"); const sendTerminal = (await waitTerminal(client, `send-${kind}`)).at(-1); expect(sendTerminal?.type === "completed" || (sendTerminal?.type === "failed" && sendTerminal?.reason === "provider_busy")).toBe(true);
      } finally { client.close(); server.stop(); }
    }
  });

  test("adapter error code 均映射稳定 reason，未知 code 不伪装业务成功", async () => {
    const { server, client } = await fixture(); try {
      await client.request("submit", { ...startBody("missing", "x", "missing-session"), kind: "send-input", input: JSON.stringify({ text: "x", images: [] }) }); expect((await waitTerminal(client, "missing")).at(-1)?.reason).toBe("provider_unavailable");
      await client.request("submit", { ...startBody("bad-input", "x"), input: "not-json" }); expect((await waitTerminal(client, "bad-input")).at(-1)?.reason).toBe("provider_input_invalid");
      await client.request("submit", { ...startBody("bad-cwd", "x"), input: JSON.stringify({ text: "x", cwd: "/definitely/missing", images: [], options }) }); expect((await waitTerminal(client, "bad-cwd")).at(-1)?.reason).toBe("provider_input_invalid");
      await client.request("submit", startBody("idle", "one", "idle-session")); await waitTerminal(client, "idle"); await client.request("interrupt", { commandId: "inactive", runId: "run-idle", sessionId: "idle-session", providerId: "claude" }); expect((await waitTerminal(client, "inactive")).at(-1)?.reason).toBe("run_not_active");
      const direct = new ClaudeCodeRunnerProvider(command); providers.push(direct); const badCommand = { schemaVersion: 1, commandId: "unsupported", kind: "unknown", acceptedAt: new Date().toISOString(), runId: "r", sessionId: "s", providerId: "claude" } as any; let found: any; try { for await (const _ of direct.execute(badCommand, "{}")) {} } catch (error) { found = error; } expect(found?.code).toBe("PROVIDER_CAPABILITY_UNSUPPORTED");
    } finally { client.close(); server.stop(); }
  });

  test("delta 聚合、notice/sidechain/tool error 与 zero usage 全部规范化", async () => {
    const { data, server, client, provider } = await fixture(); try {
      for (const [id, text] of [["multi", "MULTI_DELTA"], ["notices", "NOTICES"], ["zero", "ZERO_USAGE"]] as const) { await client.request("submit", startBody(id, text, `session-${id}`)); await waitTerminal(client, id); }
      const multi = await client.queryCommand("multi"), multiEvents = multi.body.events as any[]; expect(multiEvents.filter((event) => event.type === "delta")).toHaveLength(1); expect(JSON.stringify(payloads(data, multiEvents))).toContain('"text":"abc"');
      const notices = (await client.queryCommand("notices")).body.events as any[], noticePayloads = payloads(data, notices); expect(noticePayloads).toEqual(expect.arrayContaining([expect.objectContaining({ category: "compacting" }), expect.objectContaining({ category: "compact_failed" }), expect.objectContaining({ category: "compact_ok" }), expect.objectContaining({ category: "rate_limited" }), expect.objectContaining({ category: "auth_expired" })])); expect(provider.metrics.droppedFrames).toBeGreaterThan(0);
      // 未知 status 帧绝不产出空详情 api_error（曾让每个任务开头蹦「⚠️ API 错误」）——走 dropFrame 计数
      expect(noticePayloads.filter((p: any) => p?.category === "api_error" && !p.message && !p.error && !p.result)).toEqual([]);
      const zero = (await client.queryCommand("zero")).body.events as any[]; expect(zero.filter((event) => event.type === "usage")).toHaveLength(2); expect(payloads(data, zero)).toContainEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    } finally { client.close(); server.stop(); }
  });

  test("成功 tool_result 入 journal：带工具名、错误路径不变、超长截断有界", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("tools", "TOOL_RESULTS", "session-tools")); await waitTerminal(client, "tools");
      const events = (await client.queryCommand("tools")).body.events as any[], bodies = payloads(data, events);
      const result = bodies.find((b: any) => b?.role === "tool-result");
      expect(result).toBeDefined();
      expect(result.results[0]).toMatchObject({ name: "Bash", content: "file-a\nfile-b" });  // tool_use_id → 名字映射
      expect(result.results[1].content.length).toBeLessThanOrEqual(2_000);                   // 单条截断
      const error = bodies.find((b: any) => b?.role === "tool" && b?.error === true);
      expect(error).toMatchObject({ content: ["boom"] });                                    // 报错路径原样保留
      const assistant = bodies.find((b: any) => b?.role === "assistant" && Array.isArray(b?.tools) && b.tools.length);
      expect(assistant.thinking).toEqual(["let me look"]);
      expect(assistant.tools[0]).toMatchObject({ id: "tu-1", name: "Bash" });
      // 图片块：二进制落 agent-images 仓（不进 journal），payload 只带 URL，文件真实可读
      const withImg = result.results.find((r: any) => Array.isArray(r.images));
      expect(withImg.images[0]).toMatch(/^\/api\/agent-image\/session-tools\/[a-f0-9]{16}\.png$/);
      const { readAgentImage } = await import("../../runner/agent-images.ts");
      const [, , , imgKey, imgFile] = withImg.images[0].split("/");
      expect(readAgentImage(data, imgKey, imgFile)?.mime).toBe("image/png");
    } finally { client.close(); server.stop(); }
  });

  test(">2MiB tool_result 图片先解析落盘，payload 脱 base64且整轮成功", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("large-tool-image", "LARGE_TOOL_IMAGE", "large-image-session"));
      const events = await waitTerminal(client, "large-tool-image");
      expect(events.at(-1)?.type).toBe("completed");
      const event = events.find((item) => item.type === "message-completed" && item.payloadRef && JSON.parse(new RunnerEventJournal(data).readPayload(item)!).role === "tool-result");
      const raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(raw).not.toContain('"data"');
      const url = JSON.parse(raw).results[0].images[0];
      expect(url).toMatch(/^\/api\/agent-image\/large-image-session\/[a-f0-9]{16}\.png$/);
      const [, , , key, file] = url.split("/");
      const { readAgentImage } = await import("../../runner/agent-images.ts");
      expect(readAgentImage(data, key, file)!.bin.length).toBeGreaterThan(2 * 1024 * 1024);
    } finally { client.close(); server.stop(); }
  });

  test("单行 8 张合计 8MiB tool_result 图片完整解析归一化，不把 base64 写入 payload", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("multi-tool-images", "MULTI_TOOL_IMAGES", "multi-image-session"));
      const events = await waitTerminal(client, "multi-tool-images", 5_000);
      expect(events.at(-1)?.type).toBe("completed");
      const event = events.find((item) => item.type === "message-completed" && item.payloadRef && JSON.parse(new RunnerEventJournal(data).readPayload(item)!).role === "tool-result");
      const raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(raw).not.toContain('"data"');
      const images = JSON.parse(raw).results[0].images;
      expect(images).toHaveLength(8);
      const { readAgentImage } = await import("../../runner/agent-images.ts");
      for (const url of images) {
        const [, , , key, file] = url.split("/");
        expect(readAgentImage(data, key, file)!.bin.length).toBe(1024 * 1024);
      }
    } finally { client.close(); server.stop(); }
  });

  test("tool_result 图片总量超预算仍完成整轮，只保存预算内图片并脱掉全部 base64", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("tool-overflow", "TOOL_IMAGE_OVERFLOW", "tool-overflow-session"));
      const events = await waitTerminal(client, "tool-overflow", 5_000);
      expect(events.at(-1)?.type).toBe("completed");
      const event = events.find((item) => item.type === "message-completed" && item.payloadRef && JSON.parse(new RunnerEventJournal(data).readPayload(item)!).role === "tool-result"), raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(raw).not.toContain('"data"');
      expect(JSON.parse(raw).results[0].images).toHaveLength(7);
    } finally { client.close(); server.stop(); }
  });

  test("错误 tool_result 的小图和大图都脱敏落盘，错误文字可见且不阻断 terminal", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", startBody("error-images", "ERROR_TOOL_IMAGES", "error-image-session"));
      const events = await waitTerminal(client, "error-images", 5_000);
      expect(events.at(-1)?.type).toBe("completed");
      const event = events.find((item) => item.type === "message-completed" && item.payloadRef && JSON.parse(new RunnerEventJournal(data).readPayload(item)!).error === true), raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(raw).toContain("boom-visible");
      expect(raw).not.toContain('"data"');
      const content = JSON.parse(raw).content[0], urls = content.filter((part: any) => typeof part.url === "string").map((part: any) => part.url);
      expect(urls).toHaveLength(2);
      const { readAgentImage } = await import("../../runner/agent-images.ts");
      expect(urls.map((url: string) => { const [, , , key, file] = url.split("/"); return readAgentImage(data, key, file)!.bin.length; }).sort((a: number, b: number) => a - b)).toEqual([1032, 3 * 1024 * 1024 + 8]);
    } finally { client.close(); server.stop(); }
  });

  test("单行坏 JSON 可跳过；跨 chunk 半行可恢复；巨型半行达到上限才失败", async () => {
    const { server, client } = await fixture({ maxStdoutBufferBytes: 1024 }); try {
      for (const [id, text, expected] of [["one-bad", "ONE_BAD", "completed"], ["chunked", "CHUNKED", "completed"], ["giant", "GIANT_HALF", "failed"]] as const) { await client.request("submit", startBody(id, text, `session-${id}`)); expect((await waitTerminal(client, id)).at(-1)?.type).toBe(expected); }
    } finally { client.close(); server.stop(); }
  });

  test("resume 补发的后台任务通知不终结 turn：通知透出，用户消息照常被处理", async () => {
    // 2026-08-31 线上事故：上一轮留了个活着的后台任务，CLI 每次 resume 先补发通知 + 一个
    // origin=task-notification 的伪 turn result。旧实现认它作 turn 终结 → 立刻 SIGKILL CLI，
    // 用户消息还没从 stdin 读走就没了，run 却记成 completed，前端一句提示都没有
    const { data, server, client, provider } = await fixture({}, {}, { FAKE_CLAUDE_STALE_TASK: "1" }); try {
      await client.request("submit", startBody("stale-task", "hello", "stale-task-session"));
      const events = await waitTerminal(client, "stale-task"), values = payloads(data, events);
      expect(values.find((value) => value.category === "background_task")?.message ?? "<无通知>").toContain("bg-1");
      expect(JSON.stringify(values)).toContain("reply:hello");                       // 用户这条消息真的被处理了
      expect(events.filter((event) => ["completed", "failed", "interrupted"].includes(event.type))).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "completed" });
      expect(provider.metrics.droppedFrames).toBeGreaterThan(0);                     // 伪 turn 的 result 是可观测地丢的
    } finally { client.close(); server.stop(); }
  });

  test("stderr 仅保留有界 ring 并作为 notice blob，不进入 terminal/journal 明文", async () => {
    const { data, server, client } = await fixture({ stderrRingBytes: 1024 }); try { await client.request("submit", startBody("stderr", "STDERR_EXIT", "stderr-session")); const events = await waitTerminal(client, "stderr"), values = payloads(data, events), notice = values.find((value) => value.category === "stderr"); expect(notice.tail.length).toBeLessThanOrEqual(1024); expect(events.at(-1)).toMatchObject({ type: "failed", reason: "provider_exit" }); expect(JSON.stringify(events)).not.toContain("SSSS"); }
    finally { client.close(); server.stop(); }
  });

  test("fake Claude CLI 非 test 双门直接拒绝", async () => { const child = Bun.spawn(command, { env: { ...process.env, NODE_ENV: "production", OWNWARD_CLAUDE_FAKE: "0" }, stdout: "ignore", stderr: "pipe" }); expect(await child.exited).not.toBe(0); expect(await new Response(child.stderr).text()).toContain("test 双门"); });

  test("128 字符 commandId 仍生成稳定短 eventId", async () => {
    const { server, client } = await fixture(); try { const id = "c".repeat(128); await client.request("submit", { commandId: id, kind: "start-run", runId: "r".repeat(128), sessionId: "s".repeat(128), providerId: "claude", input: JSON.stringify({ text: "boundary", cwd: tmpdir(), images: [], options }) }); const events = await waitTerminal(client, id); expect(events.every((event) => event.eventId.length <= 128)).toBe(true); }
    finally { client.close(); server.stop(); }
  });

  test("Runner shutdown 回收 idle Claude child；active turn 只留一个 unknown 终态", async () => {
    const { data, server, client } = await fixture();
    await client.request("submit", startBody("idle-child", "pid", "idle-child-session")); const idleEvents = await waitTerminal(client, "idle-child"), serialized = JSON.stringify(payloads(data, idleEvents)), match = /pid:(\d+)/.exec(serialized); expect(match).toBeTruthy(); const pid = Number(match![1]);
    await client.request("submit", startBody("shutdown-active", "LONG", "shutdown-session")); await Bun.sleep(20); await server.shutdown(20); await Bun.sleep(20); expect(() => process.kill(pid, 0)).toThrow(); const events = new RunnerEventJournal(data).readStrict().filter((event) => event.commandId === "shutdown-active"); expect(events.filter((event) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(event.type))).toHaveLength(1); expect(events.at(-1)?.type).toBe("unknown-outcome"); client.close();
  });

  test("EOF 与非法 stream 都显式 failed；未知 Provider 在 durable accept 前拒绝", async () => {
    const { server, client } = await fixture(); try {
      await client.request("submit", startBody("eof", "EOF", "eof-session")); expect((await waitTerminal(client, "eof")).at(-1)).toMatchObject({ type: "failed", reason: "provider_exit", exitCode: 7 });
      await client.request("submit", startBody("malformed", "MALFORMED", "bad-session")); expect((await waitTerminal(client, "malformed")).at(-1)).toMatchObject({ type: "failed", reason: "provider_protocol_error" });
      await expect(client.request("submit", { ...startBody("unknown", "x"), providerId: "codex" })).rejects.toMatchObject({ code: "RUNNER_PROVIDER_UNAVAILABLE" });
    } finally { client.close(); server.stop(); }
  });

  test("Provider import 边界不含 Kernel/Vertical 私有模块", () => {
    const source = readFileSync(join(import.meta.dir, "adapter.ts"), "utf8");
    for (const forbidden of ["actions", "notify", "dispatch", "repo-panel", "flight-record", "lark", "workbench"]) expect(source).not.toMatch(new RegExp(`from [\"'][^\"']*${forbidden}`));
  });

  test("codebuddy 参数化：同一 adapter 换 id 注册，协议全链路走通且 CODEBUDDY_ 环境被剥离", async () => {
    const data = root(), provider = new ClaudeCodeRunnerProvider(command, { ...process.env, NODE_ENV: "test", OWNWARD_CLAUDE_FAKE: "1", FAKE_CLAUDE_SESSION_ID: "native-cb-1", CODEBUDDY_SECRET_SHOULD_CLEAR: "cb-secret" }, { dataRoot: data, providerId: "codebuddy" }); providers.push(provider);
    expect(provider.id).toBe("codebuddy");
    const server = new RunnerServer(data, (id) => { if (id !== "codebuddy") throw new Error("unregistered"); return provider; }); server.start();
    const client = new RunnerClient(data);
    try {
      await client.request("submit", { ...startBody("cb-start", "hello"), providerId: "codebuddy" });
      const events = await waitTerminal(client, "cb-start");
      expect(events.at(-1)?.type).toBe("completed");
      expect(payloads(data, events).some((value) => value.text?.includes("reply:hello") && value.text?.includes("envleak:none"))).toBe(true);
      // transcript 是 codebuddy 私有格式（~/.codebuddy/projects，非 CC 帧）：readHistory 显式拒绝，不许静默读错家目录
      await expect(provider.readHistory({ nativeRef: "any" })).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNSUPPORTED" });
    } finally { client.close(); server.stop(); }
  });

  test("codebuddy 显式 effort 在 CLI 不支持时同样于 spawn 前失败", async () => {
    const data = root(), spawnRecord = join(root(), "codebuddy-unsupported.jsonl"), provider = new ClaudeCodeRunnerProvider(command, { ...process.env, NODE_ENV: "test", OWNWARD_CLAUDE_FAKE: "1", FAKE_CLAUDE_EFFORT: "0", FAKE_CLAUDE_SPAWN_RECORD: spawnRecord }, { dataRoot: data, providerId: "codebuddy" }); providers.push(provider);
    const server = new RunnerServer(data, (id) => { if (id !== "codebuddy") throw new Error("unregistered"); return provider; }); server.start();
    const client = new RunnerClient(data);
    try {
      await client.request("submit", { ...startBody("cb-effort-unsupported", "hello"), providerId: "codebuddy" });
      const events = await waitTerminal(client, "cb-effort-unsupported");
      expect(events.at(-1)).toMatchObject({ type: "failed", reason: "unsupported_command" });
      expect(events.some((event) => event.type === "started" || event.type === "session-updated")).toBeFalse();
      expect(() => readFileSync(spawnRecord, "utf8")).toThrow();
    } finally { client.close(); server.stop(); }
  });

  test("CLI 无 --permission-prompt-tool 时 standard 退化 --permission-mode，bypass 不受影响", async () => {
    const { data, server, client } = await fixture({}, {}, { FAKE_CLAUDE_PERMISSION_PROMPT_TOOL: "0" });
    try {
      await client.request("submit", startBody("perm-degrade", "capability"));
      const events = await waitTerminal(client, "perm-degrade");
      expect(events.at(-1)?.type).toBe("completed");
      const serialized = JSON.stringify(payloads(data, events));
      expect(serialized).not.toContain("--permission-prompt-tool");
      expect(serialized).toContain("--permission-mode|acceptEdits");
      const bypass = { ...startBody("perm-bypass", "capability-2"), input: JSON.stringify({ text: "capability-2", cwd: tmpdir(), images: [], options: { ...options, access: "bypass" } }) };
      await client.request("submit", bypass);
      const bypassEvents = await waitTerminal(client, "perm-bypass");
      expect(bypassEvents.at(-1)?.type).toBe("completed");
      expect(JSON.stringify(payloads(data, bypassEvents))).toContain("--dangerously-skip-permissions");
    } finally { client.close(); server.stop(); }
  });
});
