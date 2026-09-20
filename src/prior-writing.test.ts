// 日报/周报生成前回看「我往期亲手写的内容」。
// 背景：草稿素材只有收割来的编码会话日志——开会、评审、写方案这类活收不到，没开会话的工作日素材直接为空，
// 而且不知道上一期计划了什么，「结果」和「计划」对不上账。我亲手定稿的往期内容正好补这三个洞。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractOwnedSections, parseWeekRange, priorWritingMaterial } from "./meeting-notes.ts";
import { historyDays } from "./routines.ts";

const user = (name: string) => `<cite type="user" user-id="ou_x" user-name="${name}"></cite>`;
const table = (rows: string) => `<table><thead><tr><th>人员</th><th>周一</th><th>周二</th></tr></thead><tbody>${rows}</tbody></table>`;
const row = (name: string, ...cells: string[]) => `<tr><td>${user(name)}</td>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;

const standup = [
  "# 09.14-09.18", "", table(row("Alex 张三", "计划：<ul><li>本周一的计划</li></ul>", "") + row("Bob 李四", "计划：<ul><li>别人的计划</li></ul>", "")),
  "", "# 09.07-09.11", "", table(row("Alex 张三", "结果：<ul><li>上周一的结果</li></ul>", "")),
].join("\n");

const projectWeekly = [
  "# 9.07-9.11",
  "## 项目：项目甲", `### 成员：${user("Cara 王五")}`, "### 本周进展：", `- 别人的项目，正文里 @ 了 ${user("Alex 张三")} 也不算我的`,
  "## 项目：项目乙", `### 成员：${user("Alex 张三")}${user("Bob 李四")}`, "### 本周进展：", "- 自动总结已上线",
  "![飞书自动生成的几百字看板截图描述](https://feishu.cn/file/x)", "### 下周计划：", "- 客户文档进入开发",
  "# 8.03-8.07", "## 项目：项目乙", `### 成员：${user("Alex 张三")}`, "### 本周进展：", "- 窗口外的旧内容",
].join("\n");

test("周标题兼容一位月份的带点写法", () => {
  expect(parseWeekRange("# 9.07-9.11", 2026)[0]).toEqual({ start: "2026-09-07", end: "2026-09-11" });
  expect(parseWeekRange("# 0907-0911", 2026)[0]).toEqual({ start: "2026-09-07", end: "2026-09-11" });
  expect(parseWeekRange("# 907-911", 2026)).toEqual([]);
});

describe("historyDays", () => {
  test("日报：今天 + 往前 7 天，今天的格子也要看（我可能已经先填了计划）", () => {
    const d = historyDays("yesterday", new Date("2026-09-17T12:00:00"));
    expect([d[0], d.at(-1)]).toEqual(["2026-09-10", "2026-09-17"]);
  });
  test("周报：取材周再往前带一周，上周的「下周计划」要拿来对账", () => {
    const d = historyDays("week", new Date("2026-09-18T12:00:00"));
    expect([d[0], d.at(-1)]).toEqual(["2026-09-07", "2026-09-18"]);
  });
});

describe("extractOwnedSections", () => {
  test("只认领成员行点到我的分节；窗口外的周不取；截图描述不占篇幅", () => {
    const got = extractOwnedSections(projectWeekly, ["2026-09-01", "2026-09-17"], ["Alex"]);
    expect(got.map((s) => `${s.week}|${s.section}`)).toEqual(["9.07-9.11|项目：项目乙"]);
    expect(got[0].text).toContain("自动总结已上线");
    expect(got[0].text).toContain("客户文档进入开发");
    expect(got[0].text).not.toContain("几百字");
  });
});

describe("priorWritingMaterial", () => {
  const days = ["2026-09-07", "2026-09-17"];
  test("表格式文档只抽我的行，最新一期排最前", async () => {
    const text = await priorWritingMaterial("u", days, ["Alex"], 8_000, { fetch: async () => standup });
    expect(text).toStartWith("===== 我之前亲手写的");
    expect(text).not.toContain("别人的计划");
    expect(text).not.toContain("跨月周");
    expect(text.indexOf("本周一的计划")).toBeGreaterThan(0);
    expect(text.indexOf("本周一的计划")).toBeLessThan(text.indexOf("上周一的结果"));
  });
  test("没有人员表的分节式文档退到认领分节", async () => {
    expect(await priorWritingMaterial("u", days, ["Alex"], 8_000, { fetch: async () => projectWeekly })).toContain("自动总结已上线");
  });
  test("拉不到不抛：返回空串 + 一条警告，草稿照常生成", async () => {
    const warnings: string[] = [];
    expect(await priorWritingMaterial("u", days, ["Alex"], 8_000, { fetch: async () => { throw new Error("飞书抖了"); }, warnings })).toBe("");
    expect(warnings.join()).toContain("上期计划未对账");
  });
  test("抽不出我的内容就当没这回事，不往素材里塞空段", async () => {
    expect(await priorWritingMaterial("u", days, ["不存在的人"], 8_000, { fetch: async () => standup })).toBe("");
  });
});

