import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prepareRelease } from "./release/build.ts";
import { reconcileEvolveReceipts, reserveEvolveAttempt, writeEvolveDeployReceipt } from "./evolve-release.ts";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"ownward-evolve-receipt-"));roots.push(root);const source=join(root,"source"),data=join(root,"data");mkdirSync(join(source,"src"),{recursive:true});mkdirSync(join(data,"releases"),{recursive:true});writeFileSync(join(source,"src/app.ts"),"export{}\n");Bun.spawnSync(["git","init","-q"],{cwd:source});Bun.spawnSync(["git","add","src/app.ts"],{cwd:source});const build=prepareRelease(source,join(data,"releases")).buildIdentity;writeFileSync(join(data,"tasks.json"),JSON.stringify([{id:"e1",kind:"evolve",project:"p",projectDir:source,cwd:source,branch:"b",task:"x",mode:"claude-bg",verify:"pass",startedAt:"now",status:"exited"}]));return{root,data,build};}
function commitRelease(data:string,build:string,attemptId="a1"){mkdirSync(join(data,"releases"),{recursive:true});writeFileSync(join(data,"releases","state.json"),JSON.stringify({current:build,lastGood:build,evolveAttemptId:attemptId}));}
function task(data:string){return JSON.parse(readFileSync(join(data,"tasks.json"),"utf8"))[0];}

describe("evolve release receipt crash consistency",()=>{
  test("helper failure before commit remains failed and diagnostic",()=>{const{data,build}=fixture();reserveEvolveAttempt(data,"e1","a1",build,"head1");writeEvolveDeployReceipt(data,"e1","a1",build,"failed","helper stopped before commit");expect(reconcileEvolveReceipts(data).failed).toEqual(["e1"]);expect(task(data)).toMatchObject({deployState:"failed",deployDiagnostic:"helper stopped before commit"});expect(task(data).applied).not.toBeTrue();});

  test("release commit before receipt is recovered only with matching build and attempt",()=>{const{data,build}=fixture();reserveEvolveAttempt(data,"e1","a1",build,"head1");commitRelease(data,build,"other");expect(reconcileEvolveReceipts(data).applied).toEqual([]);expect(task(data).deployState).toBe("pending");commitRelease(data,build,"a1");expect(reconcileEvolveReceipts(data).applied).toEqual(["e1"]);expect(task(data)).toMatchObject({deployState:"applied",applied:true,status:"done"});});

  test("receipt after commit survives crash before task write and repeated daemon reconcile",()=>{const{data,build}=fixture();reserveEvolveAttempt(data,"e1","a1",build,"head1");commitRelease(data,build);writeEvolveDeployReceipt(data,"e1","a1",build,"applied");expect(task(data).deployState).toBe("pending");expect(reconcileEvolveReceipts(data).applied).toEqual(["e1"]);expect(reconcileEvolveReceipts(data).applied).toEqual([]);expect(task(data)).toMatchObject({deployState:"applied",applied:true});});

  test("old receipt arriving after a new attempt cannot overwrite it",()=>{const{data,build}=fixture();reserveEvolveAttempt(data,"e1","old",build,"head1");writeEvolveDeployReceipt(data,"e1","old",build,"failed","old failure");reconcileEvolveReceipts(data);reserveEvolveAttempt(data,"e1","new",build,"head2");expect(()=>writeEvolveDeployReceipt(data,"e1","old",build,"applied")).toThrow("EVOLVE_RECEIPT_STALE_ATTEMPT");expect(reconcileEvolveReceipts(data).failed).toEqual([]);expect(task(data)).toMatchObject({deployState:"pending",deployAttemptId:"new",deployExpectedHead:"head2"});});

  test("success receipt is refused before transaction commit or for a mismatched build",()=>{const{data,build}=fixture();reserveEvolveAttempt(data,"e1","a1",build,"head1");mkdirSync(join(data,"releases"),{recursive:true});writeFileSync(join(data,"releases","transaction.json"),"{}");expect(()=>writeEvolveDeployReceipt(data,"e1","a1",build,"applied")).toThrow("EVOLVE_RELEASE_TRANSACTION_NOT_COMMITTED");rmSync(join(data,"releases","transaction.json"));commitRelease(data,"f".repeat(64));expect(()=>writeEvolveDeployReceipt(data,"e1","a1",build,"applied")).toThrow("EVOLVE_RELEASE_BUILD_MISMATCH");expect(existsSync(join(data,"deploy","evolve","e1","a1.json"))).toBeFalse();});
});
