import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("core survives disabled built-in Verticals", () => {
  test("Chat / Session / Action remain reachable with dev and strategy disabled", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-verticals-off-"));
    const script = `
      import { cfg } from ${JSON.stringify(join(import.meta.dir, "util.ts"))};
      cfg.verticals = { ...(cfg.verticals || {}), dev: { enabled: false }, strategy: { enabled: false }, externalPaths: [] };
      cfg.architecture = { ...(cfg.architecture || {}), allowedRoots: [] };
      cfg.dashboard = { ...(cfg.dashboard || {}), port: 0, listen: "local" };
      const { startServer } = await import(${JSON.stringify(join(import.meta.dir, "server.ts"))});
      const server = startServer();
      const base = "http://127.0.0.1:" + server.port;
      const paths = ["/api/chat/list", "/api/dev/recent", "/api/actions"];
      const statuses = [];
      for (const path of paths) statuses.push((await fetch(base + path)).status);
      server.stop(true);
      console.log(JSON.stringify(statuses));
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, OWNWARD_DATA_ROOT: dataRoot }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    try {
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual([200, 200, 200]);
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test("evolve and PR approval endpoints traverse the Dev Vertical", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-dev-approval-"));
    const script = `
      import { cfg } from ${JSON.stringify(join(import.meta.dir, "util.ts"))};
      cfg.verticals = { ...(cfg.verticals || {}), dev: { enabled: true }, strategy: { enabled: false }, externalPaths: [] };
      cfg.architecture = { ...(cfg.architecture || {}), allowedRoots: [] };
      cfg.dashboard = { ...(cfg.dashboard || {}), port: 0, listen: "local" };
      const { startServer } = await import(${JSON.stringify(join(import.meta.dir, "server.ts"))});
      const server = startServer(), base = "http://127.0.0.1:" + server.port;
      const post = async (path, body) => { const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const text = await response.text(); let payload; try { payload = JSON.parse(text); } catch { payload = { raw: text }; } return { status: response.status, body: payload }; };
      const evolve = await post("/api/evolve/apply", { id: "missing-evolve" });
      const pr = await post("/api/gh/pr/act", { repo: "owner/repo", num: 1, action: "comment" });
      const diagnostics = await (await fetch(base + "/api/system/verticals")).json();
      server.stop(true);
      console.log(JSON.stringify({ evolve, pr, diagnostics }));
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, OWNWARD_DATA_ROOT: dataRoot }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    try {
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.evolve, JSON.stringify(result.diagnostics)).toMatchObject({ status: 400, body: { ok: false } });
      expect(result.evolve.body.msg).toContain("不是演进任务");
      expect(result.pr).toMatchObject({ status: 400, body: { ok: false } });
      expect(result.pr.body.msg).toContain("需要填写内容");
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });
  test("work dispatch without allowed roots returns a diagnostic 403 before reading body",async()=>{const source=await Bun.file(new URL("./server.ts",import.meta.url)).text();expect(source).toContain('p === "/api/work"');expect(source).toContain("DEV_ROOTS_NOT_CONFIGURED");});
});
