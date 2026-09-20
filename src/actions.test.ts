import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
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
