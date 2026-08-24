import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtensionRuntime } from "./runtime.ts";
import { createScopedActions, type ActionScopePort } from "./action-scope.ts";

const roots: string[] = [];
const runtimes = new Set<ExtensionRuntime>();
afterEach(async () => {
  await Promise.allSettled([...runtimes].map((rt) => rt.stop()));
  runtimes.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const root = () => { const r = realpathSync(mkdtempSync(join(tmpdir(), "ownward-hostcap-"))); roots.push(r); return r; };

/** 内存 Action port：记录全部调用，供属主/字段断言 */
function memoryPort() {
  const rows: any[] = [];
  const port: ActionScopePort = {
    list: () => rows.map((row) => ({ ...row })),
    open: (action) => { const existing = rows.find((row) => row.id === action.id); if (existing) Object.assign(existing, action); else rows.push({ ...action, state: "open", createdAt: "2026-08-21T00:00:00Z" }); },
    resolveExact: (id, resolution) => { const row = rows.find((r) => r.id === id); if (!row) return false; row.state = "resolved"; row.resolution = resolution; return true; },
    setState: (id, state) => { const row = rows.find((r) => r.id === id); if (!row) return false; row.state = state; return true; },
  };
  return { rows, port };
}

function pkg(capabilities: string[], entrySource: string) {
  const dir = join(root(), "deskcap");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ownward.vertical.json"), JSON.stringify({
    id: "deskcap", name: "Host capability fixture", version: "1.0.0", kernelApiVersion: 1,
    entry: "index.ts", capabilities, routes: ["/api/verticals/deskcap/probe"],
  }));
  writeFileSync(join(dir, "index.ts"), entrySource);
  return dir;
}

const ENTRY = `let context;
export default {
  async activate(ctx) {
    context = ctx;
    // 属主强制：伪造前缀必须被拒；正规 open 成功
    if (await ctx.actions.open({ id: "forged:boot", kind: "decide", title: "x", reason: "y" })) throw new Error("forged id accepted");
    if (!(await ctx.actions.open({ id: "deskcap:boot", kind: "review", title: "启动待办", reason: "activate 自检", ref: { note: "n1" } }))) throw new Error("open failed");
    ctx.scheduler.every("tick", 1000, async () => { await ctx.actions.open({ id: "deskcap:tick", kind: "decide", title: "定时待办", reason: "job 落地" }); });
  },
  async route({ url }) {
    const op = url.searchParams.get("op");
    if (op === "list") return new Response(JSON.stringify({ actions: await context.actions.list() }));
    if (op === "resolve") return new Response(JSON.stringify({ ok: await context.actions.resolve("deskcap:boot", "done") }));
    if (op === "dismiss") return new Response(JSON.stringify({ ok: await context.actions.dismiss("deskcap:tick") }));
    return new Response(JSON.stringify({}));
  },
  health() { return { ok: true }; },
};`;

const config = { verticals: { deskcap: { enabled: true, trusted: true, grantedCapabilities: ["storage", "actions", "scheduler"] } } };

