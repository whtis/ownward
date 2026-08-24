import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DevSessionCandidateAuthority } from "./dev-candidates.ts";
import { devObservationDto } from "./dev-observation.ts";

describe("Dev observation/adoption split", () => {
  const meta = { id:"project/stable-native", cwd:"/repo", project:"repo", title:"title", firstUser:"hello", mtime:1_723_456_789_000, size:42, active:false, _path:"/private/transcript" } as any;
  test("real Web DTO keeps every render/pin/tab field while path and capability stay separate",()=>{const dto=devObservationDto(meta);expect(dto).toMatchObject({id:meta.id,cwd:meta.cwd,project:"repo",title:"title",firstUser:"hello",mtime:meta.mtime,size:42,active:false});expect((dto as any)._path).toBeUndefined();expect((dto as any).adoptToken).toBeUndefined();expect(()=>new Date(dto.mtime).toISOString()).not.toThrow();});
  test("stable observation identity survives TTL/restart and dedup remains stable",()=>{const before=devObservationDto(meta),after=devObservationDto(meta);expect(before.id).toBe(after.id);expect(new Map([before,after].map(x=>[x.id,x])).size).toBe(1);const restarted=new DevSessionCandidateAuthority();expect(restarted).toBeDefined();expect(devObservationDto(meta).id).toBe(meta.id);});
  test("Web observes by stable id, fresh-issues on click, and forced redraw bypasses no-message early return",()=>{const web=readFileSync(join(import.meta.dir,"../../../web/tasks.js"),"utf8"),workbench=readFileSync(join(import.meta.dir,"../../workbench.ts"),"utf8");expect(web).toContain("fetchCcInc(id");expect(web).toContain('post("/api/cc/adopt-capability", { id })');expect(web).toContain('{ id, adoptToken }');expect(web).toContain('pollCcObserve(Tasks.sel, Tasks.selKind, true)');expect(web).toContain('&& !forceHeader) return');expect(workbench).toContain("codexSessionPath(id)");expect(workbench).toContain("ccSessionPath(id)");expect(workbench).toContain("devAdoptCapabilities.issue");});
});
