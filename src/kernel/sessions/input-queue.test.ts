// 忙时输入队列（Runner 链路）：落盘存储的行为 + 「忙时进队列、本轮结束自动发出」的端到端。
// 背景：Runner 的 adapter 对并发 turn 直接回 PROVIDER_SESSION_BUSY，那条 run failed；
// 而消息已经进了 command journal，照样显示在会话里——用户以为发出去了，agent 从没收到。
// 这些用例守的就是「不许再出现这种静默丢消息」。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseQueued, QUEUE_MAX_ITEMS, SessionInputQueueStore } from "./input-queue.ts";
import { KernelSessionService } from "./service.ts";
import { SessionRepository } from "../../sessions/repository.ts";
import { RunnerCommandJournal } from "../../runner/journals.ts";
import { RunnerServer, type RunnerProvider } from "../../runner/server.ts";

const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "ownward-input-queue-")); roots.push(root); return root; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const until = async (probe: () => boolean, ms = 3_000) => { for (let waited = 0; waited < ms && !probe(); waited += 10) await Bun.sleep(10); return probe(); };

describe("SessionInputQueueStore", () => {
  test("排队消息落盘：daemon 重启后新实例仍能看见（Runner 的 turn 不随 daemon 一起死）", () => {
    const root = fresh(), store = new SessionInputQueueStore(root);
    expect(store.empty()).toBeTrue();
    store.push("s1", parseQueued("等会儿看下这个", []));
    expect(new SessionInputQueueStore(root).view("s1")).toMatchObject([{ text: "等会儿看下这个", btw: false, images: 0 }]);
  });
  test("撤回按 id 认人；撤不到如实回 false，不静默当成撤掉了", () => {
    const root = fresh(), store = new SessionInputQueueStore(root), a = parseQueued("同一句话", []), b = parseQueued("同一句话", []);
    store.push("s1", a); store.push("s1", b);
    expect(store.remove("s1", b.id)).toBeTrue();
    expect(store.view("s1").map((i) => i.id)).toEqual([a.id]);   // 撤掉的是点的那条，不是同文本的另一条
    expect(store.remove("s1", b.id)).toBeFalse();
    expect(store.remove("s1", "从来没有过的 id")).toBeFalse();
  });
  test("take 按斜杠命令切段，unshift 原样放回队首（发送失败不许打乱用户说话的顺序）", () => {
    const root = fresh(), store = new SessionInputQueueStore(root);
    for (const text of ["先做A", "/compact", "再做B"]) store.push("s1", parseQueued(text, []));
    const batch = store.take("s1");
    expect(batch.map((i) => i.text)).toEqual(["先做A"]);
    expect(store.view("s1").map((i) => i.text)).toEqual(["/compact", "再做B"]);
    store.unshift("s1", batch);
    expect(store.view("s1").map((i) => i.text)).toEqual(["先做A", "/compact", "再做B"]);
  });
  test("清空后文件直接删掉：绝大多数会话从不排队，热路径上 empty() 一个 existsSync 就短路", () => {
    const root = fresh(), store = new SessionInputQueueStore(root), item = parseQueued("x", []);
    store.push("s1", item); expect(existsSync(join(root, "session-input-queue.json"))).toBeTrue();
    store.remove("s1", item.id); expect(store.empty()).toBeTrue();
    expect(store.list("s1")).toEqual([]);
  });
  test("排到上限报错，不无声吃掉", () => {
    const root = fresh(), store = new SessionInputQueueStore(root);
    for (let i = 0; i < QUEUE_MAX_ITEMS; i++) store.push("s1", parseQueued(`第${i}条`, []));
    expect(() => store.push("s1", parseQueued("再来一条", []))).toThrow(/上限/);
  });
});

/** 一个跑到 `held` 才收尾的假 Provider：turn 挂住的这段时间就是「忙」 */
function heldProvider(seen: string[], held: Promise<void>): RunnerProvider {
  return { async *execute(command, input) {
    const first = seen.push(JSON.parse(input).text) === 1;
    const frame = (type: "started" | "completed") => ({ eventId: `${command.commandId}:${type}`, type, at: new Date().toISOString(), commandId: command.commandId, runId: command.runId, sessionId: command.sessionId, providerId: command.providerId } as const);
    yield frame("started");
    if (first) await held;
    yield frame("completed");
  } };
}
function seed(root: string) { const cwd = join(root, "repo"); mkdirSync(cwd); new SessionRepository(root).reserve({ taskId: "task", providerId: "claude", cwd }); }

