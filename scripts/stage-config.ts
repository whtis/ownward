// 预发布配置：拿生产 config.json 生成 dev（../dev）的 config.json——除下面这层固定的安全覆盖外，一切与生产相同。
//
// 为什么不直接复制生产配置：dev 和生产在同一台机器上同时跑，照搬会出事——
//   飞书长连接两个消费者抢消息（各收一半）、Gmail/GitHub 重复分流、通知推两遍、两个进程对 vault 同时 git push、
//   desk 这类外接 vertical 的数据目录直接指着生产 data/、生产的 worktree 目录被 dev 的每日清理扫到。
// 覆盖层只关「会碰共享外部状态」的东西；dev 自己的会话/任务/审批/笔记照常工作，派发的任务也是真跑。
//
// 用法：bun scripts/stage-config.ts --prod <生产检出> --dev <dev 检出> [--with <vertical>,desk]
//   写 <dev>/config.json，stdout 打一行 JSON：{ vaultSource, vaultCopy, port, verticals, overrides }
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export const STAGING_PORT = 4519;

export interface StagingOptions {
  prodRoot: string;          // 生产检出（含 config.json 与 data/）
  devRoot: string;           // dev 检出
  vaultCopy: string;         // dev 用的 vault 拷贝目录（每次预发布从生产 vault 同步一份）
  allowVerticals?: string[]; // 显式要在 dev 里打开的外接 vertical（它们连的是真实数据，默认全关）
}

const plain = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** 递归把指向生产 data/ 的字符串改到 dev 的 data/（兜底：desk 的 deskData 这类路径换谁写都不该写到生产那份） */
function rewriteDataPaths(v: any, from: string, to: string): any {
  if (typeof v === "string") return v === from || v.startsWith(from + "/") ? to + v.slice(from.length) : v;
  if (Array.isArray(v)) return v.map((x) => rewriteDataPaths(x, from, to));
  if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewriteDataPaths(x, from, to)]));
  return v;
}

/** 生产配置 → dev 配置。纯函数：同一份输入永远得到同一份输出，覆盖了哪些键记在 overrides 里给人看 */
export function stagingConfig(prod: Record<string, any>, opts: StagingOptions): { config: Record<string, any>; overrides: string[] } {
  const overrides: string[] = [];
  const c = rewriteDataPaths(JSON.parse(JSON.stringify(prod ?? {})), resolve(opts.prodRoot, "data"), resolve(opts.devRoot, "data"));
  const set = (path: string, value: unknown) => {
    const keys = path.split(".");
    let node = c;
    for (const k of keys.slice(0, -1)) node = plain(node[k]) ? node[k] : (node[k] = {});
    const last = keys[keys.length - 1];
    if (JSON.stringify(node[last]) !== JSON.stringify(value)) overrides.push(path);
    node[last] = value;
  };
  set("prerelease.enabled", true);                               // daemon 据此停掉碰共享状态的后台任务，页面挂「预发布」标
  set("dashboard.port", STAGING_PORT);
  set("dashboard.listen", "local");                            // 预发布不对外：不走令牌、不进 cloudflared
  set("notify.macos", false);
  set("notify.lark", false);
  set("heartbeat.enabled", false);
  set("digest.enabled", false);
  set("vault.root", opts.vaultCopy);
  set("vault.autoSync", false);
  for (const group of ["sources", "connectors"]) {             // 生产的事件源两处都有开关（旧 sources + Connector Runtime）
    for (const [id, v] of Object.entries(plain(c[group]) ? c[group] : {})) if (plain(v) && "enabled" in v) set(`${group}.${id}.enabled`, false);
  }
  const allow = new Set(opts.allowVerticals ?? []);
  for (const [id, v] of Object.entries(plain(c.verticals) ? c.verticals : {})) {
    if (plain(v) && "enabled" in v && !allow.has(id)) set(`verticals.${id}.enabled`, false);
  }
  if (plain(c.strategy) && "enabled" in c.strategy) set("strategy.enabled", false);
  // 派发出来的 worktree 放单独目录，且不自动清理——生产那边的清理会按天扫它自己的目录
  const worktreeRoot = typeof prod?.dispatch?.worktreeRoot === "string" && prod.dispatch.worktreeRoot ? prod.dispatch.worktreeRoot.replace(/\/+$/, "") : "~/.ownward-worktrees";
  set("dispatch.worktreeRoot", `${worktreeRoot}-staging`);
  set("dispatch.worktreeRetentionDays", 0);
  return { config: c, overrides };
}

/** 生产 vault 的实际目录（config 里可能写 ~） */
export function prodVaultRoot(prod: Record<string, any>, prodRoot: string): string {
  const raw = typeof prod?.vault?.root === "string" && prod.vault.root ? prod.vault.root : "~/Documents/ownward-vault";
  return resolve(prodRoot, expandHome(raw));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const prodRoot = resolve(arg("--prod") || ""), devRoot = resolve(arg("--dev") || "");
  if (!arg("--prod") || !arg("--dev")) { console.error("用法：bun scripts/stage-config.ts --prod <生产检出> --dev <dev 检出> [--with a,b]"); process.exit(64); }
  if (prodRoot === devRoot) { console.error("❌ --prod 和 --dev 是同一个目录"); process.exit(64); }
  const prodFile = join(prodRoot, "config.json");
  if (!existsSync(prodFile)) { console.error(`❌ 生产配置不存在：${prodFile}`); process.exit(66); }
  const prod = JSON.parse(readFileSync(prodFile, "utf8"));
  const vaultCopy = join(devRoot, "data", "staging-vault");
  const allowVerticals = (arg("--with") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const { config, overrides } = stagingConfig(prod, { prodRoot, devRoot, vaultCopy, allowVerticals });
  // 第一次覆盖 dev 原来手写的 config.json 前留一份
  const target = join(devRoot, "config.json"), backup = join(devRoot, "data", "staging", "config.before-staging.json");
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  if (existsSync(target) && !existsSync(backup)) writeFileSync(backup, readFileSync(target), { mode: 0o600 });
  const tmp = `${target}.staging-tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });   // 里面有生产的各种 token，别放宽权限
  renameSync(tmp, target);
  console.log(JSON.stringify({ vaultSource: prodVaultRoot(prod, prodRoot), vaultCopy, port: STAGING_PORT, verticals: allowVerticals, overrides }));
}
