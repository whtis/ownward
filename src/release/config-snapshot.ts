import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { dirname, join, relative, resolve } from "path";

export type ConfigSnapshot={formatVersion:1,id:string,files:string[],createdAt:string};
const names=["config.json","prompts/owner.md"] as const;

function assertNotSymlink(path:string){if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error(`config snapshot refuses symlink path: ${path}`)}
function regular(path:string,label:string){const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile())throw new Error(`config snapshot refuses non-regular file: ${label}`)}
function digest(root:string,files:string[]){const h=new Bun.CryptoHasher("sha256");for(const name of names){h.update(name);h.update("\0");h.update(files.includes(name)?readFileSync(join(root,name)):"<missing>");h.update("\0")}return h.digest("hex")}
export function configDigest(source:string):string{source=resolve(source);return digest(source,names.filter(name=>existsSync(join(source,name))))}
function sync(path:string){const fd=openSync(path,"r");try{fsyncSync(fd)}finally{closeSync(fd)}}

export function prepareConfigSnapshot(source:string,destination:string):ConfigSnapshot{
  source=resolve(source);destination=resolve(destination);assertNotSymlink(source);assertNotSymlink(dirname(destination));
  const sourceStat=lstatSync(source);if(!sourceStat.isDirectory())throw new Error("config snapshot source root invalid");
  const files=names.filter(name=>{const p=join(source,name);assertNotSymlink(dirname(p));assertNotSymlink(p);if(!existsSync(p))return false;regular(p,name);return true});
  const id=digest(source,files),manifest={formatVersion:1 as const,id,files,createdAt:new Date().toISOString()};
  if(existsSync(destination))return validateConfigSnapshot(destination,id);
  const parent=dirname(destination),staging=join(parent,`.${relative(parent,destination)}.staging-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(parent,{recursive:true,mode:0o700});assertNotSymlink(parent);chmodSync(parent,0o700);mkdirSync(staging,{mode:0o700});
  try{
    for(const name of files){const from=join(source,name),to=join(staging,name);assertNotSymlink(dirname(from));assertNotSymlink(from);regular(from,name);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(from,to);chmodSync(to,0o400);sync(to)}
    for(const dir of new Set(files.map(x=>dirname(join(staging,x))).filter(x=>x!==staging)))chmodSync(dir,0o500);
    writeFileSync(join(staging,"snapshot.json"),JSON.stringify(manifest)+"\n",{mode:0o400});sync(join(staging,"snapshot.json"));sync(staging);renameSync(staging,destination);chmodSync(destination,0o500);sync(parent);
    return validateConfigSnapshot(destination,id);
  }catch(e){if(existsSync(staging)){chmodSync(staging,0o700);rmSync(staging,{recursive:true,force:true})}throw e}
}

export function validateConfigSnapshot(root:string,expected?:string):ConfigSnapshot{
  root=resolve(root);assertNotSymlink(root);const rs=lstatSync(root);if(!rs.isDirectory()||(rs.mode&0o277)!==0)throw new Error("config snapshot directory permissions invalid");
  regular(join(root,"snapshot.json"),"snapshot.json");const m=JSON.parse(readFileSync(join(root,"snapshot.json"),"utf8"))as ConfigSnapshot;
  if(m.formatVersion!==1||!/^[a-f0-9]{64}$/.test(m.id)||expected&&m.id!==expected||!Array.isArray(m.files)||new Set(m.files).size!==m.files.length||m.files.some(x=>!names.includes(x as any)))throw new Error("config snapshot invalid");
  const allowed=new Set(["snapshot.json",...m.files,...m.files.map(dirname).filter(x=>x!==".")]);
  const walk=(dir:string)=>{for(const entry of readdirSync(join(root,dir==="."?"":dir))){const rel=dir==="."?entry:join(dir,entry),p=join(root,rel),s=lstatSync(p);if(s.isSymbolicLink()||!allowed.has(rel))throw new Error("config snapshot contains unexpected or symlink entry");if(s.isDirectory()){if((s.mode&0o277)!==0)throw new Error("config snapshot directory permissions invalid");walk(rel)}else if(!s.isFile()||(s.mode&0o377)!==0)throw new Error("config snapshot file permissions invalid")}};walk(".");
  if(digest(root,m.files)!==m.id)throw new Error("config snapshot hash mismatch");return m;
}

export function locateConfigSnapshot(buildRoot:string,expected?:string):{root:string;id:string}{
  buildRoot=resolve(buildRoot);assertNotSymlink(buildRoot);const legacyRoot=join(buildRoot,"config"),candidates=[legacyRoot];
  if(existsSync(buildRoot)){const stat=lstatSync(buildRoot);if(!stat.isDirectory())throw new Error("config snapshot build root invalid");for(const name of readdirSync(buildRoot)){const parent=join(buildRoot,name);assertNotSymlink(parent);if(lstatSync(parent).isDirectory())candidates.push(join(parent,"config"));}}
  const valid:{root:string;id:string}[]=[];for(const root of candidates){if(!existsSync(root))continue;const snapshot=validateConfigSnapshot(root);if(!expected||snapshot.id===expected)valid.push({root,id:snapshot.id});}
  if(!expected){const legacy=valid.find(candidate=>candidate.root===legacyRoot);if(legacy)return legacy;}
  if(valid.length!==1)throw new Error(valid.length?"config snapshot address ambiguous":"config snapshot not found");return valid[0]!;
}

if(import.meta.main){const cmd=process.argv[2],root=resolve(process.argv[3]);if(cmd==="prepare")console.log(JSON.stringify(prepareConfigSnapshot(root,resolve(process.argv[4]))));else if(cmd==="validate")console.log(JSON.stringify(validateConfigSnapshot(root,process.argv[4])));else if(cmd==="digest")console.log(configDigest(root));else if(cmd==="locate")console.log(JSON.stringify(locateConfigSnapshot(root,process.argv[4])));else throw new Error("config-snapshot prepare|validate|digest|locate")}
