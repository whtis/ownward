import type { ScopedAction, ScopedActions } from "./contracts.ts";

const KINDS = new Set(["reply", "review", "approve", "follow_up", "decide"]);
export interface ActionScopePort {
  list(): Array<{ id: string; source: string; kind: string; title: string; reason: string; state: "open" | "snoozed" | "processing" | "resolved" | "dismissed"; createdAt: string; ref: { url?: string; task_id?: string; note?: string } }>;
  open(action: { id: string; kind: ScopedAction["kind"]; source: string; title: string; reason: string; ref: { url?: string; task_id?: string; note?: string } }): void;
  resolveExact(id: string, resolution: string): boolean;
  setState(id: string, state: "dismissed"): boolean;
}

/** 将 Kernel Action port 收成受限门面：list 只见本 scope；open 强制 source=ownerSource 且 id 带前缀；
 *  resolve/dismiss 精确 id 且属主校验。不向 Vertical 暴露前缀写或原始对象。 */
export function createScopedActions(allowed: readonly string[], port: ActionScopePort, ownerSource = allowed[0]!): ScopedActions {
  const sources = new Set(allowed);
  const belongs = (action: { source: string }) => sources.has(action.source);
  const ref = (raw: { url?: string; task_id?: string; note?: string }) => Object.freeze({
    ...(raw.url ? { url: String(raw.url).slice(0, 500) } : {}),
    ...(raw.task_id ? { task_id: String(raw.task_id).slice(0, 100) } : {}),
    ...(raw.note ? { note: String(raw.note).slice(0, 500) } : {}),
  });
  return Object.freeze({
    list: () => Object.freeze(port.list().filter(belongs).map((action) => Object.freeze({
      id: action.id,
      source: action.source,
      kind: (KINDS.has(action.kind) ? action.kind : "decide") as ScopedAction["kind"],
      title: String(action.title || "").slice(0, 200),
      reason: String(action.reason || "").slice(0, 500),
      state: action.state,
      createdAt: action.createdAt,
      ref: ref(action.ref),
    }))),
    open(input) {
      if (!input || typeof input !== "object") return false;
      const id = String(input.id || ""), title = String(input.title || "").trim(), reason = String(input.reason || "").trim();
      if (!id.startsWith(`${ownerSource}:`) || id.length > 200 || !KINDS.has(input.kind) || !title || title.length > 200 || !reason || reason.length > 500) return false;
      const rawRef = input.ref && typeof input.ref === "object" ? input.ref : {};
      if (Object.keys(rawRef).some((key) => !["url", "task_id", "note"].includes(key))) return false;
      port.open({ id, kind: input.kind, source: ownerSource, title, reason, ref: ref(rawRef) });
      return true;
    },
    resolve(id, resolution) {
      if (!id || !resolution || resolution.length > 80) return false;
      const action = port.list().find((item) => item.id === id);
      return !!action && belongs(action) && port.resolveExact(id, resolution);
    },
    dismiss(id) {
      if (!id) return false;
      const action = port.list().find((item) => item.id === id);
      return !!action && belongs(action) && port.setState(id, "dismissed");
    },
  });
}
