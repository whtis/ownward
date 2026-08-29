// 「按分支」视图：截取 tasks.js 里的纯分组函数直接执行（同 web-tasks-status.test.ts 的姿势），
// 再用源码契约断言把 前端分组 ↔ 后端 branch 字段 的链路钉住。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "tasks.js"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server.ts"), "utf8");
const workbenchSource = readFileSync(join(import.meta.dir, "..", "src", "workbench.ts"), "utf8");

const slice = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
const body = [
  slice("const tkNorm =", "\nTABS.tasks = {"),
  slice("/* ---- 左列 ---- */", "function pinBtnHtml("),
  slice("function externalSessions(", "/* ---- 最近会话视图"),
  slice("function tkBranchRows(", "function tkBranchViewHtml("),
  "\nreturn { tkBranchRows, tkBranchTree, tkWorktreeProjects, tkBranchNodes };",
].join("\n");

function setupTasks() {
  return {
    branchWts: [
      { branch: "feat/a", project: "wt-only", dir: "/w/wt-only", path: "/w/wt-only", isMain: true },        // feat/a 已有任务的项目之外，还有个纯 worktree 项目
      { branch: "feat/a", project: "gone-proj", dir: "/w/gone", path: "/w/gone", isMain: false },           // 已隐藏项目的 worktree → 不出现
      { branch: "feat/c", project: "fresh", dir: "/w/fresh", path: "/w/fresh", isMain: true },              // 纯 worktree 分支：没有任何任务
      { branch: "feat/d", project: "gone-proj", dir: "/w/gone", path: "/w/gone", isMain: true },            // 纯 worktree 分支但项目已隐藏 → 连节点都不出
    ],
    pinned: [{ kind: "task", ref: "pin-task" }, { kind: "cc", ref: "pin-cc" }],
    dismissed: { "gone-proj": Date.parse("2026-08-07T00:00:00Z") },
    ccList: [
      { id: "pin-cc", project: "web", mtime: 1, active: true, title: "p" },
      { id: "cc1", project: "web", branch: "feat/a", mtime: Date.parse("2026-08-01T00:00:00Z"), active: false, title: "s", firstUser: "" },
    ],
  };
}

function setup() {
  const Tasks = setupTasks();
  const S = { tasks: [
    { id: "pin-task", project: "web", branch: "feat/a", startedAt: "2026-08-06T00:00:00Z", status: "done" },  // 置顶 → 只进置顶区
    { id: "t1", project: "web", branch: "feat/a", startedAt: "2026-08-05T00:00:00Z" },
    { id: "t2", project: "api", branch: "feat/a", startedAt: "2026-08-06T00:00:00Z" },
    { id: "t3", project: "api", branch: "", startedAt: "2026-08-07T00:00:00Z" },                              // 无分支
    { id: "t4", project: "gone-proj", branch: "feat/b", startedAt: "2026-08-04T00:00:00Z" },                  // 隐藏项目的旧活动
    { id: "t5", project: "gone-proj", branch: "feat/b", startedAt: "2026-08-08T00:00:00Z" },                  // 新活动 → 自动回来
    { id: "r1", kind: "routine", project: "x", branch: "", startedAt: "2026-08-08T00:00:00Z" },               // routine 代笔不进树
  ] };
  return new Function("Tasks", "S", body)(Tasks, S) as {
    tkBranchRows(): any[];
    tkBranchTree(rows: any[]): [string, any][];
    tkWorktreeProjects(branch: string): Map<string, { path: string; dir: string }[]>;
    tkBranchNodes(tree: [string, any][]): [string, any][];
  };
}

