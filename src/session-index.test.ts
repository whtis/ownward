// 会话派生索引：库本身（签名跳过 / 重入库替换 / trigram 全文 / schema 升级删库）+ 扫描端到端
//（legacy session.json 与 runner journal 两种来源进同一张表，/api/dev/recent 与 /api/search 只读库）。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SESSION_INDEX_SCHEMA, SessionIndexStore, summarizeMessages } from "./session-index.ts";

const row = (key: string, extra: Partial<Parameters<SessionIndexStore["upsert"]>[0]> = {}) => ({ key, kind: "legacy" as const, sessionId: key, taskId: key, providerId: "claude", signature: "sig-1", source: "", msgs: 0, userMsgs: 0, lastText: "", lastRole: "", lastAt: 0, turn: "", pending: [], ...extra });

describe("SessionIndexStore", () => {
  test("trigram 全文：中文子串 / 英文大小写不敏感 / 短查询退 LIKE；重入库整体替换；按会话新旧排", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-index-")), store = new SessionIndexStore(join(root, "index", "sessions.sqlite"));
    try {
      store.upsert(row("legacy:old", { lastAt: 100 }), [{ role: "user", text: "帮我把信息条改成左读右改", ts: "2026-09-13T01:00:00.000Z" }, { role: "assistant", text: "Done: sessionMetaHtml now splits meta-read / meta-act", ts: "2026-09-13T01:00:01.000Z" }]);
      store.upsert(row("legacy:new", { lastAt: 200 }), [{ role: "assistant", text: "ctx 百分比改成按 1M 窗口算", ts: "2026-09-13T02:00:00.000Z" }, { role: "tool", name: "Bash", text: "", ts: "" }]);
      expect(store.search("左读右改").map((h) => h.key)).toEqual(["legacy:old"]);
      expect(store.search("左读右改")[0].snippet).toContain("[左读右改]");
      expect(store.search("META-ACT").map((h) => h.key)).toEqual(["legacy:old"]);
      expect(store.search("1M").map((h) => h.key)).toEqual(["legacy:new"]);   // 2 个字符：LIKE 兜底
      expect(store.search("%").length).toBe(0);                                  // LIKE 通配符被转义，不是"全部命中"
      expect(store.search("百分比 OR 信息条").length).toBe(0);                   // 整串当子串，不解释 FTS 语法
      expect(store.search("改成").map((h) => h.key).sort()).toEqual(["legacy:new", "legacy:old"]);
      expect(store.search("改成")[0].key).toBe("legacy:new");                     // 新会话在前
      expect(store.search("改").length).toBe(0);                                   // 1 个字符：服务端直接挡掉，不做全表 LIKE
      expect(store.stats()).toMatchObject({ sessions: 2, messages: 3 });         // 空文本行不进库
      // 同一会话重入库：旧行全部替换，FTS 同步
      store.upsert(row("legacy:old", { lastAt: 100, signature: "sig-2" }), [{ role: "assistant", text: "全新内容", ts: "" }]);
      expect(store.search("左读右改").length).toBe(0);
      expect(store.search("全新内容").map((h) => h.key)).toEqual(["legacy:old"]);
      expect(store.get("legacy:old")?.signature).toBe("sig-2");
      expect(store.signatures().get("legacy:new")).toBe("sig-1");
      store.remove("legacy:new");
      expect(store.stats()).toMatchObject({ sessions: 1, messages: 1 });
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("schema 版本不对就删库重建；坏库也不抛", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-index-schema-")), file = join(root, "sessions.sqlite");
    try {
      const store = new SessionIndexStore(file); store.upsert(row("a"), [{ role: "user", text: "旧数据", ts: "" }]); store.close();
      const { Database } = require("bun:sqlite"); const db = new Database(file); db.run("update meta set value = ? where key = 'schema'", [String(SESSION_INDEX_SCHEMA + 1)]); db.close();
      const reopened = new SessionIndexStore(file);
      expect(reopened.stats()).toMatchObject({ sessions: 0, messages: 0 });
      reopened.close();
      writeFileSync(file, "not a database"); rmSync(file + "-wal", { force: true }); rmSync(file + "-shm", { force: true });
      const rebuilt = new SessionIndexStore(file);
      expect(rebuilt.stats()).toMatchObject({ sessions: 0 });
      rebuilt.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("summarizeMessages 与侧栏口径一致：末句取最后一条有字的 user/assistant，用户消息加「我：」", () => {
    expect(summarizeMessages([{ role: "user", text: "问", ts: "2026-09-13T00:00:00.000Z" }, { role: "assistant", text: "答", ts: "2026-09-13T00:00:01.000Z" }, { role: "tool", name: "Bash", text: "ls", ts: "" }]))
      .toEqual({ msgs: 3, userMsgs: 1, lastText: "答", lastRole: "assistant", lastAt: Date.parse("2026-09-13T00:00:01.000Z") });
    expect(summarizeMessages([{ role: "user", text: "  追问 ", ts: "" }]).lastText).toBe("我：追问");
  });
});

describe("session index sweep（子进程：DATA 来自 OWNWARD_DATA_ROOT）", () => {
  test("legacy 文件与 runner journal 都进索引；recent/search 只读库；签名没变的会话不重投影", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-index-sweep-")), data = join(root, "data"), cwd = join(root, "project");
    try {
      mkdirSync(cwd); mkdirSync(join(data, "tasks"), { recursive: true });
      writeFileSync(join(data, "tasks.json"), JSON.stringify([
        { id: "runner-task", project: "alpha", cwd, task: "runner 会话", mode: "claude-bg", engine: true, startedAt: "2026-09-13T09:00:00.000Z", status: "running" },
        { id: "legacy-task", project: "beta", cwd, task: "老会话", mode: "claude-bg", engine: true, startedAt: "2026-09-12T08:00:00.000Z", status: "exited" },
        { id: "empty-task", project: "gamma", cwd, task: "空壳", mode: "claude-bg", engine: true, startedAt: "2026-09-11T08:00:00.000Z", status: "exited" },
      ]));
      writeFileSync(join(data, "tasks/legacy-task.session.json"), JSON.stringify({ messages: [{ role: "user", text: "怎么给发布事务加探针超时", ts: "2026-09-12T08:00:00.000Z" }, { role: "assistant", text: "用 OWNWARD_OBSERVATION_TIMEOUT_SEC", ts: "2026-09-12T08:00:05.000Z" }], pending: [{ toolName: "AskUserQuestion", brief: "请选择" }], lastActivityAt: 1789200000000 }));
      const script = `
        import { SessionRepository } from ${JSON.stringify(join(import.meta.dir, "sessions/repository.ts"))};
        import { RunnerCommandJournal, RunnerEventJournal } from ${JSON.stringify(join(import.meta.dir, "runner/journals.ts"))};
        import { sweepSessionIndex, sessionIndex } from ${JSON.stringify(join(import.meta.dir, "session-index.ts"))};
        const data=${JSON.stringify(data)},cwd=${JSON.stringify(cwd)};
        new SessionRepository(data).bind({taskId:"runner-task",providerId:"claude",nativeRef:"native-1",cwd,source:"native"});
        // 老任务在仓库里只有 legacy 身份记录：正文仍在 session.json，必须照样进索引
        new SessionRepository(data).bind({taskId:"legacy-task",providerId:"claude",nativeRef:"legacy-native",cwd,source:"legacy"});
        const commands=new RunnerCommandJournal(data),events=new RunnerEventJournal(data);
        const turn=(n)=>{const c=commands.accept({commandId:"c"+n,kind:"start-run",runId:"r"+n,sessionId:"runner-task",providerId:"claude",input:JSON.stringify({text:"第"+n+"问：信息条怎么分家"})},"2026-09-13T09:0"+n+":00.000Z").record;events.append({eventId:"s"+n,type:"started",at:"2026-09-13T09:0"+n+":00.100Z",commandId:c.commandId,runId:c.runId,sessionId:"runner-task",providerId:"claude"});events.append({eventId:"m"+n,type:"message-completed",at:"2026-09-13T09:0"+n+":01.000Z",commandId:c.commandId,runId:c.runId,sessionId:"runner-task",providerId:"claude",payload:JSON.stringify({role:"assistant",text:"第"+n+"答：左读右改，meta-read 在左"})});events.append({eventId:"d"+n,type:"completed",at:"2026-09-13T09:0"+n+":02.000Z",commandId:c.commandId,runId:c.runId,sessionId:"runner-task",providerId:"claude"});};
        turn(1);
        const first=await sweepSessionIndex({dataRoot:data});
        const rowsAfterFirst=sessionIndex(data).list().map(r=>[r.key,r.msgs,r.userMsgs,r.lastText,r.turn,r.pending]).sort();
        const idle=await sweepSessionIndex({dataRoot:data,force:false,maxAgeMs:0});
        turn(2);
        const second=await sweepSessionIndex({dataRoot:data,maxAgeMs:0});
        const {handleWorkbench}=await import(${JSON.stringify(join(import.meta.dir, "workbench.ts"))});
        const get=async(path)=>{const url=new URL("http://localhost"+path);return await (await handleWorkbench(new Request(url),url)).json();};
        const recent=await get("/api/dev/recent");
        const searchRunner=await get("/api/search?q=左读右改");
        const searchLegacy=await get("/api/search?q=探针超时");
        const searchLegacyAnswer=await get("/api/search?q=observation_timeout");
        const status=await get("/api/index/status");
        const rebuilt=await (await handleWorkbench(new Request("http://localhost/api/index/rebuild",{method:"POST"}),new URL("http://localhost/api/index/rebuild"))).json();
        // 任务被删：下一轮扫描回收它的行，搜索不再命中
        const {writeFileSync,readFileSync}=await import("fs");
        writeFileSync(data+"/tasks.json",JSON.stringify(JSON.parse(readFileSync(data+"/tasks.json","utf8")).filter(t=>t.id!=="legacy-task")));
        const gc=await sweepSessionIndex({dataRoot:data,maxAgeMs:0});
        const afterGc=[gc.removed,sessionIndex(data).list().map(r=>r.key).sort(),(await get("/api/search?q=探针超时")).hits.length];
        console.log(JSON.stringify({first:[first.updated,first.runner,first.legacy,first.errors],rowsAfterFirst,idle:[idle.updated,idle.errors],second:[second.updated,second.runner,second.legacy],recent:recent.map(r=>({id:r.id,msgs:r.msgs,userMsgs:r.userMsgs,last:r.last,pending:r.runnerState.pending,turn:r.runnerState.turn,backend:r.backend})),searchRunner:searchRunner.hits.map(h=>[h.taskId,h.role,h.project,h.snippet]),searchLegacy:searchLegacy.hits.map(h=>[h.taskId,h.role,h.title]),searchLegacyAnswer:searchLegacyAnswer.hits.length,status:[status.sessions,status.messages,status.lastSweep.scanned],rebuilt:[rebuilt.ok,rebuilt.report.updated],afterGc}));`;
      const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: data }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, err).toBe(0);
      const r = JSON.parse(out.trim().split("\n").at(-1)!);
      expect(r.first).toEqual([2, 1, 1, []]);                                   // runner + legacy 各一；空壳任务没来源
      expect(r.rowsAfterFirst).toEqual([
        ["legacy:legacy-task", 2, 1, "用 OWNWARD_OBSERVATION_TIMEOUT_SEC", "", [{ toolName: "AskUserQuestion", brief: "请选择" }]],
        ["runner:runner-task", 2, 1, "第1答：左读右改，meta-read 在左", "idle", []],
      ]);
      expect(r.idle).toEqual([0, []]);                                            // 没变化：一个会话都不重投影
      expect(r.second).toEqual([1, 1, 0]);                                        // 只有追加了一轮的 runner 会话重入库
      expect(r.recent).toEqual([
        { id: "runner-task", msgs: 4, userMsgs: 2, last: "第2答：左读右改，meta-read 在左", pending: [], turn: "idle", backend: "claude" },
        { id: "legacy-task", msgs: 2, userMsgs: 1, last: "用 OWNWARD_OBSERVATION_TIMEOUT_SEC", pending: [{ toolName: "AskUserQuestion", brief: "请选择" }], turn: "", backend: "claude" },
      ]);
      expect(r.searchRunner).toEqual([["runner-task", "assistant", "alpha", "第2答：[左读右改]，meta-read 在左"], ["runner-task", "assistant", "alpha", "第1答：[左读右改]，meta-read 在左"]]);
      expect(r.searchLegacy).toEqual([["legacy-task", "user", "老会话"]]);
      expect(r.searchLegacyAnswer).toBe(1);                                       // 大小写不敏感
      expect(r.status).toEqual([2, 6, 3]);
      expect(r.rebuilt).toEqual([true, 2]);
      expect(r.afterGc).toEqual([1, ["runner:runner-task"], 0]);
      expect(readFileSync(join(data, "index", "sessions.sqlite")).length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