describe("外部 Host 的 actions/scheduler capability（B-lite ADR 批次 A）", () => {
  test("actions RPC 全链路：open 属主强制、list 全字段、resolve/dismiss；scheduler job 由 kernel 驱动落地", async () => {
    const { rows, port } = memoryPort();
    const rt = new ExtensionRuntime({
      dataRoot: root(), externalPaths: [pkg(["storage", "actions", "scheduler"], ENTRY)], config,
      actionFactory: (id) => createScopedActions([id], port, id), routeTimeoutMs: 2_000, jobTimeoutMs: 5_000,
    });
    runtimes.add(rt);
    await rt.start();
    expect(rt.statuses().find((s) => s.id === "deskcap")).toMatchObject({ state: "ready" });
    // activate 里的 open 已经落到 kernel port，source 由 scope 强制为 vertical id
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "deskcap:boot", source: "deskcap", kind: "review", title: "启动待办", reason: "activate 自检" });
    // list 经 RPC 回到 host，DTO 带 kind/title/reason/createdAt/ref.note
    const listUrl = new URL("http://x/api/verticals/deskcap/probe?op=list");
    const listed = (await (await rt.route(new Request(listUrl.toString()), listUrl))!.json()) as any;
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0]).toMatchObject({ id: "deskcap:boot", kind: "review", title: "启动待办", reason: "activate 自检", createdAt: "2026-08-21T00:00:00Z", ref: { note: "n1" } });
    // scheduler：kernel 侧 SchedulerScope 按拍打 job RPC，host 本地 fn 执行并回写 action
    await Bun.sleep(1_300);
    expect(rows.find((r) => r.id === "deskcap:tick")).toMatchObject({ source: "deskcap", state: "open" });
    // resolve / dismiss 走 RPC 且属主校验
    const resolveUrl = new URL("http://x/api/verticals/deskcap/probe?op=resolve");
    expect(await (await rt.route(new Request(resolveUrl.toString()), resolveUrl))!.json()).toEqual({ ok: true });
    expect(rows.find((r) => r.id === "deskcap:boot")).toMatchObject({ state: "resolved", resolution: "done" });
    const dismissUrl = new URL("http://x/api/verticals/deskcap/probe?op=dismiss");
    expect(await (await rt.route(new Request(dismissUrl.toString()), dismissUrl))!.json()).toEqual({ ok: true });
    expect(rows.find((r) => r.id === "deskcap:tick")).toMatchObject({ state: "dismissed" });
    await rt.stop();
  });
  test("未授权 capability 仍拒绝：sessions 不在外部开放面", async () => {
    const rt = new ExtensionRuntime({
      dataRoot: root(), externalPaths: [pkg(["sessions"], ENTRY)],
      config: { verticals: { deskcap: { enabled: true, trusted: true, grantedCapabilities: ["sessions"] } } },
    });
    runtimes.add(rt);
    await rt.start();
    const status = rt.statuses().find((s) => s.id === "deskcap")!;
    expect(["failed", "degraded"]).toContain(status.state);
    expect(status.errorCode).toBe("VERTICAL_CAPABILITY_UNAVAILABLE");
    await rt.stop();
  });
});

