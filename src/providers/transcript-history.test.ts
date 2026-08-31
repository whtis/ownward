import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCodexTranscript } from "./transcript-history.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("Codex transcript history shares current-frame decoding and variant deduplication", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-codex-history-"));
  const id = "00000000-0000-4000-8000-000000000148";
  const sessions = join(root, ".codex", "sessions", "2026", "08", "30");
  const path = join(sessions, "rollout.jsonl");
  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path, [
      line({ type: "session_meta", payload: { id } }),
      line({ timestamp: "1", type: "event_msg", payload: { type: "user_message", message: "legacy user" } }),
      line({ timestamp: "1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "legacy user" }] } }),
      line({ timestamp: "2", type: "event_msg", payload: { type: "agent_message", message: "legacy assistant" } }),
      line({ timestamp: "2.001", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "legacy assistant" }] } }),
      line({ timestamp: "3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "current only" }] } }),
    ].join(""));

    expect(readCodexTranscript(id, undefined, root)).toEqual([
      { role: "user", text: "legacy user", ts: "1" },
      { role: "assistant", text: "legacy assistant", ts: "2" },
      { role: "assistant", text: "current only", ts: "3" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex transcript recovers visible messages before a trailing row above every semantic budget", () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-codex-history-large-tail-")), id = "00000000-0000-4000-8000-000000000149";
  const sessions = join(root, ".codex", "sessions", "2026", "08", "30"), path = join(sessions, "rollout.jsonl");
  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path, [
      line({ type: "session_meta", payload: { id } }),
      line({ timestamp: "1", type: "event_msg", payload: { type: "user_message", message: "before huge row" } }),
      line({ timestamp: "2", type: "event_msg", payload: { type: "agent_message", message: "still visible" } }),
      line({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(20 * 1024 * 1024) } }),
    ].join(""));
    expect(readCodexTranscript(id, undefined, root)).toEqual([
      { role: "user", text: "before huge row", ts: "1" },
      { role: "assistant", text: "still visible", ts: "2" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
