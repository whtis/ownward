// /api/actions/stage* 端点：子进程 + 独立 OWNWARD_DATA_ROOT，不碰真实 actions.json / state.json，也不调模型。
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mod = (f: string) => JSON.stringify(join(import.meta.dir, f));

async function runScript(body: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "ownward-staging-api-"));
  try {
    const script =
      `const A=await import(${mod("actions.ts")});const{handleWorkbench}=await import(${mod("workbench.ts")});` +
      `const call=async(method,path,body)=>{const u=new URL("http://localhost"+path);` +
      `const r=await handleWorkbench(new Request(u,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}),u);` +
      `return{status:r.status,body:await r.json()}};const out={};` + body + `;console.log(JSON.stringify(out));`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("GET /api/actions/stage：有产物返回正文，没有返回 404", async () => {
  const r = await runScript(
    `A.saveStageArtifact({v:1,actionId:"lark:chat/1",kind:"reply_draft",inputSig:"s",createdAt:new Date().toISOString(),engine:"claude",model:"sonnet",body:"草稿正文",caveats:[],basis:[]});` +
    `out.hit=await call("GET","/api/actions/stage?id="+encodeURIComponent("lark:chat/1"));` +
    `out.miss=await call("GET","/api/actions/stage?id=ghost");` +
    `out.noId=await call("GET","/api/actions/stage")`);
  expect(r.hit.status).toBe(200);
  expect(r.hit.body).toMatchObject({ actionId: "lark:chat/1", body: "草稿正文" });
  expect(r.miss).toEqual({ status: 404, body: { ok: false, msg: "未找到该草稿产物" } });
  expect(r.noId.status).toBe(404);
});

test("POST /api/actions/stage/run：缺 id / 不存在 / 不支持的类型被挡；日预算用完不调模型", async () => {
  const r = await runScript(
    `const{fmt,updateState}=await import(${mod("util.ts")});` +
    `A.openAction({id:"r1",kind:"reply",source:"lark",title:"x",reason:"x",ref:{chat_id:"oc_1"}});` +
    `A.openAction({id:"f1",kind:"follow_up",source:"lark",title:"x",reason:"x",ref:{}});` +
    // 刚打开的 action 也能手动触发（不等 settleMin）——用预算耗尽来证明它确实被选中了，且没有真去调模型
    `updateState(s=>{s.staging={date:fmt(new Date(),"date"),count:999}});` +
    `out.noId=await call("POST","/api/actions/stage/run",{});` +
    `out.ghost=await call("POST","/api/actions/stage/run",{id:"ghost"});` +
    `out.unsupported=await call("POST","/api/actions/stage/run",{id:"f1"});` +
    `out.budget=await call("POST","/api/actions/stage/run",{id:"r1"});` +
    `out.stage=A.listActions(true).find(a=>a.id==="r1").stage`);
  expect(r.noId.status).toBe(400);
  expect(r.ghost.status).toBe(404);
  expect(r.unsupported.status).toBe(409);
  expect(r.budget.status).toBe(200);
  expect(r.budget.body).toMatchObject({ ok: false, status: "budget_exceeded" });
  expect(r.stage).toMatchObject({ status: "queued", kind: "reply_draft", error: "budget" });
});

test("POST /api/actions/stage/feedback：记下 outcome，Action 已收尾也照记；坏入参被挡", async () => {
  const r = await runScript(
    `A.openAction({id:"r1",kind:"reply",source:"lark",title:"x",reason:"x",ref:{}});` +
    `A.openAction({id:"r2",kind:"reply",source:"lark",title:"x",reason:"x",ref:{}});` +
    `const st={status:"ready",kind:"reply_draft",attempt:1,updatedAt:new Date().toISOString(),inputSig:"s"};` +
    `A.setActionStage("r1",{...st});A.setActionStage("r2",{...st});A.resolveActionExact("r2","replied");` +
    `out.open=await call("POST","/api/actions/stage/feedback",{id:"r1",outcome:"edited"});` +
    `out.resolved=await call("POST","/api/actions/stage/feedback",{id:"r2",outcome:"sent_as_is"});` +
    `out.bad=await call("POST","/api/actions/stage/feedback",{id:"r1",outcome:"nope"});` +
    `out.ghost=await call("POST","/api/actions/stage/feedback",{id:"ghost",outcome:"discarded"});` +
    `out.rows=Object.fromEntries(A.listActions(true).map(a=>[a.id,a.stage?.outcome]))`);
  expect(r.open).toEqual({ status: 200, body: { ok: true } });
  expect(r.resolved).toEqual({ status: 200, body: { ok: true } });
  expect(r.bad.status).toBe(400);
  expect(r.ghost.status).toBe(404);
  expect(r.rows).toEqual({ r1: "edited", r2: "sent_as_is" });
});
