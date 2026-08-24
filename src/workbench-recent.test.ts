import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("recent Ownward sessions", () => {
  test("Runner-native task is visible without legacy task sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-recent-runner-")), cwd = join(root, "project");
    try {
      mkdirSync(cwd); mkdirSync(join(root, "data"));
      writeFileSync(join(root, "data/tasks.json"), JSON.stringify([
        { id: "task-new", project: "project", projectDir: cwd, cwd, task: "首轮问题", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:00:00.000Z", status: "running" },
        { id: "task-accepted", project: "project", projectDir: cwd, cwd, task: "刚刚派发", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:01:00.000Z", status: "running" },
        { id: "task-adopted", project: "project", projectDir: cwd, cwd, task: "旧首问", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:02:00.000Z", status: "running" },
        { id: "multi-old", project: "project", projectDir: cwd, cwd, task: "旧别名", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:03:00.000Z", status: "running" },
        { id: "multi-new", project: "project", projectDir: cwd, cwd, task: "新别名", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:04:00.000Z", status: "running" },
        { id: "task-reset", project: "project", projectDir: cwd, cwd, task: "新会话输入", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:06:00.000Z", status: "running" },
      ]));
      const script = `
        import { SessionRepository } from ${JSON.stringify(join(import.meta.dir, "sessions/repository.ts"))};
        import { RunnerCommandJournal, RunnerEventJournal } from ${JSON.stringify(join(import.meta.dir, "runner/journals.ts"))};
        import { readInitialHistorySnapshot, writeInitialHistory } from ${JSON.stringify(join(import.meta.dir, "kernel/sessions/initial-history.ts"))};
        const data=${JSON.stringify(join(root, "data"))},cwd=${JSON.stringify(cwd)};
        new SessionRepository(data).bind({taskId:"task-new",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000001",cwd,source:"native"});
        new RunnerCommandJournal(data).accept({commandId:"command-new",kind:"start-run",runId:"run-new",sessionId:"task-new",providerId:"codex",input:JSON.stringify({text:"首轮问题"})},"2026-08-18T09:00:00.000Z");
        new RunnerEventJournal(data).append({eventId:"started-new",type:"started",at:"2026-08-18T09:00:00.500Z",commandId:"command-new",runId:"run-new",sessionId:"task-new",providerId:"codex"});
        new RunnerEventJournal(data).append({eventId:"message-new",type:"message-completed",at:"2026-08-18T09:00:01.000Z",commandId:"command-new",runId:"run-new",sessionId:"task-new",providerId:"codex",payload:JSON.stringify({text:"首轮回答"})});
        new RunnerCommandJournal(data).accept({commandId:"command-followup",kind:"resume-run",runId:"run-followup",sessionId:"task-new",providerId:"codex",input:JSON.stringify({text:"继续追问"})},"2026-08-18T09:00:02.000Z");
        new SessionRepository(data).bind({taskId:"task-accepted",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000002",cwd,source:"native"});
        new RunnerCommandJournal(data).accept({commandId:"command-accepted",kind:"start-run",runId:"run-accepted",sessionId:"task-accepted",providerId:"codex",input:JSON.stringify({text:"刚刚派发"})},"2026-08-18T09:01:00.000Z");
        const adopted=new SessionRepository(data).bind({taskId:"task-adopted",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000003",cwd,source:"adopted"}),adoptedAt=Date.parse(adopted.createdAt);
        writeInitialHistory(data,{sessionId:"task-adopted",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000003",messages:[{role:"user",text:"旧首问",ts:new Date(adoptedAt-2000).toISOString()},{role:"assistant",text:"旧回答",ts:new Date(adoptedAt-1000).toISOString()},{role:"user",text:"已回填追问",ts:new Date(adoptedAt+1).toISOString()}]});
        const copiedAt=Date.parse(readInitialHistorySnapshot(data,"task-adopted").copiedAt);
        new RunnerCommandJournal(data).accept({commandId:"command-adopted-overlap",kind:"resume-run",runId:"run-adopted-overlap",sessionId:"task-adopted",providerId:"codex",input:JSON.stringify({text:"已回填追问"})},new Date(copiedAt-1).toISOString());
        new RunnerCommandJournal(data).accept({commandId:"command-adopted-race",kind:"resume-run",runId:"run-adopted-race",sessionId:"task-adopted",providerId:"codex",input:JSON.stringify({text:"窗口内未回填"})},new Date(copiedAt-1).toISOString());
        new RunnerCommandJournal(data).accept({commandId:"command-adopted",kind:"resume-run",runId:"run-adopted",sessionId:"task-adopted",providerId:"codex",input:JSON.stringify({text:"接管后追问"})},new Date(copiedAt+1).toISOString());
        new SessionRepository(data).bind({taskId:"multi-old",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000004",cwd,source:"native"});
        new SessionRepository(data).bind({taskId:"multi-new",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000004",cwd,source:"native"});
        new RunnerCommandJournal(data).accept({commandId:"command-multi",kind:"start-run",runId:"run-multi",sessionId:"multi-old",providerId:"codex",input:JSON.stringify({text:"别名会话"})},"2026-08-18T09:03:00.000Z");
        const resetRepo=new SessionRepository(data);resetRepo.bind({taskId:"task-reset",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000005",cwd,source:"native"});
        new RunnerCommandJournal(data).accept({commandId:"command-before-reset",kind:"start-run",runId:"run-before-reset",sessionId:"task-reset",providerId:"codex",input:JSON.stringify({text:"旧会话输入"})},"2026-08-18T09:05:00.000Z");
        new RunnerCommandJournal(data).accept({commandId:"command-reset",kind:"new-session",runId:"run-reset",sessionId:"task-reset",providerId:"codex",input:"{}"},"2026-08-18T09:05:01.000Z");resetRepo.beginHistoryReset("task-reset","command-reset");
        new RunnerEventJournal(data).append({eventId:"started-reset",type:"started",at:"2026-08-18T09:05:01.500Z",commandId:"command-reset",runId:"run-reset",sessionId:"task-reset",providerId:"codex"});
        new RunnerEventJournal(data).append({eventId:"completed-reset",type:"completed",at:"2026-08-18T09:05:02.000Z",commandId:"command-reset",runId:"run-reset",sessionId:"task-reset",providerId:"codex"});resetRepo.finishHistoryReset("task-reset","command-reset",true);
        new RunnerCommandJournal(data).accept({commandId:"command-after-reset",kind:"start-run",runId:"run-after-reset",sessionId:"task-reset",providerId:"codex",input:JSON.stringify({text:"新会话输入"})},"2026-08-18T09:06:00.000Z");
        const {handleWorkbench}=await import(${JSON.stringify(join(import.meta.dir, "workbench.ts"))});
        const url=new URL("http://localhost/api/dev/recent"),response=await handleWorkbench(new Request(url),url);
        console.log(await response.text());`;
      const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: join(root, "data") }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, err).toBe(0);
      const recent = JSON.parse(out.trim().split("\n").at(-1)!);
      expect(recent).toContainEqual(expect.objectContaining({ id: "task-new", msgs: 3, userMsgs: 2, last: "我：继续追问" }));
      expect(recent).toContainEqual(expect.objectContaining({ id: "task-accepted", msgs: 1, userMsgs: 1, last: "我：刚刚派发" }));
      expect(recent).toContainEqual(expect.objectContaining({ id: "task-adopted", msgs: 5, userMsgs: 4, last: "我：接管后追问" }));
      expect(recent).toContainEqual(expect.objectContaining({ id: "multi-new", msgs: 1, userMsgs: 1 }));
      expect(recent.some((item:any) => item.id === "multi-old")).toBeFalse();
      expect(recent).toContainEqual(expect.objectContaining({ id: "task-reset", msgs: 1, userMsgs: 1, last: "我：新会话输入" }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("corrupt Runner journal degrades to legacy recent sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-recent-corrupt-")), data = join(root, "data"), cwd = join(root, "project");
    try {
      mkdirSync(cwd); mkdirSync(join(data, "tasks"), { recursive: true }); mkdirSync(join(data, "runner"));
      writeFileSync(join(data, "tasks.json"), JSON.stringify([
        { id: "native", project: "project", cwd, task: "native", mode: "codex-bg", engine: true, startedAt: "2026-08-18T09:00:00.000Z", status: "running" },
        { id: "legacy", project: "project", cwd, task: "legacy", mode: "claude-bg", engine: true, startedAt: "2026-08-18T08:00:00.000Z", status: "exited" },
      ]));
      writeFileSync(join(data, "tasks/legacy.session.json"), JSON.stringify({ messages: [{ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" }], lastActivityAt: 1787040000000 }));
      writeFileSync(join(data, "runner/events.jsonl"), "{broken}\n");
      const script = `import{SessionRepository}from ${JSON.stringify(join(import.meta.dir,"sessions/repository.ts"))};const data=${JSON.stringify(data)},cwd=${JSON.stringify(cwd)};new SessionRepository(data).bind({taskId:"native",providerId:"codex",nativeRef:"00000000-0000-4000-8000-000000000009",cwd,source:"native"});const{handleWorkbench}=await import(${JSON.stringify(join(import.meta.dir,"workbench.ts"))});const u=new URL("http://localhost/api/dev/recent"),r=await handleWorkbench(new Request(u),u);console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
      const proc=Bun.spawn([process.execPath,"--eval",script],{cwd:import.meta.dir,env:{...process.env,OWNWARD_DATA_ROOT:data},stdout:"pipe",stderr:"pipe"}),[out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      expect(code,err).toBe(0);const result=JSON.parse(out.trim().split("\n").at(-1)!);expect(result.status).toBe(200);expect(result.body).toContainEqual(expect.objectContaining({id:"legacy",msgs:2,last:"旧回答"}));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
