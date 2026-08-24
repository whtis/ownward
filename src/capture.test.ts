// 收割条目幂等覆盖的纯逻辑单测。
// 修的 bug：多轮任务每次重收都追加一条，同一个任务在工作日志里留下几条互相矛盾的记录
// （第一条停在第 3 分钟的「还在读代码」，最后一条才是真结果）——取材时先看到哪条全凭运气。
// 覆盖语义：按 key 找到旧条目整块换掉；找不到 key、或 key 不在任何 `## ` 块里，都退化成追加。
import { describe, expect, test } from "bun:test";
import { upsertEntry } from "./capture.ts";

const HEAD = "---\ndate: 2026-08-11\nscope: work\ntype: inbox\n---\n\n# 2026-08-11\n\n";

function entry(id: string, title: string, solution: string): string {
  return [
    `## 11:53 | open-webui-deepoffer | ${title}`,
    `- **Problem**: 修拒答`,
    `- **Solution**: ${solution}`,
    `- 来源: ownward 任务 \`${id}\`（claude-bg）· 收割于 18:35`,
    "", "",
  ].join("\n");
}

describe("upsertEntry", () => {
  test("key 不存在时追加，原内容一字不动", () => {
    const before = HEAD + entry("20260811-aaaa", "别人的任务", "改了别的");
    const out = upsertEntry(before, "`20260811-63ka`", entry("20260811-63ka", "修拒答", "合 integration"));
    expect(out.startsWith(before)).toBe(true);
    expect(out).toContain("修拒答");
    expect(out).toContain("别人的任务");
  });

  test("key 存在时整块覆盖，条目数不增加", () => {
    const stale = HEAD + entry("20260811-63ka", "熟悉项目", "纯只读探索，发现两处潜在问题");
    const out = upsertEntry(stale, "`20260811-63ka`", entry("20260811-63ka", "修拒答", "合 integration 并部署"));
    expect(out).toContain("合 integration 并部署");
    expect(out).not.toContain("纯只读探索");
    expect(out.match(/^## /gm)?.length).toBe(1);
  });

  test("覆盖中间那条时前后邻居完好", () => {
    const before = HEAD + entry("20260811-aaaa", "前一条", "A")
      + entry("20260811-63ka", "旧的中间条", "旧内容")
      + entry("20260811-zzzz", "后一条", "Z");
    const out = upsertEntry(before, "`20260811-63ka`", entry("20260811-63ka", "新的中间条", "新内容"));
    expect(out.match(/^## /gm)?.length).toBe(3);
    expect(out).toContain("前一条");
    expect(out).toContain("后一条");
    expect(out).toContain("新内容");
    expect(out).not.toContain("旧内容");
    // 顺序保持：覆盖是就地替换，不是删了再追加到末尾
    expect(out.indexOf("前一条")).toBeLessThan(out.indexOf("新的中间条"));
    expect(out.indexOf("新的中间条")).toBeLessThan(out.indexOf("后一条"));
  });

  test("覆盖最后一条后文件仍以空行收尾（下一条追加不会粘上来）", () => {
    const before = HEAD + entry("20260811-aaaa", "前一条", "A") + entry("20260811-63ka", "末条", "旧");
    const out = upsertEntry(before, "`20260811-63ka`", entry("20260811-63ka", "末条", "新"));
    expect(out.endsWith("\n\n")).toBe(true);
    const next = out + entry("20260811-zzzz", "再来一条", "Z");
    expect(next.match(/^## /gm)?.length).toBe(3);
  });

  test("key 不在任何 ## 块里（文件被手改坏）时按追加处理，不乱剪", () => {
    const weird = "---\ndate: 2026-08-11\n---\n\n# 2026-08-11\n\n随手写的一行 `20260811-63ka` 提到了任务 id\n\n";
    const out = upsertEntry(weird, "`20260811-63ka`", entry("20260811-63ka", "修拒答", "S"));
    expect(out.startsWith(weird)).toBe(true);
    expect(out).toContain("随手写的一行");
  });

  test("frontmatter 与日期标题不会被当成条目块吃掉", () => {
    const stale = HEAD + entry("20260811-63ka", "旧", "旧");
    const out = upsertEntry(stale, "`20260811-63ka`", entry("20260811-63ka", "新", "新"));
    expect(out.startsWith(HEAD)).toBe(true);
  });
});

// ---- 按触达仓库分流：在私人终端整场改工作项目，不能按 cwd 归私人 ----
import { pathsInToolUse, repoNameOf, resolveScope, type RepoTouch } from "./capture.ts";
import { scopeForRemoteText } from "./paths.ts";

describe("scopeForRemoteText", () => {
  test("含匹配串 = work；含排除串仍是 private；不含匹配串 = private", () => {
    const ex = ["example-org/ownward"];
    expect(scopeForRemoteText("origin\tgit@github.com:example-org/work-app.git (fetch)", "example-org", ex)).toBe("work");
    expect(scopeForRemoteText("origin\tgit@github.com:example-org/ownward.git (fetch)", "example-org", ex)).toBe("private");
    expect(scopeForRemoteText("origin\tgit@github.com:reader/personal-tool.git (fetch)", "example-org", ex)).toBe("private");
    expect(scopeForRemoteText("", "example-org", ex)).toBe("private");
  });
});

describe("pathsInToolUse", () => {
  test("Edit/Read 的 file_path 与 Bash 命令里的绝对路径都抽得出来，相对路径和噪声不算", () => {
    expect(pathsInToolUse({ file_path: "/Users/example/workspace/sample-app/app/agent/x.go" }))
      .toEqual(["/Users/example/workspace/sample-app/app/agent/x.go"]);
    expect(pathsInToolUse({ command: "cd /Users/example/workspace/sample-app && go test ./... && cat ~/.codebuddy/settings.json" }))
      .toEqual(["/Users/example/workspace/sample-app", `${process.env.HOME}/.codebuddy/settings.json`]);
    expect(pathsInToolUse({ command: "ls -la && git status" })).toEqual([]);
    expect(pathsInToolUse("not an object")).toEqual([]);
    expect(pathsInToolUse({ pattern: "foo", path: "relative/dir" })).toEqual([]);
  });
});

describe("repoNameOf", () => {
  test("优先远程 URL 最后一段（去 .git），没远程用目录名；worktree 目录名不算数", () => {
    expect(repoNameOf("/x/sample-app-worktrees/feat-codebuddy", "origin\tgit@github.com:example-org/sample-app.git (fetch)\norigin\tgit@github.com:example-org/sample-app.git (push)")).toBe("sample-app");
    expect(repoNameOf("/x/Foo", "origin\thttps://github.com/acme/Foo (fetch)")).toBe("foo");
    expect(repoNameOf("/x/local-only", "")).toBe("local-only");
  });
});

describe("resolveScope", () => {
  const touch = (name: string, scope: "work" | "private", touches: number): RepoTouch => ({ name, root: `/r/${name}`, scope, touches });
  test("私人 cwd 但主导仓库是工作且触达压倒（≥3 且 ≥2×）→ 归工作、slug 用仓库名", () => {
    const r = resolveScope("private", "personal-tool", "/r/personal-tool", [touch("work-app", "work", 40), touch("personal-tool", "private", 2)]);
    expect(r).toEqual({ scope: "work", slug: "work-app", repos: ["work-app", "personal-tool"] });
  });
  test("触达不够压倒（只碰了两下工作仓库）→ 沿用 cwd 判定（宁可漏进公司文档，不能错进）", () => {
    const r = resolveScope("private", "personal-tool", "/r/personal-tool", [touch("work-app", "work", 2)]);
    expect(r.scope).toBe("private");
    expect(r.slug).toBe("personal-tool");
  });
  test("工作 cwd 但整场在改私人仓库 → 归私人", () => {
    const r = resolveScope("work", "work-app", "/r/work-app", [touch("ownward", "private", 9), touch("work-app", "work", 1)]);
    expect(r.scope).toBe("private");
    expect(r.slug).toBe("ownward");
  });
  test("cwd 不是仓库（~ / ~/workspace）时 slug 用主导仓库名，scope 不变", () => {
    const r = resolveScope("private", "home", null, [touch("sample-notes", "private", 5)]);
    expect(r).toEqual({ scope: "private", slug: "sample-notes", repos: ["sample-notes"] });
  });
  test("没触达任何仓库 → 原样", () => {
    expect(resolveScope("private", "home", null, [])).toEqual({ scope: "private", slug: "home", repos: [] });
  });
});
