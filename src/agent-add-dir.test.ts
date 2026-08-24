import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { adoptEngineSession, addEngineDir, buildClaudeArgs, engineOpts } from "./agent-session.ts";
import { DATA, cfg } from "./util.ts";

const taskId = `test-add-dir-${process.pid}`;
const saved = join(DATA, "tasks", `${taskId}.session.json`);

afterAll(() => { try { unlinkSync(saved); } catch { /* no-op */ } });

describe("Claude 会话追加目录", () => {
  test("下一轮 resume 参数携带真正的 --add-dir", () => {
    const args = buildClaudeArgs({ extraDirs: ["/tmp/project two"] }, "session-1", true);
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/tmp/project two"]);
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "session-1"]);
  });

  test("追加目录写入 session json，重复目录去重", () => {
    const previous = cfg.architecture.sessionRunnerMode; cfg.architecture.sessionRunnerMode = "off";
    adoptEngineSession(taskId, "/tmp", "/tmp/test.log", "session-1", []);
    addEngineDir(taskId, "/tmp/other");
    addEngineDir(taskId, "/tmp/other");
    expect(engineOpts(taskId).extraDirs).toEqual(["/tmp/other"]);
    expect(JSON.parse(readFileSync(saved, "utf8")).opts.extraDirs).toEqual(["/tmp/other"]);
    cfg.architecture.sessionRunnerMode = previous;
  });
});
