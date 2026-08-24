import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  ConnectorDomainDispatcher,
  domainStateLockCountForTest,
  githubActionId,
  githubActionShouldRevive,
  githubActionThreadId,
  githubShouldRevive,
  projectionFailureNeedsAction,
} from "./domain-events.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function root() {
  const r = mkdtempSync(join(tmpdir(), "ownward-domain-"));
  roots.push(r);
  return r;
}
function row(root: string, id: string) {
  for (const f of readdirSync(join(root, "connectors", "domain-consumer")))
    try {
      const v = JSON.parse(
        readFileSync(join(root, "connectors", "domain-consumer", f), "utf8"),
      );
      if (v.id === id) return v;
    } catch {}
  throw new Error(`missing row ${id}`);
}
describe("Connector domain consumers", () => {
  test("GitHub action identity is stable and only resolved actions revive",()=>{expect(githubActionId("42",1)).toBe("gh:42");expect(githubActionId("42",3)).toBe("gh:42");expect(githubActionThreadId("gh:42")).toBe("42");expect(githubShouldRevive("resolved")).toBeTrue();expect(githubShouldRevive("dismissed")).toBeFalse();expect(githubShouldRevive("snoozed")).toBeFalse();expect(githubActionShouldRevive([{id:"gh:42",state:"resolved"}],"gh:42")).toBeTrue();expect(githubActionShouldRevive([{id:"gh:42",state:"dismissed"}],"gh:42")).toBeFalse();});
  test("projection action policy only alerts terminal failures",()=>{expect(projectionFailureNeedsAction(false)).toBe(false);expect(projectionFailureNeedsAction(true)).toBe(true);});
  test("public dispatcher dedupes replay and accepts full plus legacy keys", async () => {
    const data = root(),
      cards: unknown[] = [],
      touches: unknown[] = [],
      events: any[] = [
        {
          id: "lark:msg:1",
          source: "lark",
          key: "lark.inbox.im.message.receive_v1",
          ts: new Date().toISOString(),
          payload: { message_id: "1", chat_id: "c1", content: "hello" },
        },
        {
          id: "lark:card:req",
          source: "lark",
          key: "lark.inbox.card.action.trigger",
          ts: new Date().toISOString(),
          payload: { request_id: "req" },
        },
      ],
      legacy: any = {
        ...events[1],
        id: "lark:card:legacy",
        key: "card.action.trigger",
        payload: { request_id: "legacy" },
      },
      d = new ConnectorDomainDispatcher(data, {
        handleLarkCard: async (p) => {
          cards.push(p);
        },
        touchLark: (_id, v) => {
          touches.push(v);
        },
      });
    await d.dispatch([...events, ...events]);
    await d.dispatch([...events, legacy]);
    await d.drain();
    expect(cards).toHaveLength(2);
    expect(touches).toHaveLength(1);
  });
  test("non-idempotent card failure is terminal without replay", async () => {
    const data = root(),
      handled: string[] = [],
      failures: number[] = [],
      d = new ConnectorDomainDispatcher(data, {
        onFailure: (_id, _e, n) => failures.push(n),
        handleLarkCard: async (p: any) => {
          if (p.request_id === "bad") throw new Error("boom");
          handled.push(p.request_id);
        },
      }),
      bad: any = {
        id: "lark:bad",
        source: "lark",
        key: "lark.inbox.card.action.trigger",
        ts: new Date().toISOString(),
        payload: { request_id: "bad" },
      },
      good: any = { ...bad, id: "lark:good", payload: { request_id: "good" } };
    await d.dispatch([bad, good]);
    expect(failures).toEqual([1]);
    expect(handled).toEqual(["good"]);
    expect(row(data, "lark:bad").state).toBe("terminal");
  });
  test("restarted owner makes old processing uncertain immediately", async () => {
    const data = root(),
      uncertain: string[] = [],
      event: any = {
        id: "lark:ambiguous",
        source: "lark",
        key: "lark.inbox.card.action.trigger",
        ts: new Date().toISOString(),
        payload: { request_id: "good" },
      },
      path = join(data, "connectors", "domain-consumer.json");
    mkdirSync(join(data, "connectors"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rows: {
          "lark:ambiguous": {
            state: "processing",
            owner: "old",
            at: "2026-08-16T10:00:00Z",
            attempts: 1,
            leaseUntil: "2099-08-16T10:10:00Z",
          },
        },
      }),
    );
    await new ConnectorDomainDispatcher(data, {
      onUncertain: (id) => uncertain.push(id),
      handleLarkCard: async () => {
        throw new Error("must not replay");
      },
    }).dispatch([event]);
    expect(uncertain).toEqual(["lark:ambiguous"]);
    expect(row(data, event.id).state).toBe("terminal");
  });
  test("restarted owner safely replays an idempotent projection with retry backoff", async () => {
    const data = root(),
      projected: string[] = [],
      delays: number[] = [],
      resolved: string[] = [],
      event: any = {
        id: "lark:idempotent:restart",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: new Date().toISOString(),
        payload: { chat_id: "safe" },
      },
      path = join(data, "connectors", "domain-consumer.json");
    mkdirSync(join(data, "connectors"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rows: {
          [event.id]: {
            state: "processing",
            owner: "old",
            at: "2026-08-16T10:00:00Z",
            attempts: 1,
            leaseUntil: "2099-08-16T10:10:00Z",
            nonIdempotent: false,
          },
        },
      }),
    );
    const first = new ConnectorDomainDispatcher(data, {
      retryDelay: async (ms) => {
        delays.push(ms);
      },
      onProjectionResolved: (id) => resolved.push(id),
      projectEvent: (e) => {
        projected.push(e.id);
      },
    });
    first.dispatch([event]);
    await first.drain();
    const second = new ConnectorDomainDispatcher(data, {
      projectEvent: () => {
        throw new Error("done event must not replay");
      },
    });
    second.dispatch([event]);
    await second.drain();
    expect(projected).toEqual([event.id]);
    expect(delays).toEqual([250]);
    expect(resolved).toEqual([event.id]);
    expect(row(data, event.id)).toMatchObject({
      state: "done",
      attempts: 2,
      nonIdempotent: false,
    });
  });
  test("priority card leapfrogs a long normal lane", async () => {
    const data = root(),
      cards: string[] = [],
      touches: number[] = [],
      normal = Array.from({ length: 60 }, (_, i) => ({
        id: `lark:msg:${i}`,
        source: "lark" as const,
        key: "lark.inbox.im.message.receive_v1",
        ts: new Date().toISOString(),
        payload: { chat_id: `c${i}`, message_id: String(i) },
      })),
      card: any = {
        id: "lark:card:fast",
        source: "lark",
        key: "lark.inbox.card.action.trigger",
        ts: new Date().toISOString(),
        payload: { request_id: "fast" },
      },
      d = new ConnectorDomainDispatcher(data, {
        touchLark: () => {
          touches.push(1);
        },
        handleLarkCard: async (p: any) => {
          cards.push(p.request_id);
          expect(touches.length).toBeLessThan(60);
        },
      });
    d.dispatch(normal);
    await d.dispatch([card]);
    await d.drain();
    expect(cards).toEqual(["fast"]);
    expect(touches).toHaveLength(60);
  });
  test("restart recovery projects durable event exactly once", async () => {
    const data = root(),
      cards: string[] = [],
      card: any = {
        id: "lark:card:recover",
        source: "lark",
        key: "lark.inbox.card.action.trigger",
        ts: new Date().toISOString(),
        payload: { request_id: "recover" },
      };
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(card) + "\n");
    await new ConnectorDomainDispatcher(data, {
      handleLarkCard: async (p: any) => {
        cards.push(p.request_id);
      },
    }).recover();
    await new ConnectorDomainDispatcher(data, {
      handleLarkCard: async (p: any) => {
        cards.push(p.request_id);
      },
    }).recover();
    expect(cards).toEqual(["recover"]);
  });
  test("restart recovers a normal event from the durable inbox without the main queue", async () => {
    const data = root(),
      touches: string[] = [],
      event: any = {
        id: "lark:message:inbox",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: new Date().toISOString(),
        payload: {
          chat_id: "chat-1",
          message_id: "message-1",
          content: "recover me",
        },
      },
      dir = join(data, "connectors", "domain-inbox"),
      name = createHash("sha256").update(event.id).digest("hex") + ".json";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(event));
    await new ConnectorDomainDispatcher(data, {
      touchLark: (id) => {
        touches.push(id);
      },
    }).recover();
    expect(touches).toEqual(["chat-1"]);
    expect(readdirSync(dir)).toHaveLength(0);
  });
  test("recovery unions inbox and spool, dedupes, and preserves GitHub review before snapshot", async () => {
    const data = root(),
      seen: string[] = [],
      ts = "2026-08-16T00:00:00.000Z",
      review: any = {
        id: "github:review:A",
        source: "github",
        key: "github.inbox.review_requested",
        ts,
        payload: { threadId: "A", reason: "review_requested" },
      },
      snapshot: any = {
        id: "github:snapshot:B",
        source: "github",
        key: "github.inbox.snapshot",
        ts,
        payload: { unreadThreadIds: ["A"] },
      },
      inbox = join(data, "connectors", "domain-inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(
        inbox,
        createHash("sha256").update(snapshot.id).digest("hex") + ".json",
      ),
      JSON.stringify(snapshot),
    );
    writeFileSync(
      join(data, "queue.jsonl"),
      JSON.stringify(review) + "\n" + JSON.stringify(snapshot) + "\n",
    );
    await new ConnectorDomainDispatcher(data, {
      projectEvent: (e) => {
        seen.push(`${e.id}:${e.key}`);
      },
    }).recover();
    expect(seen).toEqual([
      `${review.id}:${review.key}`,
      `${snapshot.id}:${snapshot.key}`,
    ]);
  });
  test("recovery prefers processing ownership over the ready queue for the same event", async () => {
    const data = root(),
      seen: string[] = [],
      base = {
        id: "lark:message:owned",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: "2026-08-16T00:00:00.000Z",
      };
    writeFileSync(
      join(data, "queue.jsonl"),
      JSON.stringify({ ...base, payload: { origin: "ready" } }) + "\n",
    );
    writeFileSync(
      join(data, "queue.processing.owner.jsonl"),
      JSON.stringify({ ...base, payload: { origin: "processing" } }) + "\n",
    );
    await new ConnectorDomainDispatcher(data, {
      projectEvent: (e) => {
        seen.push(String((e.payload as any).origin));
      },
    }).recover();
    expect(seen).toEqual(["processing"]);
  });
  test("recovery ignores archives and cleanup removes only stale atomic temp files", async () => {
    const data = root(),
      seen: string[] = [],
      archive = join(data, "events"),
      consumer = join(data, "connectors", "domain-consumer"),
      inbox = join(data, "connectors", "domain-inbox");
    mkdirSync(archive, { recursive: true });
    mkdirSync(consumer, { recursive: true });
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(archive, "2026-08-16.jsonl"),
      JSON.stringify({
        id: "lark:archived",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: "2026-08-16T00:00:00.000Z",
        payload: {},
      }) + "\n",
    );
    const stale = join(consumer, "orphan.tmp"),
      connectorStale = join(data, "connectors", "orphan-root.tmp"),
      fresh = join(inbox, "active.tmp");
    writeFileSync(stale, "partial");
    writeFileSync(connectorStale, "partial");
    writeFileSync(fresh, "partial");
    utimesSync(
      stale,
      new Date(Date.now() - 2 * 60 * 60_000),
      new Date(Date.now() - 2 * 60 * 60_000),
    );
    utimesSync(
      connectorStale,
      new Date(Date.now() - 2 * 60 * 60_000),
      new Date(Date.now() - 2 * 60 * 60_000),
    );
    await new ConnectorDomainDispatcher(data, {
      projectEvent: (e) => {
        seen.push(e.id);
      },
    }).recover();
    for (let i = 0; i < 50 && existsSync(stale); i++) await Bun.sleep(2);
    expect(seen).toEqual([]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(connectorStale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(inbox).filter((f) => f.endsWith(".json"))).toHaveLength(
      0,
    );
  });
  test("legacy aggregate migrates once and completed state locks are released", async () => {
    const data = root(),
      legacy = join(data, "connectors", "domain-consumer.json"),
      id = "lark:legacy:done";
    mkdirSync(join(data, "connectors"), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        rows: {
          [id]: { state: "done", at: "2026-08-16T00:00:00Z", attempts: 1 },
        },
      }),
    );
    const d = new ConnectorDomainDispatcher(data, { touchLark: () => {} });
    expect(existsSync(legacy)).toBe(false);
    expect(
      readdirSync(join(data, "connectors")).some((f) =>
        f.startsWith("domain-consumer.json.migrated."),
      ),
    ).toBe(true);
    await d.dispatch([
      {
        id: "lark:new",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: new Date().toISOString(),
        payload: { chat_id: "new" },
      } as any,
    ]);
    await d.drain();
    expect(row(data, id).state).toBe("done");
    expect(row(data, "lark:new").state).toBe("done");
    expect(domainStateLockCountForTest()).toBe(0);
  });
  test("atomic state fsyncs directory and completed card tombstone prevents replay", async () => {
    const data = root(),
      dirs: string[] = [],
      cards: string[] = [],
      card: any = {
        id: "lark:card:fsync",
        source: "lark",
        key: "lark.inbox.card.action.trigger",
        ts: new Date().toISOString(),
        payload: { request_id: "fsync" },
      },
      deps = {
        onDirectoryFsync: (dir: string) => dirs.push(dir),
        handleLarkCard: async (p: any) => {
          cards.push(p.request_id);
        },
      };
    await new ConnectorDomainDispatcher(data, deps).dispatch([card]);
    expect(dirs.some((d) => d.endsWith("domain-consumer"))).toBe(true);
    expect(row(data, card.id).state).toBe("done");
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(card) + "\n");
    await new ConnectorDomainDispatcher(data, deps).recover();
    expect(cards).toEqual(["fsync"]);
  });
  test("real recovery gate preserves source FIFO while unrelated source projects concurrently", async () => {
    const data = root(),
      seen: string[] = [],
      oldEvent: any = {
        id: "github:old",
        source: "github",
        key: "github.inbox.review_requested",
        ts: "2026-08-16T00:00:00Z",
        payload: {},
      },
      live: any = {
        ...oldEvent,
        id: "github:live",
        ts: "2026-08-16T00:01:00Z",
      },
      other: any = {
        id: "lark:free",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: "2026-08-16T00:02:00Z",
        payload: {},
      };
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(oldEvent) + "\n");
    let release!: () => void,
      oldStarted = false;
    const d = new ConnectorDomainDispatcher(data, {
      projectEvent: async (event) => {
        if (event.id === "github:old") {
          oldStarted = true;
          await new Promise<void>((resolve) => (release = resolve));
        }
        seen.push(event.id!);
      },
    });
    d.startRecovery();
    while (!oldStarted) await Bun.sleep(1);
    const github = d.dispatch([live]),
      lark = d.dispatch([other]);
    await lark;
    while (!seen.includes("lark:free")) await Bun.sleep(1);
    expect(seen).toEqual(["lark:free"]);
    release();
    await github;
    await d.drain();
    expect(seen).toEqual(["lark:free", "github:old", "github:live"]);
  });
  test("long Lark projection does not block GitHub normal lane", async () => {
    const data = root(),
      seen: string[] = [];
    let release!: () => void,
      entered = false;
    const d = new ConnectorDomainDispatcher(data, {
        projectEvent: async (event) => {
          if (event.source === "lark") {
            entered = true;
            await new Promise<void>((resolve) => (release = resolve));
          }
          seen.push(event.id!);
        },
      }),
      lark: any = {
        id: "lark:slow",
        source: "lark",
        key: "lark.inbox.im.message.receive_v1",
        ts: new Date().toISOString(),
        payload: {},
      },
      github: any = {
        id: "github:fast",
        source: "github",
        key: "github.inbox.review_requested",
        ts: new Date().toISOString(),
        payload: {},
      };
    const slow = d.dispatch([lark]);
    while (!entered) await Bun.sleep(1);
    await d.dispatch([github]);
    while (!seen.includes("github:fast")) await Bun.sleep(1);
    expect(seen).toEqual(["github:fast"]);
    release();
    await slow;
    await d.drain();
  });
  test("normal dispatch returns after durable inbox while drain waits for projection", async () => {
    const data = root();
    let release!: () => void,
      entered = false;
    const d = new ConnectorDomainDispatcher(data, {
      projectEvent: async () => {
        entered = true;
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    const event: any = {
      id: "external:slow",
      source: "external",
      key: "external.inbox.received",
      ts: new Date().toISOString(),
      payload: {},
    };
    await expect(
      Promise.race([d.dispatch([event]).then(() => "queued"), Bun.sleep(100)]),
    ).resolves.toBe("queued");
    expect(existsSync(join(data, "connectors", "domain-inbox", `${createHash("sha256").update(event.id).digest("hex")}.json`))).toBe(true);
    while (!entered) await Bun.sleep(1);
    const draining = d.drain().then(() => "drained");
    expect(await Promise.race([draining, Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
    release();
    expect(await draining).toBe("drained");
  });
  test("domain-only triage exclusions are projected and inbox-acked", async () => {
    const data = root(), seen: string[] = [], event: any = {
      id: "lark:daily:excluded", source: "lark", key: "lark.inbox.daily",
      ts: new Date().toISOString(), payload: { date: "2026-08-17", items: [] },
    };
    const d = new ConnectorDomainDispatcher(data, { projectEvent: e => { seen.push(e.id!); } });
    await d.dispatch([event]);
    await d.drain();
    expect(seen).toEqual([event.id]);
    expect(readdirSync(join(data, "connectors", "domain-inbox"))).toHaveLength(0);
  });
  test("live event is durable before a recovery gate await and survives dispatcher loss", async () => {
    const data = root(), old: any = {
      id: "github:old:hung", source: "github", key: "github.inbox.review_requested",
      ts: "2026-08-16T00:00:00Z", payload: {},
    }, live: any = { ...old, id: "github:live:recover", ts: "2026-08-17T00:00:00Z" };
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(old) + "\n");
    let entered = false;
    const crashed = new ConnectorDomainDispatcher(data, { projectEvent: async e => {
      if (e.id === old.id) { entered = true; await new Promise<void>(() => {}); }
    }});
    crashed.startRecovery();
    while (!entered) await Bun.sleep(1);
    void crashed.dispatch([live]);
    const inbox = join(data, "connectors", "domain-inbox", `${createHash("sha256").update(live.id).digest("hex")}.json`);
    expect(existsSync(inbox)).toBe(true);
    rmSync(join(data, "queue.jsonl"));
    const seen: string[] = [];
    const restarted = new ConnectorDomainDispatcher(data, { projectEvent: e => { if (e.id === live.id) seen.push(e.id); } });
    await restarted.recover();
    expect(seen).toEqual([live.id]);
    expect(existsSync(inbox)).toBe(false);
  });
  test("legacy plaintext-secret inbox is quarantined instead of replayed", async () => {
    const data = root(), inbox = join(data, "connectors", "domain-inbox"), event: any = {
      id: "lark:legacy:secret", source: "lark", key: "lark.inbox.card.action.trigger",
      ts: new Date().toISOString(), payload: { request_id: "legacy", token: "plaintext" },
    };
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, `${createHash("sha256").update(event.id).digest("hex")}.json`), JSON.stringify(event));
    let projected = false;
    await new ConnectorDomainDispatcher(data, { projectEvent: () => { projected = true; } }).recover();
    expect(projected).toBe(false);
    const quarantine = join(data, "connectors", "domain-inbox-quarantine");
    expect(readdirSync(quarantine)).toHaveLength(1);
    expect(readFileSync(join(quarantine, readdirSync(quarantine)[0]!), "utf8")).toContain("plaintext");
  });
  test("restarted redacted card becomes a manual action and never invokes the callback", async () => {
    const data = root(), manual: string[] = [], handled: string[] = [], event: any = {
      id: "lark:card:redacted-restart", source: "lark", key: "lark.inbox.card.action.trigger",
      ts: new Date().toISOString(), payload: { request_id: "redacted-restart", token: "[REDACTED]" },
    };
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(event) + "\n");
    await new ConnectorDomainDispatcher(data, {
      onRedactedCard: id => manual.push(id),
      handleLarkCard: async p => { handled.push(String((p as any).request_id)); },
    }).recover();
    expect(manual).toEqual([event.id]);
    expect(handled).toEqual([]);
    expect(row(data, event.id).state).toBe("terminal");
  });
  test("large recovery installs gates synchronously then yields between bounded chunks", async () => {
    const data = root(),
      events = Array.from({ length: 300 }, (_, i) => ({
        id: `github:bulk:${i}`,
        source: "github",
        key: "github.inbox.review_requested",
        ts: new Date(1786900000000 + i).toISOString(),
        payload: {},
      }));
    writeFileSync(
      join(data, "queue.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    let projected = 0,
      ticked = false;
    const d = new ConnectorDomainDispatcher(data, {
        projectEvent: () => {
          projected++;
        },
      }),
      started = Date.now();
    d.startRecovery();
    expect(Date.now() - started).toBeLessThan(25);
    setTimeout(() => {
      ticked = true;
    }, 0);
    await Bun.sleep(5);
    expect(ticked).toBe(true);
    await d.drain();
    expect(projected).toBe(300);
  });
  test("priority card bypasses a hung normal recovery lane for the same source", async () => {
    const data = root(),
      seen: string[] = [],
      nightly: any = {
        id: "lark:daily:hung",
        source: "lark",
        key: "lark.inbox.daily",
        ts: new Date().toISOString(),
        payload: {},
      },
      card: any = {
        id: "lark:card:live",
        source: "lark",
        key: "lark.inbox.card.action.trigger",
        ts: new Date().toISOString(),
        payload: { request_id: "live" },
      };
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(nightly) + "\n");
    let release!: () => void,
      entered = false;
    const d = new ConnectorDomainDispatcher(data, {
      projectEvent: async (event) => {
        if (event.id === nightly.id) {
          entered = true;
          await new Promise<void>((resolve) => (release = resolve));
        }
        seen.push(event.id!);
      },
    });
    d.startRecovery();
    while (!entered) await Bun.sleep(1);
    expect(
      await Promise.race([
        d.dispatch([card]).then(() => "card"),
        Bun.sleep(100).then(() => "blocked"),
      ]),
    ).toBe("card");
    expect(seen).toEqual([card.id]);
    release();
    await d.drain();
  });
  test("recovery chunk ENOSPC exposes retry state and retains live FIFO", async () => {
    const data = root(),
      event: any = {
        id: "github:recover-enospc",
        source: "github",
        key: "github.inbox.review_requested",
        ts: new Date().toISOString(),
        payload: {},
      },
      seen: string[] = [],
      failures: number[] = [];
    writeFileSync(join(data, "queue.jsonl"), JSON.stringify(event) + "\n");
    let attempts = 0;
    const d = new ConnectorDomainDispatcher(data, {
      beforeRecoveryChunk: () => {
        if (++attempts <= 2)
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      onRecoveryFailure: (_source, _error, attempt) => failures.push(attempt),
      retryDelay: async () => {},
      projectEvent: (e) => {
        seen.push(e.id!);
      },
    });
    d.startRecovery();
    await d.drain();
    expect(failures).toEqual([1, 2]);
    expect(seen).toEqual([event.id]);
    expect(d.recoveryStatuses()).toEqual({});
  });
});
