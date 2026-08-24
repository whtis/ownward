// 审批规则归纳的单测：codex review 查出 pattern 粒度太粗（force-push 归并进普通 push）
// 和高危正则有洞（rm -rf . / rm -rf -- / / git -C push 绕过），这里锁死修复后的行为。
import { describe, expect, test } from "bun:test";
import { patternFor } from "./approval.ts";

const p = (command: string) => patternFor("Bash", { command });

describe("patternFor bash 高危归纳", () => {
  test("force-push 单独成规则，不和普通 push 归并", () => {
    expect(p("git push origin feature").pattern).toBe("git push");
    expect(p("git push --force origin main").pattern).toBe("git push --force");
    expect(p("git push -f origin main").pattern).toBe("git push --force");
    expect(p("git push --force-with-lease").pattern).toBe("git push --force");
    // 关键：普通 push 与 force-push 归到不同 pattern（否则「总是批准 push」会顺带放行 force-push）
    expect(p("git push origin x").pattern).not.toBe(p("git push --force origin x").pattern);
  });

  test("git 中间夹 -C <dir> 的 push 也识别为高危", () => {
    expect(p("git -C ../repo push").pattern).toBe("git push");
    expect(p("git -C /tmp/x push --force").pattern).toBe("git push --force");
  });

  test("rm -rf 各种变体都归到 rm -rf", () => {
    for (const c of ["rm -rf /tmp/x", "rm -rf .", "rm -rf -- /", "rm -fr build", "rm -Rf dir"]) {
      expect(p(c)).toEqual({ kind: "bash", pattern: "rm -rf" });
    }
  });

  test("其它高危关键词归到自身", () => {
    expect(p("sudo systemctl restart x").pattern).toBe("sudo");
    expect(p("launchctl kickstart -k y").pattern).toBe("launchctl");
  });

  test("非高危 bash：子命令工具取二级词，普通命令取首词", () => {
    expect(p("npm install lodash")).toEqual({ kind: "bash", pattern: "npm install" });
    expect(p("git status")).toEqual({ kind: "bash", pattern: "git status" });
    expect(p("ls -la").pattern).toBe("ls");
  });

  test("非 Bash 工具：pattern 取工具名", () => {
    expect(patternFor("WebFetch", { url: "https://x" })).toEqual({ kind: "tool", pattern: "WebFetch" });
  });
});
