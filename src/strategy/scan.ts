// 策略扫描与监控调度。
// - 收盘后扫描：全持仓跑 lb-analyze.py，解析结论存 scan.json；汇总事件进队列由 triage 定级
// - 盘中监控：只盯持仓票的止损/急跌（确定性判断），命中直接 notify()——不过 LLM、不受静默时段影响
// 两者都只在非测试模式由 daemon 启动。
import { homedir } from "os";
import { join } from "path";
import { appendEvent } from "../spool.ts";
import { notify } from "../notify.ts";
import { cfg, fmt, log, markHealth, run, updateState, loadState } from "../util.ts";
import {
  ScanFile, ScanResult, StockPos, loadScan, loadSnapshot, saveScan, stratCfg, toLbSymbol,
} from "./engine.ts";

const ANALYZER = join(homedir(), ".local", "bin", "lb-analyze.py");
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 长桥 CLI 调用环境：config.strategy.lbRegion 钉住 region（见 engine.ts 注释） */
function lbEnv(): Record<string, string> | undefined {
  const r = stratCfg().lbRegion;
  return r ? { LONGBRIDGE_REGION: r } : undefined;
}

/** 解析 lb-analyze 输出：现价 + 三级别结论 + 指导语 + 信号词 */
export function parseAnalysis(symbol: string, raw: string): ScanResult {
  const text = stripAnsi(raw);
  const out: ScanResult = { symbol };
  const price = text.match(/现价\s+([\d.]+)/);
  if (price) out.price = parseFloat(price[1]);
  const verdict = text.match(/短线\s*(多|空|平)[^中]*中期\s*(多|空|平)[^长]*长期\s*(多|空|平)/);
  if (verdict) { out.short = verdict[1]; out.mid = verdict[2]; out.long = verdict[3]; }
  const lines = text.split("\n").map((l) => l.trim());
  const vIdx = lines.findIndex((l) => l.startsWith("结论"));
  if (vIdx >= 0 && lines[vIdx + 1] && !lines[vIdx + 1].startsWith("关键支撑")) out.guidance = lines[vIdx + 1];
  const flags: string[] = [];
  for (const f of ["派发", "吸筹", "低位金叉", "低位死叉", "放量", "顶背离", "底背离"]) {
    if (text.includes(f)) flags.push(f);
  }
  if (flags.length) out.flags = flags;
  return out;
}

/** 收盘后全持仓扫描。并发跑、单票失败不拖垮整批。 */
export async function runStrategyScan(): Promise<ScanFile | null> {
  const snap = loadSnapshot();
  if (!snap) { log("strategy scan: 无持仓快照，跳过"); return null; }
  const prev = loadScan();
  const symbols = [...new Set(
    snap.positions.map((p) => p.kind === "stock" ? p.symbol : p.underlying),
  )];
  log(`strategy scan: ${symbols.length} symbols`);
  const results: Record<string, ScanResult> = {};
  // 有界并发：长桥 API 有 QPS 限制，全并发会集体拿到"无法获取数据"（实测 11 并发全灭、4 并发正常）
  const POOL = 3;
  const env = lbEnv();
  for (let i = 0; i < symbols.length; i += POOL) {
    await Promise.all(symbols.slice(i, i + POOL).map(async (sym) => {
      const r = await run(["python3", ANALYZER, toLbSymbol(sym)], { timeoutMs: 120_000, env });
      if (r.code === 0 && r.stdout.includes("结论")) results[sym] = parseAnalysis(sym, r.stdout);
      else log(`strategy scan ${sym} failed: ${(r.stderr || r.stdout).slice(0, 100)}`);
    }));
    if (i + POOL < symbols.length) await Bun.sleep(1500);
  }
  if (!Object.keys(results).length) return null;
  const file: ScanFile = { at: new Date().toISOString(), results };
  saveScan(file);
  markHealth("stock");

  // 汇总成一条事件交给 triage 定级（恶化的票单独点名，triage 决定 notify 还是 log）
  const allBear = Object.values(results).filter((r) => r.short === "空" && r.mid === "空" && r.long === "空");
  const worsened = allBear.filter((r) => {
    const p = prev?.results[r.symbol];
    return p && !(p.short === "空" && p.mid === "空" && p.long === "空");
  });
  appendEvent({
    source: "stock", key: "strategy/scan", ts: new Date().toISOString(),
    payload: {
      kind: "策略收盘扫描",
      scanned: Object.keys(results).length,
      allBear: allBear.map((r) => r.symbol),
      newlyBear: worsened.map((r) => r.symbol),
      flags: Object.values(results).filter((r) => r.flags?.length)
        .map((r) => `${r.symbol}:${r.flags!.join("/")}`),
      note: "全级别空头为持仓风险信号；newlyBear 是本次新恶化的票，值得点名提醒",
    },
  });
  return file;
}

