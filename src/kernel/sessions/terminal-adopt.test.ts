import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildTerminalShellCommand } from "../../dispatch.ts";
import { consumeTerminalAdoptLaunch, createTerminalAdoptLaunch, TerminalAdoptError } from "./terminal-adopt.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = realpathSync(mkdtempSync(join(tmpdir(), "ownward-terminal-adopt-"))); roots.push(value); return value; }

describe("Terminal launch-to-adopt handshake", () => {
  test("uses high-entropy private token storage and keeps the token out of Terminal argv", () => {
    const data = root(), cwd = root(), launch = createTerminalAdoptLaunch(data, { taskId: "task-1", providerId: "claude", cwd });
    const token = readFileSync(launch.tokenFile, "utf8").split("\n")[0], command = buildTerminalShellCommand(cwd, "safe task", "task-1", launch, 4517);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(statSync(launch.tokenFile).mode & 0o077).toBe(0);
    expect(command).toContain(launch.launchId);
    expect(command).toContain(launch.tokenFile);
    expect(command).not.toContain(token);
    expect(command).not.toContain("X-Ownward-Adopt-Token");
  });

  test("binds task/provider/cwd, is single-use, and wrong binding does not consume", async () => {
    const data = root(), cwd = root(), launch = createTerminalAdoptLaunch(data, { taskId: "task-1", providerId: "claude", cwd }), token = readFileSync(launch.tokenFile, "utf8").split("\n")[0];
    let adopted = 0;
    await expect(consumeTerminalAdoptLaunch(data, { launchId: launch.launchId, token, taskId: "other", providerId: "claude", cwd, nativeRef: "session-12345678" }, async () => ({ id: "bad" }))).rejects.toMatchObject({ code: "TERMINAL_ADOPT_BINDING_MISMATCH" });
    const result = await consumeTerminalAdoptLaunch(data, { launchId: launch.launchId, token, taskId: "task-1", providerId: "claude", cwd, nativeRef: "session-12345678" }, async () => ({ id: `session-${++adopted}` }));
    expect(result.session.id).toBe("session-1");
    await expect(consumeTerminalAdoptLaunch(data, { launchId: launch.launchId, token, taskId: "task-1", providerId: "claude", cwd, nativeRef: "session-12345678" }, async () => ({ id: "replayed" }))).rejects.toBeInstanceOf(TerminalAdoptError);
    expect(adopted).toBe(1);
    const receipts = readFileSync(join(data, "terminal-adopt/receipts.jsonl"), "utf8");
    expect(receipts).toContain('"outcome":"adopted"');
    expect(receipts).not.toContain(token);
    expect(receipts).not.toContain("session-12345678");
  });

  test("expired, insecure, and failed adoption never report a successful session", async () => {
    const data = root(), cwd = root(), expired = createTerminalAdoptLaunch(data, { taskId: "task-expired", providerId: "claude", cwd, now: new Date("2026-08-17T00:00:00Z"), ttlMs: 1_000 }), token = readFileSync(expired.tokenFile, "utf8").split("\n")[0];
    let called = false;
    await expect(consumeTerminalAdoptLaunch(data, { launchId: expired.launchId, token, taskId: "task-expired", providerId: "claude", cwd, nativeRef: "session-expired", now: new Date("2026-08-17T00:00:02Z") }, async () => { called = true; return { id: "fake" }; })).rejects.toMatchObject({ code: "TERMINAL_ADOPT_EXPIRED" });
    expect(called).toBeFalse();

    const insecure = createTerminalAdoptLaunch(data, { taskId: "task-insecure", providerId: "claude", cwd });
    chmodSync(insecure.tokenFile, 0o644);
    await expect(consumeTerminalAdoptLaunch(data, { launchId: insecure.launchId, token: readFileSync(insecure.tokenFile, "utf8").split("\n")[0], taskId: "task-insecure", providerId: "claude", cwd, nativeRef: "session-insecure" }, async () => ({ id: "fake" }))).rejects.toMatchObject({ code: "TERMINAL_ADOPT_FILE_INSECURE" });

    const failed = createTerminalAdoptLaunch(data, { taskId: "task-failed", providerId: "claude", cwd }), failedToken = readFileSync(failed.tokenFile, "utf8").split("\n")[0];
    await expect(consumeTerminalAdoptLaunch(data, { launchId: failed.launchId, token: failedToken, taskId: "task-failed", providerId: "claude", cwd, nativeRef: "session-failed" }, async () => { throw new Error("repository unavailable"); })).rejects.toThrow("repository unavailable");
    const retried = await consumeTerminalAdoptLaunch(data, { launchId: failed.launchId, token: failedToken, taskId: "task-failed", providerId: "claude", cwd, nativeRef: "session-failed" }, async () => ({ id: "retry-ok" }));
    expect(retried.session.id).toBe("retry-ok");
    const receipts = readFileSync(join(data, "terminal-adopt/receipts.jsonl"), "utf8");
    expect(receipts).toContain('"outcome":"adopted"');
    expect(receipts).not.toContain('"outcome":"failed"');
    expect(receipts).not.toContain('"sessionId":"fake"');
  });

  test("SESSION_RUNNER_DISABLED is retryable and does not burn the launch token", async () => {
    const data = root(), cwd = root(), launch = createTerminalAdoptLaunch(data, { taskId: "task-disabled", providerId: "claude", cwd }), token = readFileSync(launch.tokenFile, "utf8").split("\n")[0];
    await expect(consumeTerminalAdoptLaunch(data, { launchId: launch.launchId, token, taskId: "task-disabled", providerId: "claude", cwd, nativeRef: "session-disabled" }, async () => {
      throw Object.assign(new Error("runner temporarily disabled"), { code: "SESSION_RUNNER_DISABLED" });
    })).rejects.toMatchObject({ code: "SESSION_RUNNER_DISABLED" });
    const retry = await consumeTerminalAdoptLaunch(data, { launchId: launch.launchId, token, taskId: "task-disabled", providerId: "claude", cwd, nativeRef: "session-disabled" }, async () => ({ id: "retry-ok" }));
    expect(retry.session.id).toBe("retry-ok");
  });

  test("an expired credential for an adopted session rotates without revoking the stable binding",async()=>{
    const data=root(),cwd=root(),launch=createTerminalAdoptLaunch(data,{taskId:"task-rotate",providerId:"claude",cwd,now:new Date("2026-08-17T00:00:00Z"),ttlMs:1_000});
    const first=readFileSync(launch.tokenFile,"utf8").split("\n")[0];
    await consumeTerminalAdoptLaunch(data,{launchId:launch.launchId,token:first,taskId:"task-rotate",providerId:"claude",cwd,nativeRef:"session-rotate-a",now:new Date("2026-08-17T00:00:00.500Z")},async()=>({id:"stable-session"}));
    const expired=readFileSync(launch.tokenFile,"utf8").split("\n")[0];
    await expect(consumeTerminalAdoptLaunch(data,{launchId:launch.launchId,token:expired,taskId:"task-rotate",providerId:"claude",cwd,nativeRef:"session-rotate-b",now:new Date("2026-08-17T00:06:00Z")},async()=>({id:"stable-session"}))).rejects.toMatchObject({code:"TERMINAL_ADOPT_EXPIRED"});
    const renewed=readFileSync(launch.tokenFile,"utf8").split("\n")[0];expect(renewed).not.toBe(expired);
    const result=await consumeTerminalAdoptLaunch(data,{launchId:launch.launchId,token:renewed,taskId:"task-rotate",providerId:"claude",cwd,nativeRef:"session-rotate-b",now:new Date("2026-08-17T00:06:01Z")},async()=>({id:"stable-session"}));
    expect(result.session.id).toBe("stable-session");
  });

  test("real launcher record reaches /api/cc-hook and SessionService.adopt exactly once", async () => {
    const workspace = process.cwd(), data = root(), home = root(), cwd = root();
    const script = `
      import {mkdirSync,readFileSync} from "fs";
      import {join} from "path";
      import {saveTasks,buildTerminalShellCommand} from ${JSON.stringify(join(workspace, "src/dispatch.ts"))};
      import {createTerminalAdoptLaunch} from ${JSON.stringify(join(workspace, "src/kernel/sessions/terminal-adopt.ts"))};
      import {createBuiltinDevDomain,scopedSessions,scopedTasks} from ${JSON.stringify(join(workspace, "src/verticals.ts"))};
      import {SessionRepository} from ${JSON.stringify(join(workspace, "src/sessions/repository.ts"))};
      import {writeInitialHistory} from ${JSON.stringify(join(workspace, "src/kernel/sessions/initial-history.ts"))};
      const data=process.env.OWNWARD_DATA_ROOT,cwd=${JSON.stringify(cwd)},taskId="terminal-task",nativeRef="session-12345678";
      mkdirSync(join(process.env.HOME,".claude/projects/-fixture"),{recursive:true});
      writeInitialHistory(data,{sessionId:taskId,providerId:"claude",nativeRef,messages:[{role:"system",text:"fixture history"}]});
      const launch=createTerminalAdoptLaunch(data,{taskId,providerId:"claude",cwd});
      saveTasks([{id:taskId,project:"fixture",projectDir:cwd,cwd,task:"test",mode:"terminal",terminalLaunchId:launch.launchId,startedAt:new Date().toISOString(),status:"running"}]);
      const token=readFileSync(launch.tokenFile,"utf8").split("\\n")[0],command=buildTerminalShellCommand(cwd,"test",taskId,launch,4517);
      const url=new URL("http://localhost/api/cc-hook?taskId="+taskId),body={hook_event_name:"SessionStart",session_id:nativeRef,cwd,transcript_path:join(process.env.HOME,".claude/projects/-fixture",nativeRef+".jsonl")};
      const handler=createBuiltinDevDomain({id:"dev",config:{},tasks:scopedTasks([cwd]),sessions:scopedSessions([cwd]),log:()=>{}}),route=(request)=>handler.route(request,url);
      const request=()=>new Request(url,{method:"POST",headers:{"content-type":"application/json","x-ownward-adopt-launch":launch.launchId,"x-ownward-adopt-token":token},body:JSON.stringify(body)});
      const first=await route(request()),firstText=await first.text(),firstBody=JSON.parse(firstText),replay=await route(request()),replayText=await replay.text(),replayBody=JSON.parse(replayText);
      const rotatedRef="session-87654321",rotatedBody={...body,session_id:rotatedRef,transcript_path:join(process.env.HOME,".claude/projects/-fixture",rotatedRef+".jsonl")},nextToken=readFileSync(launch.tokenFile,"utf8").split("\\n")[0];
      const fakeBody={...rotatedBody,transcript_path:join(process.env.HOME,".claude/projects/-fixture","forged-session.jsonl")},fake=await route(new Request(url,{method:"POST",headers:{"content-type":"application/json","x-ownward-adopt-launch":launch.launchId,"x-ownward-adopt-token":nextToken},body:JSON.stringify(fakeBody)}));
      const noToken=await route(new Request(url,{method:"POST",headers:{"content-type":"application/json","x-ownward-adopt-launch":launch.launchId},body:JSON.stringify(rotatedBody)}));
      const rotated=await route(new Request(url,{method:"POST",headers:{"content-type":"application/json","x-ownward-adopt-launch":launch.launchId,"x-ownward-adopt-token":nextToken},body:JSON.stringify(rotatedBody)})),rotatedText=await rotated.text();
      const session=new SessionRepository(data).getByTaskId(taskId),receipts=readFileSync(join(data,"terminal-adopt/receipts.jsonl"),"utf8").trim().split("\\n");
      console.log(JSON.stringify({first:first.status,replay:replay.status,replayCode:replayBody.errorCode,fake:fake.status,noToken:noToken.status,rotated:rotated.status,session:!!session,provider:session?.providerId,native:session?.nativeRef,previous:session?.previousRefs,control:session?.control,sessionId:firstBody.sessionId,receipts:receipts.length,tokenInCommand:command.includes(token),tokenLeaked:[firstText,replayText,rotatedText,...receipts].some(x=>x.includes(token)||x.includes(nextToken))}));
    `;
    // CONFIG_ROOT 指到空目录：子进程只吃 config.default.json，不吃运行环境根目录下的 config.json。
    // 不钉死的话，在主检出里会读到生产配置（allowFullAccess/allowedRoots 等），adopt 路由行为改变、
    // receipts 根本不落盘 → ENOENT 假失败（2026-08-22 实测）；worktree 里因为配置不同看不出来。
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: workspace, env: { ...process.env, HOME: home, OWNWARD_DATA_ROOT: data, OWNWARD_CONFIG_ROOT: root(), NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text(), code = await proc.exited;
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ first: 200, replay: 401, fake:400, noToken:409, rotated: 200, session: true, provider: "claude", native: "session-87654321", previous: ["session-12345678"], control: "external", receipts: 2, tokenInCommand: false, tokenLeaked: false });
    expect(result.sessionId).toBeTruthy();
  });
});
