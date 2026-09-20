import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** 归档不是删除：判据带 lastAt，归档之后又有新活动的会话必须自己回到列表。 */
test("归档按时刻生效：更新的活动自动解除归档，恢复是显式的", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-archived-"));
  try {
    const mod = JSON.stringify(join(import.meta.dir, "archived-sessions.ts")),
      script = `import{archiveSession,restoreSession,isArchived,archivedSessions}from ${mod};` +
        `archiveSession("t-old",1000);archiveSession("t-back",1000);` +
        `const out={` +
        `stillArchived:isArchived("t-old",900),` +      // 归档后没动静
        `sameInstant:isArchived("t-old",1000),` +       // 边界：等于归档时刻仍算已归档
        `cameBack:isArchived("t-back",1001),` +         // 归档后又有新活动 → 自动回来
        `neverArchived:isArchived("t-none",5000),` +
        `store:archivedSessions()};` +
        `restoreSession("t-old");out.afterRestore=isArchived("t-old",900);out.storeAfter=archivedSessions();` +
        `restoreSession("t-none");` +                   // 恢复没归档过的不应炸
        `console.log(JSON.stringify(out))`,
      proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }),
      out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(r.stillArchived).toBeTrue();
    expect(r.sameInstant).toBeTrue();
    expect(r.cameBack).toBeFalse();
    expect(r.neverArchived).toBeFalse();
    expect(r.store).toEqual({ "t-old": 1000, "t-back": 1000 });
    expect(r.afterRestore).toBeFalse();
    expect(r.storeAfter).toEqual({ "t-back": 1000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** 坏文件不能让最近会话列表整个瘫掉——读不出来就当没归档过。 */
test("归档文件损坏时退化成空表，不抛", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-archived-bad-"));
  try {
    const mod = JSON.stringify(join(import.meta.dir, "archived-sessions.ts")),
      script = `import{writeFileSync,mkdirSync}from"fs";import{join}from"path";mkdirSync(process.env.OWNWARD_DATA_ROOT,{recursive:true});` +
        `writeFileSync(join(process.env.OWNWARD_DATA_ROOT,"archived-sessions.json"),"[1,2,3]");` +
        `const{archivedSessions,isArchived}=await import(${mod});` +
        `console.log(JSON.stringify({store:archivedSessions(),archived:isArchived("x",1)}))`,
      proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" }),
      out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(r.store).toEqual({});
    expect(r.archived).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
