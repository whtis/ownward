import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { listActions, openAction, resolveAction } from "../actions.ts";
import { isPrIgnored } from "../github-pr.ts";

export function githubActionId(threadId: unknown, _observation?: unknown): string { return `gh:${String(threadId)}`; }
export function githubActionThreadId(actionId: string): string { return actionId.slice(3).split(":",1)[0]!; }
export function githubShouldRevive(state:string|undefined):boolean{return state==="resolved";}
export function githubActionShouldRevive(actions: readonly { id: string; state: string }[], id: string): boolean { return githubShouldRevive(actions.find((action) => action.id === id)?.state); }
import { previewText, touchChat } from "../lark-state.ts";
import type { OwnwardEvent } from "../spool.ts";
import { DATA, log } from "../util.ts";
type ConsumerState = "processing" | "done" | "failed" | "terminal";
type Row = {
  id: string;
  key?: string;
  state: ConsumerState;
  at: string;
  attempts: number;
  owner?: string;
  leaseUntil?: string;
  nonIdempotent?: boolean;
};
type ProjectDeps = {
  handleLarkCard?: (payload: unknown) => Promise<void>;
  touchLark?: (chatId: string, update: any) => void;
  projectEvent?: (event: OwnwardEvent) => Promise<void> | void;
  onUncertain?: (id: string) => void;
  onRedactedCard?: (id: string) => void;
  onFailure?: (
    id: string,
    error: unknown,
    attempt: number,
    terminal: boolean,
  ) => void;
  onProjectionResolved?: (id: string) => void;
  onRecoveryFailure?: (source: string, error: unknown, attempt: number) => void;
  beforeRecoveryChunk?: (
    source: string,
    events: readonly OwnwardEvent[],
  ) => void;
  beforePersistInbox?: (event: OwnwardEvent) => void;
  onDirectoryFsync?: (path: string) => void;
  retryDelay?: (ms: number) => Promise<void>;
  now?: () => Date;
};
const LEASE_MS = 10 * 60_000,
  MAX_ATTEMPTS = 3,
  MAX_STATE_FILES = 20_000,
  STATE_RETENTION_MS = 7 * 24 * 60 * 60_000,
  STALE_TEMP_MS = 60 * 60_000,
  stateLocks = new Map<string, Promise<unknown>>(),
  cleanupScheduled = new Set<string>(),
  lastCleanup = new Map<string, number>();
