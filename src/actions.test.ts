import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
test("revive reopens only terminal actions and preserves snooze state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-actions-"));
  try {
    const mod = JSON.stringify(join(import.meta.dir, "actions.ts")),
      script = `import{openAction,setActionState,listActions,resolveActionExact}from ${mod};const base={kind:"review",source:"github",title:"x",reason:"x",ref:{}};openAction({id:"s",...base});setActionState("s","snoozed",60);openAction({id:"s",...base},{revive:true});openAction({id:"r",...base});setActionState("r","resolved");openAction({id:"r",...base},{revive:true});openAction({id:"prefix",...base});openAction({id:"prefix-child",...base});const exact=resolveActionExact("prefix","ignored");console.log(JSON.stringify({rows:listActions(true),exact}))`,
      proc = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, OWNWARD_DATA_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      }),
      out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1)!), rows = result.rows;
    expect(result.exact).toBeTrue();
    expect(rows.find((x: any) => x.id === "prefix")).toMatchObject({ state: "resolved", resolution: "ignored" });
    expect(rows.find((x: any) => x.id === "prefix-child")).toMatchObject({ state: "open" });
    expect(rows.find((x: any) => x.id === "s")).toMatchObject({
      state: "snoozed",
    });
    expect(rows.find((x: any) => x.id === "s").snoozedUntil).toBeString();
    expect(rows.find((x: any) => x.id === "r")).toMatchObject({
      state: "open",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批量改状态：一次写盘、只认还在册的 id、快照里被收掉的静默跳过", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-actions-batch-"));
  try {
    const mod = JSON.stringify(join(import.meta.dir, "actions.ts")),
      script = `import{openAction,setActionStates,listActions}from ${mod};const base={kind:"review",source:"github",title:"x",reason:"x",ref:{}};for(const id of["a","b","c"])openAction({id,...base});` +
        // 混一个不存在的 id：今天页勾完到提交之间，某条可能已被别处收掉
        `const done=setActionStates(["a","b","ghost"],"resolved");const none=setActionStates([],"dismissed");const snoozed=setActionStates(["c"],"snoozed",30);` +
        `console.log(JSON.stringify({done,none,snoozed,rows:listActions(true)}))`,
      proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }),
      out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!), by = (id: string) => r.rows.find((x: any) => x.id === id);
    expect(r.done).toBe(2);       // ghost 不计数
    expect(r.none).toBe(0);       // 空选不写盘
    expect(r.snoozed).toBe(1);
    expect(by("a")).toMatchObject({ state: "resolved", resolution: "manual" });
    expect(by("b")).toMatchObject({ state: "resolved", resolution: "manual" });
    expect(by("c")).toMatchObject({ state: "snoozed" });
    expect(by("c").snoozedUntil).toBeString();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** 每个用例独立进程 + 独立数据根：actions.ts 在模块级缓存 DATA 和列表 */
