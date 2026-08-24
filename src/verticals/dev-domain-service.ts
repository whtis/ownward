import type { VerticalContext } from "../kernel/extensions/contracts.ts";

export interface DevDomainHandler {
  route(request: Request, url: URL): Promise<Response | null>;
}

/**
 * Dev Vertical 只认识 scoped Kernel context 与显式领域 handler。
 * 具体的 git/terminal/GitHub/evolve 兼容实现由 composition root 注入，
 * 因而这里不会穿透 workbench、Kernel repository 或 Provider 私有实现。
 */
export function createDevDomainService(
  context: VerticalContext,
  handler: DevDomainHandler,
): DevDomainHandler {
  return Object.freeze({
    async route(request, url) {
      context.log("route", `${request.method} ${url.pathname}`);
      return handler.route(request, url);
    },
  });
}
