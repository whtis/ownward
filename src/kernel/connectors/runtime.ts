import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative, sep } from "path";
import { appendEvent, queueSize, type OwnwardEvent } from "../../spool.ts";
import {
  CONNECTOR_KERNEL_API_VERSION,
  type Connector,
  type ConnectorContext,
  type ConnectorEvent,
  type ConnectorManifest,
  type ConnectorStatus,
} from "./contracts.ts";
import { ConnectorDataError, ConnectorStore } from "./storage.ts";
import { ConnectorHostClient } from "./host-client.ts";
import { LifecycleCapability } from "../extensions/lifecycle.ts";
import { runExtensionMigration } from "../extensions/migration.ts";
import { emitCoreLog } from "../observability/contracts.ts";
import { connectorConfig } from "../../connector-config.ts";

const VALID_ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_SECRET_REF = /^[A-Z][A-Z0-9_]{0,63}$/;
export class ConnectorPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseConnectorManifest(raw: unknown): ConnectorManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ConnectorPolicyError(
      "CONNECTOR_MANIFEST_INVALID",
      "manifest 必须是对象",
    );
  const m = raw as any,
    keys = new Set([
      "id",
      "name",
      "version",
      "kernelApiVersion",
      "entry",
      "capabilities",
      "eventNamespaces",
      "priorityEventTypes",
      "singletonEventTypes",
    ]);
  for (const key of Object.keys(m))
    if (!keys.has(key))
      throw new ConnectorPolicyError(
        "CONNECTOR_MANIFEST_INVALID",
        `未知字段: ${key}`,
      );
  if (
    !VALID_ID.test(m.id) ||
    typeof m.name !== "string" ||
    !m.name.trim() ||
    !VERSION.test(m.version) ||
    m.kernelApiVersion !== CONNECTOR_KERNEL_API_VERSION ||
    typeof m.entry !== "string" ||
    (!m.entry && m.entry !== "builtin")
  )
    throw new ConnectorPolicyError(
      "CONNECTOR_MANIFEST_INVALID",
      "manifest 字段非法",
    );
  if (
    m.entry !== "builtin" &&
    (isAbsolute(m.entry) || m.entry.split(/[\\/]/).includes(".."))
  )
    throw new ConnectorPolicyError(
      "CONNECTOR_ENTRY_DENIED",
      "entry 必须位于 connector root",
    );
  if (
    !Array.isArray(m.capabilities) ||
    m.capabilities.some(
      (x: unknown) => !["events", "checkpoint", "secrets"].includes(String(x)),
    ) ||
    !m.capabilities.includes("events")
  )
    throw new ConnectorPolicyError(
      "CONNECTOR_MANIFEST_INVALID",
      "capabilities 非法或缺少 events",
    );
  if (
    !Array.isArray(m.eventNamespaces) ||
    !m.eventNamespaces.length ||
    m.eventNamespaces.some(
      (x: unknown) =>
        typeof x !== "string" || !String(x).startsWith(`${m.id}.`),
    )
  )
    throw new ConnectorPolicyError(
      "CONNECTOR_MANIFEST_INVALID",
      "event namespace 必须属于 connector",
    );
  if (
    m.priorityEventTypes !== undefined &&
    (!Array.isArray(m.priorityEventTypes) ||
      m.priorityEventTypes.some((x: unknown) => typeof x !== "string" || !x))
  )
    throw new ConnectorPolicyError(
      "CONNECTOR_MANIFEST_INVALID",
      "priorityEventTypes 非法",
    );
  if (
    m.singletonEventTypes !== undefined &&
    (!Array.isArray(m.singletonEventTypes) ||
      m.singletonEventTypes.some((x: unknown) => typeof x !== "string" || !x))
  )
    throw new ConnectorPolicyError(
      "CONNECTOR_MANIFEST_INVALID",
      "singletonEventTypes 非法",
    );
  return structuredClone(m);
}

export interface BuiltinConnector {
  manifest: ConnectorManifest;
  load(): Promise<Connector>;
}
export interface ConnectorRuntimeOptions {
  dataRoot: string;
  config?: Record<string, any>;
  builtins: BuiltinConnector[];
  externalPaths?: string[];
  maxPendingEvents?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  healthTimeoutMs?: number;
  restartBaseMs?: number;
  hostStableMs?: number;
  drainBaseMs?: number;
  drainMaxMs?: number;
  secretEnvAllowlist?: Record<string, string[]>;
  secretResolver?: (connectorId: string, ref: string) => string | undefined;
  onAlert?: (id: string, code: string) => void;
  onHealthy?: (id: string, at: string) => void;
  onEvents?: (events: readonly OwnwardEvent[]) => Promise<void> | void;
  beforeDrainPublish?: () => Promise<void> | void;
  afterQueueDurable?: () => void;
  afterAcceptedDurable?: () => void;
  log?: (message: string) => void;
}
type PublishResult = {
  accepted: number;
  duplicates: number;
  disposition: "appended" | "deferred";
};
interface Loaded {
  manifest: ConnectorManifest;
  source: "builtin" | "external";
  root?: string;
  load?: () => Promise<Connector>;
  module?: Connector;
  host?: ConnectorHostClient;
  store: ConnectorStore;
  lifecycle?: LifecycleCapability;
  status: ConnectorStatus;
  healthDetail?: Record<string, unknown>;
  abort?: AbortController;
  stableTimer?: ReturnType<typeof setTimeout>;
  crashAlerted?: boolean;
  stopPromise?: Promise<void>;
  drainFailures?: number;
  writeTail?: Promise<void>;
  priorityWriteTail?: Promise<void>;
  startTail?: Promise<void>;
}