describe("受信路由授权（B-lite ADR 批次 B）：deadline/body 上限/二进制透传 + frame 协商", () => {
  const BIG_ENTRY = `let context;
export default {
  async activate(ctx) { context = ctx; },
  async route({ request, url }) {
    const op = url.searchParams.get("op");
    if (op === "echo-size") { const bytes = new Uint8Array(await request.arrayBuffer()); return new Response(JSON.stringify({ size: bytes.length }), { headers: { "content-type": "application/json" } }); }
    if (op === "png") { return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } }); }
    if (op === "download") { return new Response("col1,col2", { headers: { "content-type": "text/csv" } }); }
    if (op === "form") { const form = await request.formData(); const file = form.get("file"); return new Response(JSON.stringify({ name: form.get("name"), fileSize: file instanceof Blob ? file.size : -1 }), { headers: { "content-type": "application/json" } }); }
    if (op === "slow") { await new Promise((r) => setTimeout(r, 2_500)); return new Response(JSON.stringify({ slow: true }), { headers: { "content-type": "application/json" } }); }
    if (op === "big-response") { return new Response(JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024) }), { headers: { "content-type": "application/json" } }); }
    return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
  },
};`;
  const grantedConfig = { verticals: { deskcap: { enabled: true, trusted: true, grantedCapabilities: ["storage"], grantedRouteTimeoutMs: 8_000, grantedRouteBodyBytes: 8 * 1024 * 1024, grantedRouteBinary: true } } };
  function grantedRuntime(dir: string) {
    const rt = new ExtensionRuntime({ dataRoot: root(), externalPaths: [dir], config: grantedConfig, routeTimeoutMs: 2_000 });
    runtimes.add(rt);
    return rt;
  }
  const call = (rt: ExtensionRuntime, op: string, init?: RequestInit) => { const url = new URL(`http://x/api/verticals/deskcap/probe?op=${op}`); return rt.route(new Request(url.toString(), init), url); };

  test("大 body 过协商 frame、二进制/CSV 响应透传（inline/attachment 分流）、multipart 原生可解", async () => {
    const rt = grantedRuntime(pkg(["storage"], BIG_ENTRY));
    await rt.start();
    // 2MB 请求体：默认 256KB/1MB frame 必死，授权后 roundtrip
    const big = new Uint8Array(2 * 1024 * 1024);
    const echoed = await (await call(rt, "echo-size", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: big }))!.json() as any;
    expect(echoed.size).toBe(2 * 1024 * 1024);
    // 2MB 响应体（超 host 默认 512KB 上限）
    const bigResponse = await call(rt, "big-response");
    expect(bigResponse!.status).toBe(200);
    expect(((await bigResponse!.json()) as any).payload.length).toBe(2 * 1024 * 1024);
    // 二进制响应：content-type 透传，图片 inline
    const png = await call(rt, "png");
    expect(png!.headers.get("content-type")).toBe("image/png");
    expect(png!.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await png!.arrayBuffer())[1]).toBe(80);
    // 非页面型二进制：attachment（防同源注入）
    const csv = await call(rt, "download");
    expect(csv!.headers.get("content-type")).toBe("text/csv");
    expect(csv!.headers.get("content-disposition")).toBe("attachment");
    // multipart：boundary 藏在 content-type 参数里，整帧透传后 host 侧 formData() 原生可解。
    const form = new FormData();
    form.set("name", "简历");
    form.set("file", new Blob([new Uint8Array(300 * 1024)], { type: "application/pdf" }), "resume.pdf");
    const parsed = await (await call(rt, "form", { method: "POST", body: form }))!.json() as any;
    expect(parsed).toEqual({ name: "简历", fileSize: 300 * 1024 });
    await rt.stop();
  });
  test("慢路由在授权 deadline 内完成；未授权 Vertical 维持 JSON-only 与 256KB 上限", async () => {
    const rt = grantedRuntime(pkg(["storage"], BIG_ENTRY));
    await rt.start();
    expect(((await (await call(rt, "slow"))!.json()) as any).slow).toBe(true);  // 2.5s > 默认 2s，< 授权 8s
    await rt.stop();
    const plain = new ExtensionRuntime({ dataRoot: root(), externalPaths: [pkg(["storage"], BIG_ENTRY)], config: { verticals: { deskcap: { enabled: true, trusted: true, grantedCapabilities: ["storage"] } } }, routeTimeoutMs: 2_000 });
    runtimes.add(plain);
    await plain.start();
    expect((await call(plain, "echo-size", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(8) }))!.status).toBe(415);
    expect((await call(plain, "echo-size", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array(300 * 1024) }))!.status).toBe(413);
    await plain.stop();
  });
});

test("activate 与 migrate 的 grants 必须带齐所有能力位（漏一处能力就静默失效）", () => {
  // llm 加进来时，migrate 那行带上了、activate 那行没带（两处写法不同，替换只命中一处）：
  // 扩展声明并获授权 llm，ctx.llm 却是 undefined 时必须显式失败。
  const src = readFileSync(join(import.meta.dir, "host-client.ts"), "utf8");
  const grantBlocks = [...src.matchAll(/grants:\s*\{[^}]*\}/g)].map((m) => m[0]);
  expect(grantBlocks.length).toBeGreaterThanOrEqual(2);   // activate + migrate
  for (const block of grantBlocks) {
    for (const key of ["storage", "leaseId", "actions", "actionsLeaseId", "llm", "llmLeaseId"]) {
      expect(block).toContain(key);
    }
  }
});
