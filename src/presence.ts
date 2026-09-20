// 工作台在不在前台：浏览器/桌面客户端聚焦时每 30s 上报一次（失焦就不报），
// notify 据此判断「人是不是正盯着 feed」——是的话就不用再推横幅和飞书了。
// 进程内存态即可：daemon 重启后第一次上报（≤30s）就恢复，没必要落盘。
import { cfg } from "./util.ts";

let lastActiveAt = 0;
let lastClient = "";

/** 没有上报的这段时间之后就算「人已离开」。比上报间隔（30s）留足余量，防抖动。 */
export const DEFAULT_ACTIVE_WINDOW_MS = 90_000;

function windowMs(): number {
  const sec = Number(cfg.notify?.activeWindowSec);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_ACTIVE_WINDOW_MS;
}

export function markPresence(client = "web", now = Date.now()): void {
  lastActiveAt = now;
  lastClient = client;
}

/** 工作台窗口是否处于聚焦状态。suppressWhenActive=false 时恒为 false（等于关掉这条规则）。 */
export function isWorkbenchActive(now = Date.now()): boolean {
  if (cfg.notify?.suppressWhenActive === false) return false;
  return lastActiveAt > 0 && now - lastActiveAt < windowMs();
}

export function presenceState(now = Date.now()) {
  return { active: isWorkbenchActive(now), client: lastClient, lastActiveAt, windowMs: windowMs() };
}

/** 仅供测试：清掉进程内的聚焦记录。 */
export function resetPresence(): void {
  lastActiveAt = 0;
  lastClient = "";
}
