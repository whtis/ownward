// Vertical Runtime compatibility facade. Core server/daemon only depend on this stable seam.
import { isWithin } from "./path-within.ts";
import { cfg, DATA, expandHome, fmt, log } from "./util.ts";
import { DecisionEngine, decisionEngineStatuses, runDecision } from "./kernel/decisions/service.ts";
import { ExtensionRuntime, type BuiltinVertical } from "./kernel/extensions/runtime.ts";
import { KernelSessionService } from "./kernel/sessions/service.ts";
import { parseSessionMigrationMode } from "./kernel/sessions/contracts.ts";
import type { ScopedActions, ScopedLlm, ScopedSessions, ScopedSources, VerticalManifest, VerticalStatus } from "./kernel/extensions/contracts.ts";
import type { ScopedTasks } from "./kernel/extensions/contracts.ts";
import { addTask, applyEvolve, loadTasks, removeTask, startEvolve, startWork, updateTask } from "./dispatch.ts";
import { listActions, openAction, resolveActionExact, setActionState } from "./actions.ts";
import { createScopedActions } from "./kernel/extensions/action-scope.ts";
import { resolve } from "path";
import { realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ccIdFromTranscript } from "./cc-sessions.ts";
import { findTerminalCcSession } from "./terminal-tasks.ts";
import { createDevDomainHandler } from "./dev/domain-handler.ts";
import { adoptedSessionFor, createNewSessionService } from "./session-service.ts";
import { consumeTerminalAdoptLaunch } from "./kernel/sessions/terminal-adopt.ts";
import { DEV_DOMAIN_ROUTES, manifest as devManifest } from "./verticals/dev.ts";
import { ccSessionPath } from "./cc-sessions.ts";
import { devSessionCandidates, type ConsumedCandidate } from "./kernel/sessions/dev-candidates.ts";
export { isDevDomainRoute } from "./verticals/dev.ts";
import { manifest as strategyManifest } from "./verticals/strategy.ts";
import { strategyVerticalConfig } from "./verticals/strategy.ts";
import { LarkDocumentSources } from "./kernel/sources/lark-documents.ts";

// expandHome 展开 ~：manifest.roots 要求绝对路径（parseVerticalManifest 校验 isAbsolute），
// scopedTasks.grant 也用 expandHome。不展开的话，config 里一个 "~/workspace" 就会让整个 dev builtin
// 在发现阶段抛 VERTICAL_MANIFEST_INVALID，任务/PR/evolve 页全挂——而错误提示恰恰叫用户往这里加目录。
const allowedRoots = Array.isArray(cfg.architecture?.allowedRoots) ? cfg.architecture.allowedRoots.filter((x: unknown): x is string => typeof x === "string").map((r) => expandHome(r)) : [];
export function devVerticalManifest(roots:string[]):typeof devManifest{return roots.length ? { ...devManifest, roots } : { ...devManifest, roots: [], capabilities: ["actions"], routes: [], commands: [], navigation: devManifest.navigation };}
export function devLegacyRoutes(roots:string[]):string[]{return DEV_DOMAIN_ROUTES.filter((route)=>roots.length || route!=="/api/work");}
const configuredDevManifest = devVerticalManifest(allowedRoots);
/** 接管一个已核销的候选会话。独立导出是为了可测——「接管幂等」是这里唯一的核心不变式，
 *  而它只有跑一遍真实的建卡 + bind 才能证明。 */