describe("branch view grouping", () => {
  test("same branch across projects merges into one requirement node with per-project rows", () => {
    const { tkBranchRows, tkBranchTree } = setup();
    const rows = tkBranchRows();
    expect(rows.map((r) => `${r.type}:${r.t?.id || r.s?.id}`)).toEqual(["task:t1", "task:t2", "task:t3", "task:t5", "cc:cc1"]);
    const tree = tkBranchTree(rows);
    expect(tree.map(([branch]) => branch)).toEqual(["feat/b", "feat/a", ""]);   // 最新活动倒序；无分支垫底
    const featA = tree.find(([b]) => b === "feat/a")![1];
    expect([...featA.projects.keys()]).toEqual(["web", "api"]);                 // 跨仓库归同一需求
    expect(featA.projects.get("web")!.map((r: any) => r.t?.id || r.s?.id)).toEqual(["t1", "cc1"]);   // 组内时间倒序（cc mtime 更老）
  });

  test("dismissed project stays hidden until newer activity; pinned and routine rows stay out", () => {
    const { tkBranchRows, tkBranchTree } = setup();
    const tree = tkBranchTree(tkBranchRows());
    const featB = tree.find(([b]) => b === "feat/b")![1];
    expect(featB.projects.get("gone-proj")!.map((r: any) => r.t.id)).toEqual(["t5"]);   // t4（旧活动）被隐藏
    const allIds = tkBranchRows().map((r: any) => r.t?.id || r.s?.id);
    expect(allIds).not.toContain("pin-task");
    expect(allIds).not.toContain("pin-cc");
    expect(allIds).not.toContain("r1");
  });

  test("view switch chip persists through ownward-tasks-view and renders the shared pinned section", () => {
    expect(source).toContain('id="tk-v-branch"');
    expect(source).toContain('$("#tk-v-branch").addEventListener("click", () => tkSetView("branch"))');
    expect(source).toContain('localStorage.getItem("ownward-tasks-view")');
    expect(source).toContain('localStorage.setItem("ownward-tasks-view", v)');
    expect(source).toContain('if (tkView === "branch") { el.innerHTML = tkBranchViewHtml(); return; }');
    expect(slice("function tkBranchViewHtml(", "/** 置顶区")).toContain("tkPinnedHtml()");
  });

  test("worktree-only projects join existing requirement nodes; dismissed projects stay out", () => {
    const { tkBranchTree, tkBranchRows, tkWorktreeProjects } = setup();
    const tree = tkBranchTree(tkBranchRows());   // 行分组不受 worktree 数据影响
    const featA = tree.find(([b]) => b === "feat/a")![1];
    expect([...featA.projects.keys()]).toEqual(["web", "api"]);
    expect([...tkWorktreeProjects("feat/a").keys()]).toEqual(["wt-only"]);   // 仅 worktree 的项目并进节点；已隐藏的 gone-proj 不出
  });

  test("pure-worktree branches become requirement nodes pinned below active ones and before no-branch", () => {
    const { tkBranchTree, tkBranchRows, tkBranchNodes } = setup();
    expect(tkBranchNodes(tkBranchTree(tkBranchRows())).map(([b]) => b)).toEqual(["feat/b", "feat/a", "feat/c", ""]);
  });

  test("backend exposes the branch→worktree map and the frontend merges it into the view", () => {
    expect(workbenchSource).toContain('if (p === "/api/branches") return json({ worktrees: await branchWorktrees() });');
    expect(source).toContain('getJSON("/api/branches")');
    expect(source).toContain("if (bw) Tasks.branchWts = bw.worktrees || [];");   // 分支视图消费 worktree 映射
    expect(serverSource).toContain("withBranches");   // 既有链路仍在
  });

  test("view renders 仅 worktree placeholder rows and task-less requirement nodes", () => {
    const viewBody = [
      slice("const tkNorm =", "\nTABS.tasks = {"),
      slice("/* ---- 左列 ---- */", "function pinBtnHtml("),
      slice("function externalSessions(", "/* ---- 最近会话视图"),
      slice("function tkBranchRows(", "/** 置顶区"),
    ].join("\n");
    const esc = (s: any) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const render = new Function("Tasks", "S", "tkExpanded", "esc", "jsq", "ageText", "stateBox", "tkPinnedHtml", "taskCardHtml", "ccRowHtml",
      viewBody + "\nreturn tkBranchViewHtml();");
    const html = render(setupTasks(), { tasks: [] }, new Set(["br:feat/a"]), esc, (s: any) => String(s).replace(/'/g, "\\'"), () => "",
      (m: string) => `<div class="state">${m}</div>`, () => "", () => "", () => "") as string;
    expect(html).toContain("仅 worktree");                        // wt-only 占位行（feat/a 已展开）
    expect(html).toContain("/w/wt-only");                        // worktree 路径可见
    expect(html).toContain("feat/c");                            // 纯 worktree 分支也生成需求节点
    expect(html).not.toContain("feat/d");                        // 只剩已隐藏项目的分支不出节点
    expect(html.indexOf(">feat/b<")).toBeLessThan(html.indexOf(">feat/a<"));   // 有活动的按最新活动倒序
    expect(html.indexOf(">feat/c<")).toBeGreaterThan(html.indexOf(">feat/a<"));  // 纯 worktree 分支垫其后
    expect(html).not.toContain("/w/gone");                       // 已隐藏项目的 worktree 不出现
  });

  test("backend attaches branch to tasks and observed sessions for the grouping", () => {
    expect(serverSource).toContain('json(await withBranches(loadTasks().slice(-30).reverse()))');
    expect(serverSource).toContain('broadcast("tasks", await withBranches(loadTasks().slice(-30).reverse()))');
    expect(workbenchSource).toContain("await withBranches(all.map((meta: any) => devObservationDto(meta)))");
    expect(source).toContain("t.branch || \"\"");   // 分支视图消费后端 branch 字段
  });
});
