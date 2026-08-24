export const FIRST_PARTY_CONNECTOR_IDS = ["lark", "github", "gmail", "stock"] as const;
export type FirstPartyConnectorId = typeof FIRST_PARTY_CONNECTOR_IDS[number];

/**
 * 在 defaults 合并前保留本机配置的来源语义：只有本机未显式声明该
 * connectors.<id> 时，才把同 id 的 legacy sources 覆盖映射成 canonical overlay。
 * 不能在 merge 后做，因为 defaults 自带 connectors.*，会遮住 legacy 本机值。
 */
export function canonicalConnectorOverlay(local: Record<string, any>): Record<string, any> {
  const overlay = structuredClone(local);
  for (const id of FIRST_PARTY_CONNECTOR_IDS) {
    if (local.connectors?.[id] === undefined && local.sources?.[id] !== undefined) {
      overlay.connectors ??= {};
      overlay.connectors[id] = structuredClone(local.sources[id]);
    }
  }
  return overlay;
}

/**
 * Connector 配置的唯一读取入口。connectors.* 是 canonical；sources.* 只用于
 * 尚未经过 install.sh 迁移的单版本兼容，且绝不能覆盖已经存在的 canonical 值。
 */
export function connectorConfig(config: Record<string, any>, id: string): Record<string, any> {
  const canonical = config.connectors?.[id];
  if (canonical !== undefined) return canonical;
  return config.sources?.[id] ?? {};
}

export function connectorEnabled(config: Record<string, any>, id: FirstPartyConnectorId): boolean {
  return connectorConfig(config, id).enabled === true;
}

/** /api/state 与前端沿用 sources 响应名，但值来自 canonical Connector 控制面。 */
export function connectorSourceSnapshot(config: Record<string, any>) {
  const stock = connectorConfig(config, "stock");
  return {
    lark: connectorEnabled(config, "lark"),
    github: connectorEnabled(config, "github"),
    gmail: connectorEnabled(config, "gmail"),
    stock: connectorEnabled(config, "stock") && Array.isArray(stock.watchlist) && stock.watchlist.length > 0,
  };
}

/** 写路径只写 canonical namespace；旧 sources.* 不再反向同步，避免双真相。 */
export function setConnectorConfig(config: Record<string, any>, id: FirstPartyConnectorId, value: Record<string, any>): void {
  config.connectors ??= {};
  config.connectors[id] = value;
}
