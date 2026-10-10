// 任务标题按界面语言生成（网页报上来的 ui-lang.json），不翻译已有标题。
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function sweep(lang: "zh" | "en" | null) {
  const root = await mkdtemp(join(tmpdir(), "ownward-title-lang-"));
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(root, "config.json"), JSON.stringify({ vault: { root: join(root, "vault") } }));
  if (lang) await writeFile(join(data, "ui-lang.json"), JSON.stringify({ lang }));
  const task = (id: string, extra: object) => ({ id, project: "p", projectDir: "/tmp", cwd: "/tmp", task: "x", mode: "claude-bg", startedAt: "2026-10-01T00:00:00Z", status: "exited", ...extra });
  await writeFile(join(data, "tasks.json"), JSON.stringify([
    task("old", { title: "修复登录闪退", task: "修复登录闪退" }),
    task("new", { task: "请把飞书文档排版整体优化一下，标题层级和表格都要对齐到新的规范" }),
  ]));
  const src = import.meta.dir;
  const script = `
    import { mock } from "bun:test";
    const prompts = [];
    mock.module(${JSON.stringify(join(src, "llm.ts"))}, () => ({ llmJson: async (p) => {
      prompts.push(p);
      return { title: p.includes("English title") ? "Polish Lark doc layout" : "优化飞书文档排版" };
    } }));
    const d = await import(${JSON.stringify(join(src, "dispatch.ts"))});
    await d.sweepTaskTitles();
    console.log(JSON.stringify({ titles: Object.fromEntries(d.loadTasks().map((t) => [t.id, t.title])), calls: prompts.length }));
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(src, ".."),
      env: { ...process.env, OWNWARD_SOURCE_ROOT: join(src, ".."), OWNWARD_CONFIG_ROOT: root, OWNWARD_DATA_ROOT: data, OWNWARD_BUILD_IDENTITY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("英文界面：新任务生成英文标题，已有中文标题不动", async () => {
  expect(await sweep("en")).toEqual({ titles: { old: "修复登录闪退", new: "Polish Lark doc layout" }, calls: 1 });
});

test("中文界面或从没报过语言：生成中文标题", async () => {
  expect(await sweep("zh")).toEqual({ titles: { old: "修复登录闪退", new: "优化飞书文档排版" }, calls: 1 });
  expect(await sweep(null)).toEqual({ titles: { old: "修复登录闪退", new: "优化飞书文档排版" }, calls: 1 });
});
