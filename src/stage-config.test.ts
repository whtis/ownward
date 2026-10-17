import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prodVaultRoot, STAGING_PORT, stagingConfig } from "../scripts/stage-config.ts";
import { consoleFailures, loadTab } from "../scripts/stage-smoke.ts";

const PROD = "/w/app/prod", DEV = "/w/app/dev";
// 示例配置（值都是假的）：事件源两处都开着、desk 的数据目录指着生产 data/
const prod = {
  owner: { name: "Tis" },
  dashboard: { port: 4517, listen: "all" },
  notify: { macos: true, lark: true, larkUserId: "ou_x" },
  heartbeat: { enabled: true, intervalMin: 10 },
  digest: { enabled: true },
  vault: { root: "~/ownward-vault/work-log", autoSync: true, workRemoteMatch: "acme-org" },
  sources: { lark: { enabled: true }, github: { enabled: true }, gmail: { enabled: true }, stock: { enabled: false, watchlist: ["TSLA.US"] } },
  connectors: { lark: { enabled: true, pollMin: 3 }, github: { enabled: true }, gmail: { enabled: true } },
  verticals: {
    externalPaths: ["/v/notes-vertical/vertical"],
    desk: { enabled: true, deskRoot: "/v/desk", deskData: `${PROD}/data/verticals/desk` },
    "notes-vertical": { enabled: true, coreBaseUrl: "http://127.0.0.1:4521", coreToken: "t" },
  },
  strategy: { enabled: true },
  architecture: { allowFullAccess: true, allowedRoots: ["/w"] },
  dispatch: { worktreeRoot: "~/workspace/.worktrees/", worktreeRetentionDays: 7, defaults: { dir: "~/workspace", permission: "bypass" } },
  providers: { codex: { enabled: true } },
};
const opts = { prodRoot: PROD, devRoot: DEV, vaultCopy: `${DEV}/data/staging-vault` };

describe("staging config = production config + safety overlay", () => {
  test("everything that touches shared external state is switched off; the rest stays production", () => {
    const before = JSON.stringify(prod);
    const { config: c, overrides } = stagingConfig(prod, opts);
    expect(JSON.stringify(prod)).toBe(before);   // 不改传进来的生产配置
    expect(c.prerelease).toEqual({ enabled: true });
    expect(c.dashboard).toEqual({ port: STAGING_PORT, listen: "local" });
    expect(c.notify).toEqual({ macos: false, lark: false, larkUserId: "ou_x" });
    expect([c.heartbeat.enabled, c.digest.enabled, c.strategy.enabled]).toEqual([false, false, false]);
    expect(c.vault).toEqual({ root: `${DEV}/data/staging-vault`, autoSync: false, workRemoteMatch: "acme-org" });
    expect(Object.values(c.sources).map((s: any) => s.enabled)).toEqual([false, false, false, false]);
    expect(Object.values(c.connectors).map((s: any) => s.enabled)).toEqual([false, false, false]);
    expect(c.verticals.desk.enabled).toBe(false);
    expect(c.verticals["notes-vertical"].enabled).toBe(false);
    expect(c.verticals.externalPaths).toEqual(["/v/notes-vertical/vertical"]);
    expect(c.dispatch).toEqual({ worktreeRoot: "~/workspace/.worktrees-staging", worktreeRetentionDays: 0, defaults: { dir: "~/workspace", permission: "bypass" } });
    // 生产的其余部分原样：派任务是真跑，Provider 开关、授权范围都一样
    expect(c.architecture).toEqual(prod.architecture);
    expect(c.providers).toEqual(prod.providers);
    expect(c.owner).toEqual(prod.owner);
    expect(overrides).toContain("sources.lark.enabled");
    expect(overrides).not.toContain("sources.stock.enabled");   // 生产本来就关着：值没变的不列，清单只给人看真正改了什么
  });

  test("paths into the production data dir are rewritten to dev; a vertical can be opted in explicitly", () => {
    const { config: c } = stagingConfig(prod, { ...opts, allowVerticals: ["desk"] });
    expect(c.verticals.desk).toEqual({ enabled: true, deskRoot: "/v/desk", deskData: `${DEV}/data/verticals/desk` });
    expect(c.verticals["notes-vertical"].enabled).toBe(false);
    // 前缀相同但不是 data/ 里面的路径不动（带分隔符判断）
    const { config: d } = stagingConfig({ x: `${PROD}/data-old/a`, y: `${PROD}/data` }, opts);
    expect(d.x).toBe(`${PROD}/data-old/a`);
    expect(d.y).toBe(`${DEV}/data`);
  });

  test("defaults when production leaves things unset", () => {
    const { config: c, overrides } = stagingConfig({}, opts);
    expect(c.dispatch.worktreeRoot).toBe("~/.ownward-worktrees-staging");
    expect(c.dashboard.port).toBe(STAGING_PORT);
    expect(overrides).toContain("prerelease.enabled");
    expect(prodVaultRoot({}, PROD)).toMatch(/\/Documents\/ownward-vault$/);
    expect(prodVaultRoot({ vault: { root: "/abs/vault" } }, PROD)).toBe("/abs/vault");
  });
});