function deadline<T>(
  work: Promise<T> | T,
  ms: number,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ConnectorPolicyError(code, `${ms}ms timeout`)),
      ms,
    );
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() =>
    clearTimeout(timer!),
  );
}
function clean(value: string): string {
  return value
    .replace(
      /authorization\s*[:=]?\s*bearer\s+[A-Za-z0-9._~+\/-]+/gi,
      "authorization=[REDACTED]",
    )
    .replace(
      /\"?(?:access_token|refresh_token|client_secret|token|secret|password|authorization)\"?\s*[:=]\s*\"?[^\"\s,}]+\"?/gi,
      (m) => `${m.split(/[:=]/, 1)[0]}=[REDACTED]`,
    )
    .slice(0, 1000);
}
function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] =
        /(?:token|secret|password|authorization|cookie|credential)/i.test(k)
          ? "[REDACTED]"
          : redactPayload(v);
    return out;
  }
  return value;
}

export class ConnectorRuntime {
  private loaded = new Map<string, Loaded>();
  private stopped = false;
  private startGeneration = 0;
  private stopping?: Promise<void>;
  private activeStarts = new Set<Promise<void>>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly options: ConnectorRuntimeOptions) {}
  private audit(event: string, moduleId: string, operation: string, msg: unknown, errorClass?: unknown, eventId?: unknown) {
    emitCoreLog({ event, moduleType: "connector", moduleId, operation, msg, errorClass, eventId }, this.options.log ?? console.error);
  }
  private trackStart(work: Promise<void>) {
    this.activeStarts.add(work);
    return work.finally(() => this.activeStarts.delete(work));
  }
  private serialize<T>(
    item: Loaded,
    work: () => Promise<T>,
    priority = false,
  ): Promise<T> {
    const key = priority ? "priorityWriteTail" : "writeTail",
      run = (item[key] ?? Promise.resolve()).then(work),
      tail = run.then(
        () => {},
        () => {},
      );
    item[key] = tail;
    return run.finally(() => {
      if (item[key] === tail) item[key] = undefined;
    });
  }
  /** 把同一 connector 的 startOne 串起来：重启定时器触发的 start 与 restartConnector 的 start 不再并发，
   *  否则败者的 catch 会 revoke 胜者刚装好的 lifecycle/abort，把健康实例 wedge 住(见评审 minor)。
   *  排队的 start 靠 startOne 内部的 generation 检查自然作废。 */
  private serializeStart(item: Loaded, work: () => Promise<void>): Promise<void> {
    const run = (item.startTail ?? Promise.resolve()).then(work, work);
    const tail = run.then(() => {}, () => {});
    item.startTail = tail;
    return run.finally(() => { if (item.startTail === tail) item.startTail = undefined; });
  }
  discover(): ConnectorStatus[] {
    this.loaded.clear();
    for (const b of this.options.builtins) {
      const manifest = parseConnectorManifest(b.manifest);
      if (this.loaded.has(manifest.id))
        throw new ConnectorPolicyError("CONNECTOR_ID_DUPLICATE", manifest.id);
      this.loaded.set(manifest.id, {
        manifest,
        source: "builtin",
        load: b.load,
        store: new ConnectorStore(this.options.dataRoot, manifest.id),
        status: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          source: "builtin",
          state: "discovered",
          consecutiveFailures: 0,
          accepted: 0,
          duplicates: 0,
          queueDepth: 0,
        },
      });
      this.audit("connector-discovered", manifest.id, "discover", "builtin connector discovered");
    }
    for (const raw of this.options.externalPaths ?? []) {
      try {
        if (!isAbsolute(raw))
          throw new ConnectorPolicyError(
            "CONNECTOR_PATH_NOT_ABSOLUTE",
            "absolute path required",
          );
        const root = realpathSync(raw);
        if (!statSync(root).isDirectory())
          throw new ConnectorPolicyError(
            "CONNECTOR_PATH_INVALID",
            "not directory",
          );
        const manifest = parseConnectorManifest(
          JSON.parse(
            readFileSync(join(root, "ownward.connector.json"), "utf8"),
          ),
        );
        const entry = realpathSync(join(root, manifest.entry)),
          rel = relative(root, entry);
        if (
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          isAbsolute(rel) ||
          !statSync(entry).isFile()
        )
          throw new ConnectorPolicyError(
            "CONNECTOR_ENTRY_DENIED",
            "entry 不存在或越界",
          );
        if (this.loaded.has(manifest.id))
          throw new ConnectorPolicyError("CONNECTOR_ID_CONFLICT", manifest.id);
        this.loaded.set(manifest.id, {
          manifest,
          source: "external",
          root,
          store: new ConnectorStore(this.options.dataRoot, manifest.id),
          status: {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            source: "external",
            state: "discovered",
            consecutiveFailures: 0,
            accepted: 0,
            duplicates: 0,
            queueDepth: 0,
          },
        });
        this.audit("connector-discovered", manifest.id, "discover", "external connector discovered");
      } catch (e: any) {
        this.audit("connector-discovery-failed", "unknown", "discover", "external connector rejected", e?.code || "CONNECTOR_DISCOVERY_FAILED");
      }
    }
    return this.statuses();
  }
  async start(): Promise<void> {
    const generation = ++this.startGeneration;
    this.stopped = false;
    await this.stopping;
    if (!this.current(generation)) return;
    if (!this.loaded.size) this.discover();
    for (const item of this.loaded.values()) {
      if (!this.current(generation)) break;
      item.stopPromise = undefined;
      await this.trackStart(this.serializeStart(item, () => this.startOne(item, generation)));
    }
  }
  private current(generation: number) {
    return !this.stopped && generation === this.startGeneration;
  }
  private async disposeInstance(item: Loaded) {
    item.lifecycle?.revoke();
    item.abort?.abort();
    const host = item.host,
      mod = item.module;
    item.host = undefined;
    item.module = undefined;
    if (host) await host.stop();
    else if (mod)
      await deadline(
        mod.stop?.(),
        this.options.stopTimeoutMs ?? 2_000,
        "CONNECTOR_STOP_TIMEOUT",
      );
  }
  private async startOne(
    item: Loaded,
    generation = this.startGeneration,
  ): Promise<void> {
    if (!this.current(generation)) {
      item.status.state = "disabled";
      return;
    }
    if (item.host || item.module) await this.disposeInstance(item);
    if (!this.current(generation)) return;
    const cfg = connectorConfig(this.options.config ?? {}, item.manifest.id);
    if (cfg?.enabled !== true) {
      item.status.state = "disabled";
      return;
    }
    if (item.source === "external") {
      if (cfg?.trusted !== true) {
        item.status.state = "discovered";
        item.status.errorCode = "CONNECTOR_TRUST_CONFIRMATION_REQUIRED";
        return;
      }
    }
    item.status.state = "starting";
    this.audit("connector-starting", item.manifest.id, "start", "connector start initiated");
    let restartAfterStart = false,
      startDiagnosticFailure = false;
    const failuresAtStart = item.status.consecutiveFailures;
    try {
      try {
        item.store.checkpoint();
      } catch (e) {
        if (
          e instanceof ConnectorDataError &&
          e.code === "CONNECTOR_CHECKPOINT_CORRUPT"
        ) {
          item.store.quarantineCheckpoint();
          item.status.state = "degraded";
          item.status.errorCode = e.code;
          item.status.errorMessage = clean(e.message);
          startDiagnosticFailure = true;
          this.options.onAlert?.(item.manifest.id, e.code);
        } else throw e;
      }
      item.abort = new AbortController();
      const lifecycle = new LifecycleCapability("connector", item.manifest.id);
      item.lifecycle = lifecycle;
      const ctx = this.context(item, cfg, lifecycle);
      if (item.source === "external") {
        let activated = false;
        const host = new ConnectorHostClient(
          item.root!,
          item.manifest,
          ctx,
          () => {
            if (this.stopped || item.host !== host) return;
            item.lifecycle?.revoke();
            item.host = undefined;
            item.stableTimer && clearTimeout(item.stableTimer);
            item.stableTimer = undefined;
            item.status.state = "degraded";
            item.status.errorCode = "CONNECTOR_HOST_EXITED";
            item.status.lastFailureAt = new Date().toISOString();
            item.status.consecutiveFailures++;
            this.audit("connector-host-exited", item.manifest.id, "host", "connector host exited", "CONNECTOR_HOST_EXITED");
            if (item.status.consecutiveFailures >= 3 && !item.crashAlerted) {
              item.crashAlerted = true;
              this.options.onAlert?.(
                item.manifest.id,
                "CONNECTOR_HOST_CRASH_LOOP",
              );
            }
            if (activated) this.scheduleRestart(item);
            else restartAfterStart = true;
          },
        );
        item.host = host;
        const { enabled: _enabled, trusted: _trusted, ...domainConfig } = cfg;
        await host.launch(this.options.startTimeoutMs ?? 5_000);
        this.audit("connector-host-started", item.manifest.id, "host-start", "external connector host started");
        const description = await host.describe(
          this.options.startTimeoutMs ?? 5_000,
        );
        try {
          this.audit("connector-migration-started", item.manifest.id, "migrate", "connector migration gate entered");
          await runExtensionMigration({
            dataRoot: this.options.dataRoot,
            kind: "connector",
            id: item.manifest.id,
            version: item.manifest.version,
            migrate: description.hasMigration
              ? async ({ migrationId, storage }) => {
                  host.setStorage(storage);
                  await host.migrate(
                    domainConfig,
                    migrationId,
                    this.options.startTimeoutMs ?? 5_000,
                  );
                }
              : undefined,
          });
          this.audit("connector-migration-completed", item.manifest.id, "migrate", "connector migration gate completed");
        } catch (error) {
          throw Object.assign(new Error("connector migration failed"), {
            code: "CONNECTOR_MIGRATION_FAILED",
            cause: error,
          });
        }
        host.setStorage(undefined);
        await host.activate(domainConfig, this.options.startTimeoutMs ?? 5_000);
        if (!this.current(generation)) {
          await this.disposeInstance(item);
          return;
        }
        if (item.host !== host)
          throw new ConnectorPolicyError(
            "CONNECTOR_HOST_EXITED",
            "host exited during start",
          );
        activated = true;
        if (item.status.state !== "degraded") item.status.state = "ready";
        this.audit("connector-ready", item.manifest.id, "start", "connector ready");
        item.stableTimer = setTimeout(
          () => this.markHealthy(item),
          this.options.hostStableMs ?? 30_000,
        );
        this.scheduleDrain(item);
        return;
      }
      const mod = await deadline(
        item.load!(),
        this.options.startTimeoutMs ?? 5_000,
        "CONNECTOR_LOAD_TIMEOUT",
      );
      if (!mod || typeof mod.start !== "function")
        throw new ConnectorPolicyError(
          "CONNECTOR_MODULE_INVALID",
          "connector 缺少 start",
        );
      if (!this.current(generation)) {
        item.status.state = "disabled";
        return;
      }
      item.module = mod;
      try {
        this.audit("connector-migration-started", item.manifest.id, "migrate", "connector migration gate entered");
        await runExtensionMigration({
          dataRoot: this.options.dataRoot,
          kind: "connector",
          id: item.manifest.id,
          version: item.manifest.version,
          migrate: mod.migrate
            ? async ({ migrationId, storage }) =>
                deadline(
                  mod.migrate!({
                    migrationId,
                    storage,
                    config: Object.freeze(structuredClone(cfg)),
                    log: (op, msg) => this.audit("connector-migration-log", item.manifest.id, op, msg),
                  }),
                  this.options.startTimeoutMs ?? 5_000,
                  "CONNECTOR_MIGRATION_TIMEOUT",
                )
            : undefined,
        });
        this.audit("connector-migration-completed", item.manifest.id, "migrate", "connector migration gate completed");
      } catch (error: any) {
        throw Object.assign(new Error("connector migration failed"), {
          code: "CONNECTOR_MIGRATION_FAILED",
          cause: error,
        });
      }
      await deadline(
        mod.start(ctx),
        this.options.startTimeoutMs ?? 5_000,
        "CONNECTOR_START_TIMEOUT",
      );
      if (!this.current(generation)) {
        await this.disposeInstance(item);
        return;
      }
      if (
        !startDiagnosticFailure &&
        item.status.consecutiveFailures === failuresAtStart
      )
        this.markHealthy(item);
      this.scheduleDrain(item);
      this.audit("connector-ready", item.manifest.id, "start", "connector ready");
    } catch (e: any) {
      item.lifecycle?.revoke();
      item.abort?.abort();
      if (!this.current(generation)) {
        await this.disposeInstance(item);
        return;
      }
      if (restartAfterStart) {
        this.scheduleRestart(item);
        return;
      }
      item.status.errorCode = String(e?.code || "CONNECTOR_START_FAILED");
      item.status.state =
        item.status.errorCode === "CONNECTOR_MIGRATION_FAILED"
          ? "migration_failed"
          : "failed";
      item.status.errorMessage = clean(
        String(e?.message || e?.name || "start failed"),
      );
      item.status.lastFailureAt = new Date().toISOString();
      item.status.consecutiveFailures++;
      this.options.onAlert?.(item.manifest.id, item.status.errorCode);
      emitCoreLog({
        event: "connector-lifecycle-failed",
        moduleType: "connector",
        moduleId: item.manifest.id,
        operation:
          item.status.state === "migration_failed" ? "migrate" : "start",
        errorClass: item.status.errorCode,
        msg: "connector lifecycle failed",
      });
      if (
        item.status.state !== "migration_failed" &&
        item.status.consecutiveFailures <= 5
      ) {
        // 还会重启：下一次 startOne 顶部会 disposeInstance，这里不必清（清了反而多做一次 host.stop）
        this.scheduleRestart(item);
      } else {
        // 终态（迁移失败 / 连续失败超限）不再重启：必须主动 dispose，否则 external host 子进程 +
        // socket 目录会一直挂着（没有后续 startOne 来清），随崩溃循环累积。dispose 后 restartConnector 仍可手动恢复。
        if (item.status.state !== "migration_failed")
          this.options.onAlert?.(item.manifest.id, "CONNECTOR_START_TERMINAL");
        try { await this.disposeInstance(item); } catch {}
      }
    }
  }

  /** 配置控制面保存后只重启目标 Connector，其他采集器与 recovery 不受影响。 */
  async restartConnector(id: string): Promise<void> {
    if (!this.loaded.size) this.discover();
    const item = this.loaded.get(id);
    if (!item) throw new ConnectorPolicyError("CONNECTOR_NOT_FOUND", id);
    if (this.stopped) throw new ConnectorPolicyError("CONNECTOR_RUNTIME_STOPPED", id);
    const retry = this.restartTimers.get(id);
    if (retry) clearTimeout(retry);
    this.restartTimers.delete(id);
    item.stopPromise = undefined;
    await this.trackStart(this.serializeStart(item, () => this.startOne(item, this.startGeneration)));
  }
  private scheduleRestart(item: Loaded) {
    if (this.stopped || this.restartTimers.has(item.manifest.id)) return;
    const generation = this.startGeneration,
      delay = Math.min(
        30_000,
        (this.options.restartBaseMs ?? 250) *
          2 ** Math.min(Math.max(0, item.status.consecutiveFailures - 1), 7),
      );
    const timer = setTimeout(() => {
      this.restartTimers.delete(item.manifest.id);
      if (this.current(generation))
        void this.trackStart(this.serializeStart(item, () => this.startOne(item, generation)));
    }, delay);
    (timer as any).unref?.();
    this.restartTimers.set(item.manifest.id, timer);
  }
  private markHealthy(item: Loaded) {
    item.status.lastSuccessAt = new Date().toISOString();
    item.status.consecutiveFailures = 0;
    item.crashAlerted = false;
    item.status.errorCode = undefined;
    item.status.errorMessage = undefined;
    if (["starting", "degraded", "failed"].includes(item.status.state))
      item.status.state = "ready";
    this.options.onHealthy?.(item.manifest.id, item.status.lastSuccessAt);
  }
  private context(
    item: Loaded,
    config: Record<string, unknown>,
    lifecycle: LifecycleCapability,
  ): ConnectorContext {
    return Object.freeze({
      id: item.manifest.id,
      get generation() {
        return item.store.generation();
      },
      config: Object.freeze(structuredClone(config)),
      signal: item.abort!.signal,
      checkpoint: async () => {
        if (!item.manifest.capabilities.includes("checkpoint")) return null;
        try {
          return item.store.checkpoint();
        } catch (error) {
          if (
            error instanceof ConnectorDataError &&
            error.code === "CONNECTOR_CHECKPOINT_CORRUPT"
          ) {
            item.store.quarantineCheckpoint();
            this.reportHealth(item, {
              ok: false,
              code: error.code,
              message: error.message,
            });
            this.options.onAlert?.(item.manifest.id, error.code);
            return null;
          }
          throw error;
        }
      },
      publish: async (events: readonly ConnectorEvent[], next?: any) => {
        lifecycle.assertWrite();
        const priority = this.isPriority(item, events);
        if (priority && next !== undefined) {
          this.reportHealth(item, {
            ok: false,
            code: "CONNECTOR_PRIORITY_CHECKPOINT_DENIED",
            message: "priority events cannot advance shared cursor",
          });
          this.options.onAlert?.(
            item.manifest.id,
            "CONNECTOR_PRIORITY_CHECKPOINT_DENIED",
          );
          throw new ConnectorPolicyError(
            "CONNECTOR_PRIORITY_CHECKPOINT_DENIED",
            "priority events cannot advance shared cursor",
          );
        }
        const r = await this.serialize(
          item,
          () => this.publishLocked(item, events, next, true),
          priority,
        );
        lifecycle.assertWrite();
        return { accepted: r.accepted, duplicates: r.duplicates };
      },
      secret: async (ref: string) => {
        lifecycle.assertWrite();
        if (
          !item.manifest.capabilities.includes("secrets") ||
          !SAFE_SECRET_REF.test(ref)
        )
          return undefined;
        const resolved = this.options.secretResolver?.(item.manifest.id, ref);
        if (resolved !== undefined) return resolved;
        if (
          !(this.options.secretEnvAllowlist?.[item.manifest.id] ?? []).includes(
            ref,
          )
        )
          return undefined;
        return process.env[ref];
      },
      reportHealth: async (report: {
        ok: boolean;
        code?: string;
        message?: string;
        detail?: Record<string, unknown>;
      }) => {
        lifecycle.assertWrite();
        this.reportHealth(item, report);
      },
      log: (operation: string, message: string) => this.audit("connector-module-log", item.manifest.id, operation, message),
    });
  }
  private reportHealth(
    item: Loaded,
    report: {
      ok: boolean;
      code?: string;
      message?: string;
      detail?: Record<string, unknown>;
    },
  ): void {
    item.healthDetail = redactPayload(
      report.detail ?? (report.ok ? { status: "ok" } : { status: "failed" }),
    ) as Record<string, unknown>;
    if (report.ok) {
      this.markHealthy(item);
      return;
    }
    if (item.status.state === "ready" || item.status.state === "starting")
      item.status.state = "degraded";
    item.status.errorCode = report.code || "CONNECTOR_SOURCE_UNHEALTHY";
    item.status.errorMessage = clean(
      report.message || "source reported unhealthy",
    );
    item.status.lastFailureAt = new Date().toISOString();
    item.status.consecutiveFailures++;
    if ([5, 20].includes(item.status.consecutiveFailures))
      this.options.onAlert?.(
        item.manifest.id,
        `${item.status.errorCode}_REPEATED_${item.status.consecutiveFailures}`,
      );
  }
  private isPriority(item: Loaded, events: readonly ConnectorEvent[]) {
    const allowed = new Set(item.manifest.priorityEventTypes ?? []);
    return (
      events.length > 0 && events.every((event) => allowed.has(event.type))
    );
  }
  private defer(
    item: Loaded,
    events: readonly ConnectorEvent[],
    next: any,
    priority: boolean,
  ) {
    try {
      return item.store.deferBatch(
        events.map((e) => ({
          ...e,
          payload: redactPayload(e.payload) as Record<string, unknown>,
        })),
        next,
        priority,
        new Set(item.manifest.singletonEventTypes ?? []),
      );
    } catch (e: any) {
      const code = String(e?.code || "CONNECTOR_PENDING_FAILED");
      item.status.state = "degraded";
      item.status.errorCode = code;
      this.options.onAlert?.(item.manifest.id, code);
      throw e;
    }
  }
  private async publishLocked(
    item: Loaded,
    events: readonly ConnectorEvent[],
    next?: any,
    allowDefer = true,
  ): Promise<PublishResult> {
    item.lifecycle?.assertWrite();
    if (
      this.stopped ||
      item.abort?.signal.aborted ||
      !["starting", "ready", "degraded"].includes(item.status.state)
    )
      throw new ConnectorPolicyError(
        "CONNECTOR_STOPPED",
        "connector not writable",
      );
    if (!item.manifest.capabilities.includes("events"))
      throw new ConnectorPolicyError(
        "CONNECTOR_CAPABILITY_DENIED",
        "events capability missing",
      );
    if (
      next !== undefined &&
      !item.manifest.capabilities.includes("checkpoint")
    )
      throw new ConnectorPolicyError(
        "CONNECTOR_CAPABILITY_DENIED",
        "checkpoint capability missing",
      );
    if (next !== undefined) ConnectorStore.validateCheckpoint(next);
    for (const event of events) {
      if (
        !event ||
        typeof event !== "object" ||
        !item.manifest.eventNamespaces.includes(event.namespace) ||
        typeof event.type !== "string" ||
        !event.type ||
        !Number.isFinite(Date.parse(event.occurredAt)) ||
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(event.id)
      )
        throw new ConnectorPolicyError(
          "CONNECTOR_EVENT_INVALID",
          "event schema/namespace 非法",
        );
    }
    const max = this.options.maxPendingEvents ?? 500,
      current = queueSize(this.options.dataRoot),
      priority = this.isPriority(item, events),
      hadPending = priority
        ? item.store.hasPriorityPending()
        : item.store.hasPending();
    if (events.length > max)
      throw new ConnectorPolicyError(
        "CONNECTOR_BACKPRESSURE",
        "batch exceeds durable ingress limit",
      );
    if (priority && current + events.length > max + 50)
      throw new ConnectorPolicyError(
        "CONNECTOR_PRIORITY_CAPACITY",
        "priority event retained at source ingress",
      );
    if (
      allowDefer &&
      (hadPending || (current + events.length > max && !priority))
    ) {
      const deferred = this.defer(item, events, next, priority);
      item.status.state = "degraded";
      item.status.errorCode = hadPending
        ? "CONNECTOR_FIFO_DEFERRED"
        : "CONNECTOR_BACKPRESSURE_DEFERRED";
      this.scheduleDrain(item);
      emitCoreLog({
        event: "connector-delivery-deferred",
        moduleType: "connector",
        moduleId: item.manifest.id,
        operation: "publish",
        msg: `connector deferred ${deferred.accepted} events`,
      });
      return {
        accepted: deferred.accepted,
        duplicates: deferred.duplicates,
        disposition: "deferred",
      };
    }
    if (
      !allowDefer &&
      current + events.length > max &&
      (!priority || current + events.length > max + 50)
    )
      throw new ConnectorPolicyError(
        "CONNECTOR_BACKPRESSURE",
        "drain lost ingress capacity",
      );
    let accepted = 0,
      duplicates = 0;
    const projectedEvents: OwnwardEvent[] = [];
    for (const event of events) {
      const identity = {
        id: `${item.manifest.id}:${event.id}`,
        source: item.manifest.id as any,
        key: `${event.namespace}.${event.type}`,
        ts: new Date().toISOString(),
      };
      const sourcePayload = {
        ...structuredClone(event.payload),
        _occurredAt: event.occurredAt,
      };
      projectedEvents.push({
        ...identity,
        payload: sourcePayload,
      } as OwnwardEvent);
      if (item.store.has(event.id)) {
        duplicates++;
        continue;
      }
      const stored = {
        ...identity,
        payload: redactPayload(sourcePayload),
      } as OwnwardEvent;
      item.lifecycle?.assertWrite();
      appendEvent(stored, this.options.dataRoot);
      this.options.afterQueueDurable?.();
      item.store.accept(event);
      this.options.afterAcceptedDurable?.();
      accepted++;
    }
    if (this.options.onEvents && projectedEvents.length)
      await this.options.onEvents(projectedEvents);
    item.lifecycle?.assertWrite();
    if (next) item.store.saveCheckpoint(next);
    item.status.accepted += accepted;
    item.status.duplicates += duplicates;
    item.status.queueDepth = queueSize(this.options.dataRoot);
    item.status.lastSuccessAt = new Date().toISOString();
    emitCoreLog({
      event: "connector-delivery-appended",
      moduleType: "connector",
      moduleId: item.manifest.id,
      operation: "publish",
      eventId: events.length === 1 ? events[0]!.id : null,
      msg: `connector appended ${accepted} events`,
    });
    return { accepted, duplicates, disposition: "appended" };
  }
  private scheduleDrain(item: Loaded) {
    if (this.stopped || this.drainTimers.has(item.manifest.id)) return;
    const delay = Math.min(
        this.options.drainMaxMs ?? 30_000,
        (this.options.drainBaseMs ?? 250) *
          2 ** Math.min(item.drainFailures ?? 0, 10),
      ),
      timer = setTimeout(() => {
        this.drainTimers.delete(item.manifest.id);
        void this.serialize(item, () => this.drainOneLocked(item));
      }, delay);
    (timer as any).unref?.();
    this.drainTimers.set(item.manifest.id, timer);
  }
  private retryDrain(item: Loaded, code: string) {
    item.status.state = "degraded";
    item.status.errorCode = code;
    item.drainFailures = (item.drainFailures ?? 0) + 1;
    if ([1, 5, 20].includes(item.drainFailures))
      this.options.onAlert?.(
        item.manifest.id,
        `CONNECTOR_PENDING_RETRYING_${item.drainFailures}`,
      );
    this.scheduleDrain(item);
  }
  private async drainOneLocked(item: Loaded) {
    if (this.stopped) return;
    let batch;
    try {
      batch = item.store.pendingBatch();
    } catch (e: any) {
      this.audit("connector-recovery-read-failed", item.manifest.id, "recovery", "pending journal read failed", e?.code || "CONNECTOR_PENDING_READ_FAILED");
      this.retryDrain(item, String(e?.code || "CONNECTOR_PENDING_READ_FAILED"));
      return;
    }
    const corrupt = item.store.takePendingCorruptions();
    if (corrupt) {
      item.status.state = "degraded";
      item.status.errorCode = "CONNECTOR_PENDING_CORRUPT";
      this.options.onAlert?.(item.manifest.id, "CONNECTOR_PENDING_CORRUPT");
      this.audit("connector-journal-corrupt", item.manifest.id, "journal", "pending journal corruption quarantined", "CONNECTOR_PENDING_CORRUPT");
    }
    if (!batch) return;
    try {
      const max = this.options.maxPendingEvents ?? 500,
        current = queueSize(this.options.dataRoot),
        priority = this.isPriority(item, batch.events);
      if (
        current + batch.events.length > max &&
        (!priority || current + batch.events.length > max + 50)
      )
        throw new ConnectorPolicyError(
          "CONNECTOR_BACKPRESSURE",
          "pending capacity unavailable",
        );
      await this.options.beforeDrainPublish?.();
      const result = await this.publishLocked(
        item,
        batch.events,
        batch.checkpoint,
        false,
      );
      if (result.disposition !== "appended")
        throw new ConnectorPolicyError(
          "CONNECTOR_PENDING_NOT_APPENDED",
          "pending batch was not appended",
        );
      item.store.ackPending(batch.path);
      this.audit("connector-recovery-completed", item.manifest.id, "recovery", "pending delivery recovered");
      item.drainFailures = 0;
      if (item.store.hasPending()) this.scheduleDrain(item);
    } catch (e: any) {
      const code = String(e?.code || "CONNECTOR_PENDING_RETRY_FAILED"),
        incompatible = [
          "CONNECTOR_EVENT_INVALID",
          "CONNECTOR_CHECKPOINT_INVALID",
          "CONNECTOR_CAPABILITY_DENIED",
        ].includes(code);
      item.status.state = "degraded";
      item.status.errorCode = code;
      if (incompatible) {
        try {
          if (!item.store.quarantinePending(batch.path)) {
            this.retryDrain(item, "CONNECTOR_PENDING_QUARANTINE_FAILED");
            return;
          }
          item.drainFailures = 0;
          this.options.onAlert?.(
            item.manifest.id,
            "CONNECTOR_PENDING_INCOMPATIBLE",
          );
          this.audit("connector-delivery-dropped", item.manifest.id, "drop", "incompatible pending delivery quarantined", code);
          if (item.store.hasPending()) this.scheduleDrain(item);
        } catch (error: any) {
          this.retryDrain(
            item,
            String(error?.code || "CONNECTOR_PENDING_QUARANTINE_FAILED"),
          );
        }
      } else this.retryDrain(item, code);
    }
  }
  private stopItem(item: Loaded): Promise<void> {
    if (item.stopPromise) return item.stopPromise;
    item.stopPromise = (async () => {
      if (item.stableTimer) clearTimeout(item.stableTimer);
      item.stableTimer = undefined;
      item.status.state = "stopping";
      try {
        await this.disposeInstance(item);
        item.status.state = "disabled";
        this.audit("connector-stopped", item.manifest.id, "stop", "connector stopped");
      } catch (e: any) {
        item.status.state = "failed";
        item.status.errorCode = String(e?.code || "CONNECTOR_STOP_FAILED");
        this.audit("connector-stop-failed", item.manifest.id, "stop", "connector stop failed", item.status.errorCode);
      }
    })();
    return item.stopPromise;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.startGeneration++;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    const work = Promise.all(
      [...this.loaded.values()].reverse().map((item) => this.stopItem(item)),
    )
      .then(() => Promise.all([...this.activeStarts]))
      .then(() => {});
    this.stopping = work;
    await work;
    if (this.stopping === work) this.stopping = undefined;
  }
  statuses(): ConnectorStatus[] {
    return [...this.loaded.values()].map((x) => structuredClone(x.status));
  }
  /** Executes connector-owned probes. Unlike health(), this is an explicit state transition. */
  async probe(): Promise<void> {
    for (const item of this.loaded.values()) {
      const probe = item.host
        ? () => item.host!.health(this.options.healthTimeoutMs ?? 2_000)
        : item.module?.health
          ? () =>
              deadline(
                item.module!.health!(),
                this.options.healthTimeoutMs ?? 2_000,
                "CONNECTOR_HEALTH_TIMEOUT",
              )
          : undefined;
      if (!probe) {
        item.healthDetail ??= {
          status: "unknown",
          reason: "health probe not implemented",
        };
        continue;
      }
      try {
        const detail = (await probe()) as Record<string, unknown>;
        if (typeof detail?.ok === "boolean")
          this.reportHealth(item, {
            ok: detail.ok,
            code: typeof detail.code === "string" ? detail.code : undefined,
            message:
              typeof detail.message === "string" ? detail.message : undefined,
            detail:
              detail.detail &&
              typeof detail.detail === "object" &&
              !Array.isArray(detail.detail)
                ? (detail.detail as Record<string, unknown>)
                : detail,
          });
        else {
          item.healthDetail = redactPayload(detail) as Record<string, unknown>;
          if (detail.status !== "unknown") this.markHealthy(item);
        }
      } catch (e: any) {
        const code = String(e?.code || "CONNECTOR_HEALTH_FAILED");
        item.healthDetail = { errorCode: code };
        item.status.state =
          item.status.state === "ready" ? "degraded" : item.status.state;
        item.status.errorCode = code;
        item.status.errorMessage = clean(
          String(e?.message || "health probe failed"),
        );
        item.status.lastFailureAt = new Date().toISOString();
        item.status.consecutiveFailures++;
      }
    }
  }
  /** Pure diagnostic snapshot: never probes connectors or changes their health state. */
  async health(): Promise<Record<string, unknown>[]> {
    return [...this.loaded.values()].map((item) => ({
      ...structuredClone(item.status),
      ...item.store.diagnostics(),
      detail: structuredClone(
        item.healthDetail ?? { status: "unknown", reason: "not probed" },
      ),
    }));
  }
}