async function runIsolated(prefix: string, script: (mod: string) => string, seed?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    seed?.(root);
    const proc = Bun.spawn([process.execPath, "-e", script(JSON.stringify(join(import.meta.dir, "actions.ts")))], {
        env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe",
      }),
      [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    return { root, r: JSON.parse(out.trim().split("\n").at(-1)!), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (e) { rmSync(root, { recursive: true, force: true }); throw e; }
}

const STAGE = `const stage=(sig,status="ready")=>({status,kind:"reply_draft",inputSig:sig,attempt:1,updatedAt:new Date().toISOString(),preview:"p"});`;

test("setActionStage：CAS 签名一致才写回、终态与不存在的 Action 拒写", async () => {
  const { r, cleanup } = await runIsolated("ownward-actions-stage-", (mod) =>
    `import{openAction,setActionStage,setActionState,listActions}from ${mod};${STAGE}const base={kind:"reply",source:"lark",title:"x",reason:"x",ref:{}};` +
    `openAction({id:"a",...base});openAction({id:"done",...base});setActionState("done","resolved");openAction({id:"gone",...base});setActionState("gone","dismissed");` +
    `const out={};` +
    `out.first=setActionStage("a",stage("s1","running"),{inputSig:"s1"});` +       // 尚无 stage：无从比较，放行
    `out.match=setActionStage("a",stage("s1"),{inputSig:"s1"});` +
    `out.mismatch=setActionStage("a",stage("s2"),{inputSig:"s0"});` +              // 期间输入已变，结果作废
    `out.noExpect=setActionStage("a",stage("s3","queued"));` +                    // 不带 expect 直接覆盖
    `out.missing=setActionStage("ghost",stage("s1"));` +
    `out.resolved=setActionStage("done",stage("s1"));out.dismissed=setActionStage("gone",stage("s1"));` +
    `out.rows=listActions(true);console.log(JSON.stringify(out));`);
  try {
    const by = (id: string) => r.rows.find((x: any) => x.id === id);
    expect(r).toMatchObject({ first: true, match: true, mismatch: false, noExpect: true, missing: false, resolved: false, dismissed: false });
    expect(by("a").stage).toMatchObject({ status: "queued", inputSig: "s3" });
    expect(by("done").stage).toBeUndefined();
    expect(by("gone").stage).toBeUndefined();
  } finally { cleanup(); }
});

test("setActionStage：mismatch 不改动已存 stage", async () => {
  const { r, cleanup } = await runIsolated("ownward-actions-stage-cas-", (mod) =>
    `import{openAction,setActionStage,listActions}from ${mod};${STAGE}openAction({id:"a",kind:"reply",source:"lark",title:"x",reason:"x",ref:{}});` +
    `setActionStage("a",stage("s1"));const ok=setActionStage("a",stage("s9","failed"),{inputSig:"s2"});` +
    `console.log(JSON.stringify({ok,stage:listActions(false)[0].stage}))`);
  try {
    expect(r.ok).toBeFalse();
    expect(r.stage).toMatchObject({ status: "ready", inputSig: "s1" });
  } finally { cleanup(); }
});

test("openAction：reason 变化或 revive 时把 ready 的 stage 标 stale，其余不动", async () => {
  const { r, cleanup } = await runIsolated("ownward-actions-stale-", (mod) =>
    `import{openAction,setActionStage,setActionState,listActions}from ${mod};${STAGE}const base={kind:"reply",source:"lark",title:"x",reason:"r1",ref:{}};` +
    `for(const id of["reason","same","revive","running","terminal"])openAction({id,...base});` +
    `for(const id of["reason","same","revive","terminal"])setActionStage(id,stage("s1"));setActionStage("running",stage("s1","running"));` +
    `const before=Object.fromEntries(listActions(false).map(a=>[a.id,a.stage.updatedAt]));` +
    `await Bun.sleep(5);` +
    `openAction({id:"reason",...base,reason:"r2"});openAction({id:"same",...base,title:"新标题"});openAction({id:"revive",...base},{revive:true});` +
    `openAction({id:"running",...base,reason:"r2"});` +
    `setActionState("terminal","resolved");openAction({id:"terminal",...base},{revive:true});` +
    `console.log(JSON.stringify({before,rows:listActions(true)}))`);
  try {
    const by = (id: string) => r.rows.find((x: any) => x.id === id);
    expect(by("reason").stage.status).toBe("stale");
    expect(by("reason").stage.updatedAt > r.before.reason).toBeTrue();
    expect(by("revive").stage.status).toBe("stale");
    expect(by("terminal")).toMatchObject({ state: "open", stage: { status: "stale" } });
    expect(by("same").stage.status).toBe("ready");           // 只改标题不算输入变化
    expect(by("same").stage.updatedAt).toBe(r.before.same);
    expect(by("running").stage.status).toBe("running");     // 只有 ready 会过期，运行中的交给 CAS 兜
  } finally { cleanup(); }
});

test("StageArtifact：存取删生命周期、文件名是 sha256 前 16 位、原子写不留临时文件", async () => {
  const { root, r, cleanup } = await runIsolated("ownward-actions-artifact-", (mod) =>
    `import{getStageArtifact,saveStageArtifact,deleteStageArtifact}from ${mod};import{readdirSync}from"fs";import{join}from"path";` +
    `const id="lark:oc_x/msg 1",art={v:1,actionId:id,kind:"reply_draft",inputSig:"s1",createdAt:new Date().toISOString(),engine:"claude",model:"sonnet",body:"草稿",caveats:["c"],basis:[{label:"消息",at:"t"}]};` +
    `const out={};out.missing=getStageArtifact(id);saveStageArtifact(art);out.got=getStageArtifact(id);` +
    `saveStageArtifact({...art,inputSig:"s2",body:"新稿"});out.overwritten=getStageArtifact(id);` +
    `out.files=readdirSync(join(process.env.OWNWARD_DATA_ROOT,"stages"));out.other=getStageArtifact("another");` +
    `deleteStageArtifact(id);deleteStageArtifact(id);out.afterDelete=getStageArtifact(id);` +   // 重复删除幂等
    `console.log(JSON.stringify(out))`);
  try {
    const name = new Bun.CryptoHasher("sha256").update("lark:oc_x/msg 1").digest("hex").slice(0, 16) + ".json";
    expect(r.missing).toBeNull();
    expect(r.got).toMatchObject({ v: 1, actionId: "lark:oc_x/msg 1", body: "草稿", caveats: ["c"], basis: [{ label: "消息", at: "t" }] });
    expect(r.overwritten).toMatchObject({ inputSig: "s2", body: "新稿" });
    expect(r.files).toEqual([name]);
    expect(r.other).toBeNull();
    expect(r.afterDelete).toBeNull();
    expect(existsSync(join(root, "stages", name))).toBeFalse();
  } finally { cleanup(); }
});

test("getStageArtifact：文件 actionId 对不上（截断碰撞）或坏 JSON 时返回 null", async () => {
  const { r, cleanup } = await runIsolated("ownward-actions-artifact-bad-", (mod) =>
    `import{getStageArtifact}from ${mod};console.log(JSON.stringify({wrong:getStageArtifact("a"),broken:getStageArtifact("b")}))`,
    (root) => {
      const file = (id: string) => join(root, "stages", new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 16) + ".json");
      mkdirSync(join(root, "stages"), { recursive: true });
      writeFileSync(file("a"), JSON.stringify({ v: 1, actionId: "not-a" }));
      writeFileSync(file("b"), "{oops");
    });
  try { expect(r).toEqual({ wrong: null, broken: null }); } finally { cleanup(); }
});

test("sweepActions：清掉过期终态记录时一并删除其 stage 产物，在册的保留", async () => {
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString(), fresh = new Date().toISOString();
  const row = (id: string, state: string, updatedAt: string) =>
    ({ id, kind: "reply", source: "lark", title: "x", reason: "x", state, createdAt: old, updatedAt, ref: {} });
  const { r, cleanup } = await runIsolated("ownward-actions-sweep-", (mod) =>
    `import{getStageArtifact,saveStageArtifact,sweepActions,listActions}from ${mod};` +
    `const art=(id)=>({v:1,actionId:id,kind:"reply_draft",inputSig:"s",createdAt:new Date().toISOString(),engine:"claude",model:"sonnet",body:"b",caveats:[],basis:[]});` +
    `const ids=["oldResolved","oldDismissed","recentResolved","oldOpen"];for(const id of ids)saveStageArtifact(art(id));` +
    `sweepActions();console.log(JSON.stringify({kept:listActions(true).map(a=>a.id).sort(),arts:Object.fromEntries(ids.map(id=>[id,!!getStageArtifact(id)]))}))`,
    (root) => writeFileSync(join(root, "actions.json"), JSON.stringify([
      row("oldResolved", "resolved", old), row("oldDismissed", "dismissed", old),
      row("recentResolved", "resolved", fresh), row("oldOpen", "open", old),
    ])));
  try {
    expect(r.kept).toEqual(["oldOpen", "recentResolved"]);
    expect(r.arts).toEqual({ oldResolved: false, oldDismissed: false, recentResolved: true, oldOpen: true });
  } finally { cleanup(); }
});

test("/api/actions/state 批量端点：ids 优先、空/超量/坏 state 被挡、部分失效如实回报", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-actions-api-"));
  try {
    const actions = JSON.stringify(join(import.meta.dir, "actions.ts")),
      wb = JSON.stringify(join(import.meta.dir, "workbench.ts")),
      script = `const{openAction,listActions}=await import(${actions});const base={kind:"review",source:"github",title:"x",reason:"x",ref:{}};` +
        `for(const id of["a","b","c"])openAction({id,...base});` +
        `const{handleWorkbench}=await import(${wb});` +
        `const post=async(body)=>{const u=new URL("http://localhost/api/actions/state");` +
        `const r=await handleWorkbench(new Request(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),u);` +
        `return{status:r.status,body:await r.json()}};` +
        `const out={};` +
        `out.badState=await post({ids:["a"],state:"nope"});` +
        `out.empty=await post({ids:[],state:"resolved"});` +
        `out.tooMany=await post({ids:Array.from({length:501},(_,i)=>"x"+i),state:"resolved"});` +
        `out.partial=await post({ids:["a","ghost"],state:"resolved"});` +
        // ids 与 id 同时给：ids 优先，b 不应被动到
        `out.idsWin=await post({ids:["c"],id:"b",state:"dismissed"});` +
        `out.noId=await post({state:"resolved"});` +
        `out.rows=listActions(true);console.log(JSON.stringify(out));`,
      proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }),
      [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!), by = (id: string) => r.rows.find((x: any) => x.id === id);
    expect(r.badState.status).toBe(400);
    expect(r.empty.status).toBe(400);
    expect(r.tooMany.status).toBe(400);
    expect(r.noId.status).toBe(400);
    expect(r.partial.body).toMatchObject({ ok: true, changed: 1 });
    expect(r.partial.body.msg).toContain("已不在待办中");   // 不假装两条都成功
    expect(r.idsWin.body).toMatchObject({ ok: true, changed: 1 });
    expect(by("a")).toMatchObject({ state: "resolved" });
    expect(by("b")).toMatchObject({ state: "open" });        // id 被 ids 压住，没被误伤
    expect(by("c")).toMatchObject({ state: "dismissed" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
