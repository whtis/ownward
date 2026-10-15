// 项目记忆摘要：角色「读得到整个项目的记忆」靠它——README 空骨架要跳过、日志要新的在前、预算要守住
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasEntries, isSkeletonReadme, parseLogEntries, projectMemoryDigest, projectReadmeSkeleton } from "./project-knowledge.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function base(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ownward-pk-")));
  roots.push(root);
  const b = join(root, "projects");
  mkdirSync(b);
  return b;
}
const entry = (time: string, title: string, problem: string, solution: string) =>
  `## ${time} | ownward | ${title}\n- **Problem**: ${problem}\n- **Solution**: ${solution}\n- **Files**: src/x.ts\n\n`;

describe("README 骨架判定", () => {
  test("收割建的骨架是空模板；写了任何一句实质内容就不是", () => {
    const sk = projectReadmeSkeleton("ownward", "work", "2026-10-14");
    expect(isSkeletonReadme(sk)).toBe(true);
    expect(isSkeletonReadme(sk.replace("## 已知陷阱\n", "## 已知陷阱\n- 端口 4517 写死在客户端\n"))).toBe(false);
    expect(hasEntries("---\ntype: role_principles\n---\n\n# 原则\n\n> 一条一行\n")).toBe(false);
    expect(hasEntries("# 原则\n- 证据优先")).toBe(true);
  });
});

describe("工作日志解析", () => {
  test("按 ## 切条目，新的在前；Problem / Solution / Failed attempt 各归各位", () => {
    const text = "---\ntype: x\n---\n" + entry("09:00", "旧的", "p1", "s1")
      + "## 10:30 | ownward | 新的\n- **Problem**: p2\n- **Failed attempt**: 试了 A 不行\n- **Solution**: s2\n";
    const list = parseLogEntries("2026-10", text);
    expect(list.map((e) => e.head)).toEqual(["10:30 新的", "09:00 旧的"]);
    expect(list[0]).toMatchObject({ month: "2026-10", problem: "p2", solution: "s2", failed: "试了 A 不行" });
  });
});

describe("projectMemoryDigest", () => {
  test("空骨架 README 不注入原文；日志、决策、其它文档都进来，日志新的在前", () => {
    const b = base(), dir = join(b, "ownward");
    mkdirSync(join(dir, "log"), { recursive: true });
    writeFileSync(join(dir, "README.md"), projectReadmeSkeleton("ownward", "", "2026-10-14"));
    writeFileSync(join(dir, "decisions.md"), "# 项目决策\n- DECISION_MARKER 用 bun 不用 node\n");
    writeFileSync(join(dir, "复盘-20260809.md"), "# 复盘\n很长的内容 SHOULD_NOT_INLINE");
    writeFileSync(join(dir, "log", "2026-09.md"), entry("08:00", "九月的事", "SEPT_PROBLEM", "SEPT_SOLUTION"));
    writeFileSync(join(dir, "log", "2026-10.md"), entry("09:00", "十月早", "OCT1", "OCT1_S") + entry("18:00", "十月晚", "OCT2", "OCT2_S"));
    const d = projectMemoryDigest(b, "ownward", { budget: 6000, label: "主项目记忆" });
    expect(d.startsWith("### 主项目记忆：ownward")).toBe(true);
    expect(d).not.toContain("人和 AI 共同维护");          // 骨架占位行不进
    expect(d).toContain("DECISION_MARKER");
    expect(d).toContain("复盘-20260809.md");               // 其它文档只列名字
    expect(d).not.toContain("SHOULD_NOT_INLINE");
    expect(d.indexOf("OCT2")).toBeLessThan(d.indexOf("OCT1"));
    expect(d.indexOf("OCT1")).toBeLessThan(d.indexOf("SEPT_PROBLEM"));
    expect(d).not.toContain(dir);                           // 没要 pointer 就不暴露磁盘路径
    expect(projectMemoryDigest(b, "ownward", { budget: 6000, label: "x", pointer: true })).toContain(`${dir}/`);
  });

  test("预算守得住：日志再多也只装到预算为止", () => {
    const b = base(), dir = join(b, "busy");
    mkdirSync(join(dir, "log"), { recursive: true });
    writeFileSync(join(dir, "log", "2026-10.md"), Array.from({ length: 60 }, (_, i) => entry(`10:${String(i).padStart(2, "0")}`, `任务${i}`, "问题".repeat(60), "结论".repeat(100))).join(""));
    const d = projectMemoryDigest(b, "busy", { budget: 1500, label: "项目记忆" });
    expect(d.length).toBeLessThan(1700);
    expect(d).toContain("任务59");                          // 最新的那条一定在
  });

  test("什么都没有就空串；只有空骨架时如实说一句", () => {
    const b = base();
    expect(projectMemoryDigest(b, "ghost", { budget: 1000, label: "项目记忆" })).toBe("");
    mkdirSync(join(b, "empty"));
    expect(projectMemoryDigest(b, "empty", { budget: 1000, label: "项目记忆" })).toBe("");
    writeFileSync(join(b, "empty", "README.md"), projectReadmeSkeleton("empty", "", "2026-10-14"));
    expect(projectMemoryDigest(b, "empty", { budget: 1000, label: "项目记忆" })).toContain("README 还是空模板");
  });

  test("项目目录是指到外面的软链：一个字都不读", () => {
    const b = base();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ownward-pk-outside-")));
    roots.push(outside);
    writeFileSync(join(outside, "README.md"), "OUTSIDE_SECRET");
    symlinkSync(outside, join(b, "evil"));
    expect(projectMemoryDigest(b, "evil", { budget: 1000, label: "项目记忆" })).toBe("");
    expect(projectMemoryDigest(b, "../x", { budget: 1000, label: "项目记忆" })).toBe("");
  });
});
