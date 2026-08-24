import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";
import { join, relative, resolve } from "path";

const MARKER = ".ownward-connector-drill-copy";
type Surface = { files: number; bytes: number; sha256: string };

function walk(root: string) {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "secrets" || name === "backups" || name === "migrations") continue;
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("INVENTORY_SYMLINK_REJECTED");
      if (stat.isDirectory()) visit(path); else if (stat.isFile()) out.push(path);
    }
  };
  visit(root); return out.sort();
}

const surfaceOf = (root: string, paths: string[]): Surface => {
  const hash = createHash("sha256"); let bytes = 0;
  for (const path of paths) { const raw = readFileSync(path); bytes += raw.length; hash.update(relative(root, path)); hash.update("\0"); hash.update(raw); hash.update("\0"); }
  return { files: paths.length, bytes, sha256: hash.digest("hex") };
};
const jsonFile = (path: string): any => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const sha = (parts: Uint8Array[]) => { const h=createHash("sha256");for(const part of parts){h.update(part);h.update("\0");}return h.digest("hex"); };

export function migrationSourceAggregate(rootInput: string): string {
  const root=resolve(rootInput),names=["schema.json","tasks.json","sessions.json","pinned-sessions.json","actions.json","kernel/sessions.json","migrations/stage6-kernel-sessions-v1/commit.json"];
  return sha(names.flatMap(name=>[Buffer.from(name),existsSync(join(root,name))?readFileSync(join(root,name)):Buffer.from("<missing>")]));
}

