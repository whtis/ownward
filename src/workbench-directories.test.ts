import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("workbench multi-directory APIs", () => {
  test("canonical Session directories drive messages and all historical roots become project candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-workbench-dirs-")), data = join(root, "data");
    const legacy = join(root, "legacy"), canonical = join(root, "canonical"), taskExtra = join(root, "task-extra"), sessionExtra = join(root, "session-extra"), unauthorized = mkdtempSync(join(tmpdir(), "ownward-unauthorized-dir-")), drift = join(root, "drift-link");
    try {
      for (const dir of [data, legacy, canonical, taskExtra, sessionExtra]) mkdirSync(dir);
      symlinkSync(unauthorized, drift);
      writeFileSync(join(data, "tasks.json"), JSON.stringify([{ id: "task", project: "legacy", cwd: legacy, projectDir: legacy, extraDirs: [taskExtra, unauthorized, drift], task: "x", mode: "codex-bg", engine: true, startedAt: new Date().toISOString(), status: "running" }]));
      const script = `
        import {SessionRepository} from ${JSON.stringify(join(import.meta.dir, "sessions/repository.ts"))};
        const {cfg}=await import(${JSON.stringify(join(import.meta.dir, "util.ts"))});cfg.architecture.allowedRoots=[${JSON.stringify(root)}];
        const repo=new SessionRepository(${JSON.stringify(data)});repo.reserve({taskId:"task",providerId:"codex",cwd:${JSON.stringify(canonical)},extraDirs:[${JSON.stringify(sessionExtra)},${JSON.stringify(unauthorized)}]});
        const {handleWorkbench}=await import(${JSON.stringify(join(import.meta.dir, "workbench.ts"))});
        const call=async(path)=>{const u=new URL("http://localhost"+path),r=await handleWorkbench(new Request(u),u);return await r.json()};
        const messages=await call("/api/dev/messages?id=task"),projects=await call("/api/projects");cfg.architecture.allowedRoots=[];const projectsLocked=await call("/api/projects");
        console.log(JSON.stringify({messages,projects,projectsLocked}));`;
      const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: data }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, err).toBe(0);
      const result = JSON.parse(out.trim().split("\n").at(-1)!);
      expect(result.messages.cwd).toBe(canonical);
      expect(result.messages.extraDirs).toEqual(expect.arrayContaining([sessionExtra, unauthorized]));
      const dirs = result.projects.map((p: any) => p.dir);
      expect(dirs).toEqual(expect.arrayContaining([legacy, taskExtra, canonical, sessionExtra].map((dir) => realpathSync(dir))));
      expect(dirs).not.toContain(realpathSync(unauthorized));
      expect(new Set(dirs).size).toBe(dirs.length);
      expect(result.projectsLocked).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(unauthorized, { recursive: true, force: true }); }
  });
});
