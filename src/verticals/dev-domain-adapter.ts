import type { VerticalContext } from "../kernel/extensions/contracts.ts";
import { createDevDomainService, type DevDomainHandler } from "./dev-domain-service.ts";

export interface DevDomainAdapter {
  bind(context: VerticalContext): DevDomainHandler;
}

/** Composition adapter：Dev 领域实现由 Kernel composition root 显式注入。 */
export function createDevDomainAdapter(factory: (context: VerticalContext) => DevDomainHandler): DevDomainAdapter {
  return Object.freeze({ bind: (context) => createDevDomainService(context, factory(context)) });
}