export async function adoptSessionCandidate(candidate: ConsumedCandidate) {
    const providerId = candidate.provider === "codex" ? "codex" : "claude";
    // 接管幂等：同一个原生会话已经有卡片就复用它。否则每按一次「接管续聊」都 mint 一张新卡，
    // 而 bind() 只把新 taskId 追加进同一条 Session——界面上多张卡点进去是同一个对话
    // （2026-08-24 实撞：一条 Session 挂了三个 taskId）。adopt 仍照跑，取回输入权。
    const bound = adoptedSessionFor(providerId, candidate.nativeId);
    const reused = bound ? loadTasks().find((t) => t.id === bound.id || bound.taskIds.includes(t.id)) ?? null : null;
    const id = reused?.id ?? `${fmt(new Date(), "date").replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
    const mode = candidate.provider === "codex" ? "codex-bg" : "claude-bg";
    // 接管不是一次运行，没有退出码可言：硬写 exitCode:0 会让卡片伪装成「成功」，
    // 后来真跑一轮失败又被改写成「失败 1」，状态全是假的。用 kind=adopted + done 表达。
    const task = reused ?? { id, project: candidate.project, projectDir: candidate.cwd, cwd: candidate.cwd, task: `接管 ${candidate.provider}：${candidate.title.slice(0, 80)}`, mode, kind: "adopted", engine: true, startedAt: new Date().toISOString(), status: "done", harvested: true } as any;
    if (!reused) await addTask(task);
    try {
      if (candidate.provider === "codex") {
        const providerHomePath = candidate.home === "codex" ? join(homedir(), ".codex") : candidate.home === "codex-alt" ? join(homedir(), ".codex-alt") : "";
        if (!providerHomePath) throw Object.assign(new Error("Codex Provider home 不受支持"), { code: "DEV_SESSION_PROVIDER_HOME_INVALID" });
        await createNewSessionService([candidate.cwd, providerHomePath]).adopt({ taskId: id, providerId: "codex", nativeRef: candidate.nativeId, providerHome: candidate.home, cwd: candidate.cwd, control: "ownward" }, { roots: [candidate.cwd, providerHomePath], access: "workspace" });
      } else {
        await createNewSessionService([candidate.cwd]).adopt({ taskId: id, providerId: "claude", nativeRef: candidate.nativeId, cwd: candidate.cwd, control: "ownward" }, { roots: [candidate.cwd], access: "workspace" });
      }
    } catch (error) { if (!reused) await removeTask(id); throw error; }
    return task;
}

export function createBuiltinDevDomain(context: import("./kernel/extensions/contracts.ts").VerticalContext) {
  return createDevDomainHandler(context, {
    taskById: (id) => loadTasks().find((task) => task.id === id) ?? null,
    addTask,
    removeTask,
    updateTask: (id, patch) => { updateTask(id, patch as any); },
    adoptCandidate: (token) => adoptSessionCandidate(devSessionCandidates.consume(token)),
    startEvolve: async (requirement) => { context.log("evolve-start", "owner requested self-evolution"); return startEvolve(requirement); },
    applyEvolve: async (id) => { context.log("evolve-apply", `owner approval endpoint invoked for ${id}`); return applyEvolve(id); },
    async adoptTerminalLaunch(input) {
      const consumed = await consumeTerminalAdoptLaunch(DATA, { ...input, providerId: "claude" }, async () => {
        if (!context.sessions) throw Object.assign(new Error("Dev Session capability 不可用"), { code: "SESSION_ADOPT_FAILED" });
        return await context.sessions.adopt({ taskId: input.taskId, providerId: "claude", nativeRef: input.nativeRef, cwd: input.cwd, control: "external" }) as { id: string };
      });
      return consumed.session as { id: string };
    },
  }, {
    verifyClaudeTranscript({ transcriptPath, nativeRef }) {
      const ccId = ccIdFromTranscript(transcriptPath);
      return !!ccId && ccId.split("/").pop() === nativeRef;
    },
    async findTerminalSession(task) {
      const session = await findTerminalCcSession(task as any);
      return session ? Object.freeze({ id: devSessionCandidates.issueClaude(session, ccSessionPath(session.id)), kind: "claude" as const, project: session.project, title: session.title, active: session.active }) : null;
    },
  });
}
const builtins: BuiltinVertical[] = [
  { manifest: configuredDevManifest, legacyRoutes: devLegacyRoutes(allowedRoots), load: async () => { const [vertical, adapter] = await Promise.all([import("./verticals/dev.ts"), import("./verticals/dev-domain-adapter.ts")]); return vertical.createDevVertical({ domain: adapter.createDevDomainAdapter(createBuiltinDevDomain), manifest: configuredDevManifest }); } },
  { manifest: strategyManifest, legacyRoutes: ["/strategy", "/api/strategy"], load: async () => { const [vertical, adapter] = await Promise.all([import("./verticals/strategy.ts"), import("./verticals/strategy-domain-adapter.ts")]); return vertical.createStrategyVertical({ domain: adapter.createStrategyDomainAdapter() }); } },
];
export function scopedSessions(roots: string[]): ScopedSessions {
  const mode = parseSessionMigrationMode(cfg.architecture?.sessionRunnerMode);
  const taskIds = Array.isArray(cfg.architecture?.sessionRunnerTaskIds) ? cfg.architecture.sessionRunnerTaskIds : [];
  const service = new KernelSessionService(DATA, { mode, roots, taskIds });
  const grants = { roots, access: "workspace" as const };
  return Object.freeze({
    create: (input) => service.create(input, grants),
    adopt: (input) => service.adopt(input, grants),
    send: service.send.bind(service),
    state: service.state.bind(service),
    interrupt: service.interrupt.bind(service),
  });
}
export function scopedActions(verticalId: string): ScopedActions {
  // dev 只旁观 github 来源；open/dismiss 的属主 source 恒为 vertical 自己的 id（防伪造他源）
  return createScopedActions(verticalId === "dev" ? ["github"] : [verticalId], {
    list: () => listActions(true),
    open: (action) => { openAction(action); },
    resolveExact: resolveActionExact,
    setState: (id, state) => setActionState(id, state),
  }, verticalId);
}
/** Decision Model Service 的 Vertical 门面:引擎链与命令来自 config，Vertical 只管给 prompt。
 *  cfg.llm.engines 可改序（如 ["codebuddy","claude"]）；未配置时按 codex→codebuddy→claude 依次降级。 */
export function scopedLlm(verticalId: string): ScopedLlm {
  // cfg.llm.engines 语义按「原始配置」判定，不看过滤结果：
  //  - 未配置(undefined) → 走默认链 codex→codebuddy→claude
  //  - 显式配成 [] → 有意禁用全部
  //  - 配了名字但全是无效名（多半是 typo，如 "gpt5"/"Codex"）→ 回退默认链，绝不静默全禁
  const rawEngines = cfg.llm?.engines;
  let engines: DecisionEngine[] | undefined;
  if (Array.isArray(rawEngines)) {
    const valid = (rawEngines as unknown[]).filter((e): e is DecisionEngine => ["codex", "codebuddy", "claude"].includes(e as string));
    const dropped = (rawEngines as unknown[]).filter((e) => !["codex", "codebuddy", "claude"].includes(e as string));
    if (dropped.length) log(`[verticals] 忽略 cfg.llm.engines 中的无效引擎名: ${dropped.map((e) => String(e)).join(", ")}`);
    engines = rawEngines.length === 0 ? [] : (valid.length ? valid : undefined);
  }
  // 模型白名单:cfg.llm.models 优先;没配就退回 chat 那份供应商模型表(同一台机器上能用的模型是同一批,
  // 让 Vertical 的模型选择与 chat 保持一致，不必两处维护。
  const chatModels = (cfg.chat?.providers ?? {}) as Record<string, string[]>;
  const modelChoices = {
    codex: (cfg.llm?.models?.codex ?? chatModels.codex ?? []) as string[],
    codebuddy: (cfg.llm?.models?.codebuddy ?? chatModels.codebuddy ?? []) as string[],
    claude: (cfg.llm?.models?.claude ?? chatModels.claude ?? []) as string[],
  };
  const providerCommand = (id: "claude-code" | "codex" | "codebuddy", legacy: unknown, fallback: string) => {
    const command = cfg.providers?.[id]?.command;
    if (Array.isArray(command) && command.length && command.every((part: unknown) => typeof part === "string" && !!part.trim())) return command as string[];
    return typeof legacy === "string" && legacy.trim() ? legacy : fallback;
  };
  const opts = () => ({
    engines,
    bins: {
      codex: providerCommand("codex", cfg.llm?.codexBin, "codex"),
      codebuddy: providerCommand("codebuddy", cfg.llm?.codebuddyBin, "codebuddy"),
      claude: providerCommand("claude-code", cfg.llm?.claudeBin, "claude"),
    },
    models: { codex: cfg.llm?.codexModel, codebuddy: cfg.llm?.codebuddyModel, claude: cfg.llm?.claudeModel },
    modelChoices,
  });
  return Object.freeze({
    complete: (input) => runDecision(input, verticalId, opts()),
    engines: async () => decisionEngineStatuses(opts()),
  });
}
export function scopedSources(_verticalId: string): ScopedSources {
  return Object.freeze(new LarkDocumentSources());
}

export function scopedTasks(roots: string[], capabilities: readonly string[]=[]): ScopedTasks {
  const allowed = [...new Set(roots.flatMap((r) => { try { const actual=realpathSync(resolve(expandHome(r)));if(!statSync(actual).isDirectory())throw new Error();return[actual]; } catch { log("dev task root skipped: invalid configured directory");return[]; } }))];
  const unavailable = () => Object.assign(new Error("VERTICAL_ROOT_UNAVAILABLE: 没有可用的任务目录"), { code: "VERTICAL_ROOT_UNAVAILABLE" });
  const notGranted = () => Object.assign(new Error("项目目录未授权。请在 config.json 的 architecture.allowedRoots 中加入该目录，然后运行 bash install.sh"), { code: "VERTICAL_CWD_NOT_GRANTED" });
  const grant = (raw: string) => { if(!allowed.length)throw unavailable();try { const actual=realpathSync(resolve(expandHome(raw.trim()))); if(!statSync(actual).isDirectory()||!allowed.some((r) => isWithin(r, actual))) throw notGranted(); return actual; } catch(error:any) { if(error?.code==="VERTICAL_CWD_NOT_GRANTED")throw error; throw notGranted(); } };
  return Object.freeze({
    async startWork(input) {
      input={...input,...(["model","effort","permission"] as const).reduce((out,key)=>({...out,[key]:typeof input[key]==="string"&&input[key]!.trim()===""?undefined:typeof input[key]==="string"?input[key]!.trim():input[key]}),{})};
      const keys=["dir","task","bg","codex","provider","worktree","model","effort","permission","extraDirs","images"], imageOk=(image:unknown)=>!!image&&typeof image==="object"&&!Array.isArray(image)&&Object.keys(image).every((key)=>["media_type","data"].includes(key))&&typeof (image as any).media_type==="string"&&typeof (image as any).data==="string";
      if (!input || typeof input!=="object"||Object.keys(input).some((k)=>!keys.includes(k))||typeof input.dir !== "string" || typeof input.task !== "string" || !input.task.trim()||input.task.length>100_000||["bg","codex","worktree"].some((key)=>(input as any)[key]!==undefined&&typeof (input as any)[key]!=="boolean")||["model","effort"].some((key)=>(input as any)[key]!==undefined&&typeof (input as any)[key]!=="string")||(input.images!==undefined&&(!Array.isArray(input.images)||!input.images.every(imageOk)))) throw new Error("VERTICAL_TASK_INPUT_INVALID");
      if (input.permission !== undefined && !["safe","bypass"].includes(input.permission)) throw new Error("VERTICAL_TASK_INPUT_INVALID");if(input.provider!==undefined&&!["claude","codex","codebuddy"].includes(input.provider))throw new Error("VERTICAL_TASK_INPUT_INVALID");if(input.permission==="bypass"&&(!capabilities.includes("tasks:full-access")||cfg.architecture?.allowFullAccess!==true))throw Object.assign(new Error("SESSION_ACCESS_NOT_GRANTED: Vertical capability 与 architecture.allowFullAccess 必须同时授权"),{code:"SESSION_ACCESS_NOT_GRANTED"}); if(input.extraDirs!==undefined&&(!Array.isArray(input.extraDirs)||input.extraDirs.some((x)=>typeof x!=="string")))throw new Error("VERTICAL_TASK_INPUT_INVALID");
      if (input.bg === false && input.extraDirs?.length) throw new Error("VERTICAL_TASK_INPUT_INVALID: terminal 模式不支持附加目录");
      const dir = grant(input.dir), extraDirs = canonicalTaskExtraDirs(input.extraDirs, dir, grant);
      return startWork(dir, input.task, { bg: input.bg, codex: input.codex, provider: input.provider, worktree: input.worktree, model: input.model, effort: input.effort, permission: input.permission??"safe", extraDirs, images: input.images });
    },
    list: () => structuredClone(loadTasks().filter((task) => {
      try { grant(task.cwd); return true; } catch { return false; }
    })),
  });
}
export function canonicalTaskExtraDirs(input: string[] | undefined, primary: string, grant: (dir: string) => string): string[] | undefined {
  if (!input) return undefined;
  const dirs = [...new Set(input.map(grant))].filter((candidate) => candidate !== primary);
  if (dirs.length > 32) throw new Error("VERTICAL_TASK_INPUT_INVALID: 附加目录最多 32 个");
  return dirs;
}
export const verticalRuntime = new ExtensionRuntime({
  dataRoot: DATA, config: { ...cfg, verticals: { ...cfg.verticals, strategy: strategyVerticalConfig(cfg.strategy, cfg.verticals?.strategy, cfg.timezone) } }, builtins,
  externalPaths: Array.isArray(cfg.verticals?.externalPaths) ? cfg.verticals.externalPaths : [],
  sessionFactory: scopedSessions, taskFactory: scopedTasks, actionFactory: scopedActions, llmFactory: scopedLlm, sourceFactory: scopedSources, log,
});
let startPromise: Promise<void> | null = null;
export function startVerticals(): Promise<void> { if (!startPromise) { const attempt = verticalRuntime.start(); const guarded = attempt.catch((error) => { log(`verticals start unavailable: ${error instanceof Error ? error.name : "unknown"}`); if (startPromise === guarded) startPromise = null; }); startPromise = guarded; } return startPromise; }
export async function stopVerticals():Promise<void>{await verticalRuntime.stop();startPromise=null;}
export async function routeVerticals(req: Request, url: URL): Promise<Response | null> { await startVerticals(); try { return await verticalRuntime.route(req, url); } catch (error) { log(`vertical route unavailable: ${error instanceof Error ? error.name : "unknown"}`); return null; } }
export function verticalStatuses() { return verticalRuntime.statuses(); }
export async function reloadVertical(id: string) { await startVerticals(); return verticalRuntime.reload(id); }
export function verticalManifests() { return verticalRuntime.manifests(); }
export interface ExternalVerticalNavigationItem {
  verticalId: string;
  id: string;
  label: string;
  href: string;
  state: "ready" | "degraded";
}
/** manifest navigation 是外部输入。只投影可服务的 external Vertical，且 href 必须仍在自己的静态资产命名空间内。 */
export function projectExternalVerticalNavigation(
  statuses: readonly VerticalStatus[],
  manifests: readonly VerticalManifest[],
): ExternalVerticalNavigationItem[] {
  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest] as const));
  const seenVerticals = new Set<string>(), seenEntries = new Set<string>(), seenHrefs = new Set<string>();
  const result: ExternalVerticalNavigationItem[] = [];
  for (const status of statuses) {
    if (status.source !== "external" || !["ready", "degraded"].includes(status.state) || seenVerticals.has(status.id)) continue;
    seenVerticals.add(status.id);
    const manifest = manifestById.get(status.id);
    if (!manifest || manifest.id !== status.id || !/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id)) continue;
    for (const entry of manifest.navigation ?? []) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      const href = safeExternalVerticalHref(manifest.id, entry?.href);
      const entryKey = `${manifest.id}:${id}`;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label) || !href || seenEntries.has(entryKey) || seenHrefs.has(href)) continue;
      seenEntries.add(entryKey); seenHrefs.add(href);
      result.push({ verticalId: manifest.id, id, label, href, state: status.state as "ready" | "degraded" });
    }
  }
  return result;
}
function safeExternalVerticalHref(verticalId: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || value.includes("%") || value.includes("\\") || /[?#\u0000-\u001f\u007f]/.test(value)) return null;
  const prefix = `/verticals/${verticalId}/`;
  if (!value.startsWith(prefix)) return null;
  const suffix = value.slice(prefix.length);
  if (!suffix || !/^[A-Za-z0-9._~/-]+$/.test(suffix) || suffix.split("/").some((part) => !part || part === "." || part === "..")) return null;
  try {
    const parsed = new URL(value, "http://ownward.invalid");
    return parsed.origin === "http://ownward.invalid" && parsed.pathname === value && !parsed.search && !parsed.hash ? value : null;
  } catch { return null; }
}
export async function verticalDiagnostics() {
  await startVerticals();
  let health: Awaited<ReturnType<typeof verticalRuntime.health>> = [];
  try { health = await verticalRuntime.health(); }
  catch (error) { log(`vertical diagnostics unavailable: ${error instanceof Error ? error.name : "unknown"}`); }
  const verticals = verticalStatuses(), manifests = verticalManifests();
  return {
    trust: { model: "local-code", untrustedUnsupported: true, isolation: "process-and-kernel-api-contract-not-os-sandbox", importLint: "compatibility-only-not-a-security-boundary" },
    verticals,
    manifests,
    health,
    navigation: projectExternalVerticalNavigation(verticals, manifests),
  };
}
