import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerClient } from "../../runner/client.ts";
import { stageRunnerAttachment } from "../../runner/attachments.ts";
import { auditRunnerBlobs, RunnerEventJournal } from "../../runner/journals.ts";
import { RunnerServer } from "../../runner/server.ts";
import { CodexRunnerProvider } from "./adapter.ts";
import { buildCodexArgs, CODEX_EFFORTS, CODEX_MODEL_EFFORTS, CODEX_PROVIDER_CAPABILITIES, DEFAULT_CODEX_MODEL, parseCodexOptions } from "./protocol.ts";
import { canaryProvider } from "../../release/provider-canary.ts";
import { readAgentImage } from "../../runner/agent-images.ts";
import { RUNNER_MAX_FRAME_BYTES } from "../../runner/protocol.ts";

const roots: string[] = [], providers: CodexRunnerProvider[] = [];
afterEach(async () => { for (const p of providers.splice(0)) await p.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const opts = { access: "workspace-write" as const, extraDirs: [] as string[], home: { kind: "default" as const }, model: "gpt-5.4", effort: "high" as const };
const NATIVE = "019ffae9-ad07-7ef0-ab0a-761b9a426650", OLD_NATIVE = "019ffae9-ad07-7ef0-ab0a-761b9a426651", OTHER_NATIVE = "019ffae9-ad07-7ef0-ab0a-761b9a426652";
const cmd = [process.execPath, join(import.meta.dir, "testing", "fake-codex.ts")];
const body = (id: string, text: string, sessionId = `session-${id}`) => ({ commandId: id, kind: "start-run", runId: `run-${id}`, sessionId, providerId: "codex", input: JSON.stringify({ text, cwd: tmpdir(), images: [], options: opts }) });
async function fixture(extra = {}) { const data = mkdtempSync(join(tmpdir(), "ownward-codex-provider-")); roots.push(data); const p = new CodexRunnerProvider(cmd, { ...process.env, NODE_ENV: "test", OWNWARD_CODEX_FAKE: "1", FAKE_CODEX_THREAD_ID: NATIVE }, { dataRoot: data, ...extra }); providers.push(p); const server = new RunnerServer(data, (id) => { if (id !== "codex") throw new Error("unregistered"); return p; }); server.start(); return { data, p, server, client: new RunnerClient(data) }; }
async function terminal(c: RunnerClient, id: string, timeout = 2_000) { const end = Date.now() + timeout; while (Date.now() < end) { const e = (await c.queryCommand(id)).body.events as any[]; if (e.some((x) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(x.type))) return e; await Bun.sleep(10); } throw new Error(`timeout ${id}`); }
const payloads = (data: string, events: any[]) => { const j = new RunnerEventJournal(data); return events.filter((e) => e.payloadRef).map((e) => JSON.parse(j.readPayload(e)!)); };

describe("Codex Runner Provider contract", () => {
  test("release canary fixture proves exact start/resume nonce through payload blobs",async()=>{const{server,client}=await fixture();try{expect(await canaryProvider(client,"codex",tmpdir(),2_000)).toMatchObject({ok:true,providerId:"codex"});}finally{client.close();server.stop();}});
  test("read-history 从真实 Codex rollout fixture 恢复", async () => { const home = mkdtempSync(join(tmpdir(), "ownward-codex-home-")); roots.push(home); const dir = join(home, ".codex/sessions/2026/08/17"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "rollout-fixture.jsonl"), [JSON.stringify({ type: "session_meta", payload: { id: NATIVE } }), JSON.stringify({ timestamp: "2026-08-01T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "question" } }), JSON.stringify({ timestamp: "2026-08-01T00:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "answer" } }), ""].join("\n")); const provider = new CodexRunnerProvider(cmd, { ...process.env, HOME: home }); providers.push(provider); expect(await provider.readHistory({ nativeRef: NATIVE })).toEqual([{ role: "user", text: "question", ts: "2026-08-01T00:00:00Z" }, { role: "assistant", text: "answer", ts: "2026-08-01T00:00:01Z" }]); });
  test("capability 对齐真实 CLI，不伪造 approval；resume 的 ref/正文都在 option terminator 后", () => { expect([...CODEX_PROVIDER_CAPABILITIES]).toEqual(["stream", "resume", "interrupt", "images", "tools", "add-dir", "set-access", "new-session", "model", "effort"]); const args = buildCodexArgs(["codex"], { ...opts, effort: "high", extraDirs: ["/tmp"] }, "hi", [], NATIVE), resume = args.indexOf("resume"); for (const flag of ["--model", "--config", "--sandbox", "--add-dir", "--json", "--color", "--skip-git-repo-check"]) expect(args.indexOf(flag)).toBeLessThan(resume); expect(args.slice(resume)).toEqual(["resume", "--", NATIVE, "hi"]); expect(args.slice(0, resume)).toEqual(expect.arrayContaining(["--config", 'model_reasoning_effort="high"'])); });
  test("model/effort matrix 与合法值 contract", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(CODEX_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    for (const [model, efforts] of Object.entries(CODEX_MODEL_EFFORTS)) {
      for (const effort of efforts) expect(parseCodexOptions({ ...opts, model, effort })).toMatchObject({ model, effort });
      for (const effort of CODEX_EFFORTS.filter((value) => !(efforts as readonly string[]).includes(value)))
        expect(() => parseCodexOptions({ ...opts, model, effort })).toThrow("model/effort 组合非法");
    }
    expect(parseCodexOptions({ ...opts, model: "gpt-explicit", effort: undefined })).toMatchObject({ model: "gpt-explicit" });
    expect(() => parseCodexOptions({ ...opts, model: "gpt-explicit", effort: "high" })).toThrow("model/effort 组合非法");
    expect(() => parseCodexOptions({ ...opts, model: undefined, effort: "high" })).toThrow("model/effort 组合非法");
    for (const bad of ["", "--model", "gpt 5", "gpt\0x"]) expect(() => parseCodexOptions({ ...opts, model: bad })).toThrow("model 非法");
    for (const bad of ["", "minimal", "HIGH", "high --sandbox danger-full-access"]) expect(() => parseCodexOptions({ ...opts, effort: bad })).toThrow("effort 非法");
    expect(() => parseCodexOptions({ ...opts, temperature: 1 })).toThrow("options 含未知字段");
  });
  test("initial 与 resume argv 都显式传递 model 和 model_reasoning_effort",()=>{for(const nativeRef of[undefined,NATIVE]){const args=buildCodexArgs(["codex"],{...opts,model:DEFAULT_CODEX_MODEL,effort:"max"},"prompt",[],nativeRef);expect(args).toEqual(expect.arrayContaining(["--model",DEFAULT_CODEX_MODEL,"--config",'model_reasoning_effort="max"']));if(nativeRef)expect(args.slice(args.indexOf("resume"))).toEqual(["resume","--",NATIVE,"prompt"]);else expect(args.at(-1)).toBe("prompt");}});
  test("start stream/nativeRef/message/usage/terminal 全规范化且正文只进 blob", async () => { const { data, server, client } = await fixture(); try { await client.request("submit", body("start", "hello")); const e = await terminal(client, "start"); expect(e.map((x) => x.type)).toEqual(["dispatching", "started", "session-updated", "delta", "message-completed", "message-completed", "message-completed", "message-completed", "usage", "completed"]); expect(e.find((x) => x.type === "session-updated")?.nativeRef).toBe(NATIVE); expect(JSON.stringify(e)).not.toContain("reply:hello"); const values = payloads(data, e); expect(JSON.stringify(values)).toContain("reply:hello"); expect(JSON.stringify(values)).toContain('model_reasoning_effort=\\"high\\"'); expect(values.find((x) => x.inputTokens !== undefined)).toMatchObject({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, contextTokens: 10 }); } finally { client.close(); server.stop(); } });
  // add-dir 断言必须取 tmpdir() 本身、且按 JSON 转义：p 是 JSON.stringify 的结果，
  // 硬写 /tmp 只在 tmpdir()=/tmp 的 Linux 上成立（macOS 是 /var/folders/…/T），
  // 而 Windows 路径的反斜杠在 JSON 里是 \\，直接内插同样对不上
  test("resume/send、显式 home、add-dir/set-access/new-session 映射下一轮", async () => { const { data, server, client } = await fixture(); try { await client.request("submit", body("base", "one", "shared")); await terminal(client, "base"); await client.request("submit", { commandId: "dir", kind: "add-dir", runId: "r-dir", sessionId: "shared", providerId: "codex", input: JSON.stringify({ dir: tmpdir() }) }); await terminal(client, "dir"); await client.request("submit", { commandId: "access", kind: "set-access", runId: "r-access", sessionId: "shared", providerId: "codex", input: JSON.stringify({ access: "full-access" }) }); await terminal(client, "access"); await client.request("submit", { commandId: "send", kind: "send-input", runId: "r-send", sessionId: "shared", providerId: "codex", input: JSON.stringify({ text: "two", images: [] }) }); let e = await terminal(client, "send"); let p = JSON.stringify(payloads(data, e)); expect(p).toContain(`resume|--|${NATIVE}|two`); expect(p).toContain(`--add-dir|${JSON.stringify(tmpdir()).slice(1, -1)}`); expect(p).toContain("--dangerously-bypass-approvals-and-sandbox"); await client.request("submit", { commandId: "new", kind: "new-session", runId: "r-new", sessionId: "shared", providerId: "codex", input: "{}" }); await terminal(client, "new"); await client.request("submit", { commandId: "fresh", kind: "send-input", runId: "r-fresh", sessionId: "shared", providerId: "codex", input: JSON.stringify({ text: "three", images: [] }) }); e = await terminal(client, "fresh"); expect(JSON.stringify(payloads(data, e))).not.toContain(`resume|--|${NATIVE}`); } finally { client.close(); server.stop(); } });
  test("Runner 重建只凭显式 nativeRef/home 恢复，不从 mode 猜", async () => { const { data, p, server, client } = await fixture(); await client.request("submit", body("old", "one", "stable")); await terminal(client, "old"); client.close(); server.stop(); await p.close(); const second = new CodexRunnerProvider(cmd, { ...process.env, NODE_ENV: "test", OWNWARD_CODEX_FAKE: "1" }, { dataRoot: data }); providers.push(second); const srv = new RunnerServer(data, () => second); srv.start(); const c = new RunnerClient(data); try { const explicit = { ...opts, home: { kind: "path", path: "/tmp/codex-alt" } }; await c.request("submit", { commandId: "resume", kind: "resume-run", runId: "r-resume", sessionId: "stable", providerId: "codex", input: JSON.stringify({ text: "again", images: [], cwd: tmpdir(), options: explicit, nativeRef: OLD_NATIVE }) }); const e = await terminal(c, "resume"); const pld = JSON.stringify(payloads(data, e)); expect(pld).toContain(`resume|--|${OLD_NATIVE}|again`); expect(pld).toContain("home:/tmp/codex-alt"); } finally { c.close(); srv.stop(); } });
  test("图片 blob、长 command id 与显式 unsupported approval", async () => { const { data, server, client } = await fixture(); try { const image = stageRunnerAttachment(data, Buffer.alloc(1024 * 1024, 7).toString("base64")); const id = "c".repeat(128), b: any = body(id, "image"); b.runId = "r".repeat(128); b.sessionId = "s".repeat(128); b.input = JSON.stringify({ text: "image", cwd: tmpdir(), images: [{ mediaType: "image/png", blob: image }], options: opts }); await client.request("submit", b); expect((await terminal(client, id)).every((e) => e.eventId.length <= 128)).toBe(true); await client.request("approval-response", { commandId: "approval", runId: id, sessionId: b.sessionId, providerId: "codex", approvalRequestId: "req", input: "{}" }); expect((await terminal(client, "approval")).at(-1)?.reason).toBe("unsupported_command"); } finally { client.close(); server.stop(); } });
  test("MCP ImageContent 落 agent-images，durable payload 不含 base64 且保持图文顺序", async () => {
    const { data, server, client } = await fixture();
    try {
      await client.request("submit", body("mcp-images", "MCP_IMAGES", "mcp-session"));
      const events = await terminal(client, "mcp-images"), event = events.find((e) => e.type === "message-completed" && e.payloadRef);
      const raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(event.payloadBytes).toBeLessThan(RUNNER_MAX_FRAME_BYTES);
      expect(raw).not.toContain('"data"');
      const content = JSON.parse(raw).item.result.content;
      expect(content.map((part: any) => part.type)).toEqual(["text", "image", "text"]);
      expect(content.map((part: any) => part.text ?? part.url)).toEqual(["before", expect.stringMatching(/^\/api\/agent-image\/mcp-session\/[a-f0-9]{16}\.png$/), "after"]);
      const [, , , key, file] = content[1].url.split("/");
      const image = readAgentImage(data, key, file);
      expect(image?.mime).toBe("image/png");
      expect(image!.bin.length).toBeGreaterThan(2 * 1024 * 1024);
    } finally { client.close(); server.stop(); }
  });
  test("单行 8 张合计 8MiB MCP 图片完整解析归一化，不把 base64 写入 payload", async () => {
    const { data, server, client } = await fixture();
    try {
      await client.request("submit", body("mcp-multi-images", "MCP_MULTI_IMAGES", "mcp-multi-session"));
      const events = await terminal(client, "mcp-multi-images", 5_000);
      expect(events.at(-1)?.type).toBe("completed");
      const event = events.find((item) => item.type === "message-completed" && item.payloadRef);
      const raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(raw).not.toContain('"data"');
      const content = JSON.parse(raw).item.result.content, images = content.filter((part: any) => part.type === "image");
      expect(content.map((part: any) => part.type)).toEqual(["text", ...Array(8).fill("image"), "text"]);
      expect(images).toHaveLength(8);
      for (const part of images) {
        const [, , , key, file] = part.url.split("/");
        expect(readAgentImage(data, key, file)!.bin.length).toBe(1024 * 1024);
      }
    } finally { client.close(); server.stop(); }
  });
  test("MCP 图片总量超预算仍完成整轮，只保存预算内图片并脱掉全部 base64", async () => {
    const { data, server, client } = await fixture(); try {
      await client.request("submit", body("mcp-overflow", "MCP_IMAGE_OVERFLOW", "mcp-overflow-session"));
      const events = await terminal(client, "mcp-overflow", 5_000);
      expect(events.at(-1)?.type).toBe("completed");
      const event = events.find((item) => item.type === "message-completed" && item.payloadRef), raw = new RunnerEventJournal(data).readPayload(event)!;
      expect(raw).not.toContain('"data"');
      const images = JSON.parse(raw).item.result.content;
      expect(images.filter((part: any) => typeof part.url === "string")).toHaveLength(7);
      expect(images.filter((part: any) => part.unavailable === true)).toHaveLength(1);
    } finally { client.close(); server.stop(); }
  });
  test("interrupt、EOF/坏 JSON/巨型半行及断线重连", async () => { const { data, server, client } = await fixture({ maxStdoutBufferBytes: 1024 }); try { await client.request("submit", body("long", "LONG", "long-session")); await Bun.sleep(30); await client.request("interrupt", { commandId: "stop", runId: "run-long", sessionId: "long-session", providerId: "codex" }); expect((await terminal(client, "stop")).at(-1)?.type).toBe("completed"); expect((await terminal(client, "long")).at(-1)?.type).toBe("interrupted"); for (const [id, text, reason] of [["eof", "EOF", "provider_exit"], ["bad", "BAD_LINES", "provider_protocol_error"], ["giant", "GIANT_HALF", "provider_protocol_error"]]) { await client.request("submit", body(id, text)); client.close(); const again = new RunnerClient(data); expect((await terminal(again, id)).at(-1)?.reason).toBe(reason); } } finally { client.close(); server.stop(); } });
  test("shutdown child 由 Runner 留唯一 unknown outcome", async () => { const { data, server, client } = await fixture(); await client.request("submit", body("shutdown", "LONG", "shutdown-session")); await Bun.sleep(30); await server.shutdown(20); const e = new RunnerEventJournal(data).readStrict().filter((x) => x.commandId === "shutdown"); expect(e.filter((x) => ["completed", "failed", "interrupted", "unknown-outcome"].includes(x.type))).toHaveLength(1); expect(e.at(-1)?.type).toBe("unknown-outcome"); client.close(); });
  test("fake CLI 非 test 双门拒绝", async () => { const p = Bun.spawn(cmd, { env: { ...process.env, NODE_ENV: "production" }, stderr: "pipe", stdout: "ignore" }); expect(await p.exited).not.toBe(0); expect(await new Response(p.stderr).text()).toContain("test 双门"); });
  test("单坏行可跳过且跨 chunk 半行可恢复", async () => { const { server, client } = await fixture(); try { for (const [id, value] of [["one-bad", "ONE_BAD"], ["chunked", "CHUNKED"]]) { await client.request("submit", body(id, value)); expect((await terminal(client, id)).at(-1)?.type).toBe("completed"); } } finally { client.close(); server.stop(); } });
  test("Provider import boundary 不允许反向依赖 Kernel/产品域", async () => { const glob = new Bun.Glob("**/*.ts"), forbidden = /(actions|notify|dispatch|repo-panel|flight-record|lark|workbench|sessions\/repository|runs\/repository)\.ts/; for await (const file of glob.scan({ cwd: import.meta.dir })) { const source = await Bun.file(join(import.meta.dir, file)).text(); expect(source.match(/from\s+["']([^"']+)["']/g)?.some((line) => forbidden.test(line))).not.toBe(true); } });
  test("正文 option 注入被 -- 隔离，空正文拒绝", async () => { const { data, server, client } = await fixture(); try { const dangerous = "--dangerously-bypass-approvals-and-sandbox", b = body("literal", dangerous); await client.request("submit", b); const values = JSON.stringify(payloads(data, await terminal(client, "literal"))); expect(values).toContain(`reply:${dangerous}`); expect(values).toContain("access:workspace"); const empty = body("empty", ""); await client.request("submit", empty); expect((await terminal(client, "empty")).at(-1)?.reason).toBe("provider_input_invalid"); } finally { client.close(); server.stop(); } });
  test("本机 Codex 真实 clap 离线解析生成的 resume 父 options", async () => { const binary = Bun.which("codex"); if (!binary) return; const generated = buildCodexArgs([binary], { ...opts, model: undefined, extraDirs: ["/tmp"] }, "probe", [], NATIVE), resume = generated.indexOf("resume"), argv = [binary, ...generated.slice(1, resume), "resume", "--help"]; const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", env: { ...process.env, CODEX_HOME: "/tmp/ownward-codex-offline-help" } }); expect(await p.exited).toBe(0); });
  // 锁冲突 ≠ 会话找不到：前者要释放持有者，后者要新开会话。两者混淆会把用户引向完全错误的动作。
  test("thread 锁冲突落 lock_conflict，不再被裸 resume 正则误判成 resume_not_found", async () => {
    const { data, server, client } = await fixture();
    try {
      await client.request("submit", body("locked", "LOCK_CONFLICT"));
      const events = await terminal(client, "locked"), values = payloads(data, events);
      expect(values[0]).toMatchObject({ category: "lock_conflict" });
      expect(values[0].tail).toContain("already has an active writer");
      expect(events.at(-1)).toMatchObject({ type: "failed", reason: "provider_exit" });
    } finally { client.close(); server.stop(); }
  });
  test("stderr-only 在 terminal 前落 bounded 分类 notice，快照只发正前缀 suffix", async () => { const { data, server, client } = await fixture({ stderrRingBytes: 32 }); try { await client.request("submit", body("stderr-only", "STDERR_ONLY")); const events = await terminal(client, "stderr-only"), values = payloads(data, events); expect(events.map((e) => e.type)).toEqual(["dispatching", "provider-notice", "failed"]); expect(values[0]).toMatchObject({ category: "auth_expired" }); expect(values[0].tail.length).toBeLessThanOrEqual(32); await client.request("submit", body("snapshot", "hello")); const snapshot = await terminal(client, "snapshot"), deltas = payloads(data, snapshot.filter((e) => e.type === "delta")); expect(deltas).toEqual([{ role: "assistant", text: "tial" }]); } finally { client.close(); server.stop(); } });
  test("idle watchdog 回收独立进程组 descendants，原 turn 显式 provider_no_progress", async () => { const { data, server, client } = await fixture({ idleTimeoutMs: 40, interruptGraceMs: 20 }); try { await client.request("submit", body("child-hang", "CHILD_HANG")); let child = 0; for (let i = 0; i < 50 && !child; i++) { const e = (await client.queryCommand("child-hang")).body.events as any[]; const raw = JSON.stringify(payloads(data, e)); child = Number(/child:(\d+)/.exec(raw)?.[1] || 0); await Bun.sleep(5); } expect(child).toBeGreaterThan(0); expect((await terminal(client, "child-hang")).at(-1)).toMatchObject({ type: "failed", reason: "provider_no_progress" }); await Bun.sleep(30); expect(() => process.kill(child, 0)).toThrow(); } finally { client.close(); server.stop(); } });
  test("crash 遗留的图片物化副本进入 runner audit temporary", () => { const data = mkdtempSync(join(tmpdir(), "ownward-codex-audit-")); roots.push(data); const dir = join(data, "runner", "tmp", "codex-crashed"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "0.png"), "secret"); expect(auditRunnerBlobs(data).temporary).toEqual(expect.arrayContaining(["tmp/codex-crashed", "tmp/codex-crashed/0.png"])); });
  test("已有 Session 的 resume/recovery 三元组任一漂移都 fail closed", async () => { const { server, client } = await fixture(); try { await client.request("submit", body("identity", "one", "identity-session")); await terminal(client, "identity"); for (const [id, kind, input] of [["bad-ref", "resume-run", { text: "x", images: [], cwd: tmpdir(), options: opts, nativeRef: OTHER_NATIVE }], ["bad-options", "send-input", { text: "x", images: [], cwd: tmpdir(), options: { ...opts, access: "full-access" }, nativeRef: NATIVE }], ["flag-ref", "resume-run", { text: "x", images: [], cwd: tmpdir(), options: opts, nativeRef: "--last" }]] as const) { await client.request("submit", { commandId: id, kind, runId: `r-${id}`, sessionId: "identity-session", providerId: "codex", input: JSON.stringify(input) }); expect((await terminal(client, id)).at(-1)?.reason).toBe("provider_input_invalid"); } await client.request("submit", { commandId: "still-valid", kind: "send-input", runId: "r-still-valid", sessionId: "identity-session", providerId: "codex", input: JSON.stringify({ text: "still here", images: [] }) }); expect((await terminal(client, "still-valid")).at(-1)?.type).toBe("completed"); } finally { client.close(); server.stop(); } });
  test("Runner ping 暴露结构化 Provider metrics", async () => { const { server, client } = await fixture(); try { await client.request("submit", body("metrics", "one")); await terminal(client, "metrics"); const pong = await client.request("ping", {}); expect((pong.body.providerMetrics as any).codex).toMatchObject({ invalidLines: 0, activeSessions: 0 }); } finally { client.close(); server.stop(); } });
});
