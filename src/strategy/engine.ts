// 策略引擎：确定性规则层。持仓快照 + 论点卡 + 技术扫描 → 规则命中 → 视图模型。
// 铁律：LLM 不参与任何数字判断——分层/集中度/止损全是纯函数；
// 通知文案的润色发生在 triage 端，规则命中本身在这里一锤定音。
// 策略的人读版在仓库根 STRATEGY.md；机器可执行的旋钮在 config.json.strategy。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { THESIS_DIR } from "../paths.ts";
import { DATA, cfg, ensureDir, log, run } from "./../util.ts";

export const STRAT_DIR = join(DATA, "strategy");
const POS_FILE = join(STRAT_DIR, "positions.json");
const SCAN_FILE = join(STRAT_DIR, "scan.json");

/* ---------- 数据形状 ---------- */

export interface StockPos {
  kind: "stock";
  symbol: string;
  qty: number;
  mktValue: number;
  unrealPnl: number;
}
export interface OptionPos {
  kind: "option";
  underlying: string;
  right: "C" | "P";
  strike: number;
  expiry: string;       // YYYY-MM-DD
  side: "long" | "short";
  qty: number;
  mktValue: number;     // 空头为负
  unrealPnl: number;
  multiplier?: number;  // 默认 100
}
export type Position = StockPos | OptionPos;

export interface Snapshot {
  asOf: string;
  source: "manual" | "cmd";
  account: {
    netLiq: number; cash: number; stockValue: number; optionsValue: number;
    unrealPnl?: number; maintMargin?: number; buyingPower?: number;
  };
  positions: Position[];
}

export interface Thesis {
  symbol: string;
  status: "active" | "review" | "closed";
  stop?: number;         // 止损价（每股）
  target?: number;
  invalidation?: string; // 失效条件
  opened?: string;
  body: string;
}

export interface ScanResult {
  symbol: string;
  price?: number;
  short?: string; mid?: string; long?: string;  // 多/空/平
  guidance?: string;   // 结论行下的一句话
  flags?: string[];    // 派发/金叉 等信号词
}
export interface ScanFile { at: string; results: Record<string, ScanResult>; }

/* ---------- 配置 ---------- */

export function stratCfg() {
  const c = cfg.strategy || {};
  return {
    enabled: !!c.enabled,
    targets: c.targets || { core: 70, satellite: 25, tactical: 5 },
    rules: {
      singleMaxPct: 10, themeMaxOfSatellitePct: 50, defaultStopPct: 8,
      nearStopPp: 2, fragmentPct: 2, driftPp: 10, ...(c.rules || {}),
    },
    layers: c.layers || {},                  // { core: [...], tactical: [...] }；未列出的股票默认 satellite
    themes: (c.themes || {}) as Record<string, string[]>,
    symbolSuffix: c.symbolSuffix || ".US",
    symbolOverrides: (c.symbolOverrides || {}) as Record<string, string>,
    positionsCmd: c.positionsCmd || "",
    // 长桥 CLI 的 region 按延迟自动探测会选中 cn，但 token 可能只在 global 侧有效——
    // 用 LONGBRIDGE_REGION 环境变量钉住（优先级高于它的 region-cache）
    lbRegion: (c.lbRegion || "") as string,
    scanTimes: (c.scanTimes || ["05:10"]) as string[],
    monitor: { enabled: false, intervalMin: 10, start: "21:30", end: "04:05", dropPct: 5, ...(c.monitor || {}) },
  };
}

/* ---------- 持仓快照 ---------- */

export function loadSnapshot(): Snapshot | null {
  try { return JSON.parse(readFileSync(POS_FILE, "utf8")); } catch { return null; }
}

export function saveSnapshot(s: Snapshot) {
  ensureDir(STRAT_DIR);
  writeFileSync(POS_FILE, JSON.stringify(s, null, 2));
}

