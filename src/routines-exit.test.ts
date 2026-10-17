// 周期职责的退出机制：逾期/生成失败的卡原先只能重试或进草稿弹窗找跳过（失败的连草稿都打不开），
// 过去几天的卡永远卡在今日页。覆盖：单张跳过 / 标已手动填写 / 一键跳过全部逾期，以及对应的 API。
// 子进程 + 独立 OWNWARD_DATA_ROOT，不碰真实 routines / actions，也不调模型。
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mod = (f: string) => JSON.stringify(join(import.meta.dir, f));

async function runScript(body: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "ownward-routine-exit-"));
  const data = join(root, "data");
  writeFileSync(join(root, "config.json"), JSON.stringify({ vault: { root: join(root, "vault") } }));
  try {
    const script = `
      import { mkdirSync, readFileSync, writeFileSync } from "fs";
      import { join } from "path";
      const A = await import(${mod("actions.ts")});
      const R = await import(${mod("routines.ts")});
      const { fmt } = await import(${mod("util.ts")});
      const { handleWorkbench } = await import(${mod("workbench.ts")});
      const call = async (method, path, body) => {
        const u = new URL("http://localhost" + path);
        const r = await handleWorkbench(new Request(u, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), u);
        return { status: r.status, body: await r.json() };
      };
      const DATA = ${JSON.stringify(data)}, STATE = join(DATA, "routines");
      mkdirSync(STATE, { recursive: true });
      // 每天都触发的日报：今天的卡是「待生成」（没有 occurrence），逾期卡全靠下面手种
      writeFileSync(join(DATA, "routines.json"), JSON.stringify([{ id: "daily", name: "测试日报", docUrl: "https://example.com/doc",
        days: [0, 1, 2, 3, 4, 5, 6], time: "18:00", aheadMin: 30, window: "yesterday", guide: "随便", enabled: true }]));
      const ago = (n) => fmt(new Date(Date.now() - n * 86_400_000), "date");
      const seed = (date, s) => writeFileSync(join(STATE, "daily-" + date + ".json"), JSON.stringify({ draft: "", updatedAt: new Date().toISOString(), ...s }));
      const occ = (date) => JSON.parse(readFileSync(join(STATE, "daily-" + date + ".json"), "utf8"));
      const overdue = () => R.todayRoutines().filter((c) => c.overdue).map((c) => c.date + ":" + c.status);
      const action = (id) => A.listActions(true).find((a) => a.id === id);
      const out = {};
      ${body}
      console.log(JSON.stringify(out));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, OWNWARD_SOURCE_ROOT: join(import.meta.dir, ".."), OWNWARD_CONFIG_ROOT: root, OWNWARD_DATA_ROOT: data, OWNWARD_BUILD_IDENTITY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("skipRoutine：逾期卡从今日页消失，状态 skipped，草稿行动项了结", async () => {
  const r = await runScript(`
    seed(ago(2), { status: "draft", draft: "前天的草稿" });
    A.openAction({ id: "routine:daily:" + ago(2), kind: "decide", source: "dispatch", title: "审草稿", reason: "x", ref: {} });
    out.before = overdue();
    R.skipRoutine("daily", ago(2));
    out.after = overdue();
    out.status = occ(ago(2)).status;
    out.draft = occ(ago(2)).draft;
    out.action = action("routine:daily:" + ago(2));
  `);
  expect(r.before).toHaveLength(1);
  expect(r.after).toEqual([]);
  expect(r.status).toBe("skipped");
  expect(r.draft).toBe("前天的草稿");                 // 跳过不丢草稿正文
  expect(r.action).toMatchObject({ state: "resolved", resolution: "skipped" });
});

test("markRoutineWritten：生成失败的卡也能标已填写，连同 :failed 行动项一起了结", async () => {
  const r = await runScript(`
    seed(ago(1), { status: "failed", error: "飞书导出超时", attempts: 3 });
    A.openAction({ id: "routine:daily:" + ago(1) + ":failed", kind: "decide", source: "dispatch", title: "生成失败", reason: "x", ref: {} });
    out.before = overdue();
    R.markRoutineWritten("daily", ago(1));
    out.after = overdue();
    out.status = occ(ago(1)).status;
    out.action = action("routine:daily:" + ago(1) + ":failed");
    // 今天没有 occurrence 也能标：人在外面填完了，今天的卡直接收尾
    R.markRoutineWritten("daily", ago(0));
    out.todayCard = R.todayRoutines().find((c) => c.isToday);
  `);
  expect(r.before).toEqual([expect.stringMatching(/:failed$/)]);
  expect(r.after).toEqual([]);
  expect(r.status).toBe("written");
  expect(r.action).toMatchObject({ state: "resolved", resolution: "written" });
  expect(r.todayCard.status).toBe("written");
});

test("skipAllOverdue：清掉全部逾期/失败，写入中的不动，已收尾和太老的不算", async () => {
  const r = await runScript(`
    seed(ago(1), { status: "draft", draft: "a" });
    seed(ago(2), { status: "failed", error: "x" });
    seed(ago(3), { status: "writing", draft: "c", taskId: "t1" });
    seed(ago(4), { status: "draft", draft: "d" });
    seed(ago(5), { status: "written", draft: "e" });
    seed(ago(10), { status: "draft", draft: "太老" });
    out.before = overdue().length;
    out.count = R.skipAllOverdue();
    out.after = overdue();
    out.states = [1, 2, 3, 4, 5, 10].map((n) => occ(ago(n)).status);
    out.again = R.skipAllOverdue();
  `);
  expect(r.before).toBe(4);
  expect(r.count).toBe(3);
  expect(r.after).toEqual([expect.stringMatching(/:writing$/)]);
  expect(r.states).toEqual(["skipped", "skipped", "writing", "skipped", "written", "draft"]);
  expect(r.again).toBe(0);
});

test("API：/api/routines/written 与 /api/routines/skip-overdue", async () => {
  const r = await runScript(`
    seed(ago(1), { status: "draft", draft: "a" });
    seed(ago(2), { status: "failed", error: "x" });
    seed(ago(3), { status: "draft", draft: "c" });
    A.openAction({ id: "routine:daily:" + ago(1), kind: "decide", source: "dispatch", title: "审草稿", reason: "x", ref: {} });
    out.written = await call("POST", "/api/routines/written", { id: "daily", date: ago(1) });
    out.writtenStatus = occ(ago(1)).status;
    out.action = action("routine:daily:" + ago(1));
    out.noId = await call("POST", "/api/routines/written", {});
    out.bulk = await call("POST", "/api/routines/skip-overdue");
    out.states = [2, 3].map((n) => occ(ago(n)).status);
    out.list = (await call("GET", "/api/routines")).body.filter((c) => c.overdue);
  `);
  expect(r.written).toEqual({ status: 200, body: { ok: true, msg: "已标记为已填写" } });
  expect(r.writtenStatus).toBe("written");
  expect(r.action).toMatchObject({ state: "resolved", resolution: "written" });
  expect(r.noId.status).toBe(400);
  expect(r.bulk).toEqual({ status: 200, body: { ok: true, count: 2, msg: "已跳过 2 项逾期职责" } });
  expect(r.states).toEqual(["skipped", "skipped"]);
  expect(r.list).toEqual([]);
});
