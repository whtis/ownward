import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DevAdoptCapabilityService } from "./dev-adopt-capability.ts";
import { DevSessionCandidateAuthority } from "./dev-candidates.ts";

const roots:string[]=[];process.on("exit",()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(active=false){const root=mkdtempSync(join(tmpdir(),"ownward-fresh-issue-"));roots.push(root);const cwd=join(root,"repo");mkdirSync(cwd);const path=join(root,"native.jsonl");writeFileSync(path,JSON.stringify({type:"user",entrypoint:"cli",cwd,message:{content:"hello"}})+"\n");const when=new Date(Date.now()-(active?10_000:180_000));utimesSync(path,when,when);return{cwd,path,meta:{id:"project/native",cwd,project:"repo",title:"hello",firstUser:"hello",mtime:when.getTime(),size:1,active}};}

describe("fresh Dev adopt capability issuance",()=>{
  test("pinned/out-of-window stable id issues without any recent-list membership",()=>{const x=fixture(),service=new DevAdoptCapabilityService(new DevSessionCandidateAuthority(),id=>id===x.meta.id?{provider:"claude",meta:x.meta,path:x.path}:null);expect(service.issue("project/native").adoptToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);});
  test("page/daemon restart can re-issue while observation id remains stable",()=>{const x=fixture(),resolve:any=(id:string)=>id===x.meta.id?{provider:"claude",meta:x.meta,path:x.path}:null,a=new DevAdoptCapabilityService(new DevSessionCandidateAuthority(),resolve).issue(x.meta.id),b=new DevAdoptCapabilityService(new DevSessionCandidateAuthority(),resolve).issue(x.meta.id);expect(a.adoptToken).not.toBe(b.adoptToken);expect(x.meta.id).toBe("project/native");});
  test("expired capability can be freshly re-issued, but each token stays single-use",()=>{let now=1000;const x=fixture(),authority=new DevSessionCandidateAuthority(10,()=>now),service=new DevAdoptCapabilityService(authority,()=>({provider:"claude",meta:x.meta,path:x.path}));const old=service.issue(x.meta.id).adoptToken;now=1011;expect(()=>authority.consume(old)).toThrow(/过期/);const next=service.issue(x.meta.id).adoptToken;expect(next).not.toBe(old);expect(authority.consume(next).nativeId).toBe("native");expect(()=>authority.consume(next)).toThrow(/已使用/);});
  test("fresh active snapshot refuses issuance before any capability exists",()=>{const x=fixture(true),authority=new DevSessionCandidateAuthority(),service=new DevAdoptCapabilityService(authority,()=>({provider:"claude",meta:x.meta,path:x.path}));expect(()=>service.issue(x.meta.id)).toThrow(/驱动/);expect(()=>authority.consume("not-issued")).toThrow(/无效/);});
});
