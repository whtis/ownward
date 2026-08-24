// 股票定点检查：工作日在 config.connectors.stock.checkTimes 指定时刻跑 lb-analyze.py，
// 报告作为事件进队列，由 triage 判断是否算"异动"值得通知。
import { homedir } from "os";
import { join } from "path";
import { cfg, fmt, log, run } from "../util.ts";
import type { ConnectorContext, ConnectorEvent } from "../kernel/connectors/contracts.ts";

const ANALYZER = join(homedir(), ".local", "bin", "lb-analyze.py");

export function startStock() {
  void import("../connectors.ts").then((m)=>m.startConnectors()).catch((e)=>log(`stock connector start: ${e instanceof Error?e.name:"unknown"}`));
}

export async function collectStockAt(ctx: ConnectorContext, now: Date, execute = run): Promise<void> {
  const watchlist = Array.isArray(ctx.config.watchlist) ? ctx.config.watchlist.filter((symbol): symbol is string => typeof symbol === "string" && !!symbol) : [];
  const stamp = `${fmt(now, "date")}T${fmt(now, "time")}`, events: ConnectorEvent[] = [];
  for (const symbol of watchlist) {
    const r = await execute(["python3", ANALYZER, symbol], { timeoutMs: 120_000 });
    events.push({ id: `${stamp}:${symbol}`, namespace: "stock.inbox", type: "snapshot", occurredAt: now.toISOString(), payload: { symbol, scheduledAt: stamp, ok: r.code === 0, report: (r.code === 0 ? r.stdout : r.stderr).slice(0, 3000) } });
  }
  await ctx.publish(events, { version: 1, cursor: stamp, updatedAt: new Date().toISOString(), metadata: { count: events.length } });
}

export async function startStockConnector(ctx: ConnectorContext): Promise<void> {
  const state=await restoreStockState(ctx);
  const tick = () => runStockTick(ctx,state,new Date());
  const timer = setInterval(() => void tick(), 30_000); ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
export async function restoreStockState(ctx:ConnectorContext){const checkpoint=await ctx.checkpoint();return{lastFired:typeof checkpoint?.cursor==="string"?checkpoint.cursor:"",running:false};}

export async function runStockTick(ctx:ConnectorContext,state:{lastFired:string;running?:boolean},now:Date,execute=run):Promise<boolean>{
    const dow = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, weekday: "short" }).format(now);
    if (dow === "Sat" || dow === "Sun") return false;
    const hhmm = fmt(now, "time");
    const checkTimes = Array.isArray(ctx.config.checkTimes) ? ctx.config.checkTimes : [];
    const due=checkTimes.filter((value):value is string=>typeof value==="string"&&/^\d{2}:\d{2}$/.test(value)&&value<=hhmm).sort().at(-1);if(!due)return false;
    const stamp = `${fmt(now, "date")}T${due}`;
    if (state.lastFired === stamp || state.running) return false;
    const[h,m]=hhmm.split(":").map(Number),[dh,dm]=due.split(":").map(Number),scheduled=new Date(now.getTime()-((h!*60+m!)-(dh!*60+dm!))*60_000);
    state.running=true;
    try { await collectStockAt(ctx, scheduled,execute);state.lastFired=stamp;await ctx.reportHealth({ok:true,detail:{scheduledAt:stamp}});return true; } catch (error) {const message=error instanceof Error?error.message:String(error);await ctx.reportHealth({ok:false,code:"STOCK_POLL_FAILED",message});ctx.log("poll",message);return false; }finally{state.running=false;}
}
