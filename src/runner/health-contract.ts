import { RUNNER_API_VERSION } from "./protocol.ts";

export const REQUIRED_RUNNER_CAPABILITIES = ["quiesce", "resume"] as const;
export type RunnerHealth = { ok:true; pid:number; runnerApiVersion:number; capabilities:string[]; buildIdentity:string; draining:boolean; activeRuns:string[]; providers:Array<{id:string;state:string;errorClass:string|null}> };

export function parseRunnerHealth(value:unknown, options:{expectedBuild?:string; requiredCapabilities?:readonly string[];requiredProviders?:readonly string[]}={}):RunnerHealth {
  const x=value as any, caps=options.requiredCapabilities??REQUIRED_RUNNER_CAPABILITIES;
  if(!x||x.ok!==true||!Number.isSafeInteger(x.pid)||x.pid<=0)throw Object.assign(new Error("Runner health pid/schema invalid"),{code:"RUNNER_HEALTH_INVALID"});
  if(x.runnerApiVersion!==RUNNER_API_VERSION)throw Object.assign(new Error(`Runner API incompatible: expected ${RUNNER_API_VERSION}, got ${String(x.runnerApiVersion)}`),{code:"RUNNER_API_VERSION_UNSUPPORTED"});
  if(!Array.isArray(x.capabilities)||x.capabilities.some((v:unknown)=>typeof v!=="string")||caps.some(v=>!x.capabilities.includes(v)))throw Object.assign(new Error("Runner capabilities incompatible"),{code:"RUNNER_CAPABILITIES_MISSING"});
  if(typeof x.buildIdentity!=="string"||!/^[a-f0-9]{64}$/.test(x.buildIdentity)||options.expectedBuild&&x.buildIdentity!==options.expectedBuild)throw Object.assign(new Error("Runner build identity mismatch"),{code:"RUNNER_BUILD_MISMATCH"});
  if(typeof x.draining!=="boolean"||!Array.isArray(x.activeRuns)||x.activeRuns.some((v:unknown)=>typeof v!=="string"))throw Object.assign(new Error("Runner activity schema invalid"),{code:"RUNNER_HEALTH_INVALID"});
  if(!Array.isArray(x.providers)||x.providers.some((p:any)=>!p||typeof p.id!=="string"||!['ready','degraded'].includes(p.state)||(p.errorClass!==null&&typeof p.errorClass!=="string")))throw Object.assign(new Error("Runner provider health schema invalid"),{code:"RUNNER_PROVIDER_HEALTH_INVALID"});
  for(const id of options.requiredProviders??[]){const provider=x.providers.find((p:any)=>p.id===id);if(!provider)throw Object.assign(new Error(`Runner required provider missing: ${id}`),{code:"RUNNER_PROVIDER_MISSING"});if(provider.state!=="ready")throw Object.assign(new Error(`Runner required provider degraded: ${id}`),{code:"RUNNER_PROVIDER_DEGRADED"});}
  return structuredClone(x);
}
