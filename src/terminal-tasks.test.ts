// terminal 任务匹配启发式单测：给定任务 + CC 会话列表，验证选对/选不到/沉寂判定。
import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { ccIdFromTranscript } from "./cc-sessions.ts";
import { isCcSilent, matchTerminalCcSession, TERMINAL_SILENT_MS, type CcLite } from "./terminal-tasks.ts";

const cc = (id: string, cwd: string, mtime: number, firstUser = "", active = false): CcLite =>
  ({ id, cwd, firstUser, mtime, active });

describe("matchTerminalCcSession 确定性认领", () => {
  const started = "2026-07-22T10:00:00.000Z";
  const startedMs = new Date(started).getTime();
  const TASK = "检查测试环境中的示例服务为何无法启动";
  const task = { cwd: "/repo/foo", startedAt: started, task: TASK };

  test("首条 user == 任务原文 → 命中（即便不是 mtime 最新）", () => {
    const list = [
      cc("mine", "/repo/foo", startedMs + 10_000, TASK),                 // 我自己的会话，稍旧
      cc("other", "/repo/foo", startedMs + 90_000, "别的任务：随便写点啥"),   // 无关会话，更新
    ];
    expect(matchTerminalCcSession(task, list)?.id).toBe("mine");
  });

  test("首条 user 被截断（前缀相同）也认得出", () => {
    const truncated = TASK.slice(0, 40); // firstUser 截到较短
    expect(matchTerminalCcSession(task, [cc("a", "/repo/foo", startedMs + 5_000, truncated)])?.id).toBe("a");
  });

  test("多候选都不匹配任务文本 → 返回 null（不劫持无关会话）", () => {
    const list = [
      cc("x", "/repo/foo", startedMs + 90_000, "心跳任务 heartbeat"),
      cc("y", "/repo/foo", startedMs + 50_000, "把任务压成短标题"),
    ];
    expect(matchTerminalCcSession(task, list)).toBeNull();
  });

  test("单候选但文本不匹配 → 返回 null（不凑合，避免误配无关会话）", () => {
    // 任务原文已知就必须严格按文本认，不能劫持唯一的无关会话。
    expect(matchTerminalCcSession(task, [cc("solo", "/repo/foo", startedMs + 5_000, "envscrub 验证任务")])).toBeNull();
  });

  test("任务原文缺失（历史数据）+ 单候选 → 回退用它", () => {
    const noText = { cwd: "/repo/foo", startedAt: started };
    expect(matchTerminalCcSession(noText, [cc("solo", "/repo/foo", startedMs + 5_000, "任意")])?.id).toBe("solo");
  });

  test("cwd 不同不匹配", () => {
    expect(matchTerminalCcSession(task, [cc("a", "/repo/bar", startedMs + 60_000, TASK)])).toBeNull();
  });

  test("任务派发之前的旧会话（mtime<startedAt）不匹配", () => {
    expect(matchTerminalCcSession(task, [cc("a", "/repo/foo", startedMs - 60_000, TASK)])).toBeNull();
  });

  test("空 cwd / 非法 startedAt 返回 null", () => {
    expect(matchTerminalCcSession({ cwd: "", startedAt: started, task: TASK }, [cc("a", "", startedMs, TASK)])).toBeNull();
    expect(matchTerminalCcSession({ cwd: "/repo/foo", startedAt: "bad", task: TASK }, [cc("a", "/repo/foo", startedMs, TASK)])).toBeNull();
  });

  test("多文本命中取 mtime 最新（同一任务的续写会话）", () => {
    const list = [
      cc("old", "/repo/foo", startedMs + 10_000, TASK),
      cc("new", "/repo/foo", startedMs + 90_000, TASK),
    ];
    expect(matchTerminalCcSession(task, list)?.id).toBe("new");
  });
});

describe("isCcSilent 沉寂判定", () => {
  const now = 2_000_000_000_000;

  test("active 会话永不沉寂（即便很久没写）", () => {
    expect(isCcSilent(cc("a", "/x", now - 10 * TERMINAL_SILENT_MS, "", true), now)).toBe(false);
  });

  test("非 active 且超阈值 → 沉寂命中", () => {
    expect(isCcSilent(cc("a", "/x", now - TERMINAL_SILENT_MS - 1, "", false), now)).toBe(true);
  });

  test("非 active 但刚停（未超阈值）→ 不沉寂", () => {
    expect(isCcSilent(cc("a", "/x", now - TERMINAL_SILENT_MS + 1_000, "", false), now)).toBe(false);
  });
});

// ---- SessionStart 钩子上报的 transcript 路径反解（外来输入，必须防越界）----
describe("ccIdFromTranscript 钩子路径反解", () => {
  const P = join(homedir(), ".claude", "projects");

  test("正常 transcript 路径 → <hashDir>/<uuid>", () => {
    expect(ccIdFromTranscript(join(P, "-repo-foo", "abc-123.jsonl"))).toBe("-repo-foo/abc-123");
  });

  test("目录逃逸 → null（不是把上级路径当会话 id）", () => {
    expect(ccIdFromTranscript(join(P, "..", "evil", "x.jsonl"))).toBeNull();
  });

  test("projects 之外的路径 → null", () => {
    expect(ccIdFromTranscript("/tmp/x.jsonl")).toBeNull();
  });

  test("不是 jsonl / 少一层目录 / 空串 → null", () => {
    expect(ccIdFromTranscript(join(P, "-repo-foo", "abc.txt"))).toBeNull();
    expect(ccIdFromTranscript(join(P, "abc.jsonl"))).toBeNull();
    expect(ccIdFromTranscript("")).toBeNull();
  });
});
