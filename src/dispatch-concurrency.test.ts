import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("stale reap save cannot overwrite a concurrent task registration", async () => {
  const data = mkdtempSync(join(tmpdir(), "ownward-tasks-cas-"));
  try {
    mkdirSync(data, { recursive: true });
    const old = {
      id: "old",
      project: "repo",
      projectDir: data,
      cwd: data,
      task: "old",
      mode: "codex-bg",
      startedAt: new Date().toISOString(),
      status: "running",
    };
    writeFileSync(join(data, "tasks.json"), JSON.stringify([old]));
    const module = JSON.stringify(join(import.meta.dir, "dispatch.ts"));
    const reap = `import{loadTasks,mutateTasks}from ${module};loadTasks();await Bun.sleep(100);mutateTasks(tasks=>{const old=tasks.find(t=>t.id==="old");if(old)Object.assign(old,{status:"exited",exitCode:0});return tasks})`;
    const register = `import{addTask}from ${module};await Bun.sleep(20);addTask({id:"new",project:"repo",projectDir:${JSON.stringify(data)},cwd:${JSON.stringify(data)},task:"new",mode:"codex-bg",startedAt:new Date().toISOString(),status:"running"})`;
    const env = { ...process.env, OWNWARD_DATA_ROOT: data };
    const processes = [
      Bun.spawn([process.execPath, "-e", reap], { env, stderr: "pipe" }),
      Bun.spawn([process.execPath, "-e", register], { env, stderr: "pipe" }),
    ];
    for (const process of processes)
      expect(
        await process.exited,
        await new Response(process.stderr).text(),
      ).toBe(0);
    const tasks = JSON.parse(readFileSync(join(data, "tasks.json"), "utf8"));
    expect(tasks.find((task: any) => task.id === "old")?.status).toBe("exited");
    expect(tasks.find((task: any) => task.id === "new")?.status).toBe(
      "running",
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a SIGKILL-abandoned task lock is reclaimed without stealing a live owner",async()=>{const data=mkdtempSync(join(tmpdir(),"ownward-tasks-lock-"));try{const marker=join(data,"held"),module=JSON.stringify(join(import.meta.dir,"dispatch.ts")),env={...process.env,OWNWARD_DATA_ROOT:data};const holder=Bun.spawn([process.execPath,"-e",`import{mutateTasks}from ${module};import{writeFileSync}from"fs";mutateTasks(tasks=>{writeFileSync(${JSON.stringify(marker)},"1");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return tasks})`],{env,stderr:"pipe"});for(let i=0;i<200&&!existsSync(marker);i++)await Bun.sleep(5);expect(existsSync(marker)).toBeTrue();const contender=Bun.spawn([process.execPath,"-e",`import{addTask}from ${module};try{addTask({id:"stolen",project:"x",projectDir:"/tmp",cwd:"/tmp",task:"x",mode:"codex-bg",startedAt:"now",status:"running"})}catch(e){console.log(e.message)}`],{env,stdout:"pipe",stderr:"pipe"});expect((await new Response(contender.stdout).text()).trim()).toBe("TASKS_WRITE_BUSY");expect(await contender.exited).toBe(0);holder.kill(9);await holder.exited;const recovery=Bun.spawn([process.execPath,"-e",`import{addTask}from ${module};addTask({id:"recovered",project:"x",projectDir:"/tmp",cwd:"/tmp",task:"x",mode:"codex-bg",startedAt:"now",status:"running"})`],{env,stderr:"pipe"});expect(await recovery.exited,await new Response(recovery.stderr).text()).toBe(0);expect(JSON.parse(readFileSync(join(data,"tasks.json"),"utf8"))[0].id).toBe("recovered");}finally{rmSync(data,{recursive:true,force:true});}});
test("two stale-lock contenders preserve mutual exclusion and both updates",async()=>{const data=mkdtempSync(join(tmpdir(),"ownward-tasks-lock-race-"));try{const lock=join(data,".tasks.write.lock");mkdirSync(lock);writeFileSync(join(lock,"owner.json"),JSON.stringify({pid:2147483647,createdAt:0,token:"dead"}));writeFileSync(join(data,"tasks.json"),"[]");const module=JSON.stringify(join(import.meta.dir,"dispatch.ts")),env={...process.env,OWNWARD_DATA_ROOT:data},spawn=(id:string)=>Bun.spawn([process.execPath,"-e",`import{mutateTasks}from ${module};mutateTasks(tasks=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);tasks.push({id:${JSON.stringify(id)},project:"x",projectDir:"/tmp",cwd:"/tmp",task:"x",mode:"codex-bg",startedAt:"now",status:"running"});return tasks})`],{env,stderr:"pipe"}),a=spawn("a"),b=spawn("b");for(const proc of[a,b])expect(await proc.exited,await new Response(proc.stderr).text()).toBe(0);expect(JSON.parse(readFileSync(join(data,"tasks.json"),"utf8")).map((x:any)=>x.id).sort()).toEqual(["a","b"]);expect(existsSync(join(data,".tasks.write.lock.recovery"))).toBeFalse();}finally{rmSync(data,{recursive:true,force:true});}});

test("field patches preserve concurrent status, harvest, legal clears and deletion",async()=>{const data=mkdtempSync(join(tmpdir(),"ownward-tasks-fields-"));try{writeFileSync(join(data,"tasks.json"),JSON.stringify([{id:"task",project:"x",projectDir:"/tmp",cwd:"/tmp",task:"x",mode:"codex-bg",startedAt:"now",status:"running",harvested:true,flightPath:"old"}]));const module=JSON.stringify(join(import.meta.dir,"dispatch.ts")),env={...process.env,OWNWARD_DATA_ROOT:data},run=(code:string)=>Bun.spawn([process.execPath,"-e",code],{env,stderr:"pipe"});const a=run(`import{updateTask}from ${module};updateTask("task",{status:"exited"})`),b=run(`import{updateTask}from ${module};updateTask("task",{harvested:false,flightPath:""})`);for(const proc of[a,b])expect(await proc.exited,await new Response(proc.stderr).text()).toBe(0);expect(JSON.parse(readFileSync(join(data,"tasks.json"),"utf8"))[0]).toMatchObject({status:"exited",harvested:false,flightPath:""});const remove=run(`import{removeTask}from ${module};removeTask("task")`);expect(await remove.exited).toBe(0);const stale=run(`import{updateTask}from ${module};updateTask("task",{status:"done"})`);expect(await stale.exited).toBe(0);expect(JSON.parse(readFileSync(join(data,"tasks.json"),"utf8"))).toEqual([]);}finally{rmSync(data,{recursive:true,force:true});}});
test("corrupt task registries fail closed in a fresh process",async()=>{for(const raw of["{",JSON.stringify({not:"array"})]){const data=mkdtempSync(join(tmpdir(),"ownward-tasks-corrupt-"));try{writeFileSync(join(data,"tasks.json"),raw);const module=JSON.stringify(join(import.meta.dir,"dispatch.ts")),proc=Bun.spawn([process.execPath,"-e",`import{addTask}from ${module};try{addTask({id:"new"})}catch(e){console.log(e.code)}`],{env:{...process.env,OWNWARD_DATA_ROOT:data},stdout:"pipe"});expect((await new Response(proc.stdout).text()).trim()).toBe("TASKS_REGISTRY_CORRUPT");expect(readFileSync(join(data,"tasks.json"),"utf8")).toBe(raw);}finally{rmSync(data,{recursive:true,force:true});}}});
