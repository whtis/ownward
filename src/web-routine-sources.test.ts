import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

test("草稿材料摘要兼容历史草稿，并展示真实窗口、版本与离线提示", () => {
  const source = readFileSync(join(import.meta.dir, "../web/today.js"), "utf8");
  const block = source.slice(source.indexOf("function routineSourceSummary("), source.indexOf("async function openDraft("));
  const summary = runInNewContext(`${block}; routineSourceSummary`);
  expect(summary({ draft: "旧稿" })).toBe("");
  const actual = summary({
    materialDays: ["2026-08-01", "2026-08-31"],
    materialPeople: ["张三", "李四"],
    sources: [{ url: "https://example.feishu.cn/docx/source", hash: "abcdef1234567890", fetchedAt: "2026-09-06T08:00:00Z" }],
    warnings: ["拉取失败，使用已有归档"],
  });
  expect(actual).toContain("2026-08-01 至 2026-08-31");
  expect(actual).toContain("覆盖人员：张三、李四");
  expect(actual).toContain("https://example.feishu.cn/docx/source");
  expect(actual).toContain("abcdef123456");
  expect(actual).toContain("2026-09-06T08:00:00Z");
  expect(actual).toContain("⚠ 拉取失败，使用已有归档");
});

test("审核保存失败时不得派发旧草稿写入", async () => {
  const source = readFileSync(join(import.meta.dir, "../web/today.js"), "utf8");
  const block = source.slice(source.indexOf('$("#d-write").addEventListener'), source.indexOf('$("#d-skip").addEventListener'));
  let handler: () => Promise<void> = async () => {};
  const calls: string[] = [], notices: string[] = [];
  const context = { id: "monthly", date: "2026-09-06" };
  const Today = { draftCtx: context };
  runInNewContext(block, {
    $: (selector: string) => selector === "#d-write"
      ? { addEventListener: (_name: string, callback: () => Promise<void>) => { handler = callback; } }
      : { value: "人工改过的新稿" },
    Today,
    post: async (path: string) => { calls.push(path); return { ok: false, msg: "磁盘写入失败" }; },
    toast: (message: string) => notices.push(message),
  });
  await handler();
  expect(calls).toEqual(["/api/routines/draft"]);
  expect(notices).toEqual(["磁盘写入失败"]);
  expect(Today.draftCtx).toBe(context);
});
