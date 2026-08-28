import { readFileSync } from "fs";
import { writeFileAtomic } from "./fs-durable.ts";
import { connectorConfig, setConnectorConfig } from "./connector-config.ts";

export interface StockConnectorPatch { enabled?: boolean; watchlist?: unknown[] }

/** 持久化 canonical 配置后更新进程快照，并等待目标 Connector 重启完成。 */
export async function saveStockConnectorConfig(options: {
  file: string;
  liveConfig: Record<string, any>;
  patch: StockConnectorPatch;
  restart: (id: string) => Promise<void>;
}): Promise<Record<string, any>> {
  const conf = JSON.parse(readFileSync(options.file, "utf8"));
  const stock = { ...connectorConfig(conf, "stock") };
  if (options.patch.enabled !== undefined) stock.enabled = options.patch.enabled === true;
  if (options.patch.watchlist !== undefined) {
    if (!Array.isArray(options.patch.watchlist)) throw new Error("watchlist 必须是数组");
    stock.watchlist = options.patch.watchlist
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
  }
  setConnectorConfig(conf, "stock", stock);
  writeFileAtomic(options.file, JSON.stringify(conf, null, 2) + "\n", { mode: 0o600 });
  setConnectorConfig(options.liveConfig, "stock", structuredClone(stock));
  await options.restart("stock");
  return stock;
}
