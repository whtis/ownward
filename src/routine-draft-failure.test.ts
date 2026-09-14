// 自动生成失败必须可见：卡片停在「待生成」而只有一行日志，等于 owner 到截止时间才发现草稿没出来。
// 回归覆盖：失败落 occurrence → 限速重试 → 次数耗尽才升级通知+行动项 → 重试成功后行动项了结。
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("自动生成失败：落 failed 状态、限速重试、耗尽后通知，成功后了结行动项", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownward-draft-failure-"));
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(root, "config.json"), JSON.stringify({ vault: { root: join(root, "vault") }, owner: { name: "测试人员" } }));
  const src = import.meta.dir;
  const script = `
    import { mock } from "bun:test";
    import { readFileSync, writeFileSync } from "fs";
    import { join } from "path";
    let fail = true;
    const opened = [], resolved = [], notices = [];
    mock.module(${JSON.stringify(join(src, "llm.ts"))}, () => ({ llmJson: async () => { if (fail) throw new Error("会议材料尚未归档，请先刷新会议归档"); return { draft: "月报正文" }; } }));
    mock.module(${JSON.stringify(join(src, "actions.ts"))}, () => ({ openAction: (a) => opened.push(a), resolveAction: (id, why) => resolved.push([id, why]) }));
    mock.module(${JSON.stringify(join(src, "notify.ts"))}, () => ({ notify: async (t) => { notices.push(t); return true; } }));
    mock.module(${JSON.stringify(join(src, "lark-cards.ts"))}, () => ({ sendRoutineCard: async () => {} }));
    mock.module(${JSON.stringify(join(src, "memory.ts"))}, () => ({ memoryPack: () => "", stripPersonal: (s) => s, projectScope: () => ({ personal: [] }) }));
    const r = await import(${JSON.stringify(join(src, "routines.ts"))});
    const { fmt } = await import(${JSON.stringify(join(src, "util.ts"))});

    // 每天都触发、截止时间就是此刻 → sweepRoutines 必定落进生成窗口，测试不看真实时钟走到哪
    const conf = ${JSON.stringify(join(data, "routines.json"))};
    writeFileSync(conf, JSON.stringify([{ id: "daily", name: "测试日报", docUrl: "https://example.com/doc",
      days: [0, 1, 2, 3, 4, 5, 6], time: fmt(new Date(), "time"), aheadMin: 5, window: "yesterday", guide: "随便", enabled: true }]));

    const day = fmt(new Date(), "date");
    const occ = join(${JSON.stringify(join(data, "routines"))}, "daily-" + day + ".json");
    const read = () => { try { return JSON.parse(readFileSync(occ, "utf8")); } catch { return {}; } };
    const attempts = () => read().attempts || 0;
    // 生成是 fire-and-forget：等 occurrence 真的推进到期望次数，等不到就让断言拿旧值去炸
    const sweep = async (want) => { r.sweepRoutines(); for (let i = 0; i < 600 && attempts() !== want; i++) await Bun.sleep(5); };
    const sweepQuiet = async () => { r.sweepRoutines(); await Bun.sleep(200); };   // 预期不该重试：给足机会再看
    const backdate = (min) => writeFileSync(occ, JSON.stringify({ ...read(), updatedAt: new Date(Date.now() - min * 60000).toISOString() }));

    await sweep(1);
    const first = read();
    const card = r.todayRoutines().find((x) => x.id === "daily");

    await sweepQuiet();                  // 刚失败不到 5 分钟：不该重试
    const throttled = attempts();

    backdate(10); await sweep(2);        // 第 2 次
    const second = attempts(), quietSoFar = notices.length + opened.length;
    backdate(10); await sweep(3);        // 第 3 次：耗尽
    const third = attempts();

    backdate(10); await sweepQuiet();    // 次数耗尽后不再自动重试
    const afterExhausted = attempts();

    fail = false;
    await r.generateDraft("daily");      // 手动重试成功
    const recovered = read();
    console.log(JSON.stringify({ first, card, throttled, second, quietSoFar, third, afterExhausted,
      opened, resolved, notices, recovered: { status: recovered.status, draft: recovered.draft } }));
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(src, ".."),
      env: { ...process.env, OWNWARD_SOURCE_ROOT: join(src, ".."), OWNWARD_CONFIG_ROOT: root, OWNWARD_DATA_ROOT: data, OWNWARD_BUILD_IDENTITY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    const res = JSON.parse(stdout.trim().split("\n").at(-1)!);

    // 1. 失败留痕，而不是只写日志
    expect(res.first.status).toBe("failed");
    expect(res.first.attempts).toBe(1);
    expect(res.first.error).toContain("刷新会议归档");
    // 2. 今日页卡片端出失败与原因，且给得出重试入口所需的状态
    expect(res.card.status).toBe("failed");
    expect(res.card.error).toContain("刷新会议归档");
    // 3. 头几次失败限速重试且不惊动人
    expect(res.throttled).toBe(1);
    expect(res.second).toBe(2);
    expect(res.quietSoFar).toBe(0);
    // 4. 次数耗尽 → 一条通知 + 一条行动项，且不再无限重试
    expect(res.third).toBe(3);
    expect(res.afterExhausted).toBe(3);
    const alarms = res.notices.filter((t: string) => t.includes("草稿生成失败"));
    const failedActions = res.opened.filter((a: { id: string }) => a.id.endsWith(":failed"));
    expect(alarms).toHaveLength(1);
    expect(failedActions).toHaveLength(1);
    expect(failedActions[0].id).toMatch(/^routine:daily:\d{4}-\d{2}-\d{2}:failed$/);
    // 5. 手动重试成功：草稿落地，失败行动项被了结
    expect(res.recovered.status).toBe("draft");
    expect(res.recovered.draft).toBe("月报正文");
    expect(res.resolved.map((x: string[]) => x[0])).toContain(failedActions[0].id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