describe("staging page smoke", () => {
  test("only uncaught exceptions and failed resources count as failures", () => {
    const stderr = [
      '[1:2:0922/1:INFO:CONSOLE:1] "Uncaught TypeError: x is null", source: http://127.0.0.1:4519/notes.js (12)',
      '[1:2:0922/1:INFO:CONSOLE:0] "Failed to load resource: the server responded with a status of 404 (Not Found)", source: http://127.0.0.1:4519/nope.js (0)',
      '[1:2:0922/1:INFO:CONSOLE:3] "just a log line", source: http://127.0.0.1:4519/app.js (3)',
      '[1:2:0922/1:INFO:CONSOLE:1] "Uncaught (in promise) Error: boom", source:  (0)',
      "[1:2:0922/1:ERROR:ui/display/mac/cv_display_link_mac.mm:195] CVDisplayLinkCreateWithCGDisplay failed.",
    ].join("\n");
    expect(consoleFailures(stderr)).toEqual([
      "Uncaught TypeError: x is null  (http://127.0.0.1:4519/notes.js)",
      "Failed to load resource: the server responded with a status of 404 (Not Found)  (http://127.0.0.1:4519/nope.js)",
      "Uncaught (in promise) Error: boom",
    ]);
  });
});

describe("staging page smoke against a real Chrome", () => {
  // 冒烟只看 console：异步里才抛的异常（fetch 回来后渲染炸掉）必须抓得到，干净页面不能误报
  test("catches an exception thrown after load and passes a clean page", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => {
      const tab = new URL(req.url).searchParams.get("tab");
      const script = tab === "broken" ? "setTimeout(() => { null.render(); }, 800)" : "console.log('booted')";
      return new Response(`<!doctype html><meta charset="utf-8"><body><script>${script}</script>`, { headers: { "Content-Type": "text/html" } });
    } });
    const root = mkdtempSync(join(tmpdir(), "stage-smoke-test-"));
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const [broken, clean] = await Promise.all([loadTab(base, "broken", root, 2_000), loadTab(base, "clean", root, 2_000)]);
      expect(broken.errors.some((e) => e.startsWith("Uncaught TypeError"))).toBe(true);
      expect(clean.errors).toEqual([]);
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("staging mode in the daemon", () => {
  const src = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
  const main = src.slice(src.indexOf("async function main()"));
  const lines = main.split("\n");
  /** 这一行在 main 里是否处在 staging 守卫之内：同一行带 if (!staging)，或往上先碰到 `  if (!staging) {` 再碰到 main 层级的 `  }` */
  const guarded = (i: number) => {
    if (lines[i].includes("if (!staging)")) return true;
    for (let j = i - 1; j >= 0; j--) {
      if (/^ {2}if \(!staging\) \{/.test(lines[j])) return true;
      if (/^ {2}\}/.test(lines[j])) return false;
    }
    return false;
  };
  // 碰共享外部状态的后台任务：新加同类定时任务时照着补一个标记
  const shared = ["runTriage()", "sweepRoutines", "sweepMemoryChores", "sweepCapture", "m.sweepHarvest()", "sweepDaemonTranscripts", "sweepMeetingReminders", "sweepDigest", "runHeartbeat();", "setTimeout(sweep, 120_000)"];
  test.each(shared)("%s only starts outside staging", (marker) => {
    const hits = lines.map((l, i) => (l.includes(marker) ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBeGreaterThan(0);
    for (const i of hits) expect({ marker, line: lines[i].trim().slice(0, 80), guarded: guarded(i) }).toMatchObject({ guarded: true });
  });
  test("tasks that end in staging are not harvested (model calls into a throwaway vault copy)", () => {
    const reap = main.slice(main.indexOf("for (const t of reapExited())"));
    expect(reap.indexOf("if (staging) continue;")).toBeGreaterThan(-1);
    expect(reap.indexOf("if (staging) continue;")).toBeLessThan(reap.indexOf("await harvestTask(t)"));
  });
  test("a crash loop in staging exits instead of dispatching the production rollback helper", () => {
    expect(main.indexOf("boot.shouldRollback && staging")).toBeGreaterThan(-1);
    expect(main.indexOf("boot.shouldRollback && staging")).toBeLessThan(main.indexOf('dispatchDeployHelper("rollback"'));
  });
  test("the workbench marks a staging instance", () => {
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
    const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
    expect(server).toContain("staging: cfg.prerelease?.enabled === true");
    expect(html).toContain('id="staging-badge"');
    expect(app).toContain('$("#staging-badge").hidden = !staging;');
    expect(app).toContain('function appTitle(prefix = "")');
  });
});
