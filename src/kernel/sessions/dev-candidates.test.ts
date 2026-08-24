import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DevSessionCandidateAuthority } from "./dev-candidates.ts";

const roots: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "ownward-candidate-")); roots.push(dir); return dir; };
process.on("exit", () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const idle = (path: string) => { const past = new Date(Date.now() - 180_000); utimesSync(path, past, past); };
const claudeFile = (root: string, name = "native") => {
  const cwd = join(root, "repo"); mkdirSync(cwd, { recursive: true });
  const path = join(root, `${name}.jsonl`);
  writeFileSync(path, `${JSON.stringify({type:"user",entrypoint:"cli",cwd,message:{content:"hello"}})}\n${JSON.stringify({type:"summary",summary:"safe title"})}\n`);
  idle(path); return { path, cwd, meta: { id: `project/${name}`, cwd, project: "repo", title: "safe title", firstUser: "hello", mtime: Date.now()-180_000, size: 1, active: false } as any };
};
const codexFile = (root: string, id = "00000000-0000-4000-8000-000000000001") => {
  const cwd=join(root,"repo");mkdirSync(cwd,{recursive:true});const path=join(root,"rollout.jsonl");
  writeFileSync(path,`${JSON.stringify({type:"session_meta",payload:{id,cwd}})}\n${JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"hello"}})}\n`);idle(path);
  return {path,cwd,meta:{kind:"codex",id:`cdx:codex:${id}`,home:"codex",rolloutId:id,cwd,repoUrl:"",project:"repo",title:"hello",firstUser:"hello",mtime:Date.now()-180_000,size:1,active:false} as any};
};

describe("Dev session candidate capability",()=>{
  test("Claude candidate rejects a file that became active and burns the token",()=>{const x=claudeFile(fresh()),a=new DevSessionCandidateAuthority();const token=a.issueClaude(x.meta,x.path);appendFileSync(x.path,JSON.stringify({type:"assistant"})+"\n");expect(()=>a.consume(token)).toThrow(/变化|驱动/);expect(()=>a.consume(token)).toThrow(/已使用/);});
  test("Claude candidate rejects atomic file replacement even with the same content",()=>{const x=claudeFile(fresh()),a=new DevSessionCandidateAuthority(),token=a.issueClaude(x.meta,x.path),replacement=x.path+".new";writeFileSync(replacement,`${JSON.stringify({type:"user",entrypoint:"cli",cwd:x.cwd,message:{content:"hello"}})}\n`);idle(replacement);renameSync(replacement,x.path);expect(()=>a.consume(token)).toThrow(/变化/);});
  test("Codex candidate binds rollout identity/cwd and is single-use without exposing private refs",()=>{const x=codexFile(fresh()),a=new DevSessionCandidateAuthority(),token=a.issueCodex(x.meta,x.path);expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);expect(token).not.toContain(x.meta.rolloutId);const got=a.consume(token);expect(got).toMatchObject({provider:"codex",nativeId:x.meta.rolloutId,cwd:x.cwd,home:"codex"});expect(()=>a.consume(token)).toThrow(/已使用/);});
  test("short TTL expires and concurrent consumers cannot both take over",()=>{let now=1000;const x=claudeFile(fresh()),expired=new DevSessionCandidateAuthority(10,()=>now),token=expired.issueClaude(x.meta,x.path);now=1011;expect(()=>expired.consume(token)).toThrow(/过期/);const a=new DevSessionCandidateAuthority(),live=a.issueClaude(x.meta,x.path),results=[()=>a.consume(live),()=>a.consume(live)].map(fn=>{try{fn();return"ok"}catch{return"rejected"}});expect(results.sort()).toEqual(["ok","rejected"]);});
  test("a refreshed active snapshot gets a new capability even when file identity is unchanged",()=>{const x=claudeFile(fresh()),a=new DevSessionCandidateAuthority(),old=a.issueClaude({...x.meta,active:true},x.path),next=a.issueClaude({...x.meta,active:false},x.path);expect(next).not.toBe(old);});
});
