import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prepareRelease, validateRelease } from "./build.ts";

const roots:string[]=[]; afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
test("release is content addressed, immutable-input and validates tampering",()=>{
  const root=mkdtempSync(join(tmpdir(),"ownward-release-src-")), releases=mkdtempSync(join(tmpdir(),"ownward-releases-"));roots.push(root,releases);
  mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.ts"),"one");writeFileSync(join(root,"config.json"),"{}");
  Bun.spawnSync(["git","init"],{cwd:root});Bun.spawnSync(["git","add","src/a.ts"],{cwd:root});
  const first=prepareRelease(root,releases), path=join(releases,first.buildIdentity);
  expect(validateRelease(path).buildIdentity).toBe(first.buildIdentity);expect(()=>readFileSync(join(path,"config.json"),"utf8")).toThrow();
  writeFileSync(join(root,"src/a.ts"),"two");const second=prepareRelease(root,releases);expect(second.buildIdentity).not.toBe(first.buildIdentity);expect(readFileSync(join(path,"src/a.ts"),"utf8")).toBe("one");
  Bun.spawnSync(["chmod","u+w",join(path,"src/a.ts")]);writeFileSync(join(path,"src/a.ts"),"tamper");expect(()=>validateRelease(path)).toThrow("content hash mismatch");
});
test("release rejects tracked symlinks",()=>{const root=mkdtempSync(join(tmpdir(),"ownward-release-link-")),releases=mkdtempSync(join(tmpdir(),"ownward-releases-"));roots.push(root,releases);writeFileSync(join(root,"outside"),"x");symlinkSync("outside",join(root,"link"));Bun.spawnSync(["git","init"],{cwd:root});Bun.spawnSync(["git","add","link"],{cwd:root});expect(()=>prepareRelease(root,releases)).toThrow("non-regular");});
