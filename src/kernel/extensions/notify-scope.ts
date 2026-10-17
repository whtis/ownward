import type { VerticalNotification, VerticalNotifyLevel } from "./contracts.ts";
import { ExtensionPolicyError } from "./services.ts";

export interface NotifyScopePort {
  /** Kernel 通知路由（feed → 横幅 → 飞书，过 notify-policy）。scope 不等它，失败只记日志。 */
  send(text: string, opts: { source: string; key: string; level: VerticalNotifyLevel; detail?: string; link?: string; quietExempt: boolean }): Promise<unknown>;
  /** 相对路径 → 工作台地址（配了外网地址就用外网，手机上的飞书卡片也能点开）。 */
  linkFor(path: string): string;
  /** 与 Kernel 通知冷却同一窗口：同 key 窗口内的重复调用在 scope 层就挡掉，不刷 feed。 */
  cooldownMs(): number;
  log?(message: string): void;
}
export interface NotifyScopeOptions { urgentGranted?: boolean; perMinute?: number; perHour?: number; now?: () => number }

const FIELDS = new Set(["key", "text", "detail", "level", "link", "urgent"]);
const LEVELS = new Set(["act", "fyi", "silent"]);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MINUTE = 60_000, HOUR = 3_600_000;
const invalid = (message: string) => new ExtensionPolicyError("VERTICAL_NOTIFY_INVALID", message);

/** 相对 link 只认本 Vertical 的资产命名空间；绝对地址只认 http(s)。
 *  先按 WHATWG 规则归一化再比前缀——浏览器会把 `%2e%2e` 当 `..`，字面比较拦不住。 */
function resolveLink(verticalId: string, link: unknown, linkFor: (path: string) => string): string {
  if (typeof link !== "string" || !link || link.length > 500 || /[\u0000-\u001f\u007f\\]/.test(link)) throw invalid("link 非法");
  if (link.startsWith("/")) {
    const base = "http://workbench.invalid";
    let url: URL;
    try { url = new URL(link, base); } catch { throw invalid("link 非法"); }
    if (link.startsWith("//") || url.origin !== base || !url.pathname.startsWith(`/verticals/${verticalId}/`)) throw invalid("相对 link 必须位于本 Vertical 的 /verticals/<id>/ 下");
    return linkFor(url.pathname + url.search + url.hash);
  }
  let url: URL;
  try { url = new URL(link); } catch { throw invalid("link 非法"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw invalid("link 只允许不带凭据的 http(s)");
  return url.toString();
}

/** 将 Kernel 通知收成受限门面（ADR 0003）：source/key 强制带本 Vertical 前缀，拿不到 force/卡片按钮等内部选项；
 *  urgent 需单独授权；同 key 冷却去重；按 Vertical 限流。受理即返回，投递在后台。 */
export function createScopedNotify(verticalId: string, port: NotifyScopePort, options: NotifyScopeOptions = {}): { send(input: VerticalNotification): { status: "queued" | "duplicate" } } {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(verticalId)) throw new ExtensionPolicyError("VERTICAL_ID_INVALID", "扩展 id 非法");
  const source = `vertical:${verticalId}`, now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? 10, perHour = options.perHour ?? 60;
  const queuedAt: number[] = [], lastByKey = new Map<string, number>();
  return Object.freeze({
    send(input: VerticalNotification) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !FIELDS.has(k))) throw invalid("通知字段非法");
      const { key, text, detail, level = "fyi", link, urgent } = input;
      if (typeof key !== "string" || !KEY.test(key)) throw invalid("key 非法");
      if (typeof text !== "string" || !text.trim() || text.length > 500) throw invalid("text 必填且不超过 500 字");
      if (detail !== undefined && (typeof detail !== "string" || detail.length > 2_000)) throw invalid("detail 不超过 2000 字");
      if (!LEVELS.has(level)) throw invalid("level 只能是 act/fyi/silent");
      if (urgent !== undefined && typeof urgent !== "boolean") throw invalid("urgent 必须是布尔");
      if (urgent && options.urgentGranted !== true) throw new ExtensionPolicyError("VERTICAL_NOTIFY_URGENT_NOT_GRANTED", "urgent 需要本机授权 grantedNotifyUrgent");
      const url = link === undefined ? undefined : resolveLink(verticalId, link, port.linkFor);
      const t = now(), scopedKey = `${source}:${key}`, last = lastByKey.get(scopedKey);
      if (last !== undefined && t - last < port.cooldownMs()) return Object.freeze({ status: "duplicate" as const });
      while (queuedAt.length && t - queuedAt[0]! >= HOUR) queuedAt.shift();
      if (queuedAt.length >= perHour || queuedAt.filter((at) => t - at < MINUTE).length >= perMinute) throw new ExtensionPolicyError("VERTICAL_NOTIFY_RATE_LIMITED", "通知过于频繁");
      queuedAt.push(t); lastByKey.set(scopedKey, t);
      if (lastByKey.size > 500) for (const [k, at] of lastByKey) if (t - at >= port.cooldownMs()) lastByKey.delete(k);
      void port.send(text.trim(), { source, key: scopedKey, level, ...(detail ? { detail } : {}), ...(url ? { link: url } : {}), quietExempt: urgent === true })
        .catch((error) => port.log?.(`vertical notify failed: ${verticalId} ${error instanceof Error ? error.name : "unknown"}`));
      return Object.freeze({ status: "queued" as const });
    },
  });
}
