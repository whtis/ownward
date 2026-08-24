import { KernelSessionService } from "./kernel/sessions/service.ts";
import { effectiveSessionMigrationMode } from "./kernel/sessions/contracts.ts";
import { SessionRepository } from "./sessions/repository.ts";
import { cfg, DATA } from "./util.ts";
const services=new Map<string,KernelSessionService>();
export const SESSION_SERVICE_CACHE_LIMIT = 32;

/** Composition-root factory: every product entrypoint resolves the same effective mode/canary policy. */
function effectiveSessionPolicy(taskId:string,dataRoot=DATA):{mode:"off"|"runner";taskIds:string[]}{
  let identities: string[] = [taskId];
  try {
    const repo = new SessionRepository(dataRoot), session = repo.getById(taskId) ?? repo.getByTaskId(taskId);
    // Canary is exclusively a migration gate for legacy identities. Once an
    // identity is native/adopted, every read and mutation must stay on Runner.
    if (session?.source !== "legacy") return {mode:"runner",taskIds:[]};
    identities = [session.id, ...session.taskIds];
  } catch { return {mode:"runner",taskIds:[]}; /* corrupted identity must never reopen legacy writes */ }
  const allowlist = cfg.architecture?.sessionRunnerTaskIds ?? [];
  return {mode:effectiveSessionMigrationMode(cfg.architecture?.sessionRunnerMode, identities, allowlist),taskIds:allowlist};
}
export function effectiveSessionMode(taskId:string,dataRoot=DATA){return effectiveSessionPolicy(taskId,dataRoot).mode;}
export function createSessionService(taskId: string, roots: string[] = [], dataRoot = DATA): KernelSessionService {
  const {mode,taskIds}=effectiveSessionPolicy(taskId,dataRoot);
  const key=JSON.stringify([dataRoot,mode,[...roots].sort(),[...taskIds].sort()]);let service=services.get(key);
  if(service){services.delete(key);services.set(key,service);return service;}
  service=new KernelSessionService(dataRoot,{mode,roots,taskIds});services.set(key,service);
  while(services.size>SESSION_SERVICE_CACHE_LIMIT){const oldest=services.keys().next().value!;services.get(oldest)?.dispose();services.delete(oldest);}
  return service;
}
/** Canary 只约束存量身份；全新任务在硬切后始终由 Runner 创建。 */
export function createNewSessionService(roots: string[] = [], dataRoot = DATA): KernelSessionService {
  return new KernelSessionService(dataRoot, { mode: "runner", roots, taskIds: [] });
}
/** 接管幂等查询：这个 Provider 原生会话（codex rollout / claude session id）是否已被接管过。
 *  repo.bind() 本来就按 nativeRef 去重——只把新 taskId 追加进同一条 Session——所以调用方
 *  若先 mint 了 task 再 adopt，多出来的那张卡就永远指向同一个对话。建卡前先问这一句。 */
export function adoptedSessionFor(providerId:"claude"|"codex"|"codebuddy",nativeRef:string,dataRoot=DATA){
  try{return new SessionRepository(dataRoot).findByNative(providerId,nativeRef);}catch{return null;}
}
export async function sweepLegacyApprovalsIfPresent(dataRoot=DATA):Promise<boolean>{const hasLegacy=new SessionRepository(dataRoot).list().some(s=>s.source==="legacy");if(!hasLegacy)return false;(await import("./agent-session.ts")).sweepPendingPerms();return true;}