/* ---------- 盘中监控（确定性，直接通知） ---------- */

function inWindow(now: Date, start: string, end: string): boolean {
  const t = fmt(now, "time");
  return start > end ? t >= start || t < end : t >= start && t < end;
}

/** 一次监控 tick：拉持仓票实时报价，检查止损击穿与单日急跌。同一票同一天只叫一次。 */
export async function monitorTick() {
  const c = stratCfg();
  const snap = loadSnapshot();
  if (!snap) return;
  const { loadTheses } = await import("./engine.ts");
  const theses = loadTheses();
  const stocks = snap.positions.filter((p): p is StockPos => p.kind === "stock");
  if (!stocks.length) return;

  const lbSyms = stocks.map((p) => toLbSymbol(p.symbol));
  const r = await run(["longbridge", "quote", ...lbSyms, "--format", "json"], { timeoutMs: 30_000, env: lbEnv() });
  if (r.code !== 0) { log(`strategy monitor: quote failed ${r.stderr.slice(0, 100)}`); return; }
  let quotes: any[] = [];
  try { quotes = JSON.parse(r.stdout); } catch { return; }

  const today = fmt(new Date(), "date");
  const state = loadState();
  const fired: Record<string, string> = state.strategyAlerts || {};

  for (const q of quotes) {
    const lbSym = q.symbol || "";
    const pos = stocks.find((p) => toLbSymbol(p.symbol) === lbSym || lbSym.startsWith(p.symbol + "."));
    if (!pos) continue;
    const last = parseFloat(q.last_done ?? q.lastDone ?? "0");
    const prevClose = parseFloat(q.prev_close ?? q.prevClose ?? "0");
    if (!last) continue;

    const alerts: string[] = [];
    const stop = theses[pos.symbol]?.stop;
    if (stop != null && last <= stop) alerts.push(`跌破止损价 $${stop}（现价 $${last}）`);
    if (prevClose > 0) {
      const day = (last - prevClose) / prevClose * 100;
      if (day <= -c.monitor.dropPct) alerts.push(`单日急跌 ${day.toFixed(1)}%`);
    }
    if (!alerts.length) continue;
    const key = `${pos.symbol}:${today}`;
    if (fired[key]) continue;             // 当日已叫过——止损是叫醒你，不是每 10 分钟锤你
    fired[key] = new Date().toISOString();
    await notify(`🛑 ${pos.symbol} ${alerts.join("；")}\n按 STRATEGY.md 纪律执行——打开策略页处理`, { source: "stock" });
  }
  updateState((s) => {
    // 只保留今天的记录，历史键自然清退
    s.strategyAlerts = Object.fromEntries(Object.entries(fired).filter(([k]) => k.endsWith(today)));
  });
}

/* ---------- 调度入口（daemon 非测试模式调用） ---------- */

export function startStrategy() {
  const c = stratCfg();
  if (!c.enabled) return;
  let lastScanFired = "";
  setInterval(async () => {
    const now = new Date();
    const hhmm = fmt(now, "time");
    const stamp = `${fmt(now, "date")} ${hhmm}`;
    // 收盘后扫描：按 scanTimes 定点（含周末——周末拿到的是周五收盘数据，幂等无害）
    if (c.scanTimes.includes(hhmm) && lastScanFired !== stamp) {
      lastScanFired = stamp;
      runStrategyScan().catch((e) => log(`strategy scan failed: ${e}`));
    }
  }, 30_000);

  if (c.monitor.enabled) {
    setInterval(() => {
      const now = new Date();
      const dow = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, weekday: "short" }).format(now);
      // 美股盘窗口跨午夜：周一晚到周六凌晨都可能在盘中
      if (dow === "Sun") return;
      if (!inWindow(now, c.monitor.start, c.monitor.end)) return;
      monitorTick().catch((e) => log(`strategy monitor failed: ${e}`));
    }, c.monitor.intervalMin * 60_000);
  }
  log(`strategy engine ready: scan @${c.scanTimes.join(",")}, monitor ${c.monitor.enabled ? `every ${c.monitor.intervalMin}m (${c.monitor.start}-${c.monitor.end})` : "off"}`);
}
