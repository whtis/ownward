// /api/dev/messages 的 tail 参数：长会话（2026-10 一个 8.8k 条、5.9MB）每次轮询整份下发，
// 网页标签页 V8 OOM、手机主线程解码卡顿。客户端只要最后 N 条 + 前面省了几条（omitted）。
// 不带 tail = 全量，老版本 App 照旧可用；切片只在接口出口做，handoff/fork/harvest 等内部读者仍拿全量。

/** 解析 tail：缺省 → undefined（全量）；非负整数 → 条数；其余 → null（非法） */
export function parseMessageTail(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,7}$/.test(raw)) return null;
  return Number(raw);
}

/** 只留最后 tail 条；omitted = 前面省掉的条数，客户端用它把下标还原成全量里的绝对位置（展开态 key 不随窗口滑动） */
export function tailMessages<T extends { messages?: unknown[] }>(state: T, tail: number | undefined): T & { omitted?: number } {
  if (tail === undefined) return state;
  const all = state.messages ?? [], omitted = Math.max(0, all.length - tail);
  return { ...state, messages: omitted ? all.slice(omitted) : all, omitted };
}
