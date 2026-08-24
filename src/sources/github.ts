// GitHub 通知轮询。采集只发布标准 ConnectorEvent；去重/checkpoint 由 Kernel 持久化。
import { cfg, log, run } from "../util.ts";
import type { ConnectorContext, ConnectorEvent } from "../kernel/connectors/contracts.ts";
import { randomUUID } from "crypto";

const bootNonce = randomUUID().replaceAll("-", "").slice(0, 16);

function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

function htmlUrl(apiUrl?: string): string | undefined {
  return apiUrl?.replace("api.github.com/repos/", "github.com/").replace("/pulls/", "/pull/");
}

export function startGithub() {
  void import("../connectors.ts").then((m)=>m.startConnectors()).catch((e)=>log(`github connector start: ${e instanceof Error?e.name:"unknown"}`));
}

export async function collectGithub(ctx: ConnectorContext, execute = run): Promise<void> {
  // `gh api -f` defaults to POST unless the method is explicit. Notifications is
  // read-only and GitHub rejects a POST here, so keep GET in the actual argv.
  const r = await execute(["gh", "api", "notifications", "--method", "GET", "--paginate", "--slurp", "-f", "per_page=100"], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`gh api failed: ${r.stderr.slice(0, 200)}`);
  const parsed = JSON.parse(r.stdout || "[]") as any[], allThreads = Array.isArray(parsed[0]) ? parsed.flat() : parsed;
  const truncated = allThreads.length > 1000, threads = allThreads.slice(0, 1000);
  const previous = await ctx.checkpoint();
  let previousRevisions:Record<string,string>={};try{if(typeof previous?.metadata?.threadRevisions==="string")previousRevisions=JSON.parse(previous.metadata.threadRevisions);}catch{}
  const revisions = Object.fromEntries(threads.map((t)=>[String(t.id),String(t.updated_at||"unknown")]));
  const unreadThreadIds=threads.map((t)=>String(t.id)).sort(),snapshotHash=digest(unreadThreadIds);
  const priorObservation=Number(previous?.metadata?.observation)||0;
  const snapshotChanged=!truncated&&previous?.metadata?.snapshotHash!==snapshotHash;
  const observation=priorObservation+(snapshotChanged?1:0);
  const events: ConnectorEvent[] = threads.filter((t)=>previousRevisions[String(t.id)]!==String(t.updated_at||"unknown")).map((t) => ({
    id: `${String(t.id)}:${String(t.updated_at || "unknown")}:${observation}`,
    namespace: "github.inbox", type: String(t.reason || "notification"),
    occurredAt: Number.isFinite(Date.parse(t.updated_at)) ? t.updated_at : new Date().toISOString(),
    payload: { threadId: String(t.id), reason: t.reason, repo: t.repository?.full_name, title: t.subject?.title, subjectType: t.subject?.type, type: t.subject?.type, url: htmlUrl(t.subject?.url), updatedAt: t.updated_at, updated_at: t.updated_at, observation },
  }));
  const cursor = [...threads.map((t)=>String(t.updated_at||"")), previous?.cursor].filter((value): value is string => !!value && value !== "empty").sort().at(-1) ?? "empty";
  const generation=ctx.generation||bootNonce;
  // A partial unread set must never replace the last complete snapshot: doing so
  // would falsely resolve notifications that merely fell beyond our safety cap.
  if(snapshotChanged)events.push({id:`snapshot:${generation}:${observation}:${snapshotHash}`,namespace:"github.inbox",type:"snapshot",occurredAt:new Date().toISOString(),payload:{unreadThreadIds,observation}});
  const durableSnapshotHash=truncated?previous?.metadata?.snapshotHash:snapshotHash;
  await ctx.publish(events, { version: 1, cursor, updatedAt: new Date().toISOString(), metadata: { count: events.length, observation, ...(typeof durableSnapshotHash==="string"?{snapshotHash:durableSnapshotHash}:{}), snapshotGeneration:generation, threadRevisions:JSON.stringify(revisions) } });
  if(truncated){const message=`GitHub notifications truncated at 1000 of ${allThreads.length}; snapshot withheld`;ctx.log("poll",message);await ctx.reportHealth({ok:false,code:"GITHUB_NOTIFICATIONS_TRUNCATED",message,detail:{threads:threads.length,total:allThreads.length,snapshotPublished:false}});}
  else await ctx.reportHealth({ok:true,detail:{threads:threads.length}});
}

export async function runGithubPoll(state:{running:boolean},work:()=>Promise<void>):Promise<boolean>{if(state.running)return false;state.running=true;try{await work();return true;}finally{state.running=false;}}

export function startGithubConnector(ctx: ConnectorContext): void {
  const state={running:false},poll = () => void runGithubPoll(state,()=>collectGithub(ctx)).catch(async(error) => {const message=error instanceof Error?error.message:String(error);await ctx.reportHealth({ok:false,code:"GITHUB_POLL_FAILED",message});ctx.log("poll",message);});
  poll(); const timer = setInterval(poll, (Number(ctx.config.pollMin) || 5) * 60_000); ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
