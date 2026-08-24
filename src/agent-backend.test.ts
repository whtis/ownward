import { describe, expect, test } from "bun:test";
import { buildResume } from "./agent-backend.ts";

describe("buildResume", () => {
  test("生成 Claude 原生恢复命令", () => {
    expect(buildResume({ sessionId: "session-1", cwd: "/tmp/my project" })).toEqual({
      id: "session-1",
      tool: "claude",
      cmd: "cd '/tmp/my project' && claude --resume session-1",
    });
  });

  test("安全引用包含单引号的 cwd", () => {
    expect(buildResume({ sessionId: "session-2", cwd: "/tmp/alice's repo" })?.cmd)
      .toBe("cd '/tmp/alice'\"'\"'s repo' && claude --resume session-2");
  });

  test("生成备用 CODEX_HOME 的恢复命令", () => {
    expect(buildResume({ rolloutId: "rollout-1", home: "codex-alt", cwd: "/tmp/repo" })?.cmd)
      .toBe("cd '/tmp/repo' && CODEX_HOME=\"$HOME/.codex-alt\" codex resume 'rollout-1'");
    expect(buildResume({rolloutId:"x`touch /tmp/pwn`",home:"codex",cwd:"/tmp"})?.cmd).toContain("'x`touch /tmp/pwn`'");
  });
});
