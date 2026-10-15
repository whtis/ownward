// 根目录（不是仓库）里干的活归哪个领域角色：收割端的接线。
// 修的问题：~/workspace、~ 下派的任务/开的会话（飞书文档、手机运维、本机排障…）一律按目录名记进
// private/projects/workspace 或 tis——2026-10 生产数据 64 条，其中约 32 条是工作的事落在私人里，
// 晨会/周报取材看不到，也没有哪个角色读得到。
// 子进程跑：harvestTask 要真的走 llm.ts（mock 掉）、paths.ts（临时 vault + 分流开着）这一整条路径。
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const src = import.meta.dir;

type Read = (...p: string[]) => string;
async function run(script: string, check: (out: any, read: Read) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "ownward-domain-attr-"));
  const data = join(root, "data"), vault = join(root, "vault"), workspace = join(root, "workspace");
  await mkdir(data); await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({ vault: { root: vault, workRemoteMatch: "acme-corp" } }));
  await writeFile(join(data, "task.log"), "用户：云客手机老是半夜重启\n助手：查了 adb logcat，是企业组件的定时策略\n".repeat(20));
  const body = `
    import { mock } from "bun:test";
    const prompts = [];
    let classify = { roleId: "domain-device-ops", confidence: "high", candidates: [], why: "云客手机" };
    let summaries = 0;
    mock.module(${JSON.stringify(join(src, "llm.ts"))}, () => ({ llmJson: async (p) => {
      prompts.push(p);
      if (p.includes("挑接手的「领域角色」")) return classify;
      // 每次重收的素材不同，总结也不同（同一段总结在 30 分钟缓存里只会判出同一个结果）
      summaries++;
      return { title: "云客手机重启排查", problem: "手机半夜重启", solution: "关掉企业组件的定时重启策略" + (summaries > 1 ? \`（第 \${summaries} 轮）\` : "") };
    } }));
    const RA = await import(${JSON.stringify(join(src, "role-auto.ts"))});
    const { harvestTask } = await import(${JSON.stringify(join(src, "harvest.ts"))});
    for (const [name, scope, slug] of [["手机设备运维", "work", "device-ops"], ["业务运营", "work", "biz-ops"], ["个人投资与生活", "private", "invest-life"]]) {
      const r = RA.ensureDomainRole({ name, scope, slug });
      if (!r.ok) throw new Error(r.msg);
    }
    const task = (id, extra = {}) => ({
      id, project: "workspace", projectDir: ${JSON.stringify(workspace)}, cwd: ${JSON.stringify(workspace)},
      task: "云客手机老是半夜重启", mode: "claude-bg", status: "exited", exitCode: 0,
      startedAt: "2026-10-14T03:00:00.000Z", logFile: ${JSON.stringify(join(data, "task.log"))}, ...extra,
    });
    ${script}
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", body], {
      cwd: join(src, ".."),
      env: { ...process.env, OWNWARD_SOURCE_ROOT: join(src, ".."), OWNWARD_CONFIG_ROOT: root, OWNWARD_DATA_ROOT: data, OWNWARD_BUILD_IDENTITY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    const read: Read = (...p) => { const f = join(vault, ...p); return existsSync(f) ? readFileSync(f, "utf8") : ""; };
    // 断言要在清理临时 vault 之前跑完
    check(JSON.parse(stdout.trim().split("\n").at(-1) || "{}"), read);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("根目录任务没带角色：按总结内容归到有把握的领域角色，scope 跟角色走（工作的活进 work/）", async () => {
  await run(`
    await harvestTask(task("20261014-a1"));
    console.log(JSON.stringify({ calls: prompts.length }));
  `, (_out, read) => {
    expect(read("work", "projects", "domain-device-ops", "log", "2026-10.md")).toContain("云客手机重启排查");
    expect(read("work", "projects", "domain-device-ops", "log", "2026-10.md")).toContain("| domain-device-ops |");
    expect(read("work", "inbox", "2026-10-14.md")).toContain("云客手机重启排查");
    expect(read("private", "projects", "workspace", "log", "2026-10.md")).toBe("");
  });
});

test("拿不准：留在原处（private/projects/workspace），不硬塞进工作", async () => {
  await run(`
    classify = { roleId: "domain-biz-ops", confidence: "low", candidates: ["domain-device-ops"], why: "说不清" };
    await harvestTask(task("20261014-a2"));
    console.log("{}");
  `, (_out, read) => {
    expect(read("private", "projects", "workspace", "log", "2026-10.md")).toContain("云客手机重启排查");
    expect(read("work", "projects", "domain-device-ops", "log", "2026-10.md")).not.toContain("云客手机重启排查");
    expect(read("work", "inbox", "2026-10-14.md")).toBe("");
  });
});

test("派发时就带了领域角色：直接记进它的虚拟项目，不再问模型归属", async () => {
  await run(`
    await harvestTask(task("20261014-a3", { roleId: "domain-biz-ops", roleName: "业务运营", roleProject: "domain-biz-ops", roleScope: "work" }));
    console.log(JSON.stringify({ classifyCalls: prompts.filter((p) => p.includes("挑接手的「领域角色」")).length }));
  `, (out, read) => {
    expect(out.classifyCalls).toBe(0);
    expect(read("work", "projects", "domain-biz-ops", "log", "2026-10.md")).toContain("云客手机重启排查");
  });
});

test("capture 的 domainFor：只交出有把握的匹配", async () => {
  await run(`
    const { domainFor } = await import(${JSON.stringify(join(src, "capture.ts"))});
    const sure = await domainFor("云客手机重启");
    classify = { roleId: "", confidence: "low", candidates: [], why: "" };
    const unsure = await domainFor("另一段说不清的活");
    console.log(JSON.stringify({ sure, unsure }));
  `, (out) => {
    expect(out.sure).toEqual({ slug: "domain-device-ops", scope: "work", roleId: "domain-device-ops" });
    expect(out.unsure).toBeNull();
  });
});

test("人点名了角色、但那个角色没有项目可记（跨项目角色等）：照旧按派发目录记，绝不拿模型的判断顶掉人选的角色", async () => {
  await run(`
    await harvestTask(task("20261014-a4", { roleId: "cross-a-b", roleName: "a + b" }));
    console.log(JSON.stringify({ classifyCalls: prompts.filter((p) => p.includes("挑接手的「领域角色」")).length }));
  `, (out, read) => {
    expect(out.classifyCalls).toBe(0);
    expect(read("private", "projects", "workspace", "log", "2026-10.md")).toContain("云客手机重启排查");
    expect(read("work", "projects", "domain-device-ops", "log", "2026-10.md")).toBe("");
  });
});

test("第一轮拿不准（比如只是待命开场）先留在原处但不定死；后面真干了活的那次归到领域角色，原处那条撤掉，不留两份", async () => {
  await run(`
    const D = await import(${JSON.stringify(join(src, "dispatch.ts"))});
    const { writeFileSync } = await import("fs");
    writeFileSync(process.env.OWNWARD_DATA_ROOT + "/tasks.json", JSON.stringify([task("20261014-a6")]));
    classify = { roleId: "", confidence: "low", candidates: [], why: "只是开场" };
    await harvestTask(D.loadTasks().find((t) => t.id === "20261014-a6"));
    const mid = D.loadTasks().find((t) => t.id === "20261014-a6");
    classify = { roleId: "domain-device-ops", confidence: "high", candidates: [], why: "手机重启" };
    await harvestTask(D.loadTasks().find((t) => t.id === "20261014-a6"));
    const end = D.loadTasks().find((t) => t.id === "20261014-a6");
    console.log(JSON.stringify({ mid: [mid.harvestSlug, mid.harvestScope, mid.harvestFinal], end: [end.harvestSlug, end.harvestScope, end.harvestFinal] }));
  `, (out, read) => {
    expect(out.mid).toEqual(["workspace", "private", false]);
    expect(out.end).toEqual(["domain-device-ops", "work", true]);
    expect(read("private", "projects", "workspace", "log", "2026-10.md")).not.toContain("20261014-a6");
    expect(read("private", "inbox", "2026-10-14.md")).not.toContain("20261014-a6");
    expect(read("work", "projects", "domain-device-ops", "log", "2026-10.md").match(/20261014-a6/g)?.length).toBe(1);
  });
});

test("多轮任务重收：第一次定下的归属记在任务上，后面模型改口也不挪地方（不会在两个项目各留一份）", async () => {
  await run(`
    const D = await import(${JSON.stringify(join(src, "dispatch.ts"))});
    const { writeFileSync } = await import("fs");
    writeFileSync(process.env.OWNWARD_DATA_ROOT + "/tasks.json", JSON.stringify([task("20261014-a5")]));
    await harvestTask(D.loadTasks().find((t) => t.id === "20261014-a5"));
    classify = { roleId: "domain-biz-ops", confidence: "high", candidates: [], why: "改口" };
    await harvestTask(D.loadTasks().find((t) => t.id === "20261014-a5"));
    const t = D.loadTasks().find((t) => t.id === "20261014-a5");
    console.log(JSON.stringify({ harvestSlug: t.harvestSlug, harvestScope: t.harvestScope }));
  `, (out, read) => {
    expect(out).toEqual({ harvestSlug: "domain-device-ops", harvestScope: "work" });   // harvestFinal 不在输出里，见上一条
    expect(read("work", "projects", "domain-device-ops", "log", "2026-10.md").match(/云客手机重启排查/g)?.length).toBe(1);
    expect(read("work", "projects", "domain-biz-ops", "log", "2026-10.md")).toBe("");
  });
});

test("日报候选：决策分给有角色的项目；一天只提一次（全分出去、没写当日文件的那天也一样）；待审提醒每批新候选换新 id，处理过的批次不挡新的", async () => {
  await run(`
    const M = await import(${JSON.stringify(join(src, "memory.ts"))});
    const A = await import(${JSON.stringify(join(src, "actions.ts"))});
    const PM = await import(${JSON.stringify(join(src, "project-memory.ts"))});
    let extracts = 0;
    const realPrompts = prompts;
    mock.module(${JSON.stringify(join(src, "llm.ts"))}, () => ({ llmJson: async (p) => {
      if (p.includes("从下面的当日工作记录中提取")) { extracts++; return { candidates: [{ type: "decision", text: "周报模板统一用一个开关", evidence: "原话", project: "domain-biz-ops" }] }; }
      return null;
    } }));
    const first = await M.extractCandidates("当日记录");
    const second = await M.extractCandidates("当日记录");
    const cands = PM.listProjectCandidates("domain-biz-ops", "work");
    await M.sweepMemoryChores();
    const open1 = A.listActions(false).filter((a) => a.id.startsWith("memory:project-candidates:") && a.state === "open").map((a) => a.id);
    A.setActionState(open1[0], "dismissed");
    await new Promise((r) => setTimeout(r, 1100));   // 候选 id 带日期+随机串，换一批才有新 id
    PM.createProjectCandidate("domain-biz-ops", "work", { text: "第二批", evidence: "" });
    await M.sweepMemoryChores();
    const open2 = A.listActions(false).filter((a) => a.id.startsWith("memory:project-candidates:") && a.state === "open").map((a) => a.id);
    // 只处理掉最新的那批：最新一条退回到更早的候选，提醒不能凭空消失
    const newestNow = PM.listProjectCandidates("domain-biz-ops", "work").candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    PM.dismissProjectCandidate("domain-biz-ops", "work", newestNow.id);
    await M.sweepMemoryChores();
    const open3 = A.listActions(false).filter((a) => a.id.startsWith("memory:project-candidates:") && a.state === "open").map((a) => a.id);
    // 全处理完：提醒收掉
    for (const c of PM.listProjectCandidates("domain-biz-ops", "work").candidates) PM.dismissProjectCandidate("domain-biz-ops", "work", c.id);
    await M.sweepMemoryChores();
    const open4 = A.listActions(false).filter((a) => a.id.startsWith("memory:project-candidates:") && a.state === "open").map((a) => a.id);
    console.log(JSON.stringify({ first, second, extracts, n: cands.ok ? cands.candidates.length : -1, open1, open2, open3, open4 }));
  `, (out) => {
    expect(out.first).toEqual({ file: null, routed: 1 });
    expect(out.second).toEqual({ file: null, routed: 0 });
    expect(out.extracts).toBe(1);
    expect(out.n).toBe(1);
    expect(out.open1).toHaveLength(1);
    expect(out.open2).toHaveLength(1);              // 上一批被忽略了，新来的一批照样浮上来
    expect(out.open2[0]).not.toBe(out.open1[0]);
    expect(out.open3).toEqual(out.open2);           // 只处理了一部分：还是那条提醒（数量会变），不会退回早关掉的旧 id
    expect(out.open4).toEqual([]);
  });
});