/** 用配置的命令刷新持仓（如 ssh 到 NAS curl 后端）。失败时保留旧快照并如实报错。 */
export async function refreshSnapshot(): Promise<{ ok: boolean; msg: string }> {
  const cmd = stratCfg().positionsCmd;
  if (!cmd) return { ok: false, msg: "未配置 positionsCmd——当前为手动快照" };
  const r = await run(["bash", "-c", cmd], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, msg: `刷新失败(${r.code}): ${r.stderr.slice(0, 120)}` };
  try {
    const parsed = JSON.parse(r.stdout);
    if (!parsed?.account || !Array.isArray(parsed?.positions)) throw new Error("缺 account/positions 字段");
    saveSnapshot({ ...parsed, asOf: new Date().toISOString(), source: "cmd" });
    return { ok: true, msg: "持仓已刷新" };
  } catch (e) {
    return { ok: false, msg: `返回不是合法快照: ${String(e).slice(0, 100)}` };
  }
}

/* ---------- 论点卡（vault markdown，文件即真相） ---------- */

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

export function loadTheses(): Record<string, Thesis> {
  const out: Record<string, Thesis> = {};
  if (!existsSync(THESIS_DIR)) return out;
  for (const f of readdirSync(THESIS_DIR)) {
    if (!f.endsWith(".md")) continue;
    try {
      const { meta, body } = parseFrontmatter(readFileSync(join(THESIS_DIR, f), "utf8"));
      const symbol = (meta.symbol || f.replace(/\.md$/, "")).toUpperCase();
      out[symbol] = {
        symbol,
        status: (["active", "review", "closed"].includes(meta.status) ? meta.status : "active") as Thesis["status"],
        stop: meta.stop ? parseFloat(meta.stop) : undefined,
        target: meta.target ? parseFloat(meta.target) : undefined,
        invalidation: meta.invalidation || undefined,
        opened: meta.opened || undefined,
        body: body.trim(),
      };
    } catch (e) { log(`thesis parse failed ${f}: ${e}`); }
  }
  return out;
}

export function saveThesis(t: Thesis) {
  ensureDir(THESIS_DIR);
  const fm = [
    "---",
    `symbol: ${t.symbol.toUpperCase()}`,
    `status: ${t.status}`,
    t.stop != null ? `stop: ${t.stop}` : null,
    t.target != null ? `target: ${t.target}` : null,
    t.invalidation ? `invalidation: ${t.invalidation}` : null,
    `opened: ${t.opened || new Date().toISOString().slice(0, 10)}`,
    "---",
  ].filter(Boolean).join("\n");
  writeFileSync(join(THESIS_DIR, `${t.symbol.toUpperCase()}.md`), `${fm}\n\n${t.body || ""}\n`);
}

/* ---------- 扫描结果 ---------- */

export function loadScan(): ScanFile | null {
  try { return JSON.parse(readFileSync(SCAN_FILE, "utf8")); } catch { return null; }
}
export function saveScan(s: ScanFile) {
  ensureDir(STRAT_DIR);
  writeFileSync(SCAN_FILE, JSON.stringify(s, null, 2));
}

/** IBKR 代码 → 长桥代码（AVGO → AVGO.US；特殊写法走 overrides） */
export function toLbSymbol(sym: string): string {
  const c = stratCfg();
  return c.symbolOverrides[sym] || sym + c.symbolSuffix;
}

/* ---------- 规则引擎（纯函数核心） ---------- */

export interface StratAction {
  level: "L1" | "L2" | "L3";
  kind: "stop" | "thesis" | "cap" | "theme" | "drift" | "review" | "fragment" | "expiry";
  title: string;
  reason: string;
  symbol?: string;
}

export interface HoldingRow {
  symbol: string;
  display: string;           // 期权组合的展示名
  kind: "stock" | "option";
  layer: "core" | "satellite" | "tactical";
  theme?: string;
  pctNav: number;
  mktValue: number;
  unrealPnl: number;
  unrealPct?: number;        // 相对成本
  thesis: "missing" | "active" | "review";
  stop: { state: "unset" | "set" | "near" | "breach"; price?: number; distPct?: number; note?: string };
  ta?: { verdict: string; flags: string[]; guidance?: string };
  fragment?: boolean;
  legs?: string[];           // 期权腿摘要
}

