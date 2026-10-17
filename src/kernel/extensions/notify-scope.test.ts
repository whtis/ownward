import { describe, expect, test } from "bun:test";
import { createScopedNotify, type NotifyScopePort } from "./notify-scope.ts";

function memoryPort(cooldownMs = 30 * 60_000) {
  const sent: { text: string; opts: Parameters<NotifyScopePort["send"]>[1] }[] = [], logs: string[] = [];
  const port: NotifyScopePort = {
    send: async (text, opts) => { sent.push({ text, opts }); },
    linkFor: (path) => `https://bench.example${path}`,
    cooldownMs: () => cooldownMs,
    log: (message) => logs.push(message),
  };
  return { sent, logs, port };
}
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e?.code; } return "NO_ERROR"; };

describe("ScopedNotify（ADR 0003）", () => {
  test("source/key 强制带本 Vertical 前缀；缺省 fyi；拿不到 force 等内部选项", () => {
    const { sent, port } = memoryPort(), n = createScopedNotify("acme", port);
    expect(n.send({ key: "sig:NVDA:ma50", text: " NVDA 跌破 50 日线 \n收 171.2" })).toEqual({ status: "queued" });
    expect(sent).toEqual([{ text: "NVDA 跌破 50 日线 \n收 171.2", opts: { source: "vertical:acme", key: "vertical:acme:sig:NVDA:ma50", level: "fyi", quietExempt: false } }]);
    expect(code(() => n.send({ key: "k", text: "t", force: true } as any))).toBe("VERTICAL_NOTIFY_INVALID");
    expect(code(() => n.send({ key: "k", text: "t", source: "lark" } as any))).toBe("VERTICAL_NOTIFY_INVALID");
  });

  test("字段校验：key/text/detail/level/urgent", () => {
    const n = createScopedNotify("acme", memoryPort().port);
    for (const bad of [null, [], { text: "t" }, { key: "../x", text: "t" }, { key: "k".repeat(129), text: "t" }, { key: "k", text: "  " }, { key: "k", text: "t".repeat(501) },
      { key: "k", text: "t", detail: "d".repeat(2001) }, { key: "k", text: "t", level: "urgent" }, { key: "k", text: "t", urgent: "yes" }])
      expect(code(() => n.send(bad as any))).toBe("VERTICAL_NOTIFY_INVALID");
  });

  test("link：本 Vertical 资产路径换成工作台地址；越界/他人命名空间/非 http 一律拒绝", () => {
    const { sent, port } = memoryPort(), n = createScopedNotify("acme", port);
    n.send({ key: "a", text: "t", link: "/verticals/acme/index.html#symbol=NVDA.US" });
    n.send({ key: "b", text: "t", link: "https://example.com/x?y=1" });
    expect(sent.map((s) => s.opts.link)).toEqual(["https://bench.example/verticals/acme/index.html#symbol=NVDA.US", "https://example.com/x?y=1"]);
    for (const link of ["/verticals/other/index.html", "/verticals/acme/../other/x", "/verticals/acme/%2e%2e/other/x", "/verticals/acme/.%2E/%2e%2e/api/tasks", "//evil.example/verticals/acme/", "/api/tasks",
      "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "/verticals/acme/\\x", "/verticals/acme/a\nb"])
      expect(code(() => n.send({ key: "c", text: "t", link }))).toBe("VERTICAL_NOTIFY_INVALID");
  });

  test("urgent 需要本机授权才映射成 quietExempt", () => {
    expect(code(() => createScopedNotify("acme", memoryPort().port).send({ key: "k", text: "t", urgent: true }))).toBe("VERTICAL_NOTIFY_URGENT_NOT_GRANTED");
    const { sent, port } = memoryPort();
    createScopedNotify("acme", port, { urgentGranted: true }).send({ key: "k", text: "止损触发", level: "act", urgent: true });
    expect(sent[0]!.opts).toMatchObject({ level: "act", quietExempt: true });
  });

  test("同 key 冷却窗口内返回 duplicate 且不投递、不占限流额度；过窗口再推", () => {
    let now = 0;
    const { sent, port } = memoryPort(60_000), n = createScopedNotify("acme", port, { now: () => now, perMinute: 2 });
    expect(n.send({ key: "k", text: "t" }).status).toBe("queued");
    now = 59_999;
    for (let i = 0; i < 5; i++) expect(n.send({ key: "k", text: "t" }).status).toBe("duplicate");
    expect(n.send({ key: "other", text: "t" }).status).toBe("queued");
    // 5 次 duplicate 没占额度：这一分钟只真正受理了 2 条，第三个新 key 才撞上 perMinute=2
    expect(code(() => n.send({ key: "third", text: "t" }))).toBe("VERTICAL_NOTIFY_RATE_LIMITED");
    now = 120_000;
    expect(n.send({ key: "k", text: "t" }).status).toBe("queued");
    expect(sent).toHaveLength(3);
  });

  test("按 Vertical 限流：每分钟 / 每小时上限", () => {
    let now = 0;
    const n = createScopedNotify("acme", memoryPort(1).port, { now: () => now, perMinute: 2, perHour: 3 });
    n.send({ key: "a", text: "t" }); n.send({ key: "b", text: "t" });
    expect(code(() => n.send({ key: "c", text: "t" }))).toBe("VERTICAL_NOTIFY_RATE_LIMITED");
    now = 61_000; n.send({ key: "c", text: "t" });
    now = 200_000;
    expect(code(() => n.send({ key: "d", text: "t" }))).toBe("VERTICAL_NOTIFY_RATE_LIMITED");
    now = 3_600_001;
    expect(n.send({ key: "d", text: "t" }).status).toBe("queued");
  });

  test("投递在后台：通道失败不影响受理结果，只记日志", async () => {
    const logs: string[] = [];
    const n = createScopedNotify("acme", { send: async () => { throw new Error("lark down"); }, linkFor: (p) => p, cooldownMs: () => 1, log: (m) => logs.push(m) });
    expect(n.send({ key: "k", text: "t" })).toEqual({ status: "queued" });
    await Bun.sleep(0);
    expect(logs).toEqual(["vertical notify failed: acme Error"]);
  });
});
