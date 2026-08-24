export {};
if (process.env.NODE_ENV !== "test" || process.env.OWNWARD_CODEX_FAKE !== "1") { console.error("fake Codex 仅允许 test 双门"); process.exit(91); }
const args = process.argv.slice(2); if (args.shift() !== "exec") { console.error("fake argv: missing exec"); process.exit(92); }
let native = process.env.FAKE_CODEX_THREAD_ID || "019ffae9-ad07-7ef0-ab0a-761b9a426650", separator = -1, optionEnd = -1, fakePrompt = "";
const valueFlags = new Set(["--model", "--config", "--sandbox", "--add-dir", "--color"]), boolFlags = new Set(["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]);
for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a === "resume" || a === "--") { optionEnd = i; break; } if (valueFlags.has(a)) { if (!args[++i]) process.exit(94); continue; } if (boolFlags.has(a) || a.startsWith("--image=")) continue; console.error(`fake argv: unknown ${a}`); process.exit(95); }
if (optionEnd < 0) process.exit(96);
if (args[optionEnd] === "resume") { separator = optionEnd + 1; if (args[separator] !== "--" || args.length !== optionEnd + 4) process.exit(96); native = args[optionEnd + 2] || ""; fakePrompt = args[optionEnd + 3] || ""; }
else { separator = optionEnd; if (args.length !== optionEnd + 2) process.exit(96); fakePrompt = args[optionEnd + 1] || ""; }
if (!fakePrompt) process.exit(97);
const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
if (fakePrompt === "STDERR_ONLY") { process.stderr.write("auth expired: fake\n"); process.exit(9); }
// 线上实录：终端里挂着的 `codex resume` 独占 thread writer lock，续聊 1.4 秒内失败。
// 注意这段 stderr 里带 "thread/resume failed"——正是它把裸 `resume` 正则骗成 resume_not_found。
if (fakePrompt === "LOCK_CONFLICT") { process.stderr.write("ERROR codex_core::session: thread-store conflict: thread 01a012c6-a26b-70a1-a759-156e691aa507 already has an active writer\nError: thread/resume: thread/resume failed (code -32600)\n"); process.exit(1); }
if (fakePrompt === "BAD_LINES") { process.stdout.write("bad\nbad\nbad\n"); await Bun.sleep(20); process.exit(2); }
if (fakePrompt === "GIANT_HALF") { process.stdout.write("x".repeat(4096)); await Bun.sleep(20); process.exit(2); }
if (fakePrompt === "EOF") { send({ type: "thread.started", thread_id: native }); process.stderr.write("secret-stderr-" + "S".repeat(2000)); process.exit(7); }
send({ type: "thread.started", thread_id: native }); send({ type: "turn.started" });
if (fakePrompt === "LONG") { await Bun.sleep(30_000); process.exit(0); }
if (fakePrompt === "CHILD_HANG") { const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); send({ type: "item.completed", item: { id: "child", type: "agent_message", text: `child:${child.pid}` } }); await Bun.sleep(30_000); process.exit(0); }
if (fakePrompt === "ONE_BAD") process.stdout.write("bad\n");
if (fakePrompt === "CHUNKED") { const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "chunked" } }) + "\n"; process.stdout.write(line.slice(0, 9)); await Bun.sleep(5); process.stdout.write(line.slice(9)); }
else {
  send({ type: "item.started", item: { id: "message-1", type: "agent_message", text: "par" } });
  send({ type: "item.updated", item: { id: "message-1", type: "agent_message", text: "partial" } });
  send({ type: "item.completed", item: { id: "cmd", type: "command_execution", command: "echo ok", status: "completed" } });
  send({ type: "item.completed", item: { id: "file", type: "file_change", changes: [{ path: "x", kind: "update" }] } });
  send({ type: "item.completed", item: { id: "web", type: "web_search", query: "ownward" } });
  const canary=/OWNWARD_(?:CANARY|RESUME)_[0-9a-f-]+/.exec(fakePrompt)?.[0];send({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: canary??`reply:${fakePrompt}|args:${args.join("|")}|home:${process.env.CODEX_HOME || "default"}|access:${args.slice(0, optionEnd).includes("--dangerously-bypass-approvals-and-sandbox") ? "full" : "workspace"}|pid:${process.pid}` } });
}
if (fakePrompt === "TURN_FAILED") send({ type: "turn.failed", error: { message: "fake failed" } });
else send({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
