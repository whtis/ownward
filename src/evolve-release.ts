import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { fsyncSync } from "./fs-durable.ts";
import { dirname, join } from "path";
import { resolveAction } from "./actions.ts";
import { mutateTasksAt, type WorkTask } from "./dispatch.ts";
import { validateRelease } from "./release/build.ts";
import { DATA } from "./util.ts";

export type EvolveDeployReceipt={formatVersion:1;taskId:string;attemptId:string;buildIdentity:string;result:"applied"|"failed";createdAt:string;diagnostic?:string};

function attemptFile(dataRoot:string,taskId:string,attemptId:string){
  if(!/^[A-Za-z0-9._-]+$/.test(taskId)||!/^[A-Za-z0-9._-]+$/.test(attemptId))throw new Error("EVOLVE_ATTEMPT_ID_INVALID");
  return join(dataRoot,"deploy","evolve",taskId,`${attemptId}.json`);
}
function atomicJson(file:string,value:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(value,null,2)+"\n",{mode:0o600});const fd=openSync(tmp,"r");try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);const dfd=openSync(dirname(file),"r");try{fsyncSync(dfd);}finally{closeSync(dfd);}}

export function reserveEvolveAttempt(dataRoot:string,taskId:string,attemptId:string,expectedBuild:string,expectedHead:string):WorkTask{
  let reserved:WorkTask|undefined;mutateTasksAt(dataRoot,tasks=>{const task=tasks.find(t=>t.id===taskId);if(!task||task.kind!=="evolve")throw new Error("EVOLVE_TASK_MISSING");if(task.applied)throw new Error("EVOLVE_ALREADY_APPLIED");if(task.deployState==="pending")throw new Error(`EVOLVE_APPLY_PENDING:${task.deployAttemptId||"unknown"}`);Object.assign(task,{deployState:"pending",deployAttemptId:attemptId,deployTransactionId:attemptId,deployExpectedBuild:expectedBuild,deployExpectedHead:expectedHead,deployDiagnostic:undefined});reserved=task;return tasks;});return reserved!;
}

function currentAttempt(dataRoot:string,taskId:string){let found:WorkTask|undefined;mutateTasksAt(dataRoot,tasks=>{found=tasks.find(t=>t.id===taskId);return tasks;});return found;}

export function writeEvolveDeployReceipt(dataRoot:string,taskId:string,attemptId:string,buildIdentity:string,result:"applied"|"failed",diagnostic?:string):EvolveDeployReceipt{
  const task=currentAttempt(dataRoot,taskId);if(!task||task.kind!=="evolve")throw new Error("EVOLVE_TASK_MISSING");
  if(task.deployAttemptId!==attemptId||task.deployExpectedBuild!==buildIdentity)throw new Error("EVOLVE_RECEIPT_STALE_ATTEMPT");
  if(result==="applied"){
    if(existsSync(join(dataRoot,"releases","transaction.json")))throw new Error("EVOLVE_RELEASE_TRANSACTION_NOT_COMMITTED");
    const state=JSON.parse(readFileSync(join(dataRoot,"releases","state.json"),"utf8"));
    if(state.current!==buildIdentity)throw new Error("EVOLVE_RELEASE_BUILD_MISMATCH");
    if(state.evolveAttemptId!==attemptId)throw new Error("EVOLVE_RELEASE_ATTEMPT_MISMATCH");
    validateRelease(join(dataRoot,"releases",buildIdentity),buildIdentity);
  }
  const receipt:EvolveDeployReceipt={formatVersion:1,taskId,attemptId,buildIdentity,result,createdAt:new Date().toISOString(),...(diagnostic?{diagnostic}: {})};
  const file=attemptFile(dataRoot,taskId,attemptId);if(existsSync(file)){const prior=JSON.parse(readFileSync(file,"utf8"));if(JSON.stringify(prior)!==JSON.stringify(receipt)&&prior.result!==result)throw new Error("EVOLVE_RECEIPT_CONFLICT");return prior;}
  atomicJson(file,receipt);return receipt;
}

export function reconcileEvolveReceipts(dataRoot:string):{applied:string[];failed:string[];diagnostics:string[]}{
  const applied:string[]=[],failed:string[]=[],diagnostics:string[]=[];let resolved:string[]=[];
  mutateTasksAt(dataRoot,tasks=>{for(const task of tasks){if(task.kind!=="evolve"||task.deployState!=="pending"||!task.deployAttemptId)continue;const file=attemptFile(dataRoot,task.id,task.deployAttemptId);if(!existsSync(file)){try{if(existsSync(join(dataRoot,"releases","transaction.json")))continue;const state=JSON.parse(readFileSync(join(dataRoot,"releases","state.json"),"utf8"));if(state.current!==task.deployExpectedBuild||state.evolveAttemptId!==task.deployAttemptId)continue;validateRelease(join(dataRoot,"releases",state.current),state.current);atomicJson(file,{formatVersion:1,taskId:task.id,attemptId:task.deployAttemptId,buildIdentity:state.current,result:"applied",createdAt:new Date().toISOString(),diagnostic:"recovered from committed release state"} satisfies EvolveDeployReceipt);}catch(error){task.deployDiagnostic=`pending release unverifiable: ${error}`;diagnostics.push(task.id);continue;}}let receipt:EvolveDeployReceipt;try{receipt=JSON.parse(readFileSync(file,"utf8"));}catch(error){task.deployDiagnostic=`receipt unreadable: ${error}`;diagnostics.push(task.id);continue;}if(receipt.taskId!==task.id||receipt.attemptId!==task.deployAttemptId||receipt.buildIdentity!==task.deployExpectedBuild){task.deployDiagnostic="receipt identity/build mismatch";diagnostics.push(task.id);continue;}if(receipt.result==="applied"){
      try{if(existsSync(join(dataRoot,"releases","transaction.json")))throw new Error("release transaction remains");const state=JSON.parse(readFileSync(join(dataRoot,"releases","state.json"),"utf8"));if(state.current!==receipt.buildIdentity)throw new Error("release state build mismatch");if(state.evolveAttemptId!==receipt.attemptId)throw new Error("release state attempt mismatch");validateRelease(join(dataRoot,"releases",receipt.buildIdentity),receipt.buildIdentity);}catch(error){task.deployDiagnostic=`success receipt unverifiable: ${error}`;diagnostics.push(task.id);continue;}
      Object.assign(task,{applied:true,status:"done",deployState:"applied",deployDiagnostic:undefined});applied.push(task.id);resolved.push(task.id);
    }else if(receipt.result==="failed"){task.deployState="failed";task.deployDiagnostic=receipt.diagnostic||"release helper failed";failed.push(task.id);}else{task.deployDiagnostic="receipt result unknown";diagnostics.push(task.id);}}
    return tasks;});
  if(dataRoot===DATA)for(const id of resolved)resolveAction(`evolve:${id}`,"applied");return{applied,failed,diagnostics};
}