export function domainStateLockCountForTest() {
  return stateLocks.size;
}
function eventKey(e: OwnwardEvent) {
  return (
    e.id ||
    `legacy:${e.source}:${e.key || "event"}:${String((e.payload as any)?.message_id || (e.payload as any)?.request_id || (e.payload as any)?.threadId || "")}`
  );
}
function hash(id: string) {
  return createHash("sha256").update(id).digest("hex");
}
function statePath(root: string, id: string) {
  return join(root, "connectors", "domain-consumer", `${hash(id)}.json`);
}
function inboxPath(root: string, id: string) {
  return join(root, "connectors", "domain-inbox", `${hash(id)}.json`);
}
function atomic(path: string, value: unknown, deps: ProjectDeps = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value) + "\n");
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = dirname(path),
    dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
    deps.onDirectoryFsync?.(dir);
  } finally {
    closeSync(dfd);
  }
}
function loadRow(root: string, id: string): Row | undefined {
  try {
    const row = JSON.parse(readFileSync(statePath(root, id), "utf8"));
    if (row.id === id) return row;
  } catch {}
  return undefined;
}
function saveRow(root: string, row: Row, deps: ProjectDeps) {
  atomic(statePath(root, row.id), row, deps);
}
function withState<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const work = (stateLocks.get(path) ?? Promise.resolve()).then(fn),
    tail = work.catch(() => {});
  stateLocks.set(path, tail);
  return work.finally(() => {
    if (stateLocks.get(path) === tail) stateLocks.delete(path);
  });
}
function migrateLegacy(root: string, deps: ProjectDeps) {
  const path = join(root, "connectors", "domain-consumer.json");
  if (!existsSync(path)) return;
  try {
    const rows = JSON.parse(readFileSync(path, "utf8"))?.rows ?? {};
    for (const [id, value] of Object.entries(rows)) {
      const target = statePath(root, id);
      if (!existsSync(target))
        saveRow(root, { ...(value as Omit<Row, "id">), id }, deps);
    }
    const archived = `${path}.migrated.${Date.now()}`;
    renameSync(path, archived);
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
      deps.onDirectoryFsync?.(dirname(path));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    log(
      `connector legacy state migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function nonIdempotent(e: OwnwardEvent) {
  return String(e.key || "").endsWith("card.action.trigger");
}
function recoveryLane(event: OwnwardEvent) {
  return `${event.source}:${nonIdempotent(event) ? "priority" : "normal"}`;
}
function durablePayload(value: any): any {
  if (Array.isArray(value)) return value.map(durablePayload);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /(?:token|secret|password|authorization|cookie|credential)/i.test(k)
          ? "[REDACTED]"
          : durablePayload(v),
      ]),
    );
  return value;
}
function containsPlaintextSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPlaintextSecret);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    /(?:token|secret|password|authorization|cookie|credential)/i.test(key)
      ? item !== undefined && item !== null && item !== "" && item !== "[REDACTED]"
      : containsPlaintextSecret(item),
  );
}
function quarantineLegacyInbox(root: string, path: string, reason: string) {
  const dir = join(root, "connectors", "domain-inbox-quarantine");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = join(dir, `${path.split("/").at(-1)}.${reason}.${Date.now()}`);
  renameSync(path, target);
  chmodSync(target, 0o600);
  for (const folder of [dirname(path), dir]) {
    const fd = openSync(folder, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
function persistInbox(
  root: string,
  events: readonly OwnwardEvent[],
  deps: ProjectDeps,
) {
  for (const event of events) {
    deps.beforePersistInbox?.(event);
    const id = eventKey(event),
      path = inboxPath(root, id);
    if (!existsSync(path))
      atomic(path, { ...event, payload: durablePayload(event.payload) }, deps);
  }
}
function ackInbox(root: string, events: readonly OwnwardEvent[]) {
  for (const event of events)
    try {
      unlinkSync(inboxPath(root, eventKey(event)));
    } catch {}
}
function uncertain(id: string) {
  openAction({
    id: `connector-consumer:${id}`,
    kind: "decide",
    source: "connector",
    title: "Connector 事件处理结果未知",
    reason: "领域副作用执行期间进程中断；为避免重复外部动作未自动重放",
    ref: {},
  });
}
export function projectionFailureNeedsAction(terminal:boolean){return terminal;}
function failed(
  id: string,
  error: unknown,
  attempt: number,
  terminal: boolean,
) {
  log(
    `connector projection ${terminal ? "terminal" : "retry"}: id=${id} attempt=${attempt} error=${error instanceof Error ? error.message : String(error)}`,
  );
  if (!projectionFailureNeedsAction(terminal)) return;
  openAction({
    id: `connector-projection:${id}`,
    kind: "decide",
    source: "connector",
    title: `Connector 事件投影${terminal ? "终止" : "失败"}`,
    reason: `${error instanceof Error ? error.message : String(error)}（${attempt}/${MAX_ATTEMPTS}）`,
    ref: {},
  });
}
function safeErrorCode(error: unknown) {
  const raw =
    error && typeof error === "object" && "code" in error
      ? String((error as any).code)
      : error instanceof Error
        ? error.name
        : "RECOVERY_FAILED";
  return /^[A-Z0-9_-]{1,80}$/.test(raw) ? raw : "RECOVERY_FAILED";
}
function recoveryFailed(source: string, error: unknown, attempt: number) {
  const code = safeErrorCode(error);
  log(
    `connector recovery retry: source=${source} attempt=${attempt} code=${code}`,
  );
  openAction({
    id: `connector-recovery:${source}`,
    kind: "decide",
    source: "connector",
    title: `Connector ${source} 恢复暂不可用`,
    reason: `持久恢复失败，正在自动重试（${code}）`,
    ref: {},
  });
}
function prRef(p: any) {
  const repo = p?.repo,
    m = String(p?.url || "").match(/\/pull\/(\d+)/);
  return repo && m ? { repo, number: Number(m[1]) } : null;
}
async function projectOne(event: OwnwardEvent, deps: ProjectDeps) {
  if (deps.projectEvent) {
    await deps.projectEvent(event);
    return;
  }
  const p = event.payload as any;
  if (nonIdempotent(event) && p?.token === "[REDACTED]") {
    const id = eventKey(event);
    if (deps.onRedactedCard) deps.onRedactedCard(id);
    else
      openAction({
        id: `connector-card-redacted:${id}`,
        kind: "decide",
        source: "connector",
        title: "Lark 卡片回调需要重新执行",
        reason: "历史 deferred 事件中的一次性 token 已被安全擦除，无法自动重放",
        ref: {},
      });
    throw Object.assign(new Error("redacted card token cannot be replayed"), {
      code: "LARK_CARD_TOKEN_REDACTED",
    });
  }
  if (event.source === "github") {
    if (event.key === "github.inbox.snapshot" || event.key === "snapshot") {
      const unread = new Set(
        Array.isArray(p?.unreadThreadIds) ? p.unreadThreadIds.map(String) : [],
      );
      for (const action of listActions(false))
        if (action.source === "github" && !unread.has(githubActionThreadId(action.id)))
          resolveAction(action.id, "reviewed");
      return;
    }
    if (p?.reason !== "review_requested" || !p?.threadId) return;
    const ref = prRef(p),
      id = githubActionId(p.threadId,p.observation);
    if (ref && isPrIgnored(ref.repo, ref.number)) {
      resolveAction(id, "ignored");
      return;
    }
    openAction({
      id,
      kind: "review",
      source: "github",
      title: `PR 等待 review：${String(p.title || "").slice(0, 40)}`,
      reason: `${p.repo || "GitHub"} 明确请求你 review`,
      ref: { url: p.url, task_id: undefined },
    }, { revive: githubActionShouldRevive(listActions(true), id) });
    return;
  }
  if (event.source !== "lark") return;
  if (nonIdempotent(event)) {
    const handle =
      deps.handleLarkCard ??
      ((v) =>
        import("../lark-cards.ts").then((m) => m.handleCardAction(v as any)));
    await handle(p);
    return;
  }
  if (event.key === "lark.inbox.daily" || event.key === "daily") {
    await (await import("./lark-policy.ts")).projectDailyLarkFacts(p);
    return;
  }
  if (p?.chat_id)
    (deps.touchLark ?? touchChat)(p.chat_id, {
      text: previewText(p.content),
      ts: p.create_time || p.timestamp,
      sender: p.sender_name || p.chat_partner?.name || "",
      incrementUnread: true,
      eventId: eventKey(event),
    });
}
async function projectEvents(
  events: readonly OwnwardEvent[],
  root: string,
  owner: string,
  deps: ProjectDeps,
) {
  const now = deps.now ?? (() => new Date()),
    delay =
      deps.retryDelay ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (const event of events) {
    const id = eventKey(event),
      path = statePath(root, id);
    let finished = false;
    while (!finished) {
      const begin = await withState(path, () => {
        const previous = loadRow(root, id),
          time = now();
        if (previous?.state === "done" || previous?.state === "terminal")
          return { kind: "skip" as const };
        if (previous?.state === "processing") {
          const abandoned =
            previous.owner !== owner ||
            Date.parse(previous.leaseUntil || previous.at) <= time.getTime();
          if (!abandoned) return { kind: "skip" as const };
          if (previous.nonIdempotent || nonIdempotent(event)) {
            saveRow(
              root,
              {
                ...previous,
                state: "terminal",
                at: time.toISOString(),
                nonIdempotent: true,
              },
              deps,
            );
            return { kind: "uncertain" as const };
          }
          if (previous.attempts >= MAX_ATTEMPTS) {
            saveRow(
              root,
              { ...previous, state: "terminal", at: time.toISOString() },
              deps,
            );
            return { kind: "exhausted" as const, attempt: previous.attempts };
          }
          const attempt = previous.attempts + 1;
          saveRow(
            root,
            {
              id,
              key: event.key,
              state: "processing",
              at: time.toISOString(),
              attempts: attempt,
              owner,
              leaseUntil: new Date(time.getTime() + LEASE_MS).toISOString(),
              nonIdempotent: false,
            },
            deps,
          );
          return { kind: "run" as const, attempt };
        }
        const attempt = (previous?.attempts ?? 0) + 1;
        if (attempt > MAX_ATTEMPTS) {
          saveRow(
            root,
            {
              id,
              key: event.key,
              state: "terminal",
              at: time.toISOString(),
              attempts: previous?.attempts ?? MAX_ATTEMPTS,
              nonIdempotent: nonIdempotent(event),
            },
            deps,
          );
          return {
            kind: "exhausted" as const,
            attempt: previous?.attempts ?? MAX_ATTEMPTS,
          };
        }
        saveRow(
          root,
          {
            id,
            key: event.key,
            state: "processing",
            at: time.toISOString(),
            attempts: attempt,
            owner,
            leaseUntil: new Date(time.getTime() + LEASE_MS).toISOString(),
            nonIdempotent: nonIdempotent(event),
          },
          deps,
        );
        return { kind: "run" as const, attempt };
      });
      if (begin.kind === "skip") {
        finished = true;
        continue;
      }
      if (begin.kind === "uncertain") {
        (deps.onUncertain ?? uncertain)(id);
        finished = true;
        continue;
      }
      if (begin.kind === "exhausted") {
        (deps.onFailure ?? failed)(
          id,
          new Error("projection retry budget exhausted"),
          begin.attempt,
          true,
        );
        finished = true;
        continue;
      }
      if (begin.attempt > 1)
        await delay(Math.min(2_000, 250 * 2 ** (begin.attempt - 2)));
      try {
        await projectOne(event, deps);
        await withState(path, () =>
          saveRow(
            root,
            {
              id,
              key: event.key,
              state: "done",
              at: now().toISOString(),
              attempts: begin.attempt,
              nonIdempotent: nonIdempotent(event),
            },
            deps,
          ),
        );
        if(deps.onProjectionResolved)deps.onProjectionResolved(id);else resolveAction(`connector-projection:${id}`, "recovered");
        finished = true;
      } catch (error) {
        const terminal = nonIdempotent(event) || begin.attempt >= MAX_ATTEMPTS;
        await withState(path, () =>
          saveRow(
            root,
            {
              id,
              key: event.key,
              state: terminal ? "terminal" : "failed",
              at: now().toISOString(),
              attempts: begin.attempt,
              nonIdempotent: nonIdempotent(event),
            },
            deps,
          ),
        );
        (deps.onFailure ?? failed)(id, error, begin.attempt, terminal);
        finished = terminal;
      }
    }
  }
}
function scheduleCleanup(root: string) {
  if (
    cleanupScheduled.has(root) ||
    Date.now() - (lastCleanup.get(root) ?? 0) < 60_000
  )
    return;
  lastCleanup.set(root, Date.now());
  cleanupScheduled.add(root);
  setTimeout(() => {
    cleanupScheduled.delete(root);
    const dir = join(root, "connectors", "domain-consumer"),
      inbox = join(root, "connectors", "domain-inbox"),
      connectors = join(root, "connectors"),
      now = Date.now();
    let connectorDirs: string[] = [];
    try {
      connectorDirs = readdirSync(connectors)
        .map((name) => join(connectors, name))
        .filter((path) => statSync(path).isDirectory());
    } catch {}
    for (const target of [connectors, dir, inbox, ...connectorDirs])
      try {
        for (const file of readdirSync(target).filter((f) =>
          f.endsWith(".tmp"),
        )) {
          const path = join(target, file);
          try {
            if (now - statSync(path).mtimeMs >= STALE_TEMP_MS) unlinkSync(path);
          } catch {}
        }
      } catch {}
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {}
    if (files.length <= MAX_STATE_FILES) return;
    const active = new Set<string>();
    try {
      for (const f of readdirSync(inbox).filter((f) => f.endsWith(".json")))
        active.add(f);
    } catch {}
    const candidates = files
      .filter((f) => !active.has(f))
      .flatMap((file) => {
        const path = join(dir, file);
        try {
          const stat = statSync(path);
          if (now - stat.mtimeMs < STATE_RETENTION_MS) return [];
          const row = JSON.parse(readFileSync(path, "utf8"));
          return row.state === "done" && !row.nonIdempotent
            ? [{ path, mtimeMs: stat.mtimeMs }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, files.length - MAX_STATE_FILES);
    for (const { path } of candidates)
      try {
        unlinkSync(path);
      } catch {}
  }, 0);
}
/** Single public path: durable inbox first, then priority/normal lanes with O(1) per-event state. */
export class ConnectorDomainDispatcher {
  private priorityTail = Promise.resolve();
  private normalTails = new Map<string, Promise<void>>();
  private recoveryGates = new Map<string, Promise<void>>();
  private recoveryScan?: Promise<void>;
  private recoveryState = new Map<
    string,
    { state: "retrying"; attempt: number; error: string; nextRetryAt: string }
  >();
  private recoveryGeneration = 0;
  private recoveryAbort?: AbortController;
  private readonly owner = `${process.pid}:${crypto.randomUUID()}`;
  constructor(
    private readonly dataRoot = DATA,
    private readonly deps: ProjectDeps = {},
  ) {
    migrateLegacy(dataRoot, deps);
  }
  private enqueue(
    events: readonly OwnwardEvent[],
    alreadyPersisted = false,
    awaitNormal = false,
  ): Promise<void> {
    if (!alreadyPersisted) persistInbox(this.dataRoot, events, this.deps);
    const priority = events.filter(nonIdempotent),
      normal = events.filter((e) => !nonIdempotent(e)),
      works: Promise<void>[] = [];
    if (normal.length) {
      const source = String(normal[0]!.source),
        previous = this.normalTails.get(source) ?? Promise.resolve(),
        work = previous
          .then(() =>
            projectEvents(normal, this.dataRoot, this.owner, this.deps),
          )
          .then(() => ackInbox(this.dataRoot, normal)),
        tail = work.catch((e) =>
          log(
            `connector dispatcher normal failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      this.normalTails.set(source, tail);
      void tail.finally(() => {
        if (this.normalTails.get(source) === tail)
          this.normalTails.delete(source);
      });
      if (awaitNormal) works.push(work);
    }
    if (priority.length) {
      const work = this.priorityTail
        .then(() =>
          projectEvents(priority, this.dataRoot, this.owner, this.deps),
        )
        .then(() => ackInbox(this.dataRoot, priority));
      this.priorityTail = work.catch((e) =>
        log(
          `connector dispatcher priority failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      works.push(work);
    }
    scheduleCleanup(this.dataRoot);
    return Promise.all(works).then(() => {});
  }
  dispatch(events: readonly OwnwardEvent[]): Promise<void> {
    // This is intentionally synchronous and precedes every recovery/gate await.
    // Once dispatch returns a Promise, a crash must still leave recoverable evidence.
    persistInbox(this.dataRoot, events, this.deps);
    const bySource = new Map<string, OwnwardEvent[]>();
    for (const event of events) {
      const lane = recoveryLane(event);
      const list = bySource.get(lane) ?? [];
      list.push(event);
      bySource.set(lane, list);
    }
    return Promise.all(
      [...bySource].map(async ([lane, batch]) => {
        await this.recoveryScan;
        const gate = this.recoveryGates.get(lane);
        if (gate && lane.endsWith(":priority")) {
          let timer: ReturnType<typeof setTimeout>;
          await Promise.race([
            gate,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    Object.assign(new Error("priority recovery lane busy"), {
                      code: "CONNECTOR_BACKPRESSURE",
                    }),
                  ),
                2_000,
              );
            }),
          ]).finally(() => clearTimeout(timer!));
        } else if (gate) await gate;
        await this.enqueue(batch, true);
      }),
    ).then(() => {});
  }
  private recoveredEvents() {
    const found = new Map<string, { event: OwnwardEvent; order: number }>(),
      accept = (event: any, order: number) => {
        if (
          typeof event?.source !== "string" ||
          typeof event?.id !== "string" ||
          !event.id.startsWith(`${event.source}:`)
        )
          return;
        const id = eventKey(event);
        if (!found.has(id)) found.set(id, { event, order });
      };
    let order = 0,
      processing: string[] = [];
    try {
      processing = readdirSync(this.dataRoot)
        .filter((f) => /^queue\.processing\..+\.jsonl$/.test(f))
        .sort()
        .map((f) => join(this.dataRoot, f));
    } catch {}
    for (const file of [...processing, join(this.dataRoot, "queue.jsonl")])
      try {
        for (const line of readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean))
          try {
            accept(JSON.parse(line), order++);
          } catch {}
      } catch {}
    const inbox = join(this.dataRoot, "connectors", "domain-inbox");
    try {
      for (const file of readdirSync(inbox)
        .filter((f) => f.endsWith(".json"))
        .sort())
        try {
          const path = join(inbox, file), event = JSON.parse(readFileSync(path, "utf8"));
          if (containsPlaintextSecret(event?.payload)) {
            quarantineLegacyInbox(this.dataRoot, path, "plaintext-secret");
            continue;
          }
          accept(event, order++);
        } catch {
          quarantineLegacyInbox(this.dataRoot, join(inbox, file), "invalid");
        }
    } catch {}
    return [...found.values()]
      .sort((a, b) => {
        const at = Date.parse(a.event.ts),
          bt = Date.parse(b.event.ts);
        return (
          at - bt ||
          a.order - b.order ||
          eventKey(a.event).localeCompare(eventKey(b.event))
        );
      })
      .map((x) => x.event);
  }
  startRecovery(): void {
    const generation = ++this.recoveryGeneration;
    this.recoveryAbort?.abort();
    const controller = new AbortController();
    this.recoveryAbort = controller;
    scheduleCleanup(this.dataRoot);
    const scan = Promise.resolve().then(async () => {
        await Bun.sleep(0);
        return this.recoveredEvents();
      }),
      delay = (ms: number) =>
        new Promise<void>((resolve) => {
          if (controller.signal.aborted) return resolve();
          const done = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", done);
              resolve();
            },
            timer = setTimeout(done, ms);
          controller.signal.addEventListener("abort", done, { once: true });
        });
    const install = scan.then((events) => {
      const groups = new Map<string, OwnwardEvent[]>();
      for (const event of events) {
        const lane = recoveryLane(event);
        const batch = groups.get(lane) ?? [];
        batch.push(event);
        groups.set(lane, batch);
      }
      for (const [lane, sourceEvents] of groups) {
        const source = String(sourceEvents[0]!.source);
        const gate = (async () => {
        const events = sourceEvents;
        for (
          let offset = 0;
          offset < events.length &&
          generation === this.recoveryGeneration &&
          !controller.signal.aborted;
          offset += 100
        ) {
          const chunk = events.slice(offset, offset + 100);
          let attempt = 0;
          while (
            generation === this.recoveryGeneration &&
            !controller.signal.aborted
          )
            try {
              this.deps.beforeRecoveryChunk?.(source, chunk);
              await this.enqueue(chunk, true, true);
              this.recoveryState.delete(source);
              resolveAction(`connector-recovery:${source}`, "recovered");
              break;
            } catch (error) {
              attempt++;
              (this.deps.onRecoveryFailure ?? recoveryFailed)(
                source,
                error,
                attempt,
              );
              const wait = Math.min(
                30_000,
                250 * 2 ** Math.min(attempt - 1, 7),
              );
              this.recoveryState.set(source, {
                state: "retrying",
                attempt,
                error: safeErrorCode(error),
                nextRetryAt: new Date(Date.now() + wait).toISOString(),
              });
              await (this.deps.retryDelay
                ? this.deps.retryDelay(wait)
                : delay(wait));
            }
          await Bun.sleep(0);
        }
        })();
        this.recoveryGates.set(lane, gate);
        void gate.finally(() => {
          if (this.recoveryGates.get(lane) === gate)
            this.recoveryGates.delete(lane);
        });
      }
    });
    this.recoveryScan = install;
    void install.finally(() => {
      if (this.recoveryScan === install) this.recoveryScan = undefined;
    });
  }
  recoveryStatuses() {
    return Object.fromEntries(
      [...this.recoveryState].map(([source, status]) => [
        source,
        structuredClone(status),
      ]),
    );
  }
  stopRecovery() {
    this.recoveryGeneration++;
    this.recoveryAbort?.abort();
  }
  async drain() {
    for (;;) {
      const scan = this.recoveryScan;
      if (scan) await scan;
      const priority = this.priorityTail;
      const pending = [
        ...this.recoveryGates.values(),
        priority,
        ...this.normalTails.values(),
      ];
      await Promise.all(pending);
      if (
        !this.recoveryScan &&
        this.recoveryGates.size === 0 &&
        this.normalTails.size === 0 &&
        this.priorityTail === priority
      )
        return;
      await Bun.sleep(0);
    }
  }
  async recover() {
    this.startRecovery();
    await this.drain();
  }
  /** Wait until the durable recovery scan has installed all per-source gates.
   * Failed projections keep retrying behind those gates without blocking diagnostic HTTP. */
  async recoverStartup() {
    this.startRecovery();
    const scan = this.recoveryScan;
    if (scan) await scan;
  }
}
export const connectorDomainDispatcher = new ConnectorDomainDispatcher();
