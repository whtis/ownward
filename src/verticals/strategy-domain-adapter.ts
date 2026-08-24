import { handleStrategy } from "../strategy/api.ts";
import { monitorTick, runStrategyScan } from "../strategy/scan.ts";

/** Strategy Vertical 与现有领域实现之间的唯一 composition seam。 */
export interface StrategyDomainAdapter {
  route(request: Request, url: URL): Promise<Response | null>;
  scan(): Promise<unknown>;
  monitor(): Promise<unknown>;
}

export function createStrategyDomainAdapter(): StrategyDomainAdapter {
  return Object.freeze({ route: handleStrategy, scan: runStrategyScan, monitor: monitorTick });
}