export interface StrategyView {
  meta: {
    enabled: boolean; asOf: string | null; source: string | null;
    scanAt: string | null; generatedAt: string; netLiq?: number;
  };
  structure: {
    layers: Record<"core" | "satellite" | "tactical" | "cash", { pct: number; value: number }>;
    targets: Record<string, number>;
    deviations: { label: string; pp: number }[];
    themeTop?: { theme: string; pctOfSatellite: number };
  } | null;
  actions: StratAction[];
  holdings: HoldingRow[];
  intel: { label: string; value: string }[];
}

const pct = (v: number, base: number) => base > 0 ? +(v / base * 100).toFixed(1) : 0;

export function buildView(): StrategyView {
  const c = stratCfg();
  const snap = loadSnapshot();
  const scan = loadScan();
  const theses = loadTheses();
  const generatedAt = new Date().toISOString();

  if (!snap) {
    return {
      meta: { enabled: c.enabled, asOf: null, source: null, scanAt: scan?.at || null, generatedAt },
      structure: null, actions: [], holdings: [],
      intel: [{ label: "持仓", value: "无快照——先刷新或导入持仓" }],
    };
  }

  const nav = snap.account.netLiq;
  const layerOf = (sym: string): HoldingRow["layer"] => {
    if ((c.layers.core || []).includes(sym)) return "core";
    if ((c.layers.tactical || []).includes(sym)) return "tactical";
    return "satellite";
  };
  const themeOf = (sym: string): string | undefined => {
    for (const [name, list] of Object.entries(c.themes)) if (list.includes(sym)) return name;
    return undefined;
  };

  /* -- 持仓行 -- */
  const rows: HoldingRow[] = [];
  const stocks = snap.positions.filter((p): p is StockPos => p.kind === "stock");
  const options = snap.positions.filter((p): p is OptionPos => p.kind === "option");

  for (const p of stocks) {
    const layer = layerOf(p.symbol);
    const cost = p.mktValue - p.unrealPnl;
    const unrealPct = cost > 0 ? +(p.unrealPnl / cost * 100).toFixed(1) : undefined;
    const th = theses[p.symbol];
    const price = p.qty > 0 ? p.mktValue / p.qty : 0;
    const costPrice = p.qty > 0 ? cost / p.qty : 0;

    // 止损状态：论点卡里定了止损价用它；没定则用默认线（成本 -defaultStopPct%）衡量，但状态记 unset
    let stop: HoldingRow["stop"] = { state: "unset" };
    if (th?.stop != null && price > 0) {
      const dist = +((price - th.stop) / price * 100).toFixed(1);
      stop = {
        state: dist <= 0 ? "breach" : dist <= c.rules.nearStopPp ? "near" : "set",
        price: th.stop, distPct: dist,
      };
    } else if (unrealPct != null && costPrice > 0) {
      if (unrealPct <= -c.rules.defaultStopPct) {
        stop = { state: "breach", distPct: unrealPct, note: `已破默认线 -${c.rules.defaultStopPct}%` };
      } else if (unrealPct <= -(c.rules.defaultStopPct - c.rules.nearStopPp)) {
        stop = { state: "near", distPct: unrealPct, note: "近默认线" };
      }
    }

    const sc = scan?.results[p.symbol];
    rows.push({
      symbol: p.symbol, display: p.symbol, kind: "stock", layer, theme: themeOf(p.symbol),
      pctNav: pct(p.mktValue, nav), mktValue: p.mktValue, unrealPnl: p.unrealPnl, unrealPct,
      thesis: th ? (th.status === "review" ? "review" : "active") : "missing",
      stop,
      ta: sc ? {
        verdict: [sc.short, sc.mid, sc.long].map((x) => x || "?").join("·"),
        flags: sc.flags || [], guidance: sc.guidance,
      } : undefined,
      fragment: pct(p.mktValue, nav) < c.rules.fragmentPct,
    });
  }

  // 期权按标的聚合成一行（战术层）
  const byUnderlying = new Map<string, OptionPos[]>();
  for (const o of options) {
    byUnderlying.set(o.underlying, [...(byUnderlying.get(o.underlying) || []), o]);
  }
  for (const [und, legs] of byUnderlying) {
    const mv = legs.reduce((s, l) => s + l.mktValue, 0);
    const pnl = legs.reduce((s, l) => s + l.unrealPnl, 0);
    const th = theses[und];
    const sc = scan?.results[und];
    rows.push({
      symbol: und, display: `${und} 期权`, kind: "option", layer: "tactical", theme: themeOf(und),
      pctNav: pct(mv, nav), mktValue: mv, unrealPnl: pnl,
      thesis: th ? (th.status === "review" ? "review" : "active") : "missing",
      stop: { state: "unset" },
      ta: sc ? { verdict: [sc.short, sc.mid, sc.long].map((x) => x || "?").join("·"), flags: sc.flags || [], guidance: sc.guidance } : undefined,
      legs: legs.map((l) =>
        `${l.side === "short" ? "空" : "多"}${l.qty} ${l.expiry.slice(2, 7)} $${l.strike}${l.right}`),
    });
  }

  // 排序：问题优先——破线 > 需重审/缺卡 > 仓位大小
  const sev = (r: HoldingRow) =>
    (r.stop.state === "breach" ? 400 : r.stop.state === "near" ? 300 : 0) +
    (r.thesis === "missing" ? 200 : r.thesis === "review" ? 100 : 0) + r.pctNav;
  rows.sort((a, b) => sev(b) - sev(a));

  /* -- 结构 -- */
  const layerVal = { core: 0, satellite: 0, tactical: 0 };
  for (const p of stocks) layerVal[layerOf(p.symbol)] += p.mktValue;
  layerVal.tactical += snap.account.optionsValue;
  const structure = {
    layers: {
      core: { pct: pct(layerVal.core, nav), value: layerVal.core },
      satellite: { pct: pct(layerVal.satellite, nav), value: layerVal.satellite },
      tactical: { pct: pct(layerVal.tactical, nav), value: layerVal.tactical },
      cash: { pct: pct(snap.account.cash, nav), value: snap.account.cash },
    },
    targets: c.targets,
    deviations: [] as { label: string; pp: number }[],
    themeTop: undefined as { theme: string; pctOfSatellite: number } | undefined,
  };
  for (const k of ["core", "satellite", "tactical"] as const) {
    const pp = +(structure.layers[k].pct - (c.targets[k] ?? 0)).toFixed(1);
    if (Math.abs(pp) >= c.rules.driftPp) {
      structure.deviations.push({ label: { core: "核心", satellite: "卫星", tactical: "战术" }[k], pp });
    }
  }
  // 主题集中度（占卫星仓）
  let themeTop: { theme: string; v: number } | null = null;
  for (const name of Object.keys(c.themes)) {
    const v = stocks.filter((p) => layerOf(p.symbol) === "satellite" && themeOf(p.symbol) === name)
      .reduce((s, p) => s + p.mktValue, 0);
    if (!themeTop || v > themeTop.v) themeTop = { theme: name, v };
  }
  if (themeTop && layerVal.satellite > 0) {
    structure.themeTop = { theme: themeTop.theme, pctOfSatellite: pct(themeTop.v, layerVal.satellite) };
  }

  /* -- 规则命中 → 行动 -- */
  const actions: StratAction[] = [];
  const breached = rows.filter((r) => r.stop.state === "breach");
  if (breached.length) {
    actions.push({
      level: "L1", kind: "stop",
      title: `${breached.length} 只持仓触及/跌破止损线`,
      reason: breached.map((r) => `${r.symbol} ${r.stop.price ? `破 $${r.stop.price}` : r.stop.note}（${r.unrealPct ?? "?"}%）`).join("；"),
    });
  }
  const noThesis = rows.filter((r) => r.thesis === "missing" && !r.fragment && r.layer !== "core");
  if (noThesis.length) {
    actions.push({
      level: "L1", kind: "thesis",
      title: `${noThesis.length} 只持仓没有论点卡`,
      reason: `无卡则无止损监控与失效追踪：${noThesis.map((r) => r.symbol).join("、")}。补卡即自动纳入监控。`,
    });
  }
  for (const r of rows) {
    if (r.kind === "stock" && r.pctNav > c.rules.singleMaxPct) {
      actions.push({
        level: "L2", kind: "cap", symbol: r.symbol,
        title: `${r.symbol} ${r.pctNav}% 超单票上限 ${c.rules.singleMaxPct}%`,
        reason: "减仓至上限内，或在论点卡登记例外理由。",
      });
    }
  }
  if (structure.themeTop && structure.themeTop.pctOfSatellite > c.rules.themeMaxOfSatellitePct) {
    actions.push({
      level: "L2", kind: "theme",
      title: `主题「${structure.themeTop.theme}」占卫星仓 ${structure.themeTop.pctOfSatellite}%`,
      reason: `超过上限 ${c.rules.themeMaxOfSatellitePct}%——标的名字不同，方向是同一注。`,
    });
  }
  const reviews = rows.filter((r) => r.thesis === "review");
  for (const r of reviews) {
    actions.push({
      level: "L2", kind: "review", symbol: r.symbol,
      title: `${r.symbol} 论点需重审`,
      reason: `${r.unrealPct != null ? `${r.unrealPct}% · ` : ""}${r.ta ? `技术面 ${r.ta.verdict}` : ""}——回答一个问题：当初的买入论点还成立吗？`,
    });
  }
  for (const d of structure.deviations) {
    actions.push({
      level: "L3", kind: "drift",
      title: `${d.label}仓偏离目标 ${d.pp > 0 ? "+" : ""}${d.pp}pp`,
      reason: d.label === "核心" ? "核心仓未启动——定投标的与节奏待拍板（STRATEGY.md）。" : "结构偏离，随核心仓建立自然收敛，无需急动。",
    });
  }
  const frags = rows.filter((r) => r.fragment && r.kind === "stock");
  if (frags.length >= 2) {
    actions.push({
      level: "L3", kind: "fragment",
      title: `${frags.length} 只碎仓（<${c.rules.fragmentPct}% 净值）`,
      reason: `${frags.map((r) => r.symbol).join("、")}——对收益无意义纯监控负担，考虑清掉或并仓。`,
    });
  }
  // 期权临近到期（30 天内）
  for (const o of options) {
    const days = Math.ceil((Date.parse(o.expiry) - Date.now()) / 86_400_000);
    if (days >= 0 && days <= 30) {
      actions.push({
        level: "L2", kind: "expiry", symbol: o.underlying,
        title: `${o.underlying} ${o.expiry.slice(5)} $${o.strike}${o.right} ${o.side === "short" ? "空头" : "多头"}还有 ${days} 天到期`,
        reason: o.side === "short" ? "决定：让它归零收租，还是提前平仓/roll——依据论点卡而非惯性。" : "到期临近，检查论点与时间价值损耗。",
      });
    }
  }
  const order = { L1: 0, L2: 1, L3: 2 };
  actions.sort((a, b) => order[a.level] - order[b.level]);

  /* -- 情报 -- */
  const intel: { label: string; value: string }[] = [];
  if (scan) {
    const bears = Object.values(scan.results).filter((r) => r.short === "空" && r.mid === "空" && r.long === "空");
    intel.push({ label: "技术面", value: `${Object.keys(scan.results).length} 只已扫描，${bears.length} 只全级别空头${bears.length ? `（${bears.map((b) => b.symbol).join("、")}）` : ""}` });
    const flagged = Object.values(scan.results).filter((r) => r.flags?.length);
    for (const f of flagged.slice(0, 3)) intel.push({ label: f.symbol, value: f.flags!.join("、") });
  } else {
    intel.push({ label: "技术面", value: "未扫描——点「立即扫描」或等收盘后自动扫描" });
  }
  intel.push({ label: "期权墙", value: "未接入（长桥期权行情无权限，EOD 替代源见 docs/strategy-engine.md）" });
  intel.push({ label: "下次定投", value: "核心仓未启动——标的/金额待拍板" });

  return {
    meta: {
      enabled: c.enabled, asOf: snap.asOf, source: snap.source,
      scanAt: scan?.at || null, generatedAt, netLiq: nav,
    },
    structure, actions, holdings: rows, intel,
  };
}