export function inventoryMigrationCopy(input: string) {
  const root = resolve(input);
  if (!existsSync(join(root, MARKER))) throw new Error("INVENTORY_COPY_MARKER_REQUIRED");
  if (existsSync(join(root, "secrets"))) throw new Error("INVENTORY_SECRETS_PRESENT");
  const all = walk(root), rel = (path: string) => relative(root, path), select = (fn: (name: string) => boolean) => all.filter(path => fn(rel(path)));
  const groups: Record<string, string[]> = {
    schema: select(x => x === "schema.json"),
    kernelState: select(x => ["state.json", "actions.json", "tasks.json", "sessions.json", "pinned-sessions.json", "runs.jsonl", "kernel/sessions.json"].includes(x)),
    eventSpool: select(x => x === "queue.jsonl" || /^queue\.processing\..+\.jsonl$/.test(x) || x.startsWith("events/") || x.startsWith("connectors/domain-")),
    observational: select(x => x === "feed.jsonl" || x.startsWith("logs/") || x.startsWith("boots/") || x.startsWith("daemon-life/")),
    taskArtifacts: select(x => x.startsWith("tasks/")), chats: select(x => x.startsWith("chats/") || x === "chats.json"),
    connectors: select(x => x.startsWith("connectors/") && !x.startsWith("connectors/domain-")), runner: select(x => x.startsWith("runner/")),
    indexes: select(x => /^(dismissed-projects|lark-chats|lark-digest|cc-hook-settings|routines|strategy)($|[./])/.test(x)), other: [],
  };
  const assigned = new Set(Object.values(groups).flat()); groups.other = all.filter(path => !assigned.has(path) && rel(path) !== MARKER);
  const schema=jsonFile(join(root,"schema.json"));if(!Number.isInteger(schema?.version)||schema.version!==1)throw new Error("INVENTORY_SCHEMA_UNSUPPORTED");
  const primary=join(root,"kernel","sessions.json"),legacy=join(root,"sessions.json"),canonical=existsSync(primary)?primary:legacy;
  const tasks=jsonFile(join(root,"tasks.json")),sessionStore=jsonFile(canonical),sessionsRaw=sessionStore?.sessions,pinned=jsonFile(join(root,"pinned-sessions.json")),actions=jsonFile(join(root,"actions.json"));
  if(!Array.isArray(tasks)||sessionStore?.schemaVersion!==1||!Array.isArray(sessionsRaw)||!Array.isArray(pinned)||!Array.isArray(actions))throw new Error("INVENTORY_CRITICAL_STORE_INVALID");
  const taskRows:any[]=tasks,sessionRows:any[]=sessionsRaw,pinnedRows:any[]=pinned,actionRows:any[]=actions;
  const taskIds=new Set(taskRows.map((x:any)=>String(x?.id||"")).filter(Boolean)),nativeRefs=new Set(sessionRows.flatMap((x:any)=>[x?.nativeRef,...(Array.isArray(x?.previousRefs)?x.previousRefs:[])]).map(String).filter(Boolean));
  const activeRefs=[
    ...sessionRows.flatMap(x=>(Array.isArray(x?.taskIds)?x.taskIds:x?.taskId?[x.taskId]:[]).map((value:unknown)=>({kind:"session-task",value,ok:taskIds.has(String(value))}))),
    ...pinnedRows.map(x=>({kind:x?.kind==="task"?"pinned-task-ref":"pinned-native-ref",value:x?.ref,ok:!x?.ref||(x?.kind==="task"?taskIds.has(String(x.ref)):nativeRefs.has(String(x.ref)))})),
    ...actionRows.map(x=>({kind:"action-task",value:x?.ref?.task_id,ok:!x?.ref?.task_id||taskIds.has(String(x.ref.task_id))})),
  ].filter(x=>x.value);
  const archived=sessionRows.flatMap((x:any)=>x?.archive?.state==="orphaned-task-link"&&Array.isArray(x.archive.originalTaskRefs)?x.archive.originalTaskRefs.map((value:unknown)=>({value,valid:typeof value==="string"&&!!value&&x.taskIds?.length===0&&x.archive.migrationId==="stage6-kernel-sessions-v1"&&x.archive.reason==="task-record-missing"&&/^[0-9a-f]{64}$/.test(x.archive.sourceAggregateSha256)})):[]);
  const refHash=createHash("sha256");for(const item of activeRefs)refHash.update(`${item.kind}:${item.ok?"resolved":"dangling"}\n`);for(const item of archived)refHash.update(`archived:${item.valid?"preserved":"invalid"}\n`);
  const kinds=[...new Set(activeRefs.map(x=>x.kind))].sort(),dangling=activeRefs.filter(x=>!x.ok).length,invalidArchived=archived.filter(x=>!x.valid).length;
  return {schemaVersion:1,dataSchema:Number.isInteger(schema?.version)?schema.version:null,canonicalSessionStore:existsSync(primary)?"kernel":"legacy",sourceAggregateSha256:migrationSourceAggregate(root),applyEligible:dangling===0&&invalidArchived===0,
    surfaces:Object.fromEntries(Object.entries(groups).map(([name,paths])=>[name,surfaceOf(root,paths)])),cardinality:{tasks:taskRows.length,sessions:sessionRows.length,pinned:pinnedRows.length,actions:actionRows.length},
    keyRefs:{total:activeRefs.length,resolved:activeRefs.filter(x=>x.ok).length,dangling,blocking:dangling+invalidArchived,tolerated:0,policy:"unknown dangling refs are blocking until an exact local repair input classifies them",byKind:Object.fromEntries(kinds.map(kind=>{const rows=activeRefs.filter(x=>x.kind===kind);return[kind,{total:rows.length,resolved:rows.filter(x=>x.ok).length,dangling:rows.filter(x=>!x.ok).length}];})),archived:{total:archived.length,valid:archived.filter(x=>x.valid).length,invalid:invalidArchived},aggregateSha256:refHash.digest("hex")}};
}

if(import.meta.main){const i=process.argv.indexOf("--source"),source=i>=0?process.argv[i+1]:undefined;if(!source){console.error("usage: bun scripts/data-migration-inventory.ts --source <sanitized-copy>");process.exit(2);}try{console.log(JSON.stringify(inventoryMigrationCopy(source),null,2));}catch(error:any){console.error(JSON.stringify({ok:false,code:String(error?.message||"INVENTORY_FAILED").split(":")[0]}));process.exit(1);}}