describe("Runner 会话的忙时输入队列", () => {
  test("忙时不硬发：进队列、可见、本轮结束自动发出", async () => {
    const root = fresh(); seed(root); const seen: string[] = []; let release!: () => void;
    const server = new RunnerServer(root, () => heldProvider(seen, new Promise<void>((r) => { release = r; }))); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" });
      await service.send("task", { text: "第一句" });
      expect(await until(() => seen.length === 1)).toBeTrue();
      expect(await service.send("task", { text: "第二句" })).toEqual({ queued: true });
      // 关键：忙的时候一条命令都不许再下去（下去就是 provider_busy + 静默丢消息）
      expect(new RunnerCommandJournal(root).readStrict().filter((c) => c.kind === "start-run" || c.kind === "resume-run" || c.kind === "send-input").length).toBe(1);
      expect((await service.state("task")).queued).toMatchObject([{ text: "第二句", btw: false, images: 0 }]);
      release();
      expect(await until(() => seen.length === 2)).toBeTrue();
      expect(seen[1]).toBe("第二句");
      expect((await service.state("task")).queued ?? []).toEqual([]);
    } finally { release(); await Bun.sleep(20); server.stop(); }
  });

  test("多条合并成一帧，斜杠命令仍然独占一帧", async () => {
    const root = fresh(); seed(root); const seen: string[] = []; let release!: () => void;
    const server = new RunnerServer(root, () => heldProvider(seen, new Promise<void>((r) => { release = r; }))); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" });
      await service.send("task", { text: "开工" });
      expect(await until(() => seen.length === 1)).toBeTrue();
      for (const text of ["先做A", "再做B", "/compact"]) await service.send("task", { text });
      release();
      expect(await until(() => seen.length === 3)).toBeTrue();
      expect(seen[1]).toBe("先做A\n\n再做B");   // 普通消息合并
      expect(seen[2]).toBe("/compact");          // 命令自己一帧，不然 CC 只当普通文字
    } finally { release(); await Bun.sleep(20); server.stop(); }
  });

  test("撤回的那条永远不会发出去", async () => {
    const root = fresh(); seed(root); const seen: string[] = []; let release!: () => void;
    const server = new RunnerServer(root, () => heldProvider(seen, new Promise<void>((r) => { release = r; }))); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" });
      await service.send("task", { text: "开工" });
      expect(await until(() => seen.length === 1)).toBeTrue();
      await service.send("task", { text: "说错了这条" }); await service.send("task", { text: "这条要留着" });
      const [wrong] = (await service.state("task")).queued as { id: string }[];
      expect(await service.removeQueued("task", wrong.id)).toMatchObject({ removed: true, queued: [{ text: "这条要留着" }] });
      expect(await service.removeQueued("task", wrong.id)).toMatchObject({ removed: false });
      release();
      expect(await until(() => seen.length === 2)).toBeTrue();
      expect(seen[1]).toBe("这条要留着");
    } finally { release(); await Bun.sleep(20); server.stop(); }
  });

  // 排队不能把「重试」变成「说两遍」：clientMutationId 在下发链路（bridge）和队列里都要认
  test("客户端重试同一条消息：既不重复下发，也不重复排队", async () => {
    const root = fresh(); seed(root); const seen: string[] = []; let release!: () => void;
    const server = new RunnerServer(root, () => heldProvider(seen, new Promise<void>((r) => { release = r; }))); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" });
      const first = await service.send("task", { text: "开工", clientMutationId: "m1" });
      expect(await until(() => seen.length === 1)).toBeTrue();
      expect(await service.send("task", { text: "开工", clientMutationId: "m1" })).toEqual(first);   // 重试复用同一 identity，不排队
      await service.send("task", { text: "补一句", clientMutationId: "m2" });
      await service.send("task", { text: "补一句", clientMutationId: "m2" });
      expect((await service.state("task")).queued).toMatchObject([{ text: "补一句" }]);
    } finally { release(); await Bun.sleep(20); server.stop(); }
  });

  // HTTP 契约走一遍真 handler：客户端只认这层，service 对了但路由没接上等于没做
  test("走 /api/dev/send 与 /api/dev/queue：排队可见、可撤、撤不到回 409", async () => {
    const root = fresh(); seed(root);
    const script = `
      import {cfg} from ${JSON.stringify(join(process.cwd(), "src/util.ts"))};
      import {handleWorkbench} from ${JSON.stringify(join(process.cwd(), "src/workbench.ts"))};
      import {RunnerServer} from ${JSON.stringify(join(process.cwd(), "src/runner/server.ts"))};
      cfg.architecture.sessionRunnerMode="runner"; cfg.architecture.sessionRunnerTaskIds=[];
      const seen=[]; let release; const held=new Promise(r=>{release=r;});
      const provider={async *execute(command,input){const first=seen.push(JSON.parse(input).text)===1;
        const f=(type)=>({eventId:command.commandId+":"+type,type,at:new Date().toISOString(),commandId:command.commandId,runId:command.runId,sessionId:command.sessionId,providerId:command.providerId});
        yield f("started"); if(first) await held; yield f("completed");}};
      const server=new RunnerServer(process.env.OWNWARD_DATA_ROOT,()=>provider); server.start();
      const call=async(p,body)=>{const u=new URL("http://localhost"+p);const r=await handleWorkbench(new Request(u,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:undefined),u);return {status:r.status,body:await r.json()};};
      const until=async(probe)=>{for(let i=0;i<300&&!probe();i++)await Bun.sleep(10);};
      const sent=await call("/api/dev/send",{id:"task",text:"开工"});
      await until(()=>seen.length===1);
      const queued=await call("/api/dev/send",{id:"task",text:"说错了这条"});
      await call("/api/dev/send",{id:"task",text:"这条要留着"});
      const view=await call("/api/dev/queue?id=task");
      const gone=await call("/api/dev/queue",{id:"task",action:"remove",queueId:"从来没有过的 id"});
      const removed=await call("/api/dev/queue",{id:"task",action:"remove",queueId:view.body.queued[0].id});
      release(); await until(()=>seen.length===2);
      console.log(JSON.stringify({sent,queued,view,gone,removed,seen}));
      server.stop();`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(r.sent.body).toMatchObject({ ok: true, queued: false, msg: "已发送" });
    expect(r.queued.body).toMatchObject({ ok: true, queued: true, msg: "已加入队列，本轮结束自动发送" });
    expect(r.view.body.queued.map((q: any) => q.text)).toEqual(["说错了这条", "这条要留着"]);
    expect(r.view.body.queued.every((q: any) => typeof q.id === "string" && q.id)).toBeTrue();   // 没有 id 客户端就画不出 ✕
    expect(r.gone).toMatchObject({ status: 409, body: { ok: false, errorCode: "QUEUE_ITEM_GONE" } });
    expect(r.removed).toMatchObject({ status: 200, body: { ok: true, queued: [{ text: "这条要留着" }] } });
    expect(r.seen).toEqual(["开工", "这条要留着"]);   // 撤掉的那条自始至终没到 Provider
  });

  test("释放输入权后队列不自动续发：留着等重新接管，不绕过租约", async () => {
    const root = fresh(); seed(root); const seen: string[] = []; let release!: () => void;
    const server = new RunnerServer(root, () => heldProvider(seen, new Promise<void>((r) => { release = r; }))); server.start();
    try {
      const service = new KernelSessionService(root, { mode: "runner" });
      await service.send("task", { text: "开工" });
      expect(await until(() => seen.length === 1)).toBeTrue();
      await service.send("task", { text: "本轮结束再说" });
      await service.acquireControl("task", "observing");
      release();
      await Bun.sleep(300);
      expect(seen.length).toBe(1);
      expect((await service.state("task")).queued).toMatchObject([{ text: "本轮结束再说" }]);
      await service.acquireControl("task", "ownward");
      expect(await until(() => seen.length === 2)).toBeTrue();   // 接管回来就接着发
    } finally { release(); await Bun.sleep(20); server.stop(); }
  });
});
