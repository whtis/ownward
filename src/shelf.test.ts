// 助理货架：子进程 + 独立 OWNWARD_DATA_ROOT，不碰真实 data/shelf.json，也不真派任务。
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mod = (f: string) => JSON.stringify(join(import.meta.dir, f));

async function runScript(body: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "ownward-shelf-"));
  try {
    const script = `const S=await import(${mod("shelf.ts")});const A=await import(${mod("actions.ts")});const out={};` +
      `const T0=new Date("2026-10-15T00:00:00Z");const at=(h)=>new Date(T0.getTime()+h*3600000);` + body + `;console.log(JSON.stringify(out));`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("recordShelfItems：确定性 id、72h TTL、坏条目丢弃、过期自动下架", async () => {
  const r = await runScript(
    `S.recordShelfItems([{category:"risk",title:"CI 连挂",detail:"main 连续 3 次失败"},{category:"nope",title:"x",detail:""},{category:"pattern",title:"  ",detail:""}],T0);` +
    `out.items=S.listShelfItems(at(1));out.id=S.shelfItemId("risk","CI 连挂");` +
    `out.at71=S.listShelfItems(at(71.9)).length;out.at72=S.listShelfItems(at(72)).length`);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]).toMatchObject({ id: r.id, category: "risk", title: "CI 连挂", createdAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-18T00:00:00.000Z" });
  expect(r.id).toMatch(/^[0-9a-f]{16}$/);
  expect(r.at71).toBe(1);
  expect(r.at72).toBe(0);
});

test("recordShelfItems：同 id 去重只刷新内容不续期；超过 5 条挤掉最老的", async () => {
  const r = await runScript(
    `S.recordShelfItems([{category:"suggestion",title:"t0",detail:"旧"}],T0);` +
    `S.recordShelfItems([{category:"suggestion",title:"t0",detail:"新"},{category:"suggestion",title:"t0",detail:"新2"}],at(1));` +
    `out.dedup=S.listShelfItems(at(2));` +
    `for(let i=1;i<=5;i++)S.recordShelfItems([{category:"pattern",title:"p"+i,detail:""}],at(1+i));` +
    `out.capped=S.listShelfItems(at(10)).map(x=>x.title)`);
  expect(r.dedup).toHaveLength(1);
  expect(r.dedup[0]).toMatchObject({ detail: "新2", createdAt: "2026-10-15T00:00:00.000Z" });
  expect(r.capped).toEqual(["p5", "p4", "p3", "p2", "p1"]);
});

test("actionSuggestion 规整：task 缺 prompt / 未知 kind 只丢建议，action payload 白名单", async () => {
  const r = await runScript(
    `S.recordShelfItems([` +
    `{category:"suggestion",title:"a",detail:"",actionSuggestion:{kind:"task",label:"派"}},` +
    `{category:"suggestion",title:"b",detail:"",actionSuggestion:{kind:"rm -rf",label:"x"}},` +
    `{category:"suggestion",title:"c",detail:"",actionSuggestion:{kind:"action",label:"跟进",actionPayload:{kind:"evil",title:"T",url:"javascript:alert(1)",extra:1}}}],T0);` +
    `out.rows=Object.fromEntries(S.listShelfItems(at(1)).map(x=>[x.title,x.actionSuggestion??null]))`);
  expect(r.rows.a).toBeNull();
  expect(r.rows.b).toBeNull();
  expect(r.rows.c).toEqual({ kind: "action", label: "跟进", actionPayload: { title: "T" } });
});

test("dismissShelfItem：下架，且 72h 内同一条不再上架", async () => {
  const r = await runScript(
    `S.recordShelfItems([{category:"risk",title:"r",detail:""}]);const id=S.listShelfItems()[0].id;` +
    `out.ok=S.dismissShelfItem(id);out.again=S.dismissShelfItem(id);` +
    `S.recordShelfItems([{category:"risk",title:"r",detail:"换个说法"}]);out.after=S.listShelfItems().length`);
  expect(r).toEqual({ ok: true, again: false, after: 0 });
});

test("adoptShelfItem：task 派任务、action 开行动项、派发失败不下架、没建议拒绝", async () => {
  const r = await runScript(
    `S.recordShelfItems([` +
    `{category:"suggestion",title:"task",detail:"d",actionSuggestion:{kind:"task",label:"派",prompt:"修 CI",dir:"~/x"}},` +
    `{category:"risk",title:"act",detail:"依据",actionSuggestion:{kind:"action",label:"跟进",actionPayload:{kind:"decide"}}},` +
    `{category:"pattern",title:"plain",detail:""},` +
    `{category:"suggestion",title:"boom",detail:"",actionSuggestion:{kind:"task",label:"派",prompt:"p"}}]);` +
    `const id=(t)=>S.listShelfItems().find(x=>x.title===t).id;const calls=[];` +
    `const ids={task:id("task"),act:id("act"),plain:id("plain"),boom:id("boom")};` +
    `out.task=await S.adoptShelfItem(ids.task,{dispatchTask:async(i)=>{calls.push(i);return{id:"T1"}}});` +
    `out.act=await S.adoptShelfItem(ids.act);` +
    `out.plain=await S.adoptShelfItem(ids.plain);` +
    `out.boom=await S.adoptShelfItem(ids.boom,{dispatchTask:async()=>{throw new Error("目录未授权")}});` +
    `out.ghost=await S.adoptShelfItem("ghost");` +
    `out.calls=calls;out.left=S.listShelfItems().map(x=>x.title).sort();` +
    `out.action=A.listActions(false).find(a=>a.id==="shelf:"+ids.act)`);
  expect(r.task).toEqual({ ok: true, taskId: "T1" });
  expect(r.calls).toEqual([{ dir: "~/x", prompt: "修 CI" }]);
  expect(r.act.ok).toBeTrue();
  expect(r.action).toMatchObject({ kind: "decide", source: "assistant", title: "act", reason: "依据", state: "open" });
  expect(r.plain.ok).toBeFalse();
  expect(r.boom).toEqual({ ok: false, msg: "目录未授权" });
  expect(r.ghost.ok).toBeFalse();
  expect(r.left).toEqual(["boom", "plain"]);
});

test("/api/shelf 端点 + /api/actions/investigate 的入参与重复派发闸", async () => {
  const r = await runScript(
    `const{handleWorkbench}=await import(${mod("workbench.ts")});` +
    `const call=async(method,path,body)=>{const u=new URL("http://localhost"+path);` +
    `const res=await handleWorkbench(new Request(u,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}),u);` +
    `return{status:res.status,body:await res.json()}};` +
    `S.recordShelfItems([{category:"risk",title:"r1",detail:""},{category:"pattern",title:"p1",detail:""}]);` +
    `out.list=await call("GET","/api/shelf");const id=out.list.body.find(x=>x.title==="r1").id;` +
    `out.dismissNoId=await call("POST","/api/shelf/dismiss",{});` +
    `out.dismiss=await call("POST","/api/shelf/dismiss",{id});` +
    `out.adoptPlain=await call("POST","/api/shelf/adopt",{id:out.list.body.find(x=>x.title==="p1").id});` +
    `out.after=(await call("GET","/api/shelf")).body.map(x=>x.title);` +
    `A.openAction({id:"ci1",kind:"follow_up",source:"github",title:"CI 失败",reason:"main 挂了",ref:{task_id:"T9"}});` +
    `out.invNoId=await call("POST","/api/actions/investigate",{});` +
    `out.invGhost=await call("POST","/api/actions/investigate",{id:"ghost"});` +
    `out.invDup=await call("POST","/api/actions/investigate",{id:"ci1"})`);
  expect(r.list.status).toBe(200);
  expect(r.list.body.map((x: any) => x.title).sort()).toEqual(["p1", "r1"]);
  expect(r.dismissNoId.status).toBe(400);
  expect(r.dismiss).toEqual({ status: 200, body: { ok: true } });
  expect(r.adoptPlain.status).toBe(409);
  expect(r.after).toEqual(["p1"]);
  expect(r.invNoId.status).toBe(400);
  expect(r.invGhost.status).toBe(404);
  expect(r.invDup).toEqual({ status: 409, body: { ok: false, msg: "这件事已经挂着任务了", taskId: "T9" } });
});

test("patchActionRef：合并 ref，终态拒写", async () => {
  const r = await runScript(
    `A.openAction({id:"a",kind:"follow_up",source:"x",title:"t",reason:"r",ref:{url:"https://e/x"}});` +
    `out.ok=A.patchActionRef("a",{task_id:"T1",investigated_at:"now"});out.ref=A.listActions(false)[0].ref;` +
    `A.setActionState("a","resolved");out.closed=A.patchActionRef("a",{task_id:"T2"})`);
  expect(r).toEqual({ ok: true, ref: { url: "https://e/x", task_id: "T1", investigated_at: "now" }, closed: false });
});

test("采纳说的是已挂着的事：relatesTo 或同一件事（去掉条数后标题相同）→ 不另开；指向已收尾的 → 下架报过时", async () => {
  const r = await runScript(
    `A.openAction({id:"memory:project-candidates:1",kind:"decide",source:"dispatch",title:"项目记忆候选待审（54 条）",reason:"r",ref:{}});` +
    `A.openAction({id:"gone",kind:"decide",source:"dispatch",title:"x",reason:"r",ref:{}});A.setActionState("gone","resolved");` +
    `S.recordShelfItems([` +
    `{category:"suggestion",title:"rel",detail:"",actionSuggestion:{kind:"action",label:"审",actionPayload:{kind:"review",title:"集中审核项目记忆候选（43 条）",relatesTo:"memory:project-candidates:1"}}},` +
    `{category:"suggestion",title:"same",detail:"",actionSuggestion:{kind:"action",label:"审",actionPayload:{title:"项目记忆候选待审（52 条）"}}},` +
    `{category:"suggestion",title:"stale",detail:"",actionSuggestion:{kind:"action",label:"审",actionPayload:{relatesTo:"gone"}}}]);` +
    `const id=(t)=>S.listShelfItems().find(x=>x.title===t).id;const ids={rel:id("rel"),same:id("same"),stale:id("stale")};` +
    `out.rel=await S.adoptShelfItem(ids.rel);out.same=await S.adoptShelfItem(ids.same);out.stale=await S.adoptShelfItem(ids.stale);` +
    `out.left=S.listShelfItems().length;out.open=A.listActions(false).map(a=>a.id)`);
  expect(r.rel).toEqual({ ok: true, actionId: "memory:project-candidates:1", linked: true });
  expect(r.same).toEqual({ ok: true, actionId: "memory:project-candidates:1", linked: true });
  expect(r.stale).toMatchObject({ ok: false, gone: true });
  expect(r.left).toBe(0);
  expect(r.open).toEqual(["memory:project-candidates:1"]);   // 一条冻结副本都没开
});

test("货架开的行动项带 72h 过期，到点 sweep 收成 expired；复活时续期", async () => {
  const r = await runScript(
    `S.recordShelfItems([{category:"risk",title:"act",detail:"d",actionSuggestion:{kind:"action",label:"跟进"}}]);` +
    `const sid=S.listShelfItems()[0].id;out.adopt=await S.adoptShelfItem(sid);` +
    `const a=A.listActions(false).find(x=>x.id===out.adopt.actionId);out.ttlH=Math.round((Date.parse(a.expiresAt)-Date.now())/3600000);` +
    `A.openAction({id:"old",kind:"follow_up",source:"assistant",title:"t",reason:"r",ref:{},expiresAt:new Date(Date.now()-1000).toISOString()});` +
    `A.openAction({id:"keep",kind:"follow_up",source:"github",title:"t",reason:"r",ref:{}});` +
    `A.sweepActions();out.after=A.listActions(true).map(x=>[x.id,x.state,x.resolution??null]).sort()`);
  expect(r.ttlH).toBe(72);
  expect(r.after).toEqual([["keep", "open", null], ["old", "resolved", "expired"], [r.adopt.actionId, "open", null]].sort());
});

test("心跳过滤：说的是行动队列里已有的事的观察不上货架", async () => {
  const r = await runScript(
    `const open=[{id:"memory:candidates",title:"记忆候选待确认（17 份）"}];` +
    `const obs=[{category:"suggestion",title:"a",detail:"",actionSuggestion:{kind:"action",label:"x",actionPayload:{relatesTo:"memory:candidates"}}},` +
    `{category:"suggestion",title:"b",detail:"",actionSuggestion:{kind:"action",label:"x",actionPayload:{title:"记忆候选待确认（18 份）"}}},` +
    `{category:"risk",title:"c",detail:""},` +
    `{category:"suggestion",title:"d",detail:"",actionSuggestion:{kind:"task",label:"x",prompt:"p"}}];` +
    `const res=S.dropQueuedObservations(obs,open);out.dropped=res.dropped;out.kept=res.kept.map(x=>x.title)`);
  expect(r).toEqual({ dropped: 2, kept: ["c", "d"] });
});

test("/api/actions/investigate：货架开的、审核类不派排查", async () => {
  const r = await runScript(
    `const{handleWorkbench}=await import(${mod("workbench.ts")});` +
    `const call=async(body)=>{const u=new URL("http://localhost/api/actions/investigate");` +
    `const res=await handleWorkbench(new Request(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),u);` +
    `return{status:res.status,ok:(await res.json()).ok}};` +
    `A.openAction({id:"shelf:x",kind:"review",source:"assistant",title:"集中审核项目记忆候选（43 条）",reason:"已挂 18.6h",ref:{}});` +
    `A.openAction({id:"memory:project-candidates:1",kind:"decide",source:"dispatch",title:"项目记忆候选待审（54 条）",reason:"在角色页审",ref:{}});` +
    `out.shelf=await call({id:"shelf:x"});out.mem=await call({id:"memory:project-candidates:1"});` +
    `out.rule=[A.isInvestigable({kind:"follow_up",source:"dispatch",title:"任务失败",reason:""}),A.isInvestigable({kind:"review",source:"github",title:"PR #1",reason:"等你 review"})]`);
  expect(r.shelf).toEqual({ status: 400, ok: false });
  expect(r.mem).toEqual({ status: 400, ok: false });
  expect(r.rule).toEqual([true, false]);
});
