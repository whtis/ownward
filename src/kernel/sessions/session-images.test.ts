import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionRepository } from "../../sessions/repository.ts";
import { stageRunnerAttachment } from "../../runner/attachments.ts";
import { RunnerCommandJournal } from "../../runner/journals.ts";
import { KernelSessionService } from "./service.ts";
import { readSessionImage, sessionImageIndexStatsForTest } from "./session-images.ts";

const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "ownward-session-image-")); roots.push(root); return root; };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
afterEach(() => { sessionImageIndexStatsForTest(true); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function command(root: string, sessionId: string, id: string, text = "look") {
  const blob = stageRunnerAttachment(root, PNG.toString("base64"));
  const input = JSON.stringify({ text, images: [{ mediaType: "image/png", blob }], cwd: root, options: {} });
  return { blob, record: new RunnerCommandJournal(root).accept({ commandId: id, runId: `${id}-run`, kind: "start-run", sessionId, providerId: "claude", input }).record };
}

describe("session-scoped Runner upload images", () => {
  test("projects current and predecessor uploads as safe URLs without leaking blobs", async () => {
    const root = fresh(), cwd = join(root, "repo"), repo = new SessionRepository(root); mkdirSync(cwd);
    const first = repo.reserve({ taskId: "task", providerId: "claude", cwd });
    const old = command(root, first.id, "old-command", "old image");
    const current = repo.handoff({ taskId: "task", expectedSessionId: first.id, providerId: "codex", reason: "quota" }).current;
    const now = command(root, current.id, "new-command", "new image");
    const state = await new KernelSessionService(root).state("task"), users = state.messages.filter((message) => message.role === "user");
    expect(users.map((message) => message.images)).toEqual([
      [`/api/session-image/${first.id}/${old.blob.sha256}`],
      [`/api/session-image/${current.id}/${now.blob.sha256}`],
    ]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(PNG.toString("base64"));
    expect(serialized).not.toContain("attachments/");
    expect(serialized).not.toContain("runner/");
  });

  test("denies cross-session lookup and rejects mode, hash, bytes, and MIME tampering", () => {
    const root = fresh(), one = command(root, "session-one", "image-command"), file = join(root, "runner", one.blob.ref);
    expect(readSessionImage(root, "session-one", one.blob.sha256)).toMatchObject({ mime: "image/png", bin: PNG });
    expect(readSessionImage(root, "session-two", one.blob.sha256)).toBeNull();

    chmodSync(file, 0o644);
    expect(readSessionImage(root, "session-one", one.blob.sha256)).toBeNull();
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, "utf8") + "A");
    expect(readSessionImage(root, "session-one", one.blob.sha256)).toBeNull();

    const other = fresh(), bad = stageRunnerAttachment(other, PNG.toString("base64"));
    new RunnerCommandJournal(other).accept({ commandId: "mime-command", runId: "mime-run", kind: "start-run", sessionId: "mime-session", providerId: "claude", input: JSON.stringify({ text: "x", images: [{ mediaType: "image/svg+xml", blob: bad }] }) });
    expect(readSessionImage(other, "mime-session", bad.sha256)).toBeNull();
  });

  test("reuses a bounded journal index for misses and invalidates it after append", () => {
    const root = fresh(), missing = "a".repeat(64); sessionImageIndexStatsForTest(true);
    for (let i = 0; i < 20; i++) expect(readSessionImage(root, "random-session", missing)).toBeNull();
    expect(sessionImageIndexStatsForTest().builds).toBe(1);
    const added = command(root, "late-session", "late-command");
    expect(readSessionImage(root, "late-session", added.blob.sha256)?.bin).toEqual(PNG);
    expect(sessionImageIndexStatsForTest().builds).toBe(2);
  });
});
