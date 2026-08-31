import { appendFileSync } from "fs";
export {};
if (process.env.NODE_ENV !== "test" || process.env.OWNWARD_CLAUDE_FAKE !== "1") throw new Error("fake Claude CLI 需要显式 test 双门");
const args = process.argv.slice(2);
// 模拟 commander：不认识的旗标即刻报错退出；认识但缺值的旗标报 argument missing——与真 CLI 行为一致（probe 靠 stderr 文本区分）
if(process.env.FAKE_CLAUDE_PERMISSION_PROMPT_TOOL==="0"&&args.includes("--permission-prompt-tool")){console.error("error: unknown option '--permission-prompt-tool'");process.exit(1);}
{const ppIdx=args.indexOf("--permission-prompt-tool");if(ppIdx>=0&&(ppIdx===args.length-1||args[ppIdx+1].startsWith("-"))){console.error("error: option '--permission-prompt-tool <tool>' argument missing");process.exit(1);}}
if(args.includes("--help")){const delay=Number(process.env.FAKE_CLAUDE_HELP_DELAY_MS||0);if(delay>0)await Bun.sleep(delay);if(process.env.FAKE_CLAUDE_HELP_FAIL==="1"){console.error("fake help failed");process.exit(9);}console.log(process.env.FAKE_CLAUDE_EFFORT==="0"?"fake help":"fake help --effort <level>");process.exit(0);}
if(process.env.FAKE_CLAUDE_SPAWN_RECORD)appendFileSync(process.env.FAKE_CLAUDE_SPAWN_RECORD,JSON.stringify(args)+"\n");
const sessionId = process.env.FAKE_CLAUDE_SESSION_ID || `fake-session-${process.pid}`;
let initialized = false;
let waiting: "approval" | "long" | "long-noack" | null = null;
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
function init() {
  if (initialized) return; initialized = true;
  write({ type: "system", subtype: "init", session_id: sessionId, model: "fake-claude", slash_commands: ["compact", "new"] });
}
function complete(text = "done") {
  write({ type: "stream_event", event: { delta: { type: "text_delta", text } } });
  write({ type: "assistant", message: { model: "fake-claude", usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 }, content: [{ type: "text", text }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/example" } }] } });
  write({ type: "result", is_error: false, usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 } });
}
function completeWithUsage(text: string, usage: Record<string, number>) {
  write({ type: "assistant", message: { model: "fake-claude", usage, content: [{ type: "text", text }] } }); write({ type: "result", is_error: false, usage });
}
function onFrame(frame: any) {
  if (frame?.type === "user") {
    init(); const content = frame.message?.content; const text = Array.isArray(content) ? content.filter((v: any) => v?.type === "text").map((v: any) => v.text).join("\n") : ""; const imageCount = Array.isArray(content) ? content.filter((v: any) => v?.type === "image").length : 0;
    if (text === "MALFORMED") { process.stdout.write("{not-json\n{still-bad\n[broken\n"); return; }
    if (text === "ONE_BAD") { process.stdout.write("not-json\n"); complete("after-bad-line"); return; }
    if (text === "GIANT_HALF") { process.stdout.write("x".repeat(4096)); return; }
    if (text === "MULTI_DELTA") { write({ type: "stream_event", event: { delta: { type: "text_delta", text: "a" } } }); write({ type: "stream_event", event: { delta: { type: "text_delta", text: "b" } } }); write({ type: "stream_event", event: { delta: { type: "text_delta", text: "c" } } }); completeWithUsage("abc", { input_tokens: 1, output_tokens: 1 }); return; }
    if (text === "NOTICES") { write({ type: "system", subtype: "status", status: "compacting" }); write({ type: "system", subtype: "status", compact_result: "failed", compact_error: "compact boom" }); write({ type: "system", subtype: "status", compact_result: "success" }); write({ type: "system", subtype: "status", status: "some_future_status" }); write({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "rate limit exceeded" }] } }); write({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "authentication token expired" }] } }); write({ type: "assistant", isSidechain: true, message: { model: "fake", content: [{ type: "text", text: "hidden" }] } }); write({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "tool failed" }] } }); complete("notice-done"); return; }
    if (text === "LARGE_TOOL_IMAGE") {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3 * 1024 * 1024)]).toString("base64");
      write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "large-image", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] } });
      complete("large-image-done"); return;
    }
    if (text === "MULTI_TOOL_IMAGES") {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const images = Array.from({ length: 8 }, (_, index) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.concat([signature, Buffer.alloc(1024 * 1024 - signature.length, index + 1)]).toString("base64") } }));
      write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "multi-image", content: images }] } });
      complete("multi-image-done"); return;
    }
    if (text === "TOOL_IMAGE_OVERFLOW") {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const size = 1152 * 1024;
      const images = Array.from({ length: 8 }, (_, index) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.concat([signature, Buffer.alloc(size - signature.length, index + 1)]).toString("base64") } }));
      write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "overflow", content: images }] } });
      complete("overflow-done"); return;
    }
    if (text === "ERROR_TOOL_IMAGES") {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const small = Buffer.concat([signature, Buffer.alloc(1024, 1)]).toString("base64"), large = Buffer.concat([signature, Buffer.alloc(3 * 1024 * 1024, 2)]).toString("base64");
      write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "error-images", is_error: true, content: [{ type: "text", text: "boom-visible" }, { type: "image", source: { type: "base64", media_type: "image/png", data: small } }, { type: "image", source: { type: "base64", media_type: "image/png", data: large } }] }] } });
      complete("error-images-done"); return;
    }
    if (text === "TOOL_RESULTS") {
      write({ type: "assistant", message: { model: "fake-claude", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "thinking", thinking: "let me look" }, { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }] } });
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: [{ type: "text", text: "file-a\nfile-b" }] }, { type: "tool_result", tool_use_id: "tu-x", is_error: true, content: "boom" }, { type: "tool_result", tool_use_id: "tu-2", content: "x".repeat(5_000) }, { type: "tool_result", tool_use_id: "tu-3", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] } });
      complete("tools-done"); return;
    }
    if (text === "QUESTION") { waiting = "approval"; write({ type: "control_request", request_id: "approval-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which way?", options: [{ label: "Left" }, { label: "Right" }] }] } } }); return; }
    if (text === "STDERR_EXIT") { process.stderr.write("S".repeat(50_000)); process.exit(9); return; }
    if (text === "ZERO_USAGE") { completeWithUsage("zero", { input_tokens: 0, output_tokens: 0 }); return; }
    if (text === "CHUNKED") { const line = JSON.stringify({ type: "assistant", message: { model: "fake-claude", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "chunked" }] } }) + "\n"; process.stdout.write(line.slice(0, 17)); setTimeout(() => { process.stdout.write(line.slice(17)); write({ type: "result", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }); }, 5); return; }
    if (text === "EOF") { process.exit(7); return; }
    if (text === "RESULT_THEN_LINGER") { complete(`linger:pid:${process.pid}`); setTimeout(() => process.exit(0), 250); return; }
    if (text === "APPROVAL") { waiting = "approval"; write({ type: "control_request", request_id: "approval-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push" } } }); return; }
    if (text === "LONG") { waiting = "long"; return; }
    if (text === "NO_ACK_LONG") { waiting = "long-noack"; return; }
    const canary=/OWNWARD_(?:CANARY|RESUME)_[0-9a-f-]+/.exec(text)?.[0];complete(canary??`reply:${text};images:${imageCount};pid:${process.pid};envleak:${process.env.CLAUDE_CODE_SECRET_SHOULD_CLEAR || process.env.CODEBUDDY_SECRET_SHOULD_CLEAR || "none"};args:${args.join("|")}`); return;
  }
  if (frame?.type === "control_response" && waiting === "approval") { waiting = null; write({ type: "control_response", response: { subtype: "success", request_id: frame.response?.request_id } }); complete(`approval:${frame.response?.response?.behavior}`); return; }
  if (frame?.type === "control_request" && frame.request?.subtype === "interrupt" && waiting === "long") {
    waiting = null; write({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } }); write({ type: "result", is_error: true, subtype: "interrupted", usage: { input_tokens: 1, output_tokens: 0 } });
  }
}

const reader = Bun.stdin.stream().getReader(), decoder = new TextDecoder(); let buffer = "";
// 真 CLI resume 时的时序（2026-08-31 线上抓帧）：先补发上一轮遗留的后台任务通知，并为这条通知
// 单独走一个伪 turn —— init + result(origin.kind="task-notification")，之后才是本轮自己的 init
if (process.env.FAKE_CLAUDE_STALE_TASK === "1") {
  write({ type: "system", subtype: "task_notification", task_id: "bg-1", tool_use_id: "toolu_bg", status: "stopped", output_file: "", summary: "No completion record was found for this background shell command from the previous session." });
  init(); write({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "", origin: { kind: "task-notification" }, usage: { input_tokens: 0, output_tokens: 0 } }); initialized = false;
}
init(); // 覆盖 CLI 在首条 user frame 前先发 init 的真实时序。
while (true) {
  const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line.trim()) onFrame(JSON.parse(line)); }
}
