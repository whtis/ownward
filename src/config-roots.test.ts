import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { effectiveAllowedRoots } from "./config-roots.ts";

const cleanup:string[]=[];afterEach(()=>{for(const root of cleanup.splice(0))rmSync(root,{recursive:true,force:true});});
describe("runtime effective allowed roots",()=>{
  test("upgraded local config missing key remains fail-closed despite historical tasks",()=>{const base=mkdtempSync(join(tmpdir(),"ownward-roots-")),workspace=join(base,"workspace"),repo=join(workspace,"ownward"),project=join(base,"evolve-project");cleanup.push(base);mkdirSync(repo,{recursive:true});mkdirSync(project);expect(effectiveAllowedRoots({},repo,[{projectDir:project},{cwd:join(base,"missing")},{cwd:process.env.HOME},{cwd:"/"}])).toEqual([]);});
  test("explicit empty roots remains an intentional shutdown",()=>{const base=mkdtempSync(join(tmpdir(),"ownward-roots-off-")),repo=join(base,"ownward"),project=join(base,"project");cleanup.push(base);mkdirSync(repo);mkdirSync(project);expect(effectiveAllowedRoots({architecture:{allowedRoots:[]}},repo,[{cwd:project}])).toEqual([]);});
});
