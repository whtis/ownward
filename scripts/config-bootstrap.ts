import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { computeSafeAllowedRoots } from "../src/config-roots.ts";

const CONNECTOR_IDS=["lark","github","gmail","stock"] as const;
export function migrateLegacySources(config:Record<string,any>):boolean{let changed=false;config.connectors??={};for(const id of CONNECTOR_IDS){if(config.connectors[id]===undefined&&config.sources?.[id]!==undefined){config.connectors[id]=structuredClone(config.sources[id]);changed=true;}}config.providers??={};for(const [id,key] of [["claude-code","claudeBin"],["codex","codexBin"]] as const){const legacy=config.llm?.[key];if(config.providers[id]===undefined&&typeof legacy==="string"&&legacy.trim()){config.providers[id]={command:[legacy.trim()]};changed=true;}}return changed;}
export function ensureInstallDefaults(file:string,repoRoot:string):{changed:boolean;allowedRoots:string[]}{const config=JSON.parse(readFileSync(file,"utf8"));let changed=migrateLegacySources(config);config.architecture??={};let roots=config.architecture.allowedRoots;if(roots===undefined){roots=computeSafeAllowedRoots(repoRoot,joinTasks(repoRoot));config.architecture.allowedRoots=roots;changed=true;}if(changed)writeFileSync(file,JSON.stringify(config,null,2)+"\n",{mode:0o600});return{changed,allowedRoots:roots};}
function joinTasks(repo:string):any[]{const file=resolve(repo,"data/tasks.json");if(!existsSync(file))return[];try{const value=JSON.parse(readFileSync(file,"utf8"));return Array.isArray(value)?value:[];}catch{return[];}}
if(import.meta.main){const [file,repoRoot]=process.argv.slice(2);if(!file||!repoRoot)throw new Error("usage: config-bootstrap <config> <repo-root>");console.log(JSON.stringify(ensureInstallDefaults(file,repoRoot)));}
