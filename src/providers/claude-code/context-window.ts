/** Claude Code result 帧的 modelUsage → 当前会话主循环模型的上下文窗口（token 数）。
 *  modelUsage 按模型 id 分桶（子代理跑的 haiku 也各占一桶），每桶带 contextWindow（CC ≥2.1）。
 *  取法：先按调用方给的候选模型名（本轮 assistant 帧的 model、init 帧的 model）精确命中；
 *  都命中不了再退回各桶最大值——主循环通常是最大窗口的那个，但主模型是 haiku（200k）而子代理
 *  跑 1M 型号时最大值就错了，所以命中优先。旧 CLI 没这个字段 → 返回 0，调用方按模型名兜底。 */
export function contextWindowOf(modelUsage: unknown, preferModels: readonly (string | undefined)[] = []): number {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return 0;
  const buckets = modelUsage as Record<string, unknown>;
  const windowOf = (bucket: unknown): number => {
    const w = bucket && typeof bucket === "object" ? (bucket as { contextWindow?: unknown }).contextWindow : undefined;
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.floor(w) : 0;
  };
  for (const model of preferModels) { if (model && Object.hasOwn(buckets, model)) { const w = windowOf(buckets[model]); if (w) return w; } }
  let max = 0;
  for (const bucket of Object.values(buckets)) { const w = windowOf(bucket); if (w > max) max = w; }
  return max;
}

/** CLI 没报窗口时按模型名估：2026 起 claude 主力型号（fable / opus / sonnet 4.6+）默认 1M，只有 haiku 还是 200k。
 *  与 web/tasks.js 的 ctxWindowOf 兜底口径一致——daemon 自动压缩的判据和界面显示的 ctx% 不能各算各的。 */
export function estimateContextWindow(model: string | undefined): number {
  return /haiku/i.test(model || "") ? 200_000 : 1_000_000;
}
