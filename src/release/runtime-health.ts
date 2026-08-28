import { readCompatibleSchema } from "../storage/schema.ts";
import { DATA } from "../util.ts";
import { readFileSync } from "fs";
import { join } from "path";
import { validateConfigSnapshot } from "./config-snapshot.ts";

export function runtimeHealth(dataRoot=DATA){
  readCompatibleSchema(dataRoot);
  const buildIdentity=process.env.OWNWARD_BUILD_IDENTITY||"dev";
  let configDigest:string|null=null;
  const configRoot=process.env.OWNWARD_CONFIG_ROOT;
  if(configRoot){ try { configDigest=validateConfigSnapshot(configRoot).id; } catch { configDigest=null; } }
  let generation:string|undefined;
  try { const boot=JSON.parse(readFileSync(join(dataRoot,"boots.json"),"utf8"));if(boot?.pid===process.pid&&typeof boot.generation==="string"&&boot.generation)generation=boot.generation; } catch {}
  return {ok:true,pid:process.pid,generation,buildIdentity,configDigest,releaseRoot:process.env.OWNWARD_RELEASE_ROOT||null,schemaCompatible:true,listening:true};
}
