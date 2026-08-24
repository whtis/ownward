import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerCommandJournal } from "../../runner/journals.ts";
import { RunRepository } from "../../runs/repository.ts";
import { SessionRepository } from "../../sessions/repository.ts";
import { closeLegacyRunningAtStartup } from "./legacy-startup-close.ts";

const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "ownward-legacy-close-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function seed(root: string, controls: Array<[string, "ownward" | "observing" | "external"]>): void {
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(join(root, "tasks.json"), JSON.stringify(controls.map(([id]) => ({ id, project: "p", projectDir: "/repo", cwd: "/repo", task: id, mode: "claude-bg", engine: true, startedAt: "2026-08-16T00:00:00.000Z", status: "running" }))));
  for (const [id, control] of controls) writeFileSync(join(root, "tasks", `${id}.session.json`), JSON.stringify({ toolSessionId: `native-${id}`, control }));
  new SessionRepository(root).reconcile();
}

describe("legacy startup close", () => {
  test("只收敛旧 daemon 的 ownward lease，observing/external 均保留并逐条审计", () => {
    const root = fresh(), audited: unknown[] = [];
    seed(root, [["owned", "ownward"], ["observed", "observing"], ["external", "external"]]);
    const result = closeLegacyRunningAtStartup(root, "2026-08-17T00:00:00.000Z", (entry) => audited.push(entry));
    const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
    expect(result.closed).toBe(1);
    expect(tasks.find((task: any) => task.id === "owned")).toMatchObject({ status: "exited", exitCode: 130, endedAt: "2026-08-17T00:00:00.000Z" });
    expect(tasks.find((task: any) => task.id === "observed").status).toBe("running");
    expect(tasks.find((task: any) => task.id === "external").status).toBe("running");
    expect(audited).toEqual(result.audits);
    expect(result.audits.map((entry) => entry.outcome)).toEqual(["closed", "kept-external-lease", "kept-external-lease"]);
  });

  test("任何 Runner command 或 Run identity 都禁止 legacy 收敛", () => {
    const root = fresh(); seed(root, [["command-owned", "ownward"], ["run-owned", "ownward"]]);
    const repo = new SessionRepository(root), commandSession = repo.getByTaskId("command-owned")!, runSession = repo.getByTaskId("run-owned")!;
    new RunnerCommandJournal(root).accept({ commandId: "cmd-command", kind: "start-run", runId: "run-command", sessionId: commandSession.id, providerId: "claude", input: "{}" });
    const runs = new RunRepository(root);
    runs.append({ schemaVersion: 1, eventId: "accepted", type: "command-accepted", at: "2026-08-16T00:00:00.000Z", commandId: "cmd-run", runId: "run-sidecar", taskId: "run-owned", sessionId: runSession.id, providerId: "claude" });
    expect(closeLegacyRunningAtStartup(root).closed).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "tasks.json"), "utf8")).every((task: any) => task.status === "running")).toBe(true);
  });

  test("Runner journal 损坏时 fail closed，不写 task 也不发成功审计", () => {
    for (const file of ["runner/commands.jsonl", "runner/events.jsonl", "runs.jsonl"]) {
      const root = fresh(), audited: unknown[] = []; seed(root, [["owned", "ownward"]]);
      mkdirSync(join(root, "runner"), { recursive: true }); writeFileSync(join(root, file), "not-json\n");
      const before = readFileSync(join(root, "tasks.json"), "utf8");
      expect(() => closeLegacyRunningAtStartup(root, undefined, (entry) => audited.push(entry))).toThrow();
      expect(readFileSync(join(root, "tasks.json"), "utf8")).toBe(before);
      expect(audited).toEqual([]);
    }
  });

  test("幂等且不会创建持续 reconcile 状态", () => {
    const root = fresh(); seed(root, [["owned", "ownward"]]);
    expect(closeLegacyRunningAtStartup(root).closed).toBe(1);
    expect(closeLegacyRunningAtStartup(root).closed).toBe(0);
    expect(existsSync(join(root, "legacy-reconcile.json"))).toBe(false);
  });
  test("native create 在 Runner accept 前崩溃会一次性审计收敛",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);writeFileSync(join(root,"tasks.json"),JSON.stringify([{id:"native",project:"p",projectDir:cwd,cwd,task:"x",mode:"claude-bg",engine:true,startedAt:"2026-08-16T00:00:00.000Z",status:"running"}]));new SessionRepository(root).reserve({taskId:"native",providerId:"claude",cwd});const result=closeLegacyRunningAtStartup(root,"2026-08-17T00:00:00.000Z");expect(result).toMatchObject({closed:1,audits:[{taskId:"native",reason:"native-create-died-before-runner-accept"}]});expect(JSON.parse(readFileSync(join(root,"tasks.json"),"utf8"))[0]).toMatchObject({status:"exited",exitCode:130});});
  test("fresh pending launch survives startup while stale pending without Runner fact closes",()=>{const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);new SessionRepository(root).reserve({taskId:"pending",providerId:"claude",cwd});writeFileSync(join(root,"tasks.json"),JSON.stringify([{id:"pending",project:"p",projectDir:cwd,cwd,task:"x",mode:"claude-bg",engine:true,launchState:"pending",startedAt:"2026-08-17T00:00:00.000Z",status:"running"}]));expect(closeLegacyRunningAtStartup(root,"2026-08-17T00:01:00.000Z")).toMatchObject({closed:0,audits:[{reason:"fresh-launch-pending"}]});expect(closeLegacyRunningAtStartup(root,"2026-08-17T00:10:00.000Z").closed).toBe(1);});
  test("crash after addTask but before Session reserve keeps fresh and audits stale",()=>{for(const [age,closed,reason] of[["2026-08-17T00:01:00.000Z",0,"fresh-launch-pending"],["2026-08-17T00:10:00.000Z",1,"task-registered-before-session-reserve"]] as const){const root=fresh(),cwd=join(root,"repo");mkdirSync(cwd);writeFileSync(join(root,"tasks.json"),JSON.stringify([{id:"pre-reserve",project:"p",projectDir:cwd,cwd,task:"x",mode:"claude-bg",engine:true,launchState:"pending",startedAt:"2026-08-17T00:00:00.000Z",status:"running"}]));const result=closeLegacyRunningAtStartup(root,age);expect(result).toMatchObject({closed,audits:[{taskId:"pre-reserve",reason}]});if(closed)expect(JSON.parse(readFileSync(join(root,"tasks.json"),"utf8"))[0]).toMatchObject({status:"exited",exitCode:130});}});
  test("startup close serializes with concurrent task registration",async()=>{const root=fresh(),marker=join(root,"locked");seed(root,[["owned","ownward"]]);const dispatch=JSON.stringify(join(import.meta.dir,"../../dispatch.ts")),child=Bun.spawn([process.execPath,"-e",`import{mutateTasksAt}from ${dispatch};import{writeFileSync}from"fs";mutateTasksAt(${JSON.stringify(root)},tasks=>{tasks.push({id:"new",project:"p",projectDir:"/repo",cwd:"/repo",task:"new",mode:"codex-bg",startedAt:"now",status:"running"});writeFileSync(${JSON.stringify(marker)},"1");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);return tasks})`],{stderr:"pipe"});for(let i=0;i<100&&!existsSync(marker);i++)await Bun.sleep(2);expect(existsSync(marker)).toBeTrue();expect(closeLegacyRunningAtStartup(root).closed).toBe(1);expect(await child.exited,await new Response(child.stderr).text()).toBe(0);const tasks=JSON.parse(readFileSync(join(root,"tasks.json"),"utf8"));expect(tasks.find((task:any)=>task.id==="owned").status).toBe("exited");expect(tasks.find((task:any)=>task.id==="new").status).toBe("running");});
  test("Runner accept committed while startup close waits prevents false closure",async()=>{const root=fresh(),marker=join(root,"locked");seed(root,[["owned","ownward"]]);const session=new SessionRepository(root).getByTaskId("owned")!,dispatch=JSON.stringify(join(import.meta.dir,"../../dispatch.ts")),journal=JSON.stringify(join(import.meta.dir,"../../runner/journals.ts")),child=Bun.spawn([process.execPath,"-e",`import{mutateTasksAt}from ${dispatch};import{RunnerCommandJournal}from ${journal};import{writeFileSync}from"fs";mutateTasksAt(${JSON.stringify(root)},tasks=>{new RunnerCommandJournal(${JSON.stringify(root)}).accept({commandId:"accepted",kind:"start-run",runId:"run",sessionId:${JSON.stringify(session.id)},providerId:"claude",input:"{}"});writeFileSync(${JSON.stringify(marker)},"1");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);return tasks})`],{stderr:"pipe"});for(let i=0;i<100&&!existsSync(marker);i++)await Bun.sleep(2);expect(closeLegacyRunningAtStartup(root).closed).toBe(0);expect(await child.exited,await new Response(child.stderr).text()).toBe(0);expect(JSON.parse(readFileSync(join(root,"tasks.json"),"utf8"))[0].status).toBe("running");});
});
