import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { KERNEL_API_VERSION, KERNEL_VERSION, type OwnwardVertical, type VerticalCapability, type VerticalManifest, type VerticalStatus } from "./contracts.ts";
import {
  buildVerticalContext,
  ExtensionPolicyError,
  SchedulerScope,
} from "./services.ts";
import { scopedStorage } from "./services.ts";
import { ExtensionHostClient } from "./host-client.ts";
import { LifecycleCapability } from "./lifecycle.ts";
import { runExtensionMigration } from "./migration.ts";
import { emitCoreLog } from "../observability/contracts.ts";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
/** a-b：正数表示 a 更新。只比 x.y.z 三段，逐段按数字比——
 *  字符串比较会把 "1.10.0" 判成小于 "1.9.0"。 */
function compareVersion(a: string, b: string): number {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < 3; i++) {
    const d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
    if (d !== 0) return d;
  }
  return 0;
}
const MANIFEST_KEYS = new Set([
  "id",
  "name",
  "version",
  "kernelApiVersion",
  "minKernelVersion",
  "entry",
  "capabilities",
  "roots",
  "vault",
  "routes",
  "navigation",
  "assets",
  "commands",
  "subscriptions",
]);
// 运行时白名单：TS 的 VerticalCapability 类型在运行时是擦除的，manifest 校验只认这份数组。
// 加新能力时两处必须同时改——只改类型会让声明该能力的 Vertical 以 VERTICAL_MANIFEST_INVALID
// 直接下线。能力类型与运行时白名单必须由测试保持一致。
const CAPABILITIES = new Set<VerticalCapability>([
  "storage",
  "sessions",
  "tasks",
  "tasks:full-access",
  "actions",
  "events",
  "scheduler",
  "notify",
  "vault",
  "llm",
  "sources",
]);
const FORBIDDEN_IMPORT =
  /(?:^|\/)(?:kernel|runner|providers)(?:\/|$)|(?:^|\/)(?:paths|util|actions|dispatch)\.ts$/;
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json"]);
// builtin/no-root vertical 没有 host 崩溃清理路径，失败即终态是刻意设计；这里给「请求失败」型
// 熔断加有界自恢复：最多重激活这么多次，超了维持 failed，避免持续失败时热重启循环。
const MAX_BUILTIN_RESTARTS = 5;
// Compatibility lint only: trusted external code is not sandboxed and may use bare dependencies.
const EXTERNAL_IMPORT_ALLOWLIST = new Set([
  "assert",
  "buffer",
  "crypto",
  "events",
  "fs",
  "os",
  "path",
  "stream",
  "url",
  "util",
]);

export interface BuiltinVertical {
  manifest: VerticalManifest;
  load: () => Promise<OwnwardVertical>;
  legacyRoutes?: string[];
}
export interface ExtensionRuntimeOptions {
  dataRoot: string;
  config?: Record<string, any>;
  builtins?: BuiltinVertical[];
  externalPaths?: string[];
  hostStartTimeoutMs?: number;
  activateTimeoutMs?: number;
  routeTimeoutMs?: number;
  healthTimeoutMs?: number;
  restartBaseMs?: number;
  jobTimeoutMs?: number;
  sessionFactory?: Parameters<typeof buildVerticalContext>[0]["sessionFactory"];
  taskFactory?: Parameters<typeof buildVerticalContext>[0]["taskFactory"];
  actionFactory?: Parameters<typeof buildVerticalContext>[0]["actionFactory"];
  llmFactory?: Parameters<typeof buildVerticalContext>[0]["llmFactory"];
  sourceFactory?: Parameters<typeof buildVerticalContext>[0]["sourceFactory"];
  log?: (message: string) => void;
}
interface Loaded {
  manifest: VerticalManifest;
  source: "builtin" | "external";
  module?: OwnwardVertical;
  host?: ExtensionHostClient;
  status: VerticalStatus;
  scheduler?: SchedulerScope;
  lifecycle?: LifecycleCapability;
  legacyRoutes: string[];
  root?: string;
  crashCount?: number;
  nextRestartAt?: number;
  restartTimer?: ReturnType<typeof setTimeout>;
  hasScheduler?: boolean;
  startingPromise?: Promise<void>;
  routeGrants?: { timeoutMs: number; maxBodyBytes: number; binary: boolean; frameMaxBytes: number };
}

function strictObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      `${label} 必须是对象`,
    );
  return value as any;
}
function uniqueStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== "string") ||
    new Set(value).size !== value.length
  )
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      `${label} 非法`,
    );
  return value;
}
export function parseVerticalManifest(value: unknown): VerticalManifest {
  const m = strictObject(value, "manifest");
  for (const key of Object.keys(m))
    if (!MANIFEST_KEYS.has(key))
      throw new ExtensionPolicyError(
        "VERTICAL_MANIFEST_INVALID",
        `manifest 未知字段: ${key}`,
      );
  if (
    !ID.test(m.id) ||
    typeof m.name !== "string" ||
    !m.name.trim() ||
    !VERSION.test(m.version) ||
    !Number.isInteger(m.kernelApiVersion) ||
    typeof m.entry !== "string" ||
    !m.entry
  )
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      "manifest 必填字段非法",
    );
  if (m.kernelApiVersion !== KERNEL_API_VERSION)
    throw new ExtensionPolicyError(
      "VERTICAL_KERNEL_API_INCOMPATIBLE",
      `需要 Kernel API ${m.kernelApiVersion}，当前 ${KERNEL_API_VERSION}`,
    );
  // minKernelVersion：同一代 API 内，Vertical 声明自己用到了哪一版才有的东西。
  // 不设这道门的话，新 Vertical 装到老 Kernel 会一路放行到调用时才抛
  // EXTENSION_KERNEL_METHOD_DENIED——页面打得开，点某个功能才炸。宁可拒载。
  if (m.minKernelVersion !== undefined) {
    if (typeof m.minKernelVersion !== "string" || !PLAIN_VERSION.test(m.minKernelVersion))
      throw new ExtensionPolicyError(
        "VERTICAL_MANIFEST_INVALID",
        "minKernelVersion 必须是 x.y.z",
      );
    if (compareVersion(KERNEL_VERSION, m.minKernelVersion) < 0)
      throw new ExtensionPolicyError(
        "VERTICAL_KERNEL_TOO_OLD",
        `需要 Kernel >= ${m.minKernelVersion}，当前 ${KERNEL_VERSION}`,
      );
  }
  const capabilities = uniqueStrings(m.capabilities, "capabilities");
  if (capabilities.some((x) => !CAPABILITIES.has(x as VerticalCapability)))
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      "未知 capability",
    );
  const roots = uniqueStrings(m.roots, "roots");
  if (roots.some((x) => !isAbsolute(x)))
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      "roots 必须是绝对路径",
    );
  const routes = uniqueStrings(m.routes, "routes");
  if (routes.some((p) => !p.startsWith(`/api/verticals/${m.id}/`)))
    throw new ExtensionPolicyError(
      "VERTICAL_ROUTE_DENIED",
      "API route 必须位于扩展命名空间",
    );
  if (
    m.navigation !== undefined &&
    (!Array.isArray(m.navigation) ||
      m.navigation.some(
        (n: any) =>
          !n ||
          typeof n.id !== "string" ||
          typeof n.label !== "string" ||
          typeof n.href !== "string",
      ))
  )
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      "navigation 非法",
    );
  if (
    m.assets !== undefined &&
    (!Array.isArray(m.assets) ||
      m.assets.some(
        (a: any) =>
          !a ||
          typeof a.path !== "string" ||
          !a.path.startsWith(`/verticals/${m.id}/`) ||
          typeof a.file !== "string" ||
          isAbsolute(a.file) ||
          a.file.split(/[\\/]/).includes(".."),
      ))
  )
    throw new ExtensionPolicyError(
      "VERTICAL_ASSET_DENIED",
      "asset 必须位于扩展命名空间且文件不得越界",
    );
  if (
    m.commands !== undefined &&
    (!Array.isArray(m.commands) ||
      m.commands.some(
        (c: any) => !c || !ID.test(c.id) || typeof c.title !== "string",
      ))
  )
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      "commands 非法",
    );
  if (
    m.subscriptions !== undefined &&
    (!Array.isArray(m.subscriptions) ||
      m.subscriptions.some(
        (s: any) =>
          !s || typeof s.namespace !== "string" || typeof s.event !== "string",
      ))
  )
    throw new ExtensionPolicyError(
      "VERTICAL_MANIFEST_INVALID",
      "subscriptions 非法",
    );
  if (
    isAbsolute(m.entry) ||
    m.entry.split(/[\\/]/).some((p: string) => p === "..")
  )
    throw new ExtensionPolicyError(
      "VERTICAL_ENTRY_DENIED",
      "entry 必须位于扩展目录",
    );
  if (capabilities.includes("vault") && !m.vault)
    throw new ExtensionPolicyError(
      "VERTICAL_VAULT_UNDECLARED",
      "Vault capability 必须声明 scope",
    );
  return structuredClone({
    ...m,
    capabilities,
    roots,
    routes,
  }) as VerticalManifest;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        if (SOURCE_EXT.has(extname(e.name)))
          throw new ExtensionPolicyError(
            "VERTICAL_SOURCE_SYMLINK",
            "扩展源码拒绝符号链接",
          );
        continue;
      }
      // node_modules 不进 lint：审计对象是扩展的第一方源码；三方依赖
      // 产物里常见计算型动态 import，会误触硬拒。受信双门（enabled+trusted）已是信任边界。
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (SOURCE_EXT.has(extname(e.name))) out.push(p);
    }
  };
  walk(root);
  return out;
}
export function validateExtensionImports(
  root: string,
  warn: (message: string) => void = () => {},
): void {
  const actualRoot = realpathSync(root);
  for (const file of sourceFiles(actualRoot)) {
    const src = readFileSync(file, "utf8"),
      importPattern =
        /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g,
      matches = [...src.matchAll(importPattern)],
      specs = matches.map((m) => m[1] || m[2]);
    if (/import\s*\(/.test(src.replace(importPattern, "")))
      throw new ExtensionPolicyError(
        "VERTICAL_IMPORT_DENIED",
        "动态 import 必须是可静态验证的字符串字面量",
      );
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        if (!SOURCE_EXT.has(extname(spec)))
          throw new ExtensionPolicyError(
            "VERTICAL_IMPORT_DENIED",
            `相对 import 必须带源码扩展名: ${spec}`,
          );
        const target = resolve(file, "..", spec),
          rel = relative(actualRoot, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new ExtensionPolicyError(
            "VERTICAL_IMPORT_DENIED",
            `import 越界: ${spec}`,
          );
      } else {
        const bare = spec.replace(/^node:/, "").split("/", 1)[0]!;
        if (!EXTERNAL_IMPORT_ALLOWLIST.has(bare))
          warn(`trusted bare import 未静态审计: ${spec}`);
      }
      if (FORBIDDEN_IMPORT.test(spec.replace(/^\.\.\//g, "")))
        throw new ExtensionPolicyError(
          "VERTICAL_IMPORT_DENIED",
          `禁止 import: ${spec}`,
        );
    }
  }
}
async function deadline<T>(
  work: Promise<T> | T,
  ms: number,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExtensionPolicyError(code, `${ms}ms timeout`)),
      ms,
    );
  });
  try {
    return await Promise.race([Promise.resolve(work), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class ExtensionRuntime {
  private loaded = new Map<string, Loaded>();
  private started = false;
  constructor(private readonly options: ExtensionRuntimeOptions) {}
  private audit(event: string, moduleId: string, operation: string, msg: unknown, errorClass?: unknown) {
    emitCoreLog({ event, moduleType: "vertical", moduleId, operation, msg, errorClass }, this.options.log ?? console.error);
  }
  discover(): VerticalStatus[] {
    if (this.started)
      throw new ExtensionPolicyError(
        "VERTICAL_RUNTIME_STARTED",
        "启动后不能重新发现扩展",
      );
    this.loaded.clear();
    for (const b of this.options.builtins ?? []) {
      try {
        this.add(
          {
            manifest: parseVerticalManifest(b.manifest),
            source: "builtin",
            legacyRoutes: b.legacyRoutes ?? [],
          },
          b.load,
        );
      } catch (e: any) {
        this.addFailure(
          `builtin:${String((b as any)?.manifest?.id || "unknown")}`,
          e?.code || "VERTICAL_DISCOVERY_FAILED",
          e?.message,
          "builtin",
        );
      }
    }
    for (const raw of this.options.externalPaths ?? []) {
      if (!isAbsolute(raw)) {
        this.addFailure(raw, "VERTICAL_PATH_NOT_ABSOLUTE");
        continue;
      }
      try {
        const root = realpathSync(raw);
        if (!statSync(root).isDirectory()) throw new Error("not directory");
        const manifest = parseVerticalManifest(
          JSON.parse(readFileSync(join(root, "ownward.vertical.json"), "utf8")),
        );
        validateExtensionImports(root, (warning) => this.audit("vertical-discovery-warning", manifest.id, "discover", warning));
        const entry = resolve(root, manifest.entry),
          rel = relative(root, entry);
        if (
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          isAbsolute(rel) ||
          !existsSync(entry)
        )
          throw new ExtensionPolicyError(
            "VERTICAL_ENTRY_DENIED",
            "entry 不存在或越界",
          );
        this.add({ manifest, source: "external", root, legacyRoutes: [] });
        this.audit("vertical-discovered", manifest.id, "discover", "external vertical discovered");
      } catch (e: any) {
        this.addFailure(
          raw,
          e?.code ||
            (e instanceof SyntaxError
              ? "VERTICAL_MANIFEST_INVALID"
              : "VERTICAL_DISCOVERY_FAILED"),
          e?.message,
        );
      }
    }
    return this.statuses();
  }
  private add(
    base: Pick<Loaded, "manifest" | "source" | "root" | "legacyRoutes">,
    loader?: () => Promise<OwnwardVertical>,
  ) {
    if (this.loaded.has(base.manifest.id))
      throw new ExtensionPolicyError(
        "VERTICAL_ID_DUPLICATE",
        `重复 vertical id: ${base.manifest.id}`,
      );
    (base as any).loader = loader;
    this.loaded.set(base.manifest.id, {
      ...base,
      status: {
        id: base.manifest.id,
        name: base.manifest.name,
        version: base.manifest.version,
        source: base.source,
        state: "discovered",
        consecutiveFailures: 0,
      },
    });
    this.audit("vertical-discovered", base.manifest.id, "discover", `${base.source} vertical discovered`);
  }
  private addFailure(
    path: string,
    code: string,
    message = "",
    source: "builtin" | "external" = "external",
  ) {
    const id = `invalid-${this.loaded.size + 1}`,
      name = `${source === "builtin" ? "Builtin vertical" : "External extension"} (invalid)`;
    this.loaded.set(id, {
      manifest: {
        id,
        name,
        version: "0.0.0",
        kernelApiVersion: KERNEL_API_VERSION,
        entry: "invalid",
      },
      source,
      legacyRoutes: [],
      status: {
        id,
        name,
        version: "0.0.0",
        source,
        state: "failed",
        errorCode: code,
        consecutiveFailures: 1,
        lastFailureAt: new Date().toISOString(),
      },
    });
    this.audit("vertical-discovery-failed", id, "discover", { path, message }, code);
  }
  async start(): Promise<void> {
    if (!this.loaded.size) {
      try {
        this.discover();
      } catch (e: any) {
        this.addFailure(
          "runtime",
          e?.code || "VERTICAL_DISCOVERY_FAILED",
          e?.message,
          "builtin",
        );
      }
    }
    this.started = true;
    for (const item of this.loaded.values()) {
      try {
        await this.startOne(item);
      } catch (e) {
        this.fail(item, e, true);
      }
    }
  }
  private startOne(item: Loaded): Promise<void> {
    if (item.startingPromise) return item.startingPromise;
    const attempt = this.startOneImpl(item).finally(() => {
      if (item.startingPromise === attempt) item.startingPromise = undefined;
    });
    item.startingPromise = attempt;
    return attempt;
  }
  private async startOneImpl(item: Loaded) {
    if (
      item.status.state === "failed" &&
      (item.source === "builtin" || !item.root)
    ) {
      // 只有「请求失败」型熔断(fail() 设了 nextRestartAt)且未超上限才有界恢复；fatal 启动失败维持终态。
      if (!item.nextRestartAt || (item.crashCount ?? 0) > MAX_BUILTIN_RESTARTS) return;
      // 这类没有 host 崩溃清理路径，重激活前手动清理旧实例：停旧 scheduler、deactivate 旧 module，
      // 否则旧 scheduler 定时器会泄漏、模块可能重复注册。lifecycle 已在 fail() 里 revoke。
      item.scheduler?.stop();
      item.scheduler = undefined;
      try { await item.module?.deactivate?.(); }
      catch (e) { this.audit("vertical-recover-deactivate-failed", item.manifest.id, "stop", "recover deactivate failed", safeCode(e)); }
      item.module = undefined;
    }
    const configured = this.options.config?.verticals?.[item.manifest.id];
    if (item.source === "external") {
      if (configured?.enabled === false) {
        item.status.state = "disabled";
        return;
      }
      if (configured?.enabled !== true) {
        item.status.state = "discovered";
        return;
      }
      if (configured?.trusted !== true) {
        item.status.state = "discovered";
        item.status.errorCode = "EXTENSION_TRUST_CONFIRMATION_REQUIRED";
        return;
      }
    } else if (configured?.enabled === false) {
      item.status.state = "disabled";
      return;
    }
    item.status.state = "starting";
    this.audit("vertical-starting", item.manifest.id, "start", "vertical start initiated");
    try {
      const loader = (item as any).loader as
        (() => Promise<OwnwardVertical>) | undefined;
      if (item.source === "external") {
        const verticalConfig = configured ?? {},
          grantedManifest = this.grantExternal(item, verticalConfig);
        item.routeGrants = this.externalRouteGrants(verticalConfig);
        const host = new ExtensionHostClient(
          item.root!,
          item.manifest,
          undefined,
          () => {
            item.lifecycle?.revoke();
            item.scheduler?.stop();
            item.scheduler = undefined;
            item.host = undefined;
            this.audit("vertical-host-exited", item.manifest.id, "host", "vertical host exited", "EXTENSION_HOST_EXITED");
            this.scheduleRestart(item);
            this.fail(
              item,
              Object.assign(new Error(), { code: "EXTENSION_HOST_EXITED" }),
            );
          },
          (op, msg) => this.audit("vertical-host-log", item.manifest.id, op, msg),
          { frameMaxBytes: item.routeGrants.frameMaxBytes },
        );
        const {
          enabled: _enabled,
          trusted: _trusted,
          grantedCapabilities: _caps,
          grantedRoots: _roots,
          vaultScopes: _vault,
          allowSensitiveVault: _sensitive,
          grantedRouteTimeoutMs: _routeTimeout,
          grantedRouteBodyBytes: _routeBody,
          grantedRouteBinary: _routeBinary,
          ...domainConfig
        } = verticalConfig;
        item.host = host;
        await host.launch(this.options.hostStartTimeoutMs ?? 10_000);
        this.audit("vertical-host-started", item.manifest.id, "host-start", "external host started");
        const description = await host.describe(
          this.options.activateTimeoutMs ?? 5_000,
        );
        try {
          this.audit("vertical-migration-started", item.manifest.id, "migrate", "vertical migration gate entered");
          await runExtensionMigration({
            dataRoot: this.options.dataRoot,
            kind: "vertical",
            id: item.manifest.id,
            version: item.manifest.version,
            migrate: description.hasMigration
              ? async ({ migrationId, storage }) => {
                  host.setStorage(storage);
                  await host.migrate(
                    domainConfig,
                    migrationId,
                    this.options.activateTimeoutMs ?? 5_000,
                  );
                }
              : undefined,
          });
          this.audit("vertical-migration-completed", item.manifest.id, "migrate", "vertical migration gate completed");
        } catch (error) {
          throw Object.assign(new Error("vertical migration failed"), {
            code: "VERTICAL_MIGRATION_FAILED",
            cause: error,
          });
        }
        const lifecycle = new LifecycleCapability("vertical", item.manifest.id);
        item.lifecycle = lifecycle;
        host.setStorage(
          grantedManifest.capabilities?.includes("storage")
            ? scopedStorage(this.options.dataRoot, item.manifest.id, lifecycle)
            : undefined,
        );
        if (grantedManifest.capabilities?.includes("actions")) {
          if (!this.options.actionFactory)
            throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Action Service 不可用");
          const raw = this.options.actionFactory(item.manifest.id);
          host.setActions(Object.freeze({
            list: raw.list.bind(raw),
            open: ((input: any) => { lifecycle.assertWrite(); return raw.open(input); }) as typeof raw.open,
            resolve: ((id: string, resolution: string) => { lifecycle.assertWrite(); return raw.resolve(id, resolution); }) as typeof raw.resolve,
            dismiss: ((id: string) => { lifecycle.assertWrite(); return raw.dismiss(id); }) as typeof raw.dismiss,
          }));
        } else host.setActions(undefined);
        // 决策模型：Vertical 不自己 spawn CLI，沙箱/超时/降级/审计统一在 Kernel（ADR 批次 D）
        if (grantedManifest.capabilities?.includes("llm")) {
          if (!this.options.llmFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Decision Model Service 不可用");
          const raw = this.options.llmFactory(item.manifest.id);
          host.setLlm(Object.freeze({ complete: ((inp: any) => { lifecycle.assertWrite(); return raw.complete(inp); }) as typeof raw.complete, engines: raw.engines.bind(raw) }));
        } else host.setLlm(undefined);
        if (grantedManifest.capabilities?.includes("sources")) {
          if (!this.options.sourceFactory) throw new ExtensionPolicyError("VERTICAL_SERVICE_UNAVAILABLE", "Source Service 不可用");
          host.setSources(this.options.sourceFactory(item.manifest.id));
        } else host.setSources(undefined);
        const activated = await host.activate(
          domainConfig,
          this.options.activateTimeoutMs ?? 5_000,
        );
        if (
          activated.manifest !== null &&
          activated.manifest !== undefined &&
          canonical(parseVerticalManifest(activated.manifest)) !==
            canonical(item.manifest)
        )
          throw new ExtensionPolicyError(
            "VERTICAL_MANIFEST_MISMATCH",
            "Host module manifest 与磁盘不一致",
          );
        // scheduler：登记表由 activate 响应带回，fn 在 host 本地；kernel 只负责按拍打 job RPC。
        // host 崩溃/重载会走到这里重建，先停旧表防重复注册。
        item.scheduler?.stop();
        item.scheduler = undefined;
        const jobs = Array.isArray(activated.jobs) ? activated.jobs : [];
        if (grantedManifest.capabilities?.includes("scheduler") && jobs.length) {
          const jobTimeoutMs = this.options.jobTimeoutMs ?? 600_000;
          const scope = new SchedulerScope(item.manifest.id, (e) => this.audit("vertical-scheduler-failed", item.manifest.id, "scheduler", "scheduled job failed", safeCode(e)));
          for (const job of jobs) {
            if (!job || typeof job.id !== "string" || !Number.isInteger(job.intervalMs)) throw new ExtensionPolicyError("VERTICAL_SCHEDULE_INVALID", "host 回报的调度声明非法");
            // killOnTimeout=false：慢 job 记失败走退避，不当场杀 host（杀了会连坐正在服务的路由）
            scope.every(job.id, job.intervalMs, async () => { await item.host!.request("job", { id: job.id, timeoutMs: jobTimeoutMs }, jobTimeoutMs, false); });
          }
          item.scheduler = scope;
          item.hasScheduler = true;
        } else if (jobs.length) throw new ExtensionPolicyError("VERTICAL_CAPABILITY_NOT_GRANTED", "scheduler capability 未授权却注册了 job");
        const recovering = item.status.consecutiveFailures > 0;
        item.status.state = recovering ? "degraded" : "ready";
        if (!recovering) {
          item.status.errorCode = undefined;
          item.status.lastSuccessAt = new Date().toISOString();
          item.crashCount = 0;
        }
        item.nextRestartAt = 0;
        this.audit("vertical-ready", item.manifest.id, "activate", "vertical ready");
        return;
      }
      if (!loader)
        throw new ExtensionPolicyError(
          "VERTICAL_MODULE_INVALID",
          "内置模块缺少 loader",
        );
      const mod = await deadline(
        loader(),
        this.options.activateTimeoutMs ?? 5_000,
        "VERTICAL_LOAD_TIMEOUT",
      );
      if (!mod || typeof mod.activate !== "function")
        throw new ExtensionPolicyError(
          "VERTICAL_MODULE_INVALID",
          "模块缺少 activate",
        );
      const verticalConfig = configured ?? {};
      let grantedManifest = item.manifest;
      const scheduler = new SchedulerScope(item.manifest.id, (e) => this.audit("vertical-scheduler-failed", item.manifest.id, "scheduler", "scheduled job failed", safeCode(e)));
      item.scheduler = scheduler;
      try {
        this.audit("vertical-migration-started", item.manifest.id, "migrate", "vertical migration gate entered");
        await runExtensionMigration({
          dataRoot: this.options.dataRoot,
          kind: "vertical",
          id: item.manifest.id,
          version: item.manifest.version,
          migrate: mod.migrate
            ? async ({ migrationId, storage }) =>
                deadline(
                  mod.migrate!({
                    migrationId,
                    storage,
                    config: Object.freeze(structuredClone(verticalConfig)),
                    log: (op, msg) => this.audit("vertical-migration-log", item.manifest.id, op, msg),
                  }),
                  this.options.activateTimeoutMs ?? 5_000,
                  "VERTICAL_MIGRATION_TIMEOUT",
                )
            : undefined,
        });
        this.audit("vertical-migration-completed", item.manifest.id, "migrate", "vertical migration gate completed");
      } catch (error) {
        throw Object.assign(new Error("vertical migration failed"), {
          code: "VERTICAL_MIGRATION_FAILED",
          cause: error,
        });
      }
      const lifecycle = new LifecycleCapability("vertical", item.manifest.id);
      item.lifecycle = lifecycle;
      const ctx = buildVerticalContext({
        manifest: grantedManifest,
        dataRoot: this.options.dataRoot,
        config: verticalConfig,
        sessionFactory: this.options.sessionFactory,
        taskFactory: this.options.taskFactory,
        actionFactory: this.options.actionFactory,
        llmFactory: this.options.llmFactory,
        sourceFactory: this.options.sourceFactory,
        scheduler,
        lifecycle,
        logger: (op, msg) => this.audit("vertical-module-log", item.manifest.id, op, msg),
      });
      await deadline(
        mod.activate(ctx),
        this.options.activateTimeoutMs ?? 5_000,
        "VERTICAL_ACTIVATE_TIMEOUT",
      );
      item.module = mod;
      item.status.state = "ready";
      item.status.lastSuccessAt = new Date().toISOString();
      this.audit("vertical-ready", item.manifest.id, "activate", "vertical ready");
    } catch (e) {
      item.lifecycle?.revoke();
      item.scheduler?.stop();
      item.host?.kill();
      item.host = undefined;
      const migrationFailed =
        safeCode(e) === "EXTENSION_ERROR" &&
        String((e as any)?.code) === "VERTICAL_MIGRATION_FAILED";
      if (item.source === "external" && !migrationFailed)
        this.scheduleRestart(item);
      if (migrationFailed) {
        item.status.state = "migration_failed";
        item.status.errorCode = "VERTICAL_MIGRATION_FAILED";
        item.status.lastFailureAt = new Date().toISOString();
        item.status.consecutiveFailures++;
      } else this.fail(item, e, item.source === "builtin");
      emitCoreLog({
        event: "vertical-lifecycle-failed",
        moduleType: "vertical",
        moduleId: item.manifest.id,
        operation: migrationFailed ? "migrate" : "activate",
        errorClass: item.status.errorCode,
        msg: "vertical lifecycle failed",
      });
    }
  }
  /** 受信 Vertical 的路由授权（ADR 批次 B）：deadline/body 上限/二进制透传，全部有硬顶。
   *  frame 上限随 body 授权协商（base64 膨胀 4/3 + 1MB 信封余量），host 经 env 得知同一个值。 */
  private externalRouteGrants(config: Record<string, any>) {
    const clampInt = (value: unknown, min: number, max: number, fallback: number) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
    const timeoutMs = clampInt(config.grantedRouteTimeoutMs, 1_000, 600_000, this.options.routeTimeoutMs ?? 2_000);
    const maxBodyBytes = clampInt(config.grantedRouteBodyBytes, 256 * 1024, 64 * 1024 * 1024, 256 * 1024);
    const binary = config.grantedRouteBinary === true;
    const frameMaxBytes = Math.min(96 * 1024 * 1024, Math.max(1024 * 1024, Math.ceil(maxBodyBytes * 4 / 3) + 1024 * 1024));
    return { timeoutMs, maxBodyBytes, binary, frameMaxBytes };
  }
  private grantExternal(
    item: Loaded,
    config: Record<string, any>,
  ): VerticalManifest {
    const grantedCapabilities = uniqueStrings(
      config.grantedCapabilities,
      "grantedCapabilities",
    );
    if (
      (item.manifest.capabilities ?? []).some(
        (cap) => !grantedCapabilities.includes(cap),
      )
    )
      throw new ExtensionPolicyError(
        "VERTICAL_CAPABILITY_NOT_GRANTED",
        "manifest 请求了未授权 capability",
      );
    if (
      (item.manifest.capabilities ?? []).some(
        (cap) => !["storage", "actions", "scheduler", "llm", "sources"].includes(cap),
      )
    )
      throw new ExtensionPolicyError(
        "VERTICAL_CAPABILITY_UNAVAILABLE",
        "外部 Host 目前开放 storage/actions/scheduler/llm/sources",
      );
    const grantedRoots = uniqueStrings(config.grantedRoots, "grantedRoots").map(
        (root) => resolve(root),
      ),
      roots = (item.manifest.roots ?? []).map((root) => resolve(root));
    if (
      roots.some(
        (root) =>
          !grantedRoots.some(
            (grant) => root === grant || root.startsWith(grant + sep),
          ),
      )
    )
      throw new ExtensionPolicyError(
        "VERTICAL_ROOT_NOT_GRANTED",
        "manifest 请求了未授权 root",
      );
    if (item.manifest.vault)
      throw new ExtensionPolicyError(
        "VERTICAL_CAPABILITY_UNAVAILABLE",
        "外部 Host v1 尚未开放 Vault",
      );
    return { ...item.manifest, roots };
  }
  private scheduleRestart(item: Loaded) {
    item.crashCount = (item.crashCount ?? 0) + 1;
    const delay = Math.min(
      30_000,
      (this.options.restartBaseMs ?? 250) * 2 ** item.crashCount,
    );
    item.nextRestartAt = Date.now() + delay;
    // 主动定时驱动重启：route() 只在有 HTTP 流量时驱动 nextRestartAt，纯 scheduler 的外部 vertical
    // 崩溃后没请求就永远不重启，夜里的定时任务会静默停摆。builtin 失败即终态(startOneImpl 拒绝重启)，不设。
    if (item.source !== "external" || !item.hasScheduler) return;
    if (item.restartTimer) clearTimeout(item.restartTimer);
    const timer = setTimeout(() => {
      item.restartTimer = undefined;
      if (!this.started || item.host || item.startingPromise) return;
      void this.startOne(item);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    item.restartTimer = timer;
  }
  private hostSuccess(item: Loaded) {
    item.status.state = "ready";
    item.status.errorCode = undefined;
    item.status.consecutiveFailures = 0;
    item.status.lastSuccessAt = new Date().toISOString();
    item.crashCount = 0;
    item.nextRestartAt = 0;
    if (item.restartTimer) { clearTimeout(item.restartTimer); item.restartTimer = undefined; }
  }
  private revokeHost(item: Loaded, error: unknown) {
    item.lifecycle?.revoke();
    item.scheduler?.stop();
    item.scheduler = undefined;
    item.host?.kill();
    item.host = undefined;
    this.scheduleRestart(item);
    this.fail(item, error);
  }
  private fail(item: Loaded, error: unknown, fatal = false) {
    item.status.consecutiveFailures++;
    item.status.lastFailureAt = new Date().toISOString();
    item.status.errorCode =
      error instanceof ExtensionPolicyError
        ? error.code
        : safeCode(error) === "EXTENSION_ERROR"
          ? "VERTICAL_RUNTIME_ERROR"
          : safeCode(error);
    item.status.state =
      fatal || item.status.consecutiveFailures >= 3 ? "failed" : "degraded";
    if (item.status.state === "failed") {
      item.lifecycle?.revoke();
      // 非 fatal 的 builtin/no-root 失败安排退避重启：它们没有 host 崩溃驱动，靠 route 半开据 nextRestartAt 拉起
      if (!fatal && (item.source === "builtin" || !item.root)) this.scheduleRestart(item);
    }
    this.audit("vertical-lifecycle-failed", item.manifest.id, "lifecycle", "vertical lifecycle failed", item.status.errorCode);
  }
  async route(req: Request, url: URL): Promise<Response | null> {
    for (const item of this.loaded.values()) {
      const namespaced =
          url.pathname.startsWith(`/api/verticals/${item.manifest.id}/`) ||
          url.pathname.startsWith(`/verticals/${item.manifest.id}/`),
        legacy =
          item.source === "builtin" &&
          item.legacyRoutes.some(
            (p) => url.pathname === p || url.pathname.startsWith(`${p}/`),
          );
      if (!namespaced && !legacy) continue;
      if (item.startingPromise) return unavailable(item);
      // builtin/no-root 熔断半开：请求失败型 failed 且冷却期过、未超上限，就重激活一次(startOneImpl 会先清理旧实例)。
      // 恢复后本次请求继续走到路由；成功则 hostSuccess 关熔断，仍失败则重新退避，超上限维持 failed(不热重启)。
      if (
        (item.source === "builtin" || !item.root) &&
        item.status.state === "failed" &&
        !!item.nextRestartAt &&
        Date.now() >= item.nextRestartAt &&
        (item.crashCount ?? 0) <= MAX_BUILTIN_RESTARTS
      ) {
        await this.startOne(item);
        if (item.startingPromise) return unavailable(item);
      }
      if (legacy && item.status.state === "disabled")
        return new Response(
          JSON.stringify({
            ok: false,
            code: "VERTICAL_DISABLED",
            vertical: item.manifest.id,
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        );
      if (
        item.status.state === "migration_failed" ||
        (legacy && ["starting", "failed"].includes(item.status.state))
      )
        return unavailable(item);
      if (
        item.source === "external" &&
        !item.host &&
        ["degraded", "failed"].includes(item.status.state) &&
        Date.now() >= (item.nextRestartAt ?? 0)
      ) {
        const starting = this.startOne(item);
        await starting;
      }
      if (item.startingPromise) return unavailable(item);
      if (
        item.source === "external" &&
        !item.host &&
        ["degraded", "failed"].includes(item.status.state)
      )
        return unavailable(item);
      if (
        (!item.module && !item.host) ||
        !["ready", "degraded"].includes(item.status.state)
      )
        continue;
      const asset = item.manifest.assets?.find((a) => a.path === url.pathname);
      if (asset && item.source === "external" && item.host) {
        if (req.method !== "GET" && req.method !== "HEAD")
          return new Response("method not allowed", { status: 405 });
        try {
          const result = await item.host.request(
              "asset",
              { file: asset.file },
              this.options.routeTimeoutMs ?? 2_000,
            ),
            mime = safeAssetMime(asset.contentType),
            isPage = PAGE_ASSET_MIMES.has(mime.split(";", 1)[0]);
          this.hostSuccess(item);
          return new Response(
            req.method === "HEAD" ? null : Buffer.from(result.body, "base64"),
            {
              headers: {
                "Content-Type": mime,
                "Content-Disposition": mime.startsWith("image/") || isPage
                  ? "inline"
                  : "attachment",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": isPage
                  ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
                  : "default-src 'none'",
                "Cache-Control": "no-cache",
              },
            },
          );
        } catch (e) {
          if (isHostFailure(e)) this.revokeHost(item, e);
          return new Response("asset unavailable", {
            status:
              safeCode(e) === "EXTENSION_ASSET_NOT_FOUND"
                ? 404
                : safeCode(e) === "EXTENSION_ASSET_DENIED"
                  ? 403
                  : safeCode(e) === "EXTENSION_ASSET_TOO_LARGE"
                    ? 413
                    : 502,
          });
        }
      }
      if (item.source === "external" && item.host) {
        if (!item.manifest.routes?.includes(url.pathname)) return null;
        const grants = item.routeGrants ?? { timeoutMs: this.options.routeTimeoutMs ?? 2_000, maxBodyBytes: 256 * 1024, binary: false, frameMaxBytes: 1024 * 1024 };
        if (
          !grants.binary &&
          !["GET", "HEAD"].includes(req.method) &&
          !(req.headers.get("content-type") || "")
            .toLowerCase()
            .startsWith("application/json")
        )
          return new Response("JSON required", { status: 415 });
        const declaredHeader = req.headers.get("content-length");
        if (declaredHeader !== null && !/^\d+$/.test(declaredHeader))
          return new Response("invalid content-length", { status: 400 });
        if (declaredHeader !== null && Number(declaredHeader) > grants.maxBodyBytes)
          return new Response("request too large", { status: 413 });
        const bytes = Buffer.from(await req.arrayBuffer());
        if (bytes.length > grants.maxBodyBytes)
          return new Response("request too large", { status: 413 });
        try {
          const result = await item.host.request(
            "route",
            {
              method: req.method,
              url: url.toString(),
              headers: Object.fromEntries(
                [...req.headers].filter(([k]) =>
                  ["accept", "content-type"].includes(k.toLowerCase()),
                ),
              ),
              body: bytes.toString("base64"),
              timeoutMs: grants.timeoutMs,
              maxResponseBytes: grants.maxBodyBytes,
            },
            grants.timeoutMs,
          );
          if (!result.handled) {
            this.hostSuccess(item);
            return null;
          }
          const status = Number(result.status);
          if (!Number.isInteger(status) || status < 100 || status > 599)
            throw Object.assign(new Error(), {
              code: "EXTENSION_RESPONSE_STATUS_DENIED",
            });
          const contentType = String(
            result.headers?.["content-type"] || "application/json",
          ).toLowerCase().split(";", 1)[0].trim();
          if (
            !grants.binary &&
            ![204, 205, 304].includes(status) &&
            !contentType.startsWith("application/json")
          )
            throw Object.assign(new Error(), {
              code: "EXTENSION_RESPONSE_TYPE_DENIED",
            });
          const body = [204, 205, 304].includes(status)
            ? null
            : Buffer.from(result.body || "", "base64");
          this.hostSuccess(item);
          // binary 授权：content-type 透传（已剥参数），页面型仍 inline、其余 attachment 防同源脚本注入；未授权维持 JSON-only
          const passthrough = grants.binary && !contentType.startsWith("application/json");
          const inline = contentType.startsWith("image/") || contentType === "application/json" || contentType === "application/pdf";
          return new Response(body, {
            status,
            headers: {
              ...(body
                ? { "Content-Type": passthrough ? contentType : "application/json; charset=utf-8" }
                : {}),
              ...(body && passthrough ? { "Content-Disposition": inline ? "inline" : "attachment" } : {}),
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            },
          });
        } catch (e) {
          if (isHostFailure(e)) this.revokeHost(item, e);
          return new Response(
            JSON.stringify({ ok: false, code: safeCode(e) }),
            {
              status: safeCode(e).includes("TIMEOUT") ? 504 : 502,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
      if (!item.module.route) continue;
      // Builtin legacy endpoints predate the extension breaker contract. Some of
      // them acknowledge an external side effect (hooks and task dispatch), so
      // timing out here would report failure while the operation keeps running
      // and invite a duplicate retry. Keep the deadline/breaker on the formal
      // namespaced API only.
      if (
        legacy ||
        (item.source === "builtin" && !["GET", "HEAD"].includes(req.method))
      ) {
        try {
          return await item.module.route({
            request: req,
            url,
            signal: new AbortController().signal,
          });
        } catch {
          return new Response(
            JSON.stringify({ ok: false, code: "VERTICAL_LEGACY_ROUTE_ERROR" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      const abort = new AbortController(),
        timeoutMs = this.options.routeTimeoutMs ?? 2_000;
      try {
        const response = await deadline(
          item.module.route({ request: req, url, signal: abort.signal }),
          timeoutMs,
          "VERTICAL_ROUTE_TIMEOUT",
        );
        if (response) {
          item.status.consecutiveFailures = 0;
          item.status.state = "ready";
          item.status.lastSuccessAt = new Date().toISOString();
          return response;
        }
      } catch (e) {
        abort.abort();
        this.fail(item, e);
        return new Response(
          JSON.stringify({ ok: false, code: item.status.errorCode }),
          {
            status:
              item.status.errorCode === "VERTICAL_ROUTE_TIMEOUT" ? 504 : 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }
    return null;
  }
  async health(): Promise<
    Array<VerticalStatus & { report?: Record<string, unknown> }>
  > {
    return Promise.all(
      [...this.loaded.values()].map(async (item) => {
        if (
          (!item.module?.health && !item.host && !item.scheduler) ||
          !["ready", "degraded"].includes(item.status.state)
        )
          return { ...item.status };
        try {
          const moduleReport = item.host
            ? await item.host.request(
                "health",
                {},
                this.options.healthTimeoutMs ?? 1_000,
                false,
              )
            : item.module?.health
              ? await deadline(
                  item.module.health(),
                  this.options.healthTimeoutMs ?? 1_000,
                  "VERTICAL_HEALTH_TIMEOUT",
                )
              : { ok: true };
          const scheduler = item.scheduler?.health(),
            host = item.host?.diagnostics();
          const report = {
            ...moduleReport,
            ...(scheduler
              ? { ok: moduleReport.ok !== false && scheduler.ok, scheduler }
              : {}),
            ...(host && Object.keys(host).length ? { host } : {}),
          };
          return { ...item.status, report };
        } catch {
          return {
            ...item.status,
            report: {
              ok: false,
              code: "EXTENSION_HEALTH_UNAVAILABLE",
              ...(item.scheduler ? { scheduler: item.scheduler.health() } : {}),
              ...(item.host && Object.keys(item.host.diagnostics()).length
                ? { host: item.host.diagnostics() }
                : {}),
            },
          };
        }
      }),
    );
  }
  statuses(): VerticalStatus[] {
    return [...this.loaded.values()].map((x) => ({ ...x.status }));
  }
  /** 外部 Vertical 热重载：杀 host 进程重拉即重新 import 磁盘代码（开发循环用，改完秒级生效）。
   *  先重读并校验 manifest/lint/entry 再拆旧实例——新代码坏了就报错返回，正在跑的旧实例不受影响。
   *  内置 Vertical 拒绝：它在 daemon 进程内，import 缓存刷不掉，改内置代码请重启 daemon。 */
  async reload(id: string): Promise<VerticalStatus> {
    const item = this.loaded.get(id);
    if (!item)
      throw new ExtensionPolicyError("VERTICAL_NOT_FOUND", `未知 vertical: ${id}`);
    if (item.source !== "external" || !item.root)
      throw new ExtensionPolicyError(
        "VERTICAL_RELOAD_UNSUPPORTED",
        "只有外部 Vertical 支持热重载；内置模块请重启 daemon",
      );
    const manifest = parseVerticalManifest(
      JSON.parse(readFileSync(join(item.root, "ownward.vertical.json"), "utf8")),
    );
    if (manifest.id !== id)
      throw new ExtensionPolicyError("VERTICAL_ID_MISMATCH", "重载不允许更换 vertical id");
    validateExtensionImports(item.root, (warning) => this.audit("vertical-discovery-warning", id, "reload", warning));
    const entry = resolve(item.root, manifest.entry),
      rel = relative(item.root, entry);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(entry))
      throw new ExtensionPolicyError("VERTICAL_ENTRY_DENIED", "entry 不存在或越界");
    if (item.startingPromise) await item.startingPromise.catch(() => {});
    item.status.state = "stopping";
    item.lifecycle?.revoke();
    item.scheduler?.stop();
    item.scheduler = undefined;
    // host.stop() 先置 stopped 旗标，不会触发崩溃自动重启回调
    try { if (item.host) await item.host.stop(); } catch { item.host?.kill(); }
    item.host = undefined;
    item.manifest = manifest;
    Object.assign(item.status, { name: manifest.name, version: manifest.version, state: "discovered", errorCode: undefined, consecutiveFailures: 0 });
    item.crashCount = 0;
    item.nextRestartAt = 0;
    this.audit("vertical-reload", id, "reload", "manual reload initiated");
    await this.startOne(item);
    return { ...item.status };
  }
  manifests(): VerticalManifest[] {
    return [...this.loaded.values()]
      .filter((x) => x.status.state !== "failed")
      .map((x) => structuredClone(x.manifest));
  }
  async stop(): Promise<void> {
    // 先清掉所有待重启定时器：崩溃项(host/module 都空)会被下面的循环 continue 跳过，必须单独清，
    // 否则 unref 的定时器会在后续测试/运行里 startOne 造成串扰
    for (const item of this.loaded.values())
      if (item.restartTimer) { clearTimeout(item.restartTimer); item.restartTimer = undefined; }
    for (const item of [...this.loaded.values()].reverse()) {
      if (!item.module && !item.host) continue;
      item.status.state = "stopping";
      item.lifecycle?.revoke();
      item.scheduler?.stop();
      try {
        if (item.host) {
          await item.host.stop();
          item.host = undefined;
        } else if (item.module?.deactivate)
          await deadline(
            item.module.deactivate(),
            this.options.activateTimeoutMs ?? 5_000,
            "VERTICAL_DEACTIVATE_TIMEOUT",
          );
        item.status.state = "disabled";
        emitCoreLog({
          event: "vertical-stopped",
          moduleType: "vertical",
          moduleId: item.manifest.id,
          operation: "stop",
          msg: "vertical stopped",
        });
      } catch (e) {
        this.fail(item, e, true);
      }
    }
    this.started = false;
  }
}
function safeCode(error: unknown): string {
  const code = String((error as any)?.code || "EXTENSION_ERROR");
  return /^EXTENSION_[A-Z0-9_]{1,64}$/.test(code) ? code : "EXTENSION_ERROR";
}
function unavailable(item: Loaded): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      code: item.status.errorCode || "EXTENSION_HOST_STARTING",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(
          Math.max(
            1,
            Math.ceil(
              ((item.nextRestartAt ?? Date.now() + 1000) - Date.now()) / 1000,
            ),
          ),
        ),
      },
    },
  );
}
function isHostFailure(error: unknown): boolean {
  return new Set([
    "EXTENSION_HOST_UNAVAILABLE",
    "EXTENSION_HOST_TIMEOUT",
    "EXTENSION_HOST_EXITED",
    "EXTENSION_HOST_DISCONNECTED",
    "EXTENSION_HOST_PROTOCOL_INVALID",
    "EXTENSION_HOST_SOCKET_INVALID",
    "EXTENSION_HOST_START_TIMEOUT",
    "EXTENSION_HOST_BACKPRESSURE",
    "EXTENSION_HOST_WRITE_FAILED",
  ]).has(safeCode(error));
}
// 页面资产（html/css/js）：受信外部 Vertical 的前端本体。inline 渲染 + 收紧 CSP（同源+内联，禁外联）；
// 其余可执行/可嵌入类型（svg/xml/pdf…）仍降级 octet-stream + attachment，不给同源执行面。
const PAGE_ASSET_MIMES = new Set(["text/html", "text/css", "text/javascript"]);
function safeAssetMime(value: unknown): string {
  const mime = String(value || "application/octet-stream")
    .toLowerCase()
    .split(";", 1)[0]
    .trim();
  if (PAGE_ASSET_MIMES.has(mime)) return `${mime}; charset=utf-8`;
  return [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "text/plain",
    "application/octet-stream",
  ].includes(mime)
    ? mime
    : "application/octet-stream";
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as any)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
