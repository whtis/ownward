import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inspectCodexSessionFile, listCodexSessions, readCodexMessages } from "./codex-sessions.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("response_item-only user frame supplies inspect/list title and firstUser", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-codex-meta-"));
  const sessions = join(root, "sessions"), path = join(sessions, "rollout.jsonl");
  try {
    mkdirSync(sessions);
    writeFileSync(path, [
      line({ type: "session_meta", payload: { id: "019c-rollout", cwd: "/repo/project", originator: "codex-tui" } }),
      line({ timestamp: "1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "  response item title\nwith detail  " }] } }),
      line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(2100) } }),
    ].join(""));

    expect(inspectCodexSessionFile(path, "codex")).toMatchObject({
      id: "cdx:codex:019c-rollout",
      title: "response item title with detail",
      firstUser: "response item title\nwith detail",
    });
    expect(listCodexSessions(1, [["codex-test", sessions]])[0]).toMatchObject({
      id: "cdx:codex-test:019c-rollout",
      title: "response item title with detail",
      firstUser: "response item title\nwith detail",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decodes current response_item messages without duplicating legacy variants", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-codex-rollout-"));
  const path = join(root, "rollout.jsonl");
  try {
    writeFileSync(path, [
      line({ timestamp: "1", type: "event_msg", payload: { type: "user_message", message: "hello" } }),
      line({ timestamp: "1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
      line({ timestamp: "2", type: "event_msg", payload: { type: "agent_message", message: "working" } }),
      line({ timestamp: "2.001", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] } }),
      line({ timestamp: "3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }),
    ].join(""));

    expect(readCodexMessages(path).messages).toEqual([
      { role: "user", text: "hello", ts: "1" },
      { role: "assistant", text: "working", ts: "2" },
      { role: "assistant", text: "done", ts: "3" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("first read seeks behind a large tool frame and keeps an incomplete tail for the next poll", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-codex-seek-"));
  const path = join(root, "rollout.jsonl");
  try {
    const leadingNoise = line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(400 * 1024) } });
    const recentMessages = [
      line({ timestamp: "1", type: "event_msg", payload: { type: "user_message", message: "take over here" } }),
      line({ timestamp: "2", type: "event_msg", payload: { type: "agent_message", message: "still running" } }),
    ].join("");
    const trailingNoise = line({ type: "response_item", payload: { type: "function_call_output", output: `${"y".repeat(400 * 1024)}中文` } });
    const pending = JSON.stringify({ timestamp: "3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "finished" }] } });
    const split = Math.floor(pending.length / 2);
    const complete = leadingNoise + recentMessages + trailingNoise;
    writeFileSync(path, complete + pending.slice(0, split));

    const first = readCodexMessages(path);
    expect(first.truncated).toBeTrue();
    expect(first.messages).toEqual([
      { role: "user", text: "take over here", ts: "1" },
      { role: "assistant", text: "still running", ts: "2" },
    ]);
    expect(first.offset).toBe(Buffer.byteLength(complete));

    appendFileSync(path, `${pending.slice(split)}\n`);
    const next = readCodexMessages(path, first.offset);
    expect(next).toEqual({
      messages: [{ role: "assistant", text: "finished", ts: "3" }],
      offset: Buffer.byteLength(`${complete}${pending}\n`),
      truncated: false,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trailing tool row above every semantic budget does not hide preceding messages or poison the next offset", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-codex-large-tail-")), path = join(root, "rollout.jsonl");
  try {
    const prefix = [
      line({ timestamp: "1", type: "event_msg", payload: { type: "user_message", message: "before huge row" } }),
      line({ timestamp: "2", type: "event_msg", payload: { type: "agent_message", message: "still visible" } }),
    ].join("");
    const huge = line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(20 * 1024 * 1024) } });
    writeFileSync(path, prefix + huge);
    const first = readCodexMessages(path);
    expect(first.messages).toEqual([{ role: "user", text: "before huge row", ts: "1" }, { role: "assistant", text: "still visible", ts: "2" }]);
    expect(first.offset).toBe(Buffer.byteLength(prefix + huge));
    appendFileSync(path, line({ timestamp: "3", type: "event_msg", payload: { type: "agent_message", message: "after huge row" } }));
    expect(readCodexMessages(path, first.offset).messages).toEqual([{ role: "assistant", text: "after huge row", ts: "3" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