test("生成草稿：往期内容排在素材最前并附用法；对不上账的上期计划进 warnings 而不是正文；当天素材不再被 2k 截断", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownward-prior-writing-"));
  const data = join(root, "data"), src = import.meta.dir;
  await mkdir(data);
  await writeFile(join(root, "config.json"), JSON.stringify({ vault: { root: join(root, "vault") }, owner: { name: "Alex" } }));
  await writeFile(join(data, "routines.json"), JSON.stringify([
    { id: "daily", name: "晨会", docUrl: "https://example.com/doc", days: [1, 2, 3, 4, 5], time: "10:30", aheadMin: 30, window: "yesterday", guide: "格式", enabled: true },
    { id: "off", name: "晨会", docUrl: "https://example.com/doc", days: [1, 2, 3, 4, 5], time: "10:30", aheadMin: 30, window: "yesterday", guide: "格式", enabled: true, priorWriting: false },
    { id: "weekly", name: "周会", docUrl: "https://example.com/weekly", days: [5], time: "16:00", aheadMin: 30, window: "week", guide: "格式", enabled: true, priorWriting: false, refRoutines: ["daily"] },
  ]));
  const script = `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "fs";
    const prompts = [], fetched = [], refCalls = [];
    mock.module(${JSON.stringify(join(src, "llm.ts"))}, () => ({ llmJson: async (p) => { prompts.push(p); return { draft: "正文", unverified: ["完成回收政策可评审稿", "", 3] }; } }));
    mock.module(${JSON.stringify(join(src, "actions.ts"))}, () => ({ openAction: () => {}, resolveAction: () => {} }));
    mock.module(${JSON.stringify(join(src, "notify.ts"))}, () => ({ notify: async () => true }));
    mock.module(${JSON.stringify(join(src, "lark-cards.ts"))}, () => ({ sendRoutineCard: async () => {} }));
    mock.module(${JSON.stringify(join(src, "memory.ts"))}, () => ({ memoryPack: () => "", stripPersonal: (s) => s, projectScope: () => ({ personal: [] }) }));
    mock.module(${JSON.stringify(join(src, "meeting-notes.ts"))}, () => ({ priorWritingMaterial: async (url, days, people) => { fetched.push([url, days.length, people]); return "===== 我之前亲手写的（x）=====\\n计划：完成回收政策可评审稿"; },
      meetingNotesMaterial: async (label, url, days, people, cap, opts) => { refCalls.push({ label, archive: opts.archive, dryRun: opts.dryRun, sources: !!opts.sources }); opts.warnings.push(label + "：取材失败，无可用归档，请补充材料"); return "(拉取失败)"; } }));
    const r = await import(${JSON.stringify(join(src, "routines.ts"))});
    const { inboxDir } = await import(${JSON.stringify(join(src, "paths.ts"))});
    const { fmt } = await import(${JSON.stringify(join(src, "util.ts"))});
    mkdirSync(inboxDir(), { recursive: true });
    writeFileSync(inboxDir() + "/" + r.materialDays("yesterday")[0] + ".md", "上午的活\\n" + "填充".repeat(3000) + "\\n下午的活");
    await r.generateDraft("daily");
    await r.generateDraft("off");
    await r.generateDraft("weekly");   // 引用的晨会表拉不到：周报照常出，不像月度复盘那样整期失败
    const view = r.draftView("daily", fmt(new Date(), "date"));
    console.log(JSON.stringify({ prompts, fetched, refCalls, warnings: view.warnings, draft: view.draft }));
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: join(src, ".."), env: { ...process.env, OWNWARD_SOURCE_ROOT: join(src, ".."), OWNWARD_CONFIG_ROOT: root, OWNWARD_DATA_ROOT: data, OWNWARD_BUILD_IDENTITY: "" }, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    const got = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(got.fetched).toEqual([["https://example.com/doc", 8, ["Alex"]]]);   // priorWriting:false 的那条连拉取都不发生
    // 周报引用晨会表：实时读、不归档、不冻结来源指纹（否则读到的是月度归档的旧快照，本周内容一条都没有）
    expect(got.refCalls).toEqual([{ label: "晨会", dryRun: true, sources: false }]);
    expect(got.prompts).toHaveLength(3);
    const [on, off] = got.prompts as string[];
    expect(on).toContain("=== 我之前亲手写的内容怎么用 ===");
    expect(on).toContain("\"unverified\"");
    expect(on.indexOf("===== 我之前亲手写的")).toBeLessThan(on.indexOf("工作日志 ====="));
    expect(on).toContain("下午的活");
    expect(off).not.toContain("我之前亲手写的");
    expect(off).not.toContain("unverified");
    expect(got.warnings).toEqual(["上期计划未见证据：完成回收政策可评审稿"]);
    expect(got.draft).toBe("正文");
  } finally { await rm(root, { recursive: true, force: true }); }
});
