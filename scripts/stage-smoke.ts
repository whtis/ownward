// 预发布冒烟：无头 Chrome 把工作台每个 tab 打开一遍，抓页面脚本没接住的异常（Uncaught / Uncaught (in promise)）
// 和加载失败的资源（404/500 的脚本、样式、接口）。verify.sh 只做语法检查和接口探活，
// 「某个 tab 一打开就抛异常、页面白着」这类问题只有真把页面跑起来才看得见。
//
// 用法：bun scripts/stage-smoke.ts http://127.0.0.1:4519   （全部通过退出 0，否则 1）
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const SMOKE_TABS = ["today", "tasks", "chat", "notes", "roles", "feed", "system", "settings", "pr", "lark", "mail"] as const;

/** 从 Chrome 的 stderr 日志里挑出算作失败的 console 行（--enable-logging=stderr 会把页面 console 打成 INFO:CONSOLE） */
export function consoleFailures(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split("\n")) {
    const m = /:CONSOLE(?::\d+)?\]\s*"(.*)",\s*source:\s*([^\s(]\S*)?/.exec(line);   // source 为空时后面紧跟的是 (行号)
    if (!m) continue;
    if (/^Uncaught\b/.test(m[1]) || /^Failed to load resource\b/.test(m[1])) out.push(`${m[1]}${m[2] ? `  (${m[2]})` : ""}`);
  }
  return [...new Set(out)];
}

export async function loadTab(base: string, tab: string, root: string, settleMs = 8_000, maxMs = 40_000) {
  // 不用 --dump-dom：工作台常开一条 SSE，--virtual-time-budget 要等网络空闲才推进虚拟时间，永远等不到头；
  // 加 --timeout 又会在 load 事件一到就吐 DOM，异步渲染里的异常还没发生。冒烟只要「有没有报错」——
  // 打开页面实打实跑，再结束 Chrome 读它的 console 日志。
  // 计时从页面第一次出 console 输出（HTML 开始执行）算起：机器忙时 Chrome 光启动就要好几秒，
  // 固定睡眠会把「启动慢」误判成「没加载」（整套测试并行跑时实撞）。
  // 独立 profile：用用户默认 profile 起 headless 会跟正在用的 Chrome 抢锁
  const proc = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${join(root, tab)}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update",
    "--enable-logging=stderr", "--v=0", `${base}/?tab=${tab}`], { stdout: "ignore", stderr: "pipe" });
  const reader = proc.stderr.getReader(), decoder = new TextDecoder(), began = Date.now();
  let stderr = "", firstConsole = 0, pending = reader.read();
  for (;;) {
    const now = Date.now();
    if ((firstConsole && now - firstConsole >= settleMs) || now - began >= maxMs) break;
    const next = await Promise.race([pending, Bun.sleep(250).then(() => null)]);
    if (next === null) continue;
    if (next.done) break;
    stderr += decoder.decode(next.value, { stream: true });
    if (!firstConsole && /:CONSOLE/.test(stderr)) firstConsole = Date.now();
    pending = reader.read();
  }
  proc.kill("SIGKILL");
  await proc.exited;
  const errors = consoleFailures(stderr);
  // 页面压根没加载（daemon 挂了/连不上）时 console 一行都不会有——没有报错不等于通过
  if (!firstConsole && !/net::ERR_/.test(stderr)) errors.unshift(`页面 ${maxMs / 1000}s 内没有产生任何 console 输出，疑似没加载起来`);
  for (const m of stderr.matchAll(/net::(ERR_[A-Z_]+)/g)) errors.push(`网络错误 ${m[1]}`);
  return { tab, errors: [...new Set(errors)] };
}

if (import.meta.main) {
  const base = (process.argv[2] || "http://127.0.0.1:4519").replace(/\/+$/, "");
  const root = mkdtempSync(join(tmpdir(), "ownward-stage-smoke-"));
  let failed = 0;
  try {
    for (const tab of SMOKE_TABS) {
      const r = await loadTab(base, tab, root);
      if (r.errors.length) { failed++; console.log(`   ❌ ${tab}`); for (const e of r.errors.slice(0, 5)) console.log(`      ${e}`); }
      else console.log(`   ✅ ${tab}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.exit(failed ? 1 : 0);
}
