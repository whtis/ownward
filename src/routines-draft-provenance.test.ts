import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("dryRun 不落草稿与 action；真实生成冻结来源，编辑正文不会清除过期提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownward-draft-provenance-"));
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(root, "config.json"), JSON.stringify({ vault: { root: join(root, "vault") }, owner: { name: "测试人员" } }));
  await writeFile(join(data, "routines.json"), JSON.stringify([{ id: "monthly", name: "测试月报", window: "month", time: "15:00", guide: "项目分节", days: [], cadence: "monthly", enabled: false, refRoutines: ["meeting"] }, { id: "meeting", name: "晨会", docUrl: "https://example.com/doc", days: [] }]));
  const src = import.meta.dir;
  const script = `
    import { mock } from "bun:test";
    import { existsSync, readFileSync, writeFileSync } from "fs";
    let actions = 0, notices = 0;
    mock.module(${JSON.stringify(join(src, "llm.ts"))}, () => ({ llmJson: async () => ({draft: "月报正文"}) }));
    mock.module(${JSON.stringify(join(src, "actions.ts"))}, () => ({ openAction: () => actions++, resolveAction: () => {} }));
    mock.module(${JSON.stringify(join(src, "notify.ts"))}, () => ({ notify: async () => notices++ }));
    mock.module(${JSON.stringify(join(src, "lark-cards.ts"))}, () => ({ sendRoutineCard: async () => {} }));
    mock.module(${JSON.stringify(join(src, "memory.ts"))}, () => ({ memoryPack: () => "", stripPersonal: (s) => s, projectScope: () => ({personal: []}) }));
    mock.module(${JSON.stringify(join(src, "meeting-notes.ts"))}, () => ({ meetingNotesMaterial: async (label, url, days, people, cap, opts) => { if (opts.archive !== false) throw new Error("月报不应刷新会议归档"); opts.sources.push({url, hash: "a".repeat(64), fetchedAt: "2026-09-01T00:00:00Z"}); opts.warnings.push("离线旧快照"); return "会议素材"; } }));
    const r = await import(${JSON.stringify(join(src, "routines.ts"))});
    const { fmt } = await import(${JSON.stringify(join(src, "util.ts"))});
    await r.generateDraft("monthly", {dryRun:true});
    if (actions || notices || existsSync(${JSON.stringify(join(data, "routines"))})) throw new Error("dryRun wrote state");
    await r.generateDraft("monthly");
    const day = fmt(new Date(), "date"), before = r.draftView("monthly", day);
    r.saveDraft("monthly", day, "人工改稿");
    const after = r.draftView("monthly", day);
    console.log(JSON.stringify({ actions, notices, before, after }));
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: join(src, ".."), env: { ...process.env, OWNWARD_SOURCE_ROOT: join(src, ".."), OWNWARD_CONFIG_ROOT: root, OWNWARD_DATA_ROOT: data, OWNWARD_BUILD_IDENTITY: "" }, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.actions).toBe(1);
    expect(result.notices).toBe(1);
    expect(result.before.sources[0].hash).toBe("a".repeat(64));
    expect(result.before.materialDays.length).toBeGreaterThan(27);
    expect(result.before.materialPeople).toEqual(["测试人员"]);
    expect(result.before.warnings).toEqual(["离线旧快照"]);
    expect(result.before.stale).toBe(true);
    expect(result.after.stale).toBe(true);
    expect(result.after.sources).toEqual(result.before.sources);
  } finally { await rm(root, { recursive: true, force: true }); }
});
