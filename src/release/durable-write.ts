import{ chmodSync, closeSync, existsSync, lstatSync, openSync, renameSync, rmSync, writeFileSync }from"fs";
import { fsyncSync } from "../fs-durable.ts";import{dirname,resolve}from"path";
function sync(path:string){const fd=openSync(path,"r");try{fsyncSync(fd)}finally{closeSync(fd)}}
function rejectSymlinks(path:string){for(const candidate of[path,dirname(path)])if(existsSync(candidate)&&lstatSync(candidate).isSymbolicLink())throw new Error(`durable write refuses symlink path: ${candidate}`)}
export function durableWrite(path:string,content:string,mode=0o600){path=resolve(path);rejectSymlinks(path);const tmp=`${path}.tmp.${process.pid}.${crypto.randomUUID()}`;writeFileSync(tmp,content,{mode,flag:"wx"});try{chmodSync(tmp,mode);sync(tmp);renameSync(tmp,path);sync(dirname(path))}finally{rmSync(tmp,{force:true})}}
export function durableRemove(path:string){path=resolve(path);rejectSymlinks(path);if(!existsSync(path))return;rmSync(path);sync(dirname(path))}
if(import.meta.main){const command=process.argv[2];if(command==="write")durableWrite(process.argv[3],await Bun.stdin.text(),Number(process.argv[4]??"384"));else if(command==="remove")durableRemove(process.argv[3]);else throw new Error("durable-write write <path> [mode] | remove <path>")}
